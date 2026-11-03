// 写入用的文件锁。
//
// 为什么需要：MemoryStore 的整个 read-modify-write 窗口（load() 到 save()）
// 没有任何保护。两个持有者同时写，后写的一方只是把自己的内存快照整个覆盖上去，
// 前一方写进去的条目从来没被它读到过 —— 于是数据凭空消失，而且双方都返回成功。
//
// 实测（两个独立 node 进程，各做 N 次 read → push → write）：
//   每进程写 10 次：9 组里 3 组丢数据（丢 9 / 7 条）
//   每进程写 40 次：80 条只剩 40 条，丢一半
// 所有子进程都正常退出、零异常、零日志。
//
// 触发场景不止「开两个窗口」：
//   · DSH 宿主和设置页 HTTP 路由各持一个 MemoryStore 实例
//   · 用户手工编辑 memory.json（这是文档里写明的正常用法）
//   · 提炼任务（afterWrite → organize）和工具调用是两个不同入口
//
// 【取舍：锁是 best-effort，宁可偶发丢一次，也不要永久写不进】
// 如果进程在持锁期间被强杀（DSH 是 Electron，用户关窗口、任务管理器结束进程
// 都是常态），锁文件会残留。如果只做「抢不到就抛错」，后果是从「静默丢数据」
// 变成「**彻底写不进去**」—— 用户会以为插件装坏了直接卸载。
// 所以这里必须带陈旧锁回收：锁文件里写 {pid, ts}，超过 STALE_MS 就视为死锁
// 删掉重抢。这个取舍是明确的：极端情况下（进程刚好在临界区里卡超过 10 秒）
// 可能放进来第二个写者，代价是丢一次更新；反过来则可能是永久不可用。
import fs from 'node:fs';
import path from 'node:path';
import { readLongMemoryStoreResult, writeLongMemoryStore } from './long-memory.js';

const LOCK_SUFFIX = '.lock';
const STALE_MS = 10_000;
const ACQUIRE_TIMEOUT_MS = 5_000;
const RETRY_MIN_MS = 8;
const RETRY_MAX_MS = 40;

/**
 * 本进程**当前真的持有**的锁路径集合。
 *
 * 用来区分「本进程 pid 的锁」到底是残留还是活跃 —— 见 isStaleLock。
 * 没有它就只能靠「pid === process.pid 一律判陈旧」，而那会在未来引入
 * 持锁期间重入 save() 时破坏互斥（把活锁当成死锁删掉，两个写者同时进临界区）。
 */
const heldByThisProcess = new Set();

function sleepSync(ms) {
  // 这里必须是同步睡眠：save() 的调用方（工具、路由 handler）全都是同步写盘语义，
  // 改成 async 会波及 9 处调用点和它们的 try/catch。
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // 忙等，但单次最多 40ms，可接受
  }
}

function lockPathOf(file) {
  return `${file}${LOCK_SUFFIX}`;
}

/**
 * 目录是否可写 —— 用来区分「锁被占用」和「真的没权限」。
 *
 * 不能靠 `fs.existsSync(lockPath)` 判断：对方可能刚好在那一瞬释放了锁，
 * 于是把正常竞争误判成权限故障（实测踩过）。
 * 这里用一个独立的探测文件：能建就能删就说明目录可写，与锁的时序无关。
 */
function isDirWritable(dir) {
  const probe = path.join(dir, `.write-probe-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return true;
  } catch {
    try {
      fs.unlinkSync(probe);
    } catch {
      // 清理失败不重要
    }
    return false;
  }
}

/** 读锁文件里记的持有者信息；读不到或格式不对都当「无信息」。 */
function readLockInfo(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      pid: Number(parsed?.pid) || 0,
      ts: Number(parsed?.ts) || 0
    };
  } catch {
    return { pid: 0, ts: 0 };
  }
}

/**
 * 判断锁是不是「陈旧」的（持有者已经死了）。
 *
 * 两道判断，任一成立即可回收：
 *   1. 时间戳超过 STALE_MS —— 纯时间兜底，不依赖任何平台特性。
 *   2. 持有者进程已经不在了 —— process.kill(pid, 0) 只探测不发送信号。
 *
 * 第 2 条在 Windows 上行为需要留意：对不存在的 pid 抛 ESRCH 才是「已退出」；
 * 抛 EPERM 表示进程存在但没权限（跨用户场景），那**不能**当成死了 —— 宁可
 * 等时间超时。所以这里只把 ESRCH 当作死亡证据，其余一律交给时间判断。
 */
function isStaleLock(lockPath) {
  const info = readLockInfo(lockPath);
  const now = Date.now();
  if (info.ts && now - info.ts > STALE_MS) return true;

  // 【F3 · 本进程 pid 的锁】必须单独处理，否则会白等满一个 STALE_MS。
  //
  // 问题：ACQUIRE_TIMEOUT_MS(5000) < STALE_MS(10000)。若锁里写的是**本进程**的 pid，
  // 下面那句 `info.pid !== process.pid` 为假 → 跳过进程存活检查 → 落到最后一行
  // 「无 pid/ts 信息」的兜底（同样为假）→ 判**不陈旧** → 只能等时间戳超过 10 秒。
  // 实测要等满 10.5s 才抛错，而 P0-2b 验收①要求「1 个超时周期内」（≤5s）。
  //
  // 为什么本进程 pid 的锁基本必然是残留：acquire() 全程同步、不可重入 ——
  // 抢到锁后到 release() 之间没有 await/回调，本进程不可能「一边持锁一边又来抢锁」。
  // 所以看到本进程 pid 却不在 heldByThisProcess 里，只可能是上次崩溃/强杀留下的。
  // （另一个来源是 pid 复用：本进程恰好拿到一个已死进程用过的 pid。）
  //
  // 但**不能**无条件把 `pid === process.pid` 判陈旧：万一将来有代码在持锁期间
  // 重入 save()（比如某个 afterMerge 钩子触发写盘），那会把一把活锁当死锁删掉，
  // 两个写者同时进临界区 —— 正是这把锁要防的事。所以用 heldByThisProcess 精确判定：
  // 在集合里 = 我们自己正持有 → 判陈旧等于自杀；不在集合里 = 残留 → 立刻可回收。
  if (info.pid > 0 && info.pid === process.pid) {
    return !heldByThisProcess.has(lockPath);
  }

  if (info.pid > 0 && info.pid !== process.pid) {
    try {
      process.kill(info.pid, 0);
      return false; // 进程还活着
    } catch (error) {
      return Boolean(error && error.code === 'ESRCH');
    }
  }
  // 没有 pid/ts 信息（文件损坏或刚创建还没写完）—— 给一个短暂的宽限期，
  // 超过 RETRY 上限仍然读不出信息就当陈旧。
  return info.ts === 0 && info.pid === 0;
}

/** 抢锁。成功返回释放函数；超时抛错（调用方必须让这个错误冒出去）。 */
function acquire(file) {
  const lockPath = lockPathOf(file);
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  let attempt = 0;
  let dirWritable = null; // 懒探测：只有真遇到 EPERM/EACCES 才检查，且只检查一次

  while (true) {
    try {
      // 'wx' = O_CREAT | O_EXCL，创建成功即抢到，原子操作。
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      } finally {
        fs.closeSync(fd);
      }
      // 登记「本进程正持有这把锁」，供 isStaleLock 区分残留锁与活锁（见那里的注释）。
      // 必须在返回释放函数**之前**登记：中间任何一步抛出都会让锁文件留在磁盘上
      // 却没人认领，那种状态会被 isStaleLock 当成残留立刻回收（正好是对的）。
      heldByThisProcess.add(lockPath);
      return () => {
        heldByThisProcess.delete(lockPath);
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // 已经被别人回收了，不算错误
        }
      };
    } catch (error) {
      // 【Windows 实测：锁被占用时报的不一定是 EEXIST】
      // 2026-11-03 本机实测（Windows 11 / Node v24.22.0）：当锁文件正被另一个
      // 进程打开着，`fs.openSync(lockPath, 'wx')` 会抛
      //   EPERM: operation not permitted, open '...memory.json.lock'
      // 而不是 EEXIST。原来这里只认 EEXIST，其余一律 throw —— 于是「另一个
      // 进程正在持锁」这个**完全正常**的情况被当成致命错误抛给用户，多进程
      // 探针 10 轮里 1 轮撞上（第 4 轮，54/80 条）。
      //
      // 这三种错误码都表示「抢不到」，跟 EEXIST 语义相同，都应该走重试，
      // 而不是当致命错误。真正的致命错误（目录不存在 ENOENT、磁盘满 ENOSPC、
      // 路径是目录 EISDIR 等）仍然直接抛。
      const code = error && error.code;
      const isContended = code === 'EEXIST' || code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!isContended) {
        throw error;
      }
      // 例外：EPERM/EACCES 可能不是「被占用」，而是真的没权限建文件
      // （目录只读、ACL 拒绝）。这种情况重试 5 秒也没用，直接抛，
      // 别让用户对着一个永远好不了的错误干等。
      //
      // 判据用「目录是否可写」而不是「锁文件是否存在」：后者有竞态 ——
      // 对方可能刚好在 existsSync 执行的那一瞬释放了锁（文件消失），
      // 于是把一个**正常竞争**误判成权限问题直接抛出。这个竞态在实测中
      // 真的发生了（10 轮里 1 轮，第 7 轮 45/80 条）。目录可写性是稳定属性，
      // 不受对方加解锁的时序影响。
      //
      // 而且只探测一次（结果缓存在 dirWritable 里）：每次失败都建探测文件
      // 会额外制造磁盘竞争，正好在最不该加压的时候加压。
      if (code !== 'EEXIST' && dirWritable === null) {
        dirWritable = isDirWritable(path.dirname(lockPath));
      }
      if (code !== 'EEXIST' && dirWritable === false) {
        throw error;
      }
    }

    // 锁已存在：先看是不是陈旧锁，是就回收重抢。
    if (isStaleLock(lockPath)) {
      try {
        fs.unlinkSync(lockPath);
        // 【只在**真的删掉了**才 continue】锁没了，立刻回到顶部重抢，这是一条快速路径。
        continue;
      } catch {
        // 【F2 · 回收失败时绝对不能 continue】这里是 reviewer 抓到的死循环：
        //
        // 原来 try 里只有 unlinkSync、catch 是空的，然后**无条件** continue。
        // 而 continue 直接跳回 while(true) 顶部，把下面的 deadline 检查与
        // sleepSync 退避**一起跳过**。于是只要 isStaleLock 恒真、unlinkSync 恒失败，
        // 就是一个无睡眠、无超时、单核打满的死循环：save() 永不返回，
        // ACQUIRE_TIMEOUT_MS=5000 完全失效。
        //
        // reviewer 已实测复现（_r-busy.mjs）：锁路径是**目录**时 → readFileSync
        // EISDIR → readLockInfo 兜底得 {pid:0,ts:0} → isStaleLock 兜底判据恒真
        // → unlinkSync(目录) EPERM 被吞 → continue。子进程被 9 秒外部强杀，
        // 退出码 null、无结果文件。
        //
        // 触发场景根本不需要用户懂技术：同步盘（OneDrive/坚果云）把文件占成目录、
        // 杀软隔离后留下同名目录、或者手工误建。
        //
        // 更严重的是它把本文件开头那条取舍**反转**了：那里写的是
        // 「宁可偶发丢一次，也不要永久写不进」，而死循环给出的正是**永久写不进**，
        // 而且比原问题更糟 —— 它卡死整个工具调用线程，用户连报错都看不到。
        //
        // 所以失败时什么都不做，让它自然落到下面的 deadline + 退避：
        // 至少 5 秒后会抛出一个**可读的错误**告诉用户锁路径有问题。
      }
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `memory-lens: 无法在 ${ACQUIRE_TIMEOUT_MS}ms 内获得记忆文件锁（${lockPath}）。` +
          '这通常意味着另一个进程正在写，或者有一个残留的锁文件。'
      );
    }
    attempt += 1;
    const backoff = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * attempt);
    sleepSync(backoff + Math.floor(Math.random() * 10));
  }
}

/**
 * 在锁内做一次「重读 → 合并 → 写」。
 *
 * 为什么要重读而不是直接写内存快照：这才是真正的 CAS。持有者在 load() 之后
 * 可能已经过了几十毫秒（中间 await 过一次网络请求、渲染、或者用户操作），
 * 期间别人写进去的条目它没见过。直接覆盖 = 丢更新。
 *
 * 合并规则：
 *   · 磁盘上有、内存里没有的条目 → 保留磁盘的（别人刚写的）
 *   · 两边都有 → 取 updatedAt 更新的那个（后写者赢，但不是无脑覆盖）
 *   · 内存里有、磁盘上没有 → 加进去（自己新写的）
 *   · **在 deletedIds 里的 → 无论磁盘上有没有都删掉**
 *
 * 最后一条是关键。union 合并天然没法表达「删除」—— 用户用 forget 删掉一条，
 * 磁盘上还在，合并就会把它复活。所以调用方必须告诉这里「这次删了哪些 id」。
 * 没有这一条时，实测 delete 后条目立刻回来（tools.test.mjs 的「真的从库里消失」）。
 *
 * @param {string} file
 * @param {object} localStore 内存里的库
 * @param {object} [options]
 * @param {Set<string>} [options.deletedIds] 本次操作删掉的 id
 * @param {(merged:object) => void} [options.afterMerge] 合并后、写盘前的钩子
 */
export function withStoreLock(file, localStore, options = {}) {
  const { deletedIds, afterMerge } = options;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const release = acquire(file);
  try {
    const onDisk = readLongMemoryStoreResult(file);
    let merged = localStore;

    if (onDisk.ok) {
      merged = mergeStores(onDisk.store, localStore, deletedIds);
    } else if (onDisk.reason === 'read-failed') {
      // 读不到磁盘（不是解析失败而是读不出来，比如权限）—— 不能盲目覆盖，
      // 把错误抛给调用方，由它决定是报错还是跳过。
      throw onDisk.error;
    }
    // parse-failed 的情况：磁盘文件坏了。这时**不能**用空库覆盖它，
    // 但也不能拒绝写（否则用户永远修不好）。折中：先把坏文件留一份备份，
    // 再用内存里的内容重建。备份由 store.js 的 corrupt 逻辑负责，
    // 这里只标记出来（见返回值的 recoveredFromCorrupt）。

    if (typeof afterMerge === 'function') afterMerge(merged);
    writeLongMemoryStore(file, merged);
    return { store: merged, recoveredFromCorrupt: !onDisk.ok };
  } finally {
    release();
  }
}

/**
 * 把磁盘版和内存版合并成一个。
 *
 * 只在 shared 桶上做精细合并（当前设计只有一个桶），其余桶整体以内存版为准。
 */
function mergeStores(diskStore, localStore, deletedIds) {
  const merged = {
    ...diskStore,
    buckets: { ...diskStore.buckets },
    meta: { ...(diskStore.meta || {}), ...(localStore.meta || {}) }
  };

  const keys = new Set([...Object.keys(diskStore.buckets || {}), ...Object.keys(localStore.buckets || {})]);
  for (const key of keys) {
    const diskList = Array.isArray(diskStore.buckets?.[key]) ? diskStore.buckets[key] : [];
    const localList = Array.isArray(localStore.buckets?.[key]) ? localStore.buckets[key] : [];
    if (diskList.length === 0) {
      merged.buckets[key] = stripDeleted(localList, deletedIds);
      continue;
    }
    if (localList.length === 0) {
      // 本地这个桶是空的：可能「本来就是空的」，也可能「刚被清空」。
      // 只有后者该删；前者应该保留磁盘内容。靠 deletedIds 区分 —— 如果本地
      // 清空是删除造成的，调用方会把那些 id 报上来；否则视为空桶不动磁盘。
      merged.buckets[key] = deletedIds?.size
        ? stripDeleted(diskList, deletedIds)
        : diskList;
      continue;
    }
    merged.buckets[key] = mergeLists(diskList, localList, deletedIds);
  }
  return merged;
}

/** 去掉在 deletedIds 里的条目（没有集合就原样返回）。 */
function stripDeleted(list, deletedIds) {
  if (!deletedIds || deletedIds.size === 0) return list;
  return list.filter((m) => !(m && deletedIds.has(m.id)));
}

/**
 * 按 id 做 union，同 id 取 updatedAt 更新的；内存里新写的（磁盘没有）追加在后面。
 *
 * 【已知限制：合并是「整条」粒度的，不是字段级】—— captain 2026-11-03 明确拍板，
 * 这里记下来免得以后有人把它当 bug 修。
 *
 * 两个进程同时改**同一条记忆的不同字段**时，先写的那次会丢：
 *   A 进程把 weight 改成 5（updatedAt=T1），B 进程把 tags 加了「考研」（updatedAt=T2>T1），
 *   B 后写，合并时按 updatedAt 整条取 B 的版本 → A 改的 weight 被 B 的旧 weight 覆盖。
 *
 * 方案承诺的是 per-item LWW（同 id 整条取较新），**没有承诺字段级合并**，
 * 所以这不是缺陷。要做字段级合并就得给每个字段单独记时间戳，存储体积和复杂度都翻倍，
 * 而实际使用中「两个进程同时改同一条的不同字段」几乎不会发生 —— 一次记忆写入
 * 通常就是一个完整的 upsert，改的是整条。
 *
 * 真正重要的保证仍然成立：**不会丢条目**（union），也不会出现「A 的新条目被 B 覆盖消失」。
 */
function mergeLists(diskList, localList, deletedIds) {
  const byId = new Map();
  for (const item of diskList) {
    if (item && item.id) byId.set(item.id, item);
  }
  const appended = [];
  for (const item of localList) {
    if (!item || !item.id) continue;
    const onDisk = byId.get(item.id);
    if (!onDisk) {
      appended.push(item);
      continue;
    }
    // 同 id：谁更新用谁。updatedAt 缺失时保守取内存版（本次操作的意图最新）。
    const diskAt = Number(onDisk.updatedAt) || 0;
    const localAt = Number(item.updatedAt) || Number.MAX_SAFE_INTEGER;
    byId.set(item.id, localAt >= diskAt ? item : onDisk);
  }
  // 顺序：磁盘原有顺序在前，新追加的在后 —— 保证「最近写的在队尾」这个隐含约定。
  const out = [];
  const seen = new Set();
  for (const item of diskList) {
    if (!item || !item.id) continue;
    if (deletedIds?.has(item.id)) continue;
    out.push(byId.get(item.id));
    seen.add(item.id);
  }
  for (const item of appended) {
    if (seen.has(item.id) || deletedIds?.has(item.id)) continue;
    out.push(item);
    seen.add(item.id);
  }
  return out;
}

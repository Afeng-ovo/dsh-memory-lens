// P0-2a/2b 探针 · 单进程部分（验收②③④）
//
// 验收① 的多进程部分在 _probe-p02-multi.mjs（需要子进程，单独一个文件）。
//
// 跑法：node test/_probe-p02.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const { MemoryStore } = await import('../lib/store.js');

const out = [];
let failed = 0;
const check = (name, cond, extra = '') => {
  out.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failed += 1;
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memlens-p02-'));

function freshFile(name) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'memory.json');
}

function countItems(file) {
  try {
    const store = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (store.buckets?.shared || []).length;
  } catch {
    return -1;
  }
}

function makeItem(id, text) {
  return {
    id,
    text,
    kind: 'fact',
    status: 'active',
    createdAt: 1700000000000,
    updatedAt: 1700000000000
  };
}

// ── 验收③ 进程内并发：两个 async 各写 20 条，中间插 await ────────────────────
//
// 这是 P0-2a 第 4 条（进程内 promise 链）要解决的问题。核心疑问：save() 是
// 同步函数，同步代码在 JS 单线程里不可能被另一个 async 打断 —— 那么真正的
// 危险窗口到底在哪？实测两种典型写法。
{
  // ③-1 共享同一个 MemoryStore 实例（index.js 里 9 处 save 的真实形态）
  const file = freshFile('intra-shared');
  const store = new MemoryStore(file);
  store.load();

  const write = async (prefix, n) => {
    for (let i = 0; i < n; i += 1) {
      store.bucket('shared').push(makeItem(`lm-${prefix}-${i}`, `${prefix} 的第 ${i} 条`));
      await new Promise((r) => setTimeout(r, 1)); // 关键：跨 await
      store.save();
    }
  };
  await Promise.all([write('a', 20), write('b', 20)]);
  const n1 = countItems(file);
  check('③-1 共享实例：两个 async 各写 20 条 → 40 条', n1 === 40, `实际 ${n1} 条`);
}

{
  // ③-2 两个独立的 MemoryStore 实例指向同一个文件（宿主与 HTTP 路由的真实形态）
  const file = freshFile('intra-separate');
  const storeA = new MemoryStore(file);
  const storeB = new MemoryStore(file);
  storeA.load();
  storeB.load();

  const write = async (store, prefix, n) => {
    for (let i = 0; i < n; i += 1) {
      store.bucket('shared').push(makeItem(`lm-${prefix}-${i}`, `${prefix} 的第 ${i} 条`));
      await new Promise((r) => setTimeout(r, 1));
      store.save();
    }
  };
  await Promise.all([write(storeA, 'a', 20), write(storeB, 'b', 20)]);
  const n2 = countItems(file);
  check('③-2 两个独立实例指向同一文件 → 40 条', n2 === 40, `实际 ${n2} 条`);
}

// ── 验收② 锁超时路径必须明确抛错（不是静默继续）────────────────────────────
//
// 造一个「活着的持锁者」：ts 是现在（不超 STALE_MS），pid 是**另一个真实活着的进程**。
// 这种锁既不会被时间回收，也不会被 pid 探测回收 —— 抢锁只能等到超时后抛错。
//
// 【为什么不能用 pid: process.pid —— 原来这里就是那么写的，被 F3 修掉后走不通了】
// 用本进程 pid 伪造「活着的持锁者」在语义上本来就是**错的**：acquire() 全程同步、
// 不可重入，本进程不可能一边持锁一边又来抢锁，所以本进程 pid 的锁**必然是残留**
// （上次崩溃/强杀留下的，或者 pid 复用）。F3 修的就是这个 —— 让这种锁被立刻回收，
// 而不是白等满一个 STALE_MS(10s) 才抛错（那会违反 P0-2b 验收①「1 个超时周期内」）。
//
// 所以探针必须改用**真正的另一个活进程**：起一个 node 子进程让它在原地睡着，
// 拿到它的 pid 写进锁文件，测完再杀掉。这才是「另一个进程正在写」的真实形态。
{
  const file = freshFile('timeout');
  const store = new MemoryStore(file);
  store.load();
  store.bucket('shared').push(makeItem('lm-timeout-0', '先写一条让库存在'));

  const lockPath = `${file}.lock`;
  // 起一个「活着但不干活」的进程：-e 'setTimeout(()=>{},30000)' 会挂 30 秒。
  // 用 async spawn 拿 child.pid（spawnSync 的 result 里没有 pid 字段）。
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  const holderPid = await new Promise((resolve) => {
    if (holder.pid) return resolve(holder.pid);
    holder.on('spawn', () => resolve(holder.pid));
  });
  try {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: holderPid, ts: Date.now() }), 'utf8');

    const started = Date.now();
    let threw = null;
    try {
      store.save();
    } catch (error) {
      threw = error;
    }
    const elapsed = Date.now() - started;
    check('② 持锁者活着且未超时 → save() 抛错', threw instanceof Error, threw ? String(threw.message).slice(0, 50) : '静默返回了');
    check('② 抛出的错误说的是锁超时，不是别的', threw ? /锁/.test(String(threw.message)) : false, threw ? String(threw.message).slice(0, 70) : '');
    check('② 等到超时才抛（不是立刻抛也不是永不抛）', elapsed >= 4000 && elapsed <= 7000, `${elapsed}ms`);
  } finally {
    try { holder.kill('SIGKILL'); } catch { /* 已经退了就算了 */ }
    try { fs.unlinkSync(lockPath); } catch { /* 可能已被回收 */ }
  }
}

// ── 验收②b 本进程残留锁必须**立刻**回收（F3：不许白等满 STALE_MS）────────────
//
// 这是 F3 的直接验收：ACQUIRE_TIMEOUT_MS(5000) < STALE_MS(10000)，若把本进程 pid 的锁
// 当活锁，就会等满 10.5s 才抛错，违反「1 个超时周期内」。正确行为是**立刻回收**。
{
  const file = freshFile('ownstale');
  const store = new MemoryStore(file);
  store.load();
  store.bucket('shared').push(makeItem('lm-own-0', '本进程残留锁应该立刻被回收'));

  const lockPath = `${file}.lock`;
  // 本进程 pid + 刚刚的时间戳 = 最坏情况（既不像陈旧、pid 又「活着」）
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }), 'utf8');

  const started = Date.now();
  let threw = null;
  try {
    store.save();
  } catch (error) {
    threw = error;
  }
  const elapsed = Date.now() - started;
  check('②b 本进程残留锁被**立刻**回收，save() 成功', threw === null, threw ? String(threw.message).slice(0, 50) : '写入成功');
  check('②b 且用时远小于 STALE_MS（不是白等 10s）', elapsed < 2000, `${elapsed}ms（STALE_MS=10000）`);
  const n = countItems(file);
  check('②b 写入真的落地了', n === 1, `${n} 条`);
}

// ── 验收④ 持锁进程被强杀 → 下一个进程必须在 1 个超时周期内成功写入 ──────────
//
// 造一个真实「已退出进程」的 pid：起一个 node 子进程让它立刻退出，拿它的 pid。
// 锁文件写 {pid: 那个已死进程, ts: 现在}。按 plan-v2 第 3 条，process.kill(pid,0)
// 抛 ESRCH 就是死亡证据 → 应立刻回收，而不是傻等 10s 或直接永久抛错。
{
  const file = freshFile('stale');
  const store = new MemoryStore(file);
  store.load();
  store.bucket('shared').push(makeItem('lm-stale-0', '陈旧锁回收之后应该写得进去'));

  // 拿一个刚退出的真实 pid。
  // 注意不能用 spawnSync：同步版返回的 result 里**没有 pid 字段**（只有
  // stdout/stderr/status），拿到的 pid 是 undefined → 0，于是锁文件变成
  // 「pid=0」这种特殊值，测的就不是「死进程」而是「无效 pid 退化路径」了。
  // 必须用异步 spawn，在 child.pid 一出现就记下来，再等它退出。
  const deadPid = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const pid = child.pid;
    child.on('exit', () => setTimeout(() => resolve(pid), 50));
    child.on('error', reject);
  });
  check('④ 拿到了一个已退出子进程的 pid', Number.isInteger(deadPid) && deadPid > 0, `pid=${deadPid}`);

  const lockPath = `${file}.lock`;
  // ts 是**现在**，故意不超过 STALE_MS —— 这样只能靠 pid 存活探测回收
  fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, ts: Date.now() }), 'utf8');

  const started = Date.now();
  let threw = null;
  try {
    store.save();
  } catch (error) {
    threw = error;
  }
  const elapsed = Date.now() - started;
  const n = countItems(file);
  check('④ 死进程持的陈旧锁被回收，写入成功', threw === null, threw ? String(threw.message).slice(0, 60) : '');
  check('④ 在 1 个超时周期内完成（不是等 10s 也不是永久抛错）', elapsed < 5000, `${elapsed}ms`);
  check('④ 数据确实落盘', n >= 1, `${n} 条`);
  check('④ 目录里不残留 .lock', !fs.existsSync(lockPath), fs.existsSync(lockPath) ? '还有 .lock' : '已清');
}

// ── 附加：ts 超 10s 的陈旧锁（纯时间兜底，不依赖 pid 探测）──────────────────
{
  const file = freshFile('stale-time');
  const store = new MemoryStore(file);
  store.load();
  store.bucket('shared').push(makeItem('lm-stale-time-0', '时间超时的陈旧锁也要能回收'));

  const lockPath = `${file}.lock`;
  // pid 用本进程（活着），但 ts 是 20 秒前 → 只能靠时间判断回收
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() - 20000 }), 'utf8');

  let threw = null;
  try {
    store.save();
  } catch (error) {
    threw = error;
  }
  check('附加：ts 超 10s 的陈旧锁被时间兜底回收', threw === null, threw ? String(threw.message).slice(0, 60) : '');
  check('附加：目录里不残留 .lock', !fs.existsSync(lockPath));
}

// ── 附加：EPERM 不能当死亡证据（跨用户/系统进程的活锁）─────────────────────
//
// 按 plan-v2 第 3 条：EPERM 表示「进程存在但没权限」，当成锁有效、继续等。
// pid 4 在 Windows 上是系统进程，探测必抛 EPERM。
{
  const file = freshFile('eperm');
  const store = new MemoryStore(file);
  store.load();
  store.bucket('shared').push(makeItem('lm-eperm-0', '活锁不该被误删'));

  const lockPath = `${file}.lock`;
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 4, ts: Date.now() }), 'utf8');

  let threw = null;
  try {
    store.save();
  } catch (error) {
    threw = error;
  }
  // 关键：不能把 pid 4 的锁删掉当成功 —— 必须等到超时抛错（当成活锁）
  check('附加：EPERM（pid 4 系统进程）不被当死亡证据', threw instanceof Error, threw ? '抛错了（当成活锁，正确）' : '静默成功了（把活锁误删了）');
  fs.rmSync(lockPath, { force: true });
}

// ── 附加：pid 0 / 负数必须跳过存活探测（Windows 上语义特殊）────────────────
//
// captain 实测：pid 0 不抛、pid -1 抛 ESRCH。若锁文件被改成 pid=0，
// 绝不能当成「活着」而永久等下去 —— 应退化为纯时间戳判断。
{
  const file = freshFile('pid0');
  const store = new MemoryStore(file);
  store.load();
  store.bucket('shared').push(makeItem('lm-pid0-0', 'pid=0 的锁文件不该永久卡住'));

  const lockPath = `${file}.lock`;
  // pid 0 + ts 很旧 → 时间兜底应该回收
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 0, ts: Date.now() - 20000 }), 'utf8');
  let threw = null;
  try {
    store.save();
  } catch (error) {
    threw = error;
  }
  check('附加：pid=0 且 ts 超时 → 时间兜底回收', threw === null, threw ? String(threw.message).slice(0, 60) : '');
}

// ── 附加：锁内合并必须能表达「删除」（P0-2a 第 5 条，防删掉的记忆复活）──────
//
// 【这段曾被判为假绿，改法记在这里】
// 下面变体 A 在删除**之前**先 `store.save()` 了一次，那一次就把 knownIds 建起来了，
// 于是删除断言恰好绕过了 bug —— **真实路径没有那次前置 save**。
// 真实形态是：进程刚启动 → load → 用户删掉一条 → 保存。
// 若 load 之后、第一次 save 之前就删除，而 knownIds 没被建立，
// 则 deletedIdsSinceSync() 的 `size === 0` 早退恒触发 → save() 传给锁的 deletedIds 是空集
// → 锁内 union 合并把磁盘上的条目**原样合并回来** → 删除被静默撤销。
//
// 所以现在**两个变体都要有**：
//   A（有前置 save）：确认「已经同步过一次」时删除正常 —— 保留原断言，不删。
//   B（无前置 save）：确认「load 之后首次写盘前删除」也正常 —— 这才是真实路径。
{
  const file = freshFile('delete');
  const store = new MemoryStore(file);
  store.load();
  store.bucket('shared').push(makeItem('lm-keep', '要留下的'));
  store.bucket('shared').push(makeItem('lm-drop', '要删掉的'));
  store.save();
  check('附加：两条先落盘', countItems(file) === 2, `${countItems(file)} 条`);

  // 从内存里删掉一条，再 save
  store.state.buckets.shared = store.state.buckets.shared.filter((m) => m.id !== 'lm-drop');
  store.save();
  const reread = JSON.parse(fs.readFileSync(file, 'utf8'));
  const stillThere = (reread.buckets?.shared || []).some((m) => m.id === 'lm-drop');
  check('附加 A（有前置 save）：删除后重读不复活（forget delete 不被 union 合并吃掉）', stillThere === false, stillThere ? '又回来了' : '确实删掉了');
}

// ── 附加 B：真实路径 —— load 之后、**第一次 save 之前**就删除 ─────────────
//
// 这是上面那个变体 A 绕过的场景。盘上先有数据（真实库的形态），
// 然后 load，**不 save**，直接删，再 save。
{
  const file = freshFile('delete-firstsave');

  // ① 先落盘 3 条 —— 复刻「盘上已有数据」这个真实前提
  {
    const seed = new MemoryStore(file);
    seed.load();
    seed.bucket('shared').push(makeItem('lm-a', '条目甲'));
    seed.bucket('shared').push(makeItem('lm-b', '条目乙'));
    seed.bucket('shared').push(makeItem('lm-gone', '我要删掉它'));
    seed.save();
  }
  check('附加 B 前提：盘上已有 3 条（否则没有可复活的旧条目，本变体会假绿）', countItems(file) === 3, `${countItems(file)} 条`);

  // ② 新实例 load —— 这是插件启动的真实形态，**此后不 save，直接删**
  const store2 = new MemoryStore(file);
  store2.load();
  const knownSize = store2.knownIds ? store2.knownIds.size : -1;
  check(
    '附加 B：load 之后 knownIds 非空（否则 deletedIds 机制失效）',
    knownSize > 0,
    `knownIds.size=${knownSize}（期望 3；为 0 则下面的删除必被撤销）`
  );

  // ③ 用户删掉一条（**没有任何前置 save**）
  store2.state.buckets.shared = store2.state.buckets.shared.filter((m) => m.id !== 'lm-gone');
  check('附加 B：内存里确实只剩 2 条', store2.bucket('shared').length === 2, `${store2.bucket('shared').length} 条`);

  // ④ 保存并重读
  store2.save();
  const reread2 = JSON.parse(fs.readFileSync(file, 'utf8'));
  const back = (reread2.buckets?.shared || []).some((m) => m.id === 'lm-gone');
  check(
    '附加 B（无前置 save）：删除后重读不复活（真实路径：load→删→首次 save）',
    back === false,
    back ? '**又回来了 —— 用户的删除被静默撤销**' : '确实删掉了'
  );
  check('附加 B：删除后盘上确实 2 条', (reread2.buckets?.shared || []).length === 2, `${(reread2.buckets?.shared || []).length} 条`);
}

console.log(out.join('\n'));
console.log(`\n${failed === 0 ? 'P0-2 单进程探针：全部通过' : `P0-2 单进程探针：${failed} 项失败`}（${out.length} 项）`);
if (failed > 0) process.exitCode = 1;

// 插件自己的记忆仓库：一个 JSON 文件，$DSH_HOME 优先。
//
// 为什么不自带数据库：这套数据是「几十到几千条小文本」，JSON 全量读写的成本远低于
// 引入 sqlite 带来的原生模块编译问题（DSH 是 Electron，原生模块要按 ABI 重新编译，
// 插件一升级就崩，那是开源项目最容易被 issue 淹没的地方）。真到了上万条再换存储，
// 换的时候只要保持 normalizeStore 的入参形状，上层不用动。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  activeList,
  bucketOf,
  normalizeStore,
  readLongMemoryStoreResult,
  recallableList
} from './core/long-memory.js';
import { withStoreLock } from './core/store-lock.js';

/** 最多留几份损坏备份。读失败持续存在时（比如权限问题一直没修好），
 *  每次 save 尝试都存一份会让目录堆满 —— 只留最近几份，够排查就行。 */
const MAX_CORRUPT_BACKUPS = 3;

/**
 * 记忆文件的默认位置。$DSH_HOME 是 DSH 自己声明的数据根目录，用户装到别的盘、
 * 或者用环境变量重定向数据目录时，这里会跟着走 —— 写死 homedir 会让「换机器/换盘」
 * 之后找不到自己记过的东西，而记忆系统最不能出的问题就是「看着有、其实没了」。
 */
export function defaultStoreFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'memory-lens', 'memory.json');
}

/**
 * 读一个配置项的裸值。
 *
 * DSH 的 `.extra('volatile', true)` 字段会被包成访问器对象
 * （`{get, Symbol(cosmokit.volatile.write)}`），直接 `String(obj)` 会得到
 * "[object Object]" —— 用户配的路径会被当成相对路径拼到 $DSH_HOME 下面，
 * 于是记忆写进一个谁也没想到的地方。所以取值必须统一走这里。
 */
function setting(config, key, fallback) {
  const raw = config?.[key];
  if (raw !== null && typeof raw === 'object' && typeof raw.get === 'function') {
    try {
      const value = raw.get();
      return value === undefined ? fallback : value;
    } catch {
      return fallback;
    }
  }
  return raw === undefined ? fallback : raw;
}

/** 解析配置里的 storeFile：空值走默认路径，相对路径按 $DSH_HOME 展开。 */
export function resolveStoreFile(config) {
  const raw = String(setting(config, 'storeFile', '') ?? '').trim();
  if (raw === '') return defaultStoreFile();
  if (path.isAbsolute(raw)) return raw;
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, raw);
}

/**
 * 带外部改动感知的仓库。
 *
 * 为什么要感知磁盘 mtime：这个文件会被三拨人写 —— 插件的工具、设置页的
 * 「导入/删除」按钮、以及用户手工编辑（这是纯文本 JSON，一定会有人直接改）。
 * 如果读路径永远信任内存里的副本，用户改完文件刷新页面看到的是旧数据，
 * 而文件里明明已经是新的。**「看见的」和「存在的」分家，是记忆系统最不能出的问题**，
 * 比慢一点严重得多，所以这里宁可每次 stat 一下。
 */
export class MemoryStore {
  constructor(file) {
    this.file = file;
    this.state = null;
    this.mtimeMs = 0;
    this.size = -1;
    // 读失败时置位。置位期间 save() 必须拒绝写 —— 这是「一次读失败永久清库」
    // 那条路径的唯一拦截点。见下面 save() 的注释。
    this.readOnly = false;
    // 最近一次读失败的原因，供面板显示红条用。
    this.lastError = null;
    // 同上，语义更明确的别名：面板/日志要报的是「上次读失败了」这件事。
    // 两个名字同时保留是因为 lastError 也被写盘路径（backup-failed 等）复用，
    // 而读失败的判定必须只看读路径。
    this.loadError = null;
    // 上一次备份的损坏文件内容指纹，避免同一次故障反复备份。
    this.lastCorruptFingerprint = null;
    // 上一次「与磁盘一致」时库里有哪些 id。save() 用它算本次删掉了哪些条目，
    // 否则锁内 union 合并会把刚删的条目从磁盘上复活回来。
    // 这样 9 处 save() 调用点一行都不用改。
    this.knownIds = new Set();
  }

  /**
   * 记下「当前与磁盘一致」时库里有哪些 id（读盘/写盘成功后调用）。
   *
   * 【为什么必须传参，不能读 this.state —— 这是 t15 修的 blocker】
   * 原实现是无参的，内部读 `this.state?.buckets`。它被 `reloadFromDisk()` 的 ok
   * 分支调用，而 `load()` 写的是 `this.state = this.reloadFromDisk(...)` ——
   * **赋值发生在返回之后**。于是被调用的那一刻，`this.state` 还是**调用前的旧值**：
   *   · 首次 `load()`：`this.state` 是 `null` → 读到空 → `knownIds` 恒为空集
   *   · mtime 变化时重读：读到的是**上一次**的旧 state，同样不是新的
   *
   * `knownIds` 一旦恒空，`deletedIdsSinceSync()` 的 `size === 0` 早退就恒触发 →
   * `save()` 传给锁的 `deletedIds` 恒为空集 → 锁内 union 合并把磁盘上的条目
   * **原样合并回来** → **用户删掉的记忆自己回来了**，而且没有报错、没有日志。
   *
   * 所以显式传入「刚读到的那个 store」，让这个函数不依赖 `this.state` 的赋值时机。
   * 不传参时（`save()` 那条路径，此刻 `this.state` 已经是最新）回落到 `this.state`，
   * 保持既有调用点可用。
   *
   * @param {object} [state] 要记 id 的库对象；省略时用 `this.state`
   */
  rememberIds(state = this.state) {
    const ids = new Set();
    for (const list of Object.values(state?.buckets || {})) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (item && item.id) ids.add(item.id);
      }
    }
    this.knownIds = ids;
  }

  /** 本次相对上次同步点被删掉的 id 集合。 */
  deletedIdsSinceSync() {
    const deleted = new Set();
    if (this.knownIds.size === 0) return deleted;
    const current = new Set();
    for (const list of Object.values(this.state?.buckets || {})) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (item && item.id) current.add(item.id);
      }
    }
    for (const id of this.knownIds) {
      if (!current.has(id)) deleted.add(id);
    }
    return deleted;
  }

  /**
   * 读。磁盘比内存新就重读，返回的是同一个内存对象（调用方可直接改）。
   *
   * 注意 `store.buckets[key]` 是**数组本身**（见 core/long-memory.js 的
   * normalizeStore），不是 `{ items: [...] }`。写 `.items` 会静默拿到
   * undefined，然后整条链路读到「零条记忆」—— 这种错不报异常，最难查。
   */
  load() {
    if (this.state) {
      let diskMtime = 0;
      let diskSize = -1;
      try {
        const st = fs.statSync(this.file);
        diskMtime = st.mtimeMs;
        diskSize = st.size;
      } catch {
        // 文件被删了或正在原子替换的瞬间读不到 —— 用内存里的，不要抛。
        return this.state;
      }
      // 这里曾经写成 `diskMtime - this.mtimeMs > 1`（1ms 容差），理由是「不同文件系统
      // 时间精度不一样」。那个容差是错的：别人在自己上一次保存后 1ms 内写入（测试、
      // 脚本、另一个进程紧接着写），改动会被判成「没变化」而静默忽略 —— 于是
      // 「文件里已经有这条，界面上没有」。容差防的是浮点噪声，不是真实改动，所以
      // 用严格比较，另外把 size 也算进来（极少数文件系统 mtime 精度只到秒）。
      if (diskMtime !== this.mtimeMs || diskSize !== this.size) {
        // 【必须把返回值赋回 this.state —— 这是曾经引入过的一个回归】
        // reloadFromDisk 返回的是**新的** store 对象（normalizeStore 每次建新对象），
        // 只调用不接收，this.state 就永远停留在最初读到的那个旧对象上：
        // 磁盘上的外部改动再也进不来。表现不是崩溃，而是「文件里明明有这条，
        // 界面上/注入里没有」—— host.test.mjs 的话题层召回 60 天前旧记忆那条
        // 就是这么挂的（另一个 MemoryStore 实例写进去的条目，本实例看不见）。
        this.state = this.reloadFromDisk(diskMtime, diskSize);
      }
      return this.state;
    }
    this.state = this.reloadFromDisk(null, null);
    return this.state;
  }

  /**
   * 真正读盘并更新缓存。失败时**保留旧状态并置 readOnly**，而不是给一个空库。
   *
   * 这是整个数据安全链条的关键：原来 `readLongMemoryStore` 内部 catch 后返回
   * blank()，外面这层 try/catch 就永远不触发 —— 「读失败」和「文件真空」
   * 在代码里完全无法区分，于是 save() 把空库写回去，原文件永久消失。
   */
  reloadFromDisk(diskMtime, diskSize) {
    const result = readLongMemoryStoreResult(this.file);
    if (result.ok) {
      this.readOnly = false;
      this.lastError = null;
      this.loadError = null;
      this.lastCorruptFingerprint = null;
      if (diskMtime !== null) {
        this.mtimeMs = diskMtime;
        this.size = diskSize;
      } else {
        try {
          const st = fs.statSync(this.file);
          this.mtimeMs = st.mtimeMs;
          this.size = st.size;
        } catch {
          this.mtimeMs = 0;
          this.size = -1;
        }
      }
      // 【必须显式传 result.store —— 见 rememberIds 的 docblock】
      // 这里是 `load()` 的 `this.state = this.reloadFromDisk(...)` 内部，
      // 赋值还没发生，`this.state` 仍是调用前的旧值（首次是 null）。
      // 读 `this.state` 会让 knownIds 恒空 → 一切删除被锁内合并撤销。
      this.rememberIds(result.store);
      return result.store;
    }

    // 读失败：保留内存里的旧状态（如果有），置 readOnly，让 save() 拒绝写。
    this.readOnly = true;
    this.lastError = result.reason;
    this.loadError = result.reason;
    // 【为什么备份必须在这里，而不是在 save() 里】
    // 原方案把备份放在 save() 的「写盘前校验」那一步，但 readOnly 守卫在它之前
    // 就抛错了 —— 一旦置位，save() 永远走不到备份那一步，验收③（存在
    // memory.json.corrupt-*）就永远不通过。两个保护互相抵消。
    // 而且语义上前移才是对的：这里备份的是「刚刚读到但解析不了的那份磁盘文件」，
    // 而不是「准备覆盖时才想起来备份」（那时文件可能已经被别的进程改过，
    // 备份下来的已经不是出问题的那一份了）。
    this.backupIfCorrupt();
    // 注意：这里**不要**更新 mtimeMs/size，否则下次 load() 会以为「已经是最新」而
    // 不再重试读盘 —— 用户修好文件后仍然看不到自己的记忆。
    this.mtimeMs = 0;
    this.size = -1;
    // 返回旧状态；一次都没读成功过（首次 load 就坏）时给一个**内存里的空库**。
    // 为什么不能返回 null：bucket() 会把 null 传给 bucketOf，直接 TypeError，
    // 于是「读失败」从一个可报告的故障变成整条链路崩溃 —— 面板打不开、连
    // 报错都看不到。空库 + readOnly 的组合是安全的：save() 守卫在前，写不出去。
    //
    // 而且这个空库要**存回 this.state**，不能每次新建：load() 在 state 已存在时
    // 会走「stat 比较」分支，每次都会重新尝试读盘 —— 用户修好文件后能自动恢复。
    // 若每次返回一个新的游离对象，bucket() 往里 push 的条目会挂在一个没人持有
    // 的数组上，表现是「改了但界面不变」，又是一类静默失败。
    if (!this.state) this.state = normalizeStore({});
    return this.state;
  }

  /**
   * 写。
   *
   * 两道保护，任何一道都不能省：
   *   1. readOnly 守卫：读过一次失败就拒绝写。这是「一次截断永久清库」的拦截点。
   *   2. 锁 + 锁内重读合并：防止并发/多入口互相覆盖（见 core/store-lock.js）。
   *
   * 【备份为什么在两个地方，而不是一个】
   * 修正 I2 把备份前移到读失败那一刻（见 reloadFromDisk），但**不能**因此把
   * save() 里的备份整个删掉 —— 两个时机覆盖的是两个不同的故障场景：
   *   · 读失败那一刻备份 → 覆盖「load() 就读不出来」，这条路径上 readOnly 会置位，
   *     save() 在守卫处直接抛错，**永远走不到**下面的备份代码。不在这里补一份，
   *     验收③（存在 memory.json.corrupt-*）就永远不通过。这是 I2 修的那个互斥。
   *   · save() 里备份 → 覆盖「load() 成功过，但之后磁盘被别的进程/用户改坏了」。
   *     此时 readOnly 是 false（上次读是好的），save() 会走到这里；如果没有这一步，
   *     withStoreLock 的锁内重读会拿到 parse-failed，然后用内存版重建 —— 那份
   *     坏文件就被**无备份地覆盖**了，等于把 P0-1 要防的事从这个侧门放回来。
   * 两处互补，少任何一处都留一个洞。
   */
  save() {
    // readOnly 守卫必须放在最前面，**不能**放在 `if (!this.state) return` 之后。
    // 顺序错了这条保护就是死的：首次 load() 就读失败时 state 是 null，
    // save() 会静默 return —— 既不抛错也不写盘，调用方以为写成功了，
    // 而验收②（「随后调 save() 抛错」）永远不通过。
    if (this.readOnly) {
      throw new Error(
        `memory-lens: 记忆文件读取失败（${this.lastError ?? 'unknown'}），已拒绝写入以免覆盖原文件。` +
          `请检查 ${this.file} 的权限或格式（常见原因：JSON 被截断、编码带 BOM、被其他程序独占）。`
      );
    }
    if (!this.state) return;

    // 走到这里说明上次读是成功的（readOnly 为 false），但磁盘可能已经被别人改坏。
    // 指纹去重保证「同一份坏文件」不会重复备份，所以这里每次调用都做是安全的。
    this.backupIfCorrupt();

    // 为什么是同步写、不用 promise 链排队：写盘本身是同步的
    // （writeFileSync + renameSync），而 JS 是单线程 —— 一段同步代码不可能被
    // 另一个 async 任务打断。所以「进程内两个入口同时写」真正危险的窗口不是
    // save() 本身，而是 load() 之后、save() 之前跨过的那次 await。
    // 那个窗口由 withStoreLock 的「锁内重读 + 按 id 合并」覆盖，不靠排队。
    //
    // 反过来，把 save() 改成异步链会破坏一个既有契约：9 处调用点都假定
    // save() 返回时文件已经落地（`store.save()` 后面紧跟着读文件、或者
    // 同一个 tick 里再 load()）。改成微任务会把这类调用静默变成「读到旧数据」。
    const deletedIds = this.deletedIdsSinceSync();
    const { store, recoveredFromCorrupt } = withStoreLock(this.file, this.state, { deletedIds });
    this.state = store;
    this.rememberIds();
    if (recoveredFromCorrupt) {
      // 磁盘上那份坏了，我们用它备份过、又用内存版重建了。
      //
      // 【注释与实现必须一致 —— reviewer 的 F9 抓到原来这里写的是「保持 readOnly 置位」，
      // 而实现只设了 lastError，readOnly 一直是 false。】
      // 到底该不该置 readOnly？**不该**。readOnly 的语义是「这次写入**没成功**」
      // （见 load() 失败路径与 save() 的抛错分支），它会让后续所有 save() 直接抛错。
      // 而这里写入**是成功的** —— 坏文件已备份、新文件已重建，用户的数据保住了。
      // 把 readOnly 置位等于因为一次可恢复的故障，把插件永久钉成只读。
      //
      // 所以只设 lastError 留痕：让面板能显示「上次从损坏中恢复」这件事，
      // 但不阻断写入。两件事分开表达，才是对的。
      this.lastError = 'recovered-from-corrupt';
    }
    try {
      const st = fs.statSync(this.file);
      this.mtimeMs = st.mtimeMs;
      this.size = st.size;
    } catch {
      this.mtimeMs = 0;
      this.size = -1;
    }
  }

  /**
   * 如果磁盘上的文件存在但解析不出来，先复制一份带时间戳的备份。
   *
   * 为什么需要：save() 的锁内合并遇到 parse-failed 时会用内存版重建文件。
   * 如果那份坏文件其实还包含可抢救的数据（比如只坏了一个字符），
   * 不备份就等于把最后的挽回机会也覆盖掉。
   */
  backupIfCorrupt() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return; // 文件不存在，没有可备份的东西
    }
    if (!raw.trim()) return; // 空文件不需要备份
    const result = readLongMemoryStoreResult(this.file);
    if (result.ok) {
      this.lastCorruptFingerprint = null;
      return;
    }
    // 同一次故障不重复备份：内容没变就不再生成新文件
    const fingerprint = `${raw.length}:${raw.slice(0, 32)}:${raw.slice(-32)}`;
    if (fingerprint === this.lastCorruptFingerprint) return;
    this.lastCorruptFingerprint = fingerprint;

    try {
      fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      this.pruneCorruptBackups();
    } catch {
      // 备份失败不该阻塞写入（否则用户彻底用不了），但要让调用方知道
      this.lastError = 'backup-failed';
    }
  }

  /** 只留最近 MAX_CORRUPT_BACKUPS 份，旧的删掉。 */
  pruneCorruptBackups() {
    const dir = path.dirname(this.file);
    const prefix = `${path.basename(this.file)}.corrupt-`;
    let names;
    try {
      names = fs.readdirSync(dir).filter((n) => n.startsWith(prefix));
    } catch {
      return;
    }
    if (names.length <= MAX_CORRUPT_BACKUPS) return;
    // 文件名里的时间戳是定长的，字典序即时间序
    names.sort();
    for (const name of names.slice(0, names.length - MAX_CORRUPT_BACKUPS)) {
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch {
        // 删不掉就算了，下次再试
      }
    }
  }

  /**
   * 取某个 bucket 的条目数组（默认 shared）。返回值就是数组本身，可直接 push。
   *
   * 必须用 bucketOf 而不是 `store.buckets[key] ?? []`：后者在 key 不存在时返回一个
   * **游离的新数组**，往里 push 的条目不会挂到 store 上，save() 时自然也不在文件里。
   * 表现是「写成功了、文件里没有」，而且不报错 —— 空库首次写入必踩，极难查。
   */
  bucket(key = 'shared') {
    return bucketOf(this.load(), key);
  }

  /** 当前生效的条目。 */
  active(key = 'shared') {
    return activeList(this.bucket(key));
  }

  /**
   * 当前「生效 + 已结案」的条目 —— 注入、体检、UI 默认列表都看这个。
   * 结案（resolved）的条目也在这里：结案 ≠ 删除，它仍然值得被想起
   * （「上次那个面试过了」正是活人记忆里最自然的一句），只是不再当待办追问。
   */
  recallable(key = 'shared') {
    return recallableList(this.bucket(key));
  }

  /** 所有条目，含已取代/已归档 —— UI 的「全部」视图和体检要看到它们。 */
  all(key = 'shared') {
    return this.bucket(key);
  }
}

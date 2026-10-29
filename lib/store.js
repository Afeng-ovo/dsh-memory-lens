// 插件自己的记忆仓库：一个 JSON 文件，$DSH_HOME 优先。
//
// 为什么不自带数据库：这套数据是「几十到几千条小文本」，JSON 全量读写的成本远低于
// 引入 sqlite 带来的原生模块编译问题（DSH 是 Electron，原生模块要按 ABI 重新编译，
// 插件一升级就崩，那是开源项目最容易被 issue 淹没的地方）。真到了上万条再换存储，
// 换的时候只要保持 normalizeStore 的入参形状，上层不用动。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activeList, bucketOf, readLongMemoryStore, recallableList, writeLongMemoryStore } from './core/long-memory.js';

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
        try {
          this.state = readLongMemoryStore(this.file);
          this.mtimeMs = diskMtime;
          this.size = diskSize;
        } catch {
          return this.state;
        }
      }
      return this.state;
    }
    this.state = readLongMemoryStore(this.file);
    try {
      const st = fs.statSync(this.file);
      this.mtimeMs = st.mtimeMs;
      this.size = st.size;
    } catch {
      this.mtimeMs = 0;
      this.size = -1;
    }
    return this.state;
  }

  /** 写。写完立刻同步 mtime，否则下一次 load() 会把自己刚写的内容当成「外部改动」重读一遍。 */
  save() {
    if (!this.state) return;
    writeLongMemoryStore(this.file, this.state);
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

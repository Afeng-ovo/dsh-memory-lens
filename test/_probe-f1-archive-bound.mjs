// F1 守卫：归档区必须有界（reviewer 的 high）。
//
// 原来 enforceCap 只有一个调用点 —— upsertLongMemory 的 created 分支。
// organizeLongMemories 的 decay 归档完全不经过它，于是归档区无界：
// reviewer 实测 300 条弱 event 跑 100 轮 organize → archived=300 > MAX_ARCHIVED=200。
//
// 这与「容量仍然有界」的承诺、以及 tools.js 按「归档区有上限」设计的 purged 契约
// 直接矛盾。本探针锁死这个不变式：**任何**归档路径之后，归档区都不许超上限。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  organizeLongMemories,
  pruneArchived,
  upsertLongMemory
} from '../lib/core/long-memory.js';
import { MemoryStore } from '../lib/store.js';

// MAX_ARCHIVED 是内核常数、故意没有 export —— 为了测试而把它漏进公共契约不值得。
// 这里复制字面量，并单独断言「实现里用的确实是这个值」（见下面第 0 项），
// 免得实现改了上限而探针还在用旧值、探针假绿。
const MAX_ARCHIVED = 200;

const out = [];
const check = (name, cond, extra = '') => {
  out.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

// ── 0. 先确认「探针里写的上限」和「实现里用的上限」是同一个数 ────────────────
// 否则实现改了上限、探针还按旧值断言，就会得到一条假绿。
{
  const src = fs.readFileSync(
    new URL('../lib/core/long-memory.js', import.meta.url),
    'utf8'
  );
  const m = src.match(/const MAX_ARCHIVED = (\d+);/);
  check('0 实现里 MAX_ARCHIVED 与探针一致', m && Number(m[1]) === MAX_ARCHIVED,
    m ? `实现 ${m[1]}，探针 ${MAX_ARCHIVED}` : '没找到定义');
}

// ── 1. reviewer 的原场景：300 条弱 event 跑 100 轮 organize ──────────────────
//
// 注意：maxArchivePerRun 默认 3，100 轮最多只能归档 300 条 —— 恰好够、也恰好
// 说明「为什么原来无界」。但要**真的触发裁剪**（archived > 200），必须让归档量
// 超过上限，所以这里把 maxArchivePerRun 提到 50：5 轮就到 250 条 > 200。
// 我第一版用默认 3 跑 100 轮，结果归档量从未超过 200 → 裁剪一次也没触发，
// 于是「裁剪确实发生了」这条断言失败 —— 不是实现有问题，是探针根本没压到那个点。
{
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const list = [];
  for (let i = 0; i < 300; i += 1) {
    list.push({
      id: `weak-${i}`,
      kind: 'event',
      text: `很久以前的一件小事 ${i}`,
      status: 'active',
      weight: 1,
      // 300 天前 + 从没被用过 → 强度远低于 0.6
      createdAt: now - 300 * DAY,
      lastUsedAt: 0,
      updatedAt: now - 300 * DAY,
      tags: []
    });
  }
  const before = list.filter((m) => m.status === 'archived').length;
  let totalArchived = 0;
  let totalPurged = 0;
  for (let round = 0; round < 100; round += 1) {
    // consolidate:false —— 必须关掉。300 条文本几乎相同（「很久以前的一件小事 N」），
    // 默认的 consolidate 会把它们并成十几条（keep.lastUsedAt 被设成 now → 强度变 1），
    // 归档量就永远到不了上限。实测开着的版本第一轮归档 50 条、之后再也不归档，
    // 剩 18 条 active 强度全是 1.000。这个场景要压的是**归档裁剪**，不是合并。
    const r = organizeLongMemories(list, { now, maxArchivePerRun: 50, consolidate: false });
    totalArchived += r.archived;
    totalPurged += r.purged.length;
  }
  const after = list.filter((m) => m.status === 'archived').length;
  check('1 确实归档了条目（防空集平凡通过）', totalArchived > 0, `共归档 ${totalArchived} 条`);
  check('1 归档量确实超过了上限（否则这条场景压不到裁剪）', totalArchived > MAX_ARCHIVED,
    `共归档 ${totalArchived} 条 > 上限 ${MAX_ARCHIVED}`);
  check('1 归档区**没有**超上限', after <= MAX_ARCHIVED, `archived=${after}，上限 ${MAX_ARCHIVED}`);
  check('1 裁剪确实发生了（说明真删了最老的）', totalPurged > 0, `共真删 ${totalPurged} 条`);
  check('1 organize 返回值带 purged 字段', Array.isArray(organizeLongMemories([], { now }).purged),
    '空列表也返回数组，不返回 undefined');
  check('1 归档 + 裁剪后总条目数守恒',
    list.length + totalPurged === 300, `${list.length} 条留下 + ${totalPurged} 条被删 = 300`);
  out.push(`       （起始 archived=${before}，最终 archived=${after}，真删 ${totalPurged}）`);
}

// ── 2. pruneArchived 独立可用（不依赖 enforceCap）───────────────────────────
{
  const list = [];
  for (let i = 0; i < 250; i += 1) {
    list.push({ id: `a-${i}`, text: `归档 ${i}`, status: 'archived', archivedAt: 1000 + i, archiveReason: 'decay' });
  }
  const purged = pruneArchived(list, 200);
  check('2 超限时删掉了 50 条', purged.length === 50, `${purged.length} 条`);
  check('2 剩下的恰好是上限', list.filter((m) => m.status === 'archived').length === 200,
    `${list.filter((m) => m.status === 'archived').length} 条`);
  check('2 删的是**最老的**', purged.every((p) => Number(p.id.split('-')[1]) < 50),
    `删掉的 id 范围 ${purged[0]?.id} ~ ${purged[purged.length - 1]?.id}`);
  check('2 purged 带完整信息（调用方才能记日志）',
    purged.every((p) => p.id && typeof p.text === 'string' && 'archiveReason' in p && 'archivedAt' in p));
  check('2 未超限时不删', pruneArchived(list, 200).length === 0);
}

// ── 3. 不误伤：active/resolved/superseded 不该被归档裁剪删掉 ────────────────
{
  const list = [];
  for (let i = 0; i < 210; i += 1) {
    list.push({ id: `arc-${i}`, text: `归档 ${i}`, status: 'archived', archivedAt: 1000 + i });
  }
  list.push({ id: 'keep-active', text: '正在用的', status: 'active' });
  list.push({ id: 'keep-resolved', text: '已结案', status: 'resolved' });
  list.push({ id: 'keep-superseded', text: '被取代', status: 'superseded' });
  const purged = pruneArchived(list, 200);
  check('3 只删归档区的', purged.every((p) => p.id.startsWith('arc-')), `${purged.length} 条`);
  check('3 active 没被误删', list.some((m) => m.id === 'keep-active'));
  check('3 resolved 没被误删', list.some((m) => m.id === 'keep-resolved'));
  check('3 superseded 没被误删', list.some((m) => m.id === 'keep-superseded'));
}

// ── 4. upsert 路径仍然正常（enforceCap 重构后行为不变）──────────────────────
{
  const list = [];
  const r = upsertLongMemory(list, { text: '阿风喜欢喝无糖可乐', kind: 'pref' }, { maxEntries: 3 });
  check('4 upsert 正常返回', r.ok === true, JSON.stringify(r.action ?? r.reason));
  check('4 未超容量时不归档', r.archivedByCap === 0, String(r.archivedByCap));
  check('4 未超容量时 purged 是空数组', Array.isArray(r.purged) && r.purged.length === 0);
}

// ── 5. 真实读盘链路：organize 之后落盘读回，归档区仍有界 ────────────────────
//
// 【这段曾被判为假绿，改法记在这里】
// 原版是 `new MemoryStore(file)` 指向一个**空文件**，load 之后直接往内存 push 300 条。
// 盘上从来没有过数据 → 锁内 union 合并**没有旧条目可复活** → 落盘自然正确。
// 但真实形态是「盘上已有数据，用户 load 进来，然后整理/删除」。
// 只差这一个前提，结果就完全不同（见下面 B 段对照：盘上已有 300 条时落盘仍是 300）。
//
// 根因当时在 store.js 的 rememberIds()：它在 reloadFromDisk 的 ok 分支被调用，
// 而 load() 是 `this.state = this.reloadFromDisk(...)`，**赋值发生在返回之后**。
// 于是首次 load 时 this.state 还是 null → knownIds 恒空 → deletedIdsSinceSync() 早退
// → save() 传给锁的 deletedIds 是空集 → union 合并把磁盘上的条目原样合并回来
// → **用户删掉的记忆自己回来了**，无报错、无日志。
//
// 所以这里必须**先落盘 300 条，再 load**，并且显式断言「load 之后 knownIds 非空」——
// 那正是原探针从来没有观测过的值。
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-disk-'));
  const file = path.join(dir, 'memory.json');
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();

  // 【关键改动】先落盘 300 条 —— 复刻「盘上已有数据」这个真实前提
  {
    const seed = new MemoryStore(file);
    seed.load();
    const seedList = seed.bucket('shared');
    for (let i = 0; i < 300; i += 1) {
      seedList.push({
        id: `w-${i}`, kind: 'event', text: `旧事 ${i}`, status: 'active', weight: 1,
        createdAt: now - 300 * DAY, lastUsedAt: 0, updatedAt: now - 300 * DAY, tags: []
      });
    }
    seed.save();
  }

  // 现在才 load —— 这是真实形态：盘上有 300 条
  const store = new MemoryStore(file);
  store.load();
  const diskBefore = new MemoryStore(file);
  diskBefore.load();
  check(
    '5 前提：盘上确实已有 300 条（否则本段又退回空文件假绿）',
    diskBefore.all('shared').length === 300,
    `盘上 ${diskBefore.all('shared').length} 条`
  );

  // 【新断言】load 之后 knownIds 必须非空 —— 原探针从未观测过这个值
  const knownSize = store.knownIds ? store.knownIds.size : -1;
  check(
    '5 load 之后 knownIds 非空（deletedIds 机制可用的前提）',
    knownSize > 0,
    `knownIds.size=${knownSize}（期望 300；若为 0 则删除会被 union 合并撤销）`
  );

  const list = store.bucket('shared');
  let purgedTotal = 0;
  let archivedTotal = 0;
  for (let round = 0; round < 100; round += 1) {
    const r = organizeLongMemories(list, { now, maxArchivePerRun: 50 });
    purgedTotal += r.purged.length;
    archivedTotal += r.archived;
  }
  store.save();
  const reread = new MemoryStore(file);
  reread.load();
  const total = reread.all('shared').length;
  const arch = reread.all('shared').filter((m) => m.status === 'archived');
  check('5 落盘读回后归档区仍**有界**', arch.length <= MAX_ARCHIVED, `archived=${arch.length}，上限 ${MAX_ARCHIVED}`);
  check('5 归档量超过上限过（否则压不到裁剪）', archivedTotal > MAX_ARCHIVED, `共归档 ${archivedTotal} 条`);
  check('5 落盘读回后裁剪确实生效过', purgedTotal > 0, `本轮真删 ${purgedTotal} 条`);
  // 【新断言】物理删除必须反映到磁盘上 —— 内存删了多少，盘上就该少多少
  check(
    '5 物理删除已落盘（盘上条数 = 内存条数，没被 union 合并复活）',
    total === list.length,
    `盘上 ${total} 条 vs 内存 ${list.length} 条${total !== list.length ? ` → **复活 ${total - list.length} 条**` : ''}`
  );
}

console.log(out.join('\n'));
const failCount = out.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${failCount === 0 ? 'F1 归档区有界守卫：全部通过' : `F1 归档区有界守卫：${failCount} 项失败`}（${out.filter((l) => l.startsWith('PASS') || l.startsWith('FAIL')).length} 项）`);
if (failCount > 0) process.exitCode = 1;

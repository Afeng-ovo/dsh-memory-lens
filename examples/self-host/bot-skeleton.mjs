// 最小接入示例：把记忆系统接进一个通用聊天机器人。
//
// 这是一个「抄走就能用」的骨架，展示七个接入点的真实写法：
//   1. 初始化（读库、合并旧桶）
//   2. 收集消息窗口
//   3. 触发提炼（关键：解析失败不消费窗口）
//   4. 注入（关键：放 system 末尾）
//   5. 定时整理
//   6. 主动提醒（捎带式，不开定时器）
//   7. 结案（事情办完了要有个终点）
//
// 模型调用用一个占位函数 callModel()，换成你自己的网关即可。
// 运行：node examples/bot-skeleton.mjs

import {
  activeList,
  buildLongMemoryPrompt,
  formatLongMemoryBlock,
  markDueReminded,
  mergeIntoShared,
  organizeLongMemories,
  parseLongMemoryJson,
  readLongMemoryStore,
  resolveLongMemory,
  selectDueMemories,
  selectLongMemories,
  sharedBucketOf,
  upsertLongMemory,
  writeLongMemoryStore
} from '../../lib/core/long-memory.js';

// ── 接入点 1 · 初始化 ────────────────────────────────────────────────────
import { fileURLToPath } from 'node:url';
const MEMORY_FILE = fileURLToPath(new URL('./data/long-memory.json', import.meta.url));
const store = readLongMemoryStore(MEMORY_FILE);
if (mergeIntoShared(store)) writeLongMemoryStore(MEMORY_FILE, store);
const memories = sharedBucketOf(store);
const save = () => writeLongMemoryStore(MEMORY_FILE, store);
const DAY = 86400000;

console.log(`记忆库：${activeList(memories).length} 条生效 | 整理每 24h`);

// ── 模型适配层（换成你的）───────────────────────────────────────────────
async function callModel(prompt) {
  // 生产环境用 OpenAI 兼容网关。这里为了让示例能跑，返回一个写死的提炼结果。
  if (prompt.includes('考研')) {
    return JSON.stringify([
      { kind: 'fact', text: '阿风在准备考研，目标是本校计算机', tags: ['学业', '考研'], weight: 5 }
    ]);
  }
  return '[]';
}

// ── 接入点 2 · 消息窗口 ─────────────────────────────────────────────────
const windows = new Map(); // key -> [{sender, text, isOwner, at}]

function noteMessage(key, { sender, text, isOwner = false }) {
  if (!text.trim()) return;
  const win = windows.get(key) ?? [];
  win.push({ sender, text: text.trim(), isOwner: Boolean(isOwner), at: Date.now() });
  windows.set(key, win);
}

// ── 接入点 3 · 触发提炼 ─────────────────────────────────────────────────
const MIN_MESSAGES = 5;      // 演示用小数字；生产建议 20
const COOLDOWN_MS = 10 * 60_000;
let lastRunAt = 0;
let chain = Promise.resolve();

function maybeExtract(key) {
  if (Date.now() - lastRunAt < COOLDOWN_MS) return;
  const win = windows.get(key) ?? [];
  if (win.length < MIN_MESSAGES) return;
  lastRunAt = Date.now();
  chain = chain.then(() => extract(key, win.slice(0, MIN_MESSAGES)))
    .catch((e) => console.error('提炼失败', e));
}

async function extract(key, batch) {
  const prompt = buildLongMemoryPrompt(batch, activeList(memories));
  const raw = await callModel(prompt);
  const parsed = parseLongMemoryJson(raw);

  if (!parsed.ok) {
    // 关键：解析失败绝不消费窗口，原料留到下一轮
    console.warn(`提炼解析失败（${key}），原料保留 ${batch.length} 条`);
    return;
  }

  // 解析成功（含明确 []）才消费
  windows.set(key, (windows.get(key) ?? []).slice(batch.length));

  let added = 0;
  for (const item of parsed.items) {
    if (upsertLongMemory(memories, item, { maxEntries: 1000 }).ok) added += 1;
  }
  if (added) save();
  console.log(`提炼完成（${key}）：新增 ${added}，生效 ${activeList(memories).length} 条`);
}

// ── 接入点 4 · 注入 ─────────────────────────────────────────────────────
function systemPromptWithMemory(userMessage, rolePrompt) {
  const picked = selectLongMemories(memories, userMessage, 12, 1200, Date.now(), true);
  const block = picked.length ? formatLongMemoryBlock(picked, Date.now()) : '';
  return [rolePrompt, block].filter(Boolean).join('\n\n'); // 记忆放末尾
}

// ── 接入点 5 · 定时整理 ─────────────────────────────────────────────────
let lastOrganizeAt = 0;
function maybeOrganize() {
  if (Date.now() - lastOrganizeAt < 24 * 3600_000) return;
  lastOrganizeAt = Date.now();
  const r = organizeLongMemories(memories, { archiveBelow: 0.6, consolidate: true });
  if (r.archived || r.merged) save();
  console.log(`整理：归档 ${r.archived}，合并 ${r.merged}，生效 ${activeList(memories).length} 条`);
}

// ── 接入点 6 · 主动提醒（捎带式）────────────────────────────────────────
// 记忆系统「被问才答」的话，永远说不出「你上周说的面试怎么样了」。
// dueAt 就是主动开口的锚。这里在收到用户消息时顺手扫一遍到期项，
// 有的话拼进回复里，并结案（remindedAt），避免同一条反复追问。
function maybeRemind() {
  const due = selectDueMemories(memories, Date.now());
  if (!due.length) return '';
  const lines = due.map((m) => {
    const when = m.dueAt.when || m.dueAt.date || new Date(m.dueAt.ts).toLocaleDateString();
    markDueReminded(m); // 结案：提醒过就不再重复
    return `有件事之前约好了：${m.text}（${when}），现在怎么样了？`;
  });
  save();
  return lines.join('\n');
}

// ── 接入点 7 · 结案 ─────────────────────────────────────────────────────
// 提醒只管「问过没有」，不管「事情办完没有」。没有结案，约定会一直挂在到期列表里。
// 真实接入时，触发条件通常有两个：用户明确说「办完了」，或者提炼结果里带了 resolves
// （后者由 upsertLongMemory 自动处理，见接入点 3）。
function maybeResolve(userMessage) {
  if (!/看完了|喝完|办完|吃完|做完|搞定了|办好了|已经过了|去过了/.test(userMessage)) return false;
  // 用户原话几乎不可能和记忆原文逐字对上，先检索出最像的那条，再按 id 结案。
  // 直接拿整句用户消息当 text 去匹配，多半找不到（这句话本身就是"结案不生效"的常见原因）。
  const [best] = selectLongMemories(memories, userMessage, 1, 1200, Date.now(), false);
  if (!best || best.status !== 'active') return false;
  const hit = resolveLongMemory(memories, { id: best.id, note: '用户说已经办好了' });
  if (hit) {
    save();
    console.log(`结案：${hit.text}（仍可检索，聊起来还记得）`);
  }
  return Boolean(hit);
}

// ── 模拟一段对话，把整条链路走一遍 ───────────────────────────────────────
async function main() {
  const key = 'private:demo';
  const chats = [
    { sender: '阿风', text: '最近在准备考研，目标是本校计算机，压力有点大', isOwner: true },
    { sender: '阿风', text: '养了只柯基叫土豆，两岁了', isOwner: true },
    { sender: '小鲸鱼', text: '考研加油，土豆这名字好可爱' },
    { sender: '阿风', text: '我特别讨厌下雨天，出门必带伞', isOwner: true },
    { sender: '阿风', text: '周六一起看电影吧，《流浪地球3》', isOwner: true }
  ];

  for (const msg of chats) {
    noteMessage(key, msg);
    // 每条用户消息后都可能触发提炼；真实机器人在这里是异步的
    if (msg.isOwner) maybeExtract(key);
  }

  // 等提炼串行链跑完
  await chain;

  // 现在库里有记忆了，模拟一轮带注入的对话
  const sys = systemPromptWithMemory('周六那个电影还看吗', '你是小鲸鱼，一个温柔的 QQ 机器人。');
  console.log('\n────── 注入到 system prompt 的内容 ──────\n');
  console.log(sys);

  maybeOrganize();

  // 演示主动提醒：手动塞一条「昨天到期」的跟进项，看 maybeRemind 能不能主动问出来
  upsertLongMemory(memories, {
    kind: 'promise', text: '阿风上周说要请我喝奶茶', weight: 3,
    dueAt: { when: '昨天', date: new Date(Date.now() - DAY).toISOString().slice(0, 10) }
  });
  console.log('\n────── 主动提醒（收到消息时捎带触发）──────\n');
  console.log(maybeRemind() || '（没有到期项）');
  console.log('\n第二次调用（已提醒过，不会再问）：', JSON.stringify(maybeRemind() || ''));

  console.log('\n────── 结案（用户说办完了）──────');
  maybeResolve('上次说好请我喝的奶茶，已经喝完了');
  console.log('结案后到期列表：', JSON.stringify(maybeRemind() || '（空）'));

  console.log('\n────── 最终状态 ──────');
  console.log(`生效 ${activeList(memories).length} 条，全部 ${memories.length} 条（含已完成/归档/已取代）`);
}

main().catch((e) => { console.error(e); process.exit(1); });

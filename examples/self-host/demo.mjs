#!/usr/bin/env node
// 一周演示：不联网、不调模型，用一段写死的「模型返回」走完整生命周期。
//
// 真实接入时唯一要换掉的只有一步：把 buildLongMemoryPrompt() 的输出发给模型，
// 把模型的回答喂给 parseLongMemoryJson()。其余全部照旧。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  activeList,
  buildLongMemoryPrompt,
  formatLongMemoryBlock,
  markDueReminded,
  memoryStrength,
  organizeLongMemories,
  parseLongMemoryJson,
  readLongMemoryStore,
  selectDueMemories,
  selectLongMemories,
  sharedBucketOf,
  upsertLongMemory,
  writeLongMemoryStore
} from '../../lib/core/long-memory.js';

const DAY = 86400000;
const T0 = new Date('2026-10-27T20:00:00+08:00').getTime();
const at = (day, hour = 20) => T0 + (day - 1) * DAY + (hour - 20) * 3600000;
const KIND = { fact: '事实', pref: '偏好', promise: '约定', event: '事件' };

function width(text) {
  return [...text].reduce((acc, ch) => acc + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
}
function head(text) {
  const line = '━'.repeat(60);
  console.log(`\n${line}\n ${text}\n${line}`);
}
function dim(text) { console.log(`   ${text}`); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-demo-'));
const file = path.join(dir, 'long-memory.json');
const store = readLongMemoryStore(file);
const list = sharedBucketOf(store);

// ── 第 1 天：聊天 → 提炼 ────────────────────────────────────────────────
const chat1 = [
  { sender: '阿风', text: '最近在准备考研，目标是本校计算机，压力有点大', isOwner: true },
  { sender: '阿风', text: '哦对，我养了只柯基叫土豆，两岁了', isOwner: true },
  { sender: '阿风', text: '我特别讨厌下雨天，出门必带伞', isOwner: true },
  { sender: '小鲸鱼', text: '考研加油呀，土豆这名字好可爱' },
  { sender: '阿风', text: '周六一起看电影吧，《流浪地球3》', isOwner: true },
  { sender: '阿风', text: '不过这周三得先交实验报告，烦', isOwner: true },
  { sender: '小鲸鱼', text: '好啊，那就周六' }
];

head('第 1 天 · 把聊天交给模型提炼');
dim(`输入 ${chat1.length} 句聊天，其中 ${chat1.filter((m) => m.isOwner).length} 句是主人说的`);
const prompt = buildLongMemoryPrompt(chat1, activeList(list));
dim(`生成提示词 ${prompt.length} 字（含 ${activeList(list).length} 条已有记忆 + ${chat1.length} 句聊天）`);

// 模型真实返回常常长这样：先客套一句，再包一层代码块，字段名还可能漂移。
const modelReply1 = `好的，我整理一下：
\`\`\`json
[
  {"kind":"fact","text":"阿风在准备考研，目标是本校计算机","tags":["学业","考研"],"weight":5},
  {"kind":"fact","text":"阿风养了只柯基叫土豆，两岁","tags":["宠物"],"weight":4},
  {"kind":"pref","text":"阿风讨厌下雨天，出门必带伞","tags":["生活习惯"],"weight":3},
  {"kind":"promise","text":"说好周六一起看电影《流浪地球3》","tags":["约定","电影"],"weight":4},
  {"kind":"event","text":"阿风这周三要交实验报告","tags":["学业"],"weight":3}
]
\`\`\``;
dim('模型返回：带客套话 + ```json 代码块（这是常态，解析器必须能吃）');
const parsed1 = parseLongMemoryJson(modelReply1);
for (const item of parsed1.items) {
  const r = upsertLongMemory(list, item, { now: at(1) });
  if (r.ok) dim(`  + [${KIND[r.item.kind]}] w${r.item.weight}  ${r.item.text}`);
}
dim(`→ 写入 ${parsed1.items.length} 条，库里生效 ${activeList(list).length} 条`);
writeLongMemoryStore(file, store);

// ── 第 1 天：注入 ────────────────────────────────────────────────────────
head('第 1 天 · 下次对话时注入（注意每条的日期）');
const quoted = selectLongMemories(list, '周日有空吗', 12, 1200, at(1, 21), false);
console.log(formatLongMemoryBlock(quoted, at(1, 21)).split('\n').map((l) => `   ${l}`).join('\n'));
dim('日期不是装饰：模型由此能分清「上周说的」和「上个月说的」');

// ── 第 3 天：新信息取代旧的 ──────────────────────────────────────────────
head('第 3 天 · 计划变了：考研改考公');
const chat2 = [
  { sender: '阿风', text: '我想了很久，决定不考研了，改考公，目标是省直机关', isOwner: true },
  { sender: '小鲸鱼', text: '想清楚就好，考公也挺好' }
];
const modelReply2 = `[{"kind":"fact","text":"阿风改考公了，目标是省直机关","tags":["学业","考公"],"weight":5,"supersedes":["阿风在准备考研"]}]`;
const parsed2 = parseLongMemoryJson(modelReply2);
for (const item of parsed2.items) {
  const r = upsertLongMemory(list, item, { now: at(3) });
  dim(`  + ${r.item.text}`);
  for (const old of r.retired) dim(`  − 旧记忆下架（没删）：${old.text}`);
}
dim('冲突不静默合并：短句相似度高，硬合并会把「考研」和「考公」揉成一条，且再也淘汰不掉');
writeLongMemoryStore(file, store);

// ── 第 6 天：被问起 → 命中刷新 ───────────────────────────────────────────
head('第 6 天 · 她问起电影，相关记忆被选中');
const picked = selectLongMemories(list, '周六那个电影还看吗', 3, 1200, at(6), true);
for (const m of picked) {
  dim(`  ${m.hits ? `命中 ${m.hits} 次` : '不相关，只是占位'} · ${m.text}`);
}
const before = picked.find((m) => m.text.includes('电影'));
dim(`「${before.text.slice(0, 12)}…」的强度被刷新到 ${memoryStrength(before, at(6)).toFixed(2)}`);
dim('只有真正沾边的条目才算「被想起」；无关条目不会被顺手刷新，否则衰减永远不生效');

// ── 第 7 天：主动提醒 ────────────────────────────────────────────────────
head('第 7 天 · 主动提醒：到了该问的时候');
// 之前那条「周六看电影」带 dueAt，现在（第 7 天）已经过期了
upsertLongMemory(list, {
  kind: 'promise', text: '说好周六一起看电影《流浪地球3》', weight: 4,
  dueAt: { when: '这周六', date: new Date(at(6)).toISOString().slice(0, 10) }
}, { now: at(1) });
const due = selectDueMemories(list, at(7));
for (const m of due) {
  dim(`  主动开口：有件事之前约好了——${m.text}（${m.dueAt.when}），现在怎么样了？`);
  markDueReminded(m, at(7));
}
dim(`到期 ${due.length} 条被提醒，提醒后结案（remindedAt），不会再重复追问`);
dim('对比活人：她会自己找话头，而不是等你问「电影还看吗」才想起来');
writeLongMemoryStore(file, store);

// ── 第 8 天：事情有结果了 → 结案（不是删除） ────────────────────────────
head('第 8 天 · 电影看完了：结案，而不是删掉');
const modelReply3 = `[{"kind":"fact","text":"阿风和鲸鱼一起看了《流浪地球3》，他说挺好看","tags":["电影","约定兑现"],"weight":3,"resolves":["说好周六一起看电影"],"result":"看完了"}]`;
const parsed3 = parseLongMemoryJson(modelReply3);
for (const item of parsed3.items) {
  const rr = upsertLongMemory(list, item, { now: at(8) });
  dim(`  + ${rr.item.text}`);
  for (const old of rr.resolved) dim(`  ✓ 结案（原文没删）：${old.text}`);
}
for (const m of selectLongMemories(list, '上次那个电影好看吗', 5, 1200, at(9), false)) {
  if (m.status !== 'resolved') continue;
  dim(`  聊起旧事还记得：${m.text}（已完成：${m.resolveNote || '—'}）`);
}
dim('结案 = 不再当待办追问，但仍然留在检索库里 —— 结案不等于失忆');
writeLongMemoryStore(file, store);

// ── 第 40 天：整理 ──────────────────────────────────────────────────────
head('第 40 天 · 整理：该淡出的淡出');
const r = organizeLongMemories(list, { now: at(40) });
for (const m of list.filter((x) => x.status === 'archived')) {
  dim(`  归档 ${m.text}（强度 ${memoryStrength(m, at(40)).toFixed(2)} < 0.60）`);
}
dim(`生效 ${r.before} → ${r.after}：归档 ${r.archived}，合并 ${r.merged}`);
dim('归档只是改成「不再主动提起」，原文一直留在文件里');
writeLongMemoryStore(file, store);

// ── 第 40 天：再打开一次 ────────────────────────────────────────────────
head('第 40 天 · 重新读盘，状态没变');
const back = readLongMemoryStore(file);
dim(`生效 ${activeList(sharedBucketOf(back)).length} 条，已完成 ${sharedBucketOf(back).filter((m) => m.status === 'resolved').length} 条，归档 ${sharedBucketOf(back).filter((m) => m.status === 'archived').length} 条，已取代 ${sharedBucketOf(back).filter((m) => m.status === 'superseded').length} 条`);
dim('归档状态必须能扛过一次读写 —— 这条专门有测试守着');

// ── 收尾 ────────────────────────────────────────────────────────────────
head('现在的库长这样');
console.log(activeList(sharedBucketOf(back))
  .sort((a, b) => memoryStrength(b, at(40)) - memoryStrength(a, at(40)))
  .map((m) => `   ${memoryStrength(m, at(40)).toFixed(2)}  [${KIND[m.kind]}] ${m.text}`)
  .join('\n'));

fs.rmSync(dir, { recursive: true, force: true });
console.log('\n演示结束。真实库里这些条目会一直在，直到被新信息取代、被结案，或自然淡出。\n');

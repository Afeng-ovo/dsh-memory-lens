#!/usr/bin/env node
// 日记查看/搜索：读 state/diary.json，按天列或按关键词搜。
//
// 用法：
//   node scripts/diary.mjs                   列出所有日记（新日期在前）
//   node scripts/diary.mjs --search "考研"   按关键词搜（复用长期记忆的 BM25）
//   node scripts/diary.mjs --limit 10        配合 --search 限制条数
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, bm25Scores, tokenize } from '../../../lib/core/long-memory.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIARY_FILE = path.resolve(here, '..', 'state', 'diary.json');

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const search = getArg('--search', '');
const limit = Math.max(1, Number(getArg('--limit', '10')) || 10);

function load() {
  try { return JSON.parse(fs.readFileSync(DIARY_FILE, 'utf8')); }
  catch { return { version: 1, days: {} }; }
}

function daysList(store) {
  return Object.entries(store.days ?? {}).sort((a, b) => (a[0] < b[0] ? 1 : -1));
}

function main() {
  const store = load();
  const days = daysList(store);

  if (!days.length) {
    console.log('（还没有日记。等 bridge 跑满一天，凌晨 4 点会自动写第一页。）');
    return;
  }

  if (search) {
    // 复用长期记忆的 BM25：summary + moments 都当文档
    const docs = [];
    for (const [date, entry] of days) {
      if (!entry || typeof entry !== 'object') continue;
      docs.push({ date, text: entry.summary ?? '', entry });
      for (const m of (entry.moments ?? [])) docs.push({ date, text: m, entry });
    }
    const index = buildIndex(docs.map((d) => ({ text: d.text, kind: 'fact', tags: [] })));
    const scores = bm25Scores(index, tokenize(search));
    const seen = new Set();
    const out = [];
    const ranked = docs.map((d, i) => ({ d, s: scores[i] })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    for (const { d, s } of ranked) {
      if (seen.has(d.date)) continue;
      seen.add(d.date);
      out.push({ date: d.date, summary: d.entry.summary ?? '', score: s });
      if (out.length >= limit) break;
    }
    if (!out.length) { console.log(`搜「${search}」没有命中。`); return; }
    console.log(`搜「${search}」命中 ${out.length} 天：\n`);
    for (const h of out) {
      console.log(`  ${h.date}  （相关度 ${h.score.toFixed(2)}）`);
      console.log(`  ${String(h.summary ?? '').slice(0, 200)}`);
      console.log('');
    }
    return;
  }

  console.log(`共 ${days.length} 天日记：\n`);
  for (const [date, entry] of days) {
    console.log(`━━━ ${date} ━━━`);
    console.log(String(entry?.summary ?? ''));
    if ((entry?.moments ?? []).length) {
      console.log('');
      for (const m of entry.moments) console.log(`  · ${m}`);
    }
    console.log('');
  }
}

main();

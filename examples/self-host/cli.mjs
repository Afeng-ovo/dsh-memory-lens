#!/usr/bin/env node
// 命令行入口：把一个 long-memory.json 当成可操作的东西 —— 查、看、加、忘、整理、导出。
//
// 设计原则：任何命令都只读写一个 JSON 文件，没有隐藏状态。
// 这样它既能当运维工具（上服务器看记忆），也能当接入前的验证工具（先手工喂几条，
// 看回话有没有变化，再决定要不要上自动提炼）。
import fs from 'node:fs';
import path from 'node:path';
import {
  activeList,
  buildIndex,
  buildLongMemoryPrompt,
  formatLongMemoryBlock,
  memoryStrength,
  normalizeDueAt,
  organizeLongMemories,
  overlapRatio,
  parseLongMemoryJson,
  readLongMemoryStore,
  recallableList,
  removeLongMemory,
  resolveLongMemory,
  scoreDocs,
  selectDueMemories,
  selectLongMemories,
  sharedBucketOf,
  tokenize,
  upsertLongMemory,
  writeLongMemoryStore
} from '../../lib/core/long-memory.js';

const DEFAULT_STORE = path.join(process.cwd(), 'data', 'long-memory.json');
const KIND_LABEL = { fact: '事实', pref: '偏好', promise: '约定', event: '事件' };
const KIND_ORDER = ['fact', 'pref', 'promise', 'event'];
const DAY = 86400000;

// ── 参数与 IO ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i += 1; }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function readInput(args) {
  if (args.file && args.file !== true) return fs.readFileSync(String(args.file), 'utf8');
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function storePath(args) {
  return path.resolve(args.store && args.store !== true ? String(args.store) : DEFAULT_STORE);
}

function load(args) {
  const file = storePath(args);
  const store = readLongMemoryStore(file);
  return { file, store, list: sharedBucketOf(store) };
}

function save(file, store) {
  writeLongMemoryStore(file, store);
}

function days(ts, now = Date.now()) {
  if (!ts) return '—';
  return `${Math.max(0, (now - ts) / DAY).toFixed(1)}d`;
}

function pad(s, n) {
  // 中文按两个宽度算，纯 ASCII 补空格，让表格在等宽字体下对齐
  const w = [...String(s)].reduce((acc, ch) => acc + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
  return String(s) + ' '.repeat(Math.max(0, n - w));
}

function stat(list) {
  const now = Date.now();
  const active = activeList(list);
  const archived = list.filter((m) => m.status === 'archived');
  const superseded = list.filter((m) => m.status === 'superseded');
  const resolved = list.filter((m) => m.status === 'resolved');
  const byKind = {};
  for (const k of KIND_ORDER) byKind[k] = 0;
  for (const m of active) byKind[m.kind] = (byKind[m.kind] || 0) + 1;
  const strengths = active.map((m) => memoryStrength(m, now));
  const hits = active.map((m) => m.hits || 0).sort((a, b) => a - b);
  const lens = active.map((m) => m.text.length);
  return {
    now,
    total: list.length,
    active,
    archived,
    superseded,
    resolved,
    byKind,
    strengths,
    minStrength: strengths.length ? Math.min(...strengths) : 0,
    maxStrength: strengths.length ? Math.max(...strengths) : 0,
    avgLen: lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0,
    maxLen: lens.length ? Math.max(...lens) : 0,
    hitMedian: hits.length ? hits[Math.floor(hits.length / 2)] : 0,
    neverUsed: active.filter((m) => !m.hits).length,
    oldest: active.length ? Math.min(...active.map((m) => m.createdAt || now)) : 0,
    newest: active.length ? Math.max(...active.map((m) => m.createdAt || now)) : 0
  };
}

// ── 命令 ─────────────────────────────────────────────────────────────────

function cmdStatus(args) {
  const { file, list } = load(args);
  const s = stat(list);
  console.log(`库文件  ${file}`);
  console.log(`总量    ${s.total} 条 = 生效 ${s.active.length} + 已完成 ${s.resolved.length} + 归档 ${s.archived.length} + 已取代 ${s.superseded.length}`);
  if (!s.total) {
    console.log('\n（还没有记忆。用 `add` 加一条，或 `ingest` 灌一次模型提炼结果）');
    return;
  }
  if (!s.active.length) {
    console.log('\n（当前没有生效中的记忆：都已经结案 / 归档 / 被取代。`list --status all` 可以看全部）');
    return;
  }
  console.log('\n分类');
  for (const k of KIND_ORDER) {
    const n = s.byKind[k] || 0;
    const bar = '█'.repeat(Math.round((n / s.active.length) * 24));
    console.log(`  ${pad(KIND_LABEL[k], 6)}${pad(n, 5)}${bar}`);
  }
  console.log('\n健康度');
  console.log(`  强度范围    ${s.minStrength.toFixed(2)} ~ ${s.maxStrength.toFixed(2)}   （低于 0.60 会被整理归档）`);
  console.log(`  文本长度    平均 ${s.avgLen.toFixed(0)} 字，最长 ${s.maxLen} 字   （建议一条 ≤60 字）`);
  console.log(`  被想起次数  中位 ${s.hitMedian}，从未被想起 ${s.neverUsed} 条`);
  console.log(`  时间跨度    ${new Date(s.oldest).toLocaleDateString()} ~ ${new Date(s.newest).toLocaleDateString()}`);
}

function cmdList(args) {
  const { list } = load(args);
  const now = Date.now();
  const want = String(args.status || 'active');
  const kind = args.kind && args.kind !== true ? String(args.kind) : '';
  const rows = list
    .filter((m) => (want === 'all' ? true : (m.status || 'active') === want))
    .filter((m) => (kind ? m.kind === kind : true))
    .sort((a, b) => (b.lastUsedAt || b.createdAt || 0) - (a.lastUsedAt || a.createdAt || 0));
  if (!rows.length) { console.log('（空）'); return; }
  console.log(`${pad('状态', 10)}${pad('类别', 6)}${pad('权重', 5)}${pad('强度', 6)}${pad('想起', 5)}${pad('最近', 8)}${pad('跟进', 12)}原文`);
  for (const m of rows) {
    const st = { archived: '归档', superseded: '已取代', resolved: '已完成' }[m.status] || '';
    const due = m.dueAt?.ts ? new Date(m.dueAt.ts).toLocaleDateString() : '';
    const note = m.status === 'resolved' && m.resolveNote ? `  ← ${m.resolveNote}` : '';
    console.log(
      `${pad(st, 10)}${pad(KIND_LABEL[m.kind] || m.kind, 6)}${pad(m.weight || 3, 5)}` +
      `${pad(memoryStrength(m, now).toFixed(2), 6)}${pad(m.hits || 0, 5)}` +
      `${pad(days(m.lastUsedAt || m.createdAt, now), 8)}${pad(due, 12)}${m.text}${note}`
    );
  }
  console.log(`\n共 ${rows.length} 条`);
}

function cmdDue(args) {
  const { list } = load(args);
  const now = Date.now();
  const due = selectDueMemories(list, now);
  if (!due.length) { console.log('（没有到期的跟进项）'); return; }
  console.log(`有 ${due.length} 条到期待提醒：\n`);
  for (const m of due) {
    const overdue = Math.max(0, now - m.dueAt.ts);
    const overdueDays = overdue >= DAY ? `已过期 ${(overdue / DAY).toFixed(0)} 天` : '今天到期';
    const when = m.dueAt.when || m.dueAt.date || new Date(m.dueAt.ts).toLocaleDateString();
    console.log(`  · ${m.text}   （${when}，${overdueDays}）`);
  }
  console.log('\n提示：真实提醒由机器人收到消息时捎带触发，见 examples/bot-skeleton.mjs 的「接入点 6」。');
  console.log('      事情办完了用 `done --text "..."` 结案，别再让它天天追着问。');
}

// 结案：约定兑现 / 事情有结果了。和 forget 的区别是——原文留着，还能当旧事聊。
function cmdDone(args) {
  const { file, store, list } = load(args);
  const id = args.id && args.id !== true ? String(args.id) : '';
  const text = args.text && args.text !== true ? String(args.text) : '';
  if (!id && !text) { console.error('用 --text "原文" 或 --id lm-xxx 指定要结案的那条'); process.exit(2); }
  const note = args.note && args.note !== true ? String(args.note) : (args.result && args.result !== true ? String(args.result) : '');
  const got = resolveLongMemory(list, { id, text, note });
  if (!got) { console.error('没找到这条生效中的记忆（可能已归档/已取代，或文本对不上）'); process.exit(1); }
  save(file, store);
  console.log(`已结案：${got.text}${got.resolveNote ? `（${got.resolveNote}）` : ''}`);
  console.log('结案后不再进到期提醒，但仍参与检索——聊到相关话题还能想起这件事。');
}

function cmdRender(args) {
  const { file, store, list } = load(args);
  const now = Date.now();
  const query = args.query && args.query !== true ? String(args.query) : '';
  const limit = Number(args.limit) || 12;
  const maxChars = Number(args.chars) || 1200;
  const touch = !args['no-touch'];
  const picked = selectLongMemories(list, query, limit, maxChars, now, touch);
  if (!picked.length) { console.log('（没有可注入的记忆）'); return; }
  const block = formatLongMemoryBlock(picked, now);
  console.log(block);
  const pool = recallableList(list);
  const closed = pool.filter((m) => m.status === 'resolved').length;
  const poolNote = closed ? `（库内可检索 ${pool.length} 条，含已完成 ${closed} 条）` : '';
  console.log(`\n--- ${picked.length}/${pool.length} 条，${block.length} 字${query ? `，查询「${query}」` : '，无查询（按权重与新近度）'} ---`);
  if (poolNote) console.log(poolNote);
  if (touch) {
    save(file, store);
    console.log('（已记录本次命中：hits +1、lastUsedAt 刷新。加 --no-touch 可只读）');
  }
}

function cmdPrompt(args) {
  const { list } = load(args);
  const raw = readInput(args);
  if (!raw.trim()) {
    console.error('把聊天记录通过 --file 或 stdin 传进来。每行一条，格式：昵称：内容');
    process.exit(2);
  }
  const messages = raw.split(/\r?\n/).filter((l) => l.trim()).map((line) => {
    const i = line.indexOf('：') >= 0 ? line.indexOf('：') : line.indexOf(':');
    if (i < 0) return { sender: '某人', text: line.trim(), isOwner: false };
    const sender = line.slice(0, i).trim();
    return { sender, text: line.slice(i + 1).trim(), isOwner: /管理员|主人|owner/i.test(sender) };
  });
  console.log(buildLongMemoryPrompt(messages, recallableList(list)));
}

function cmdIngest(args) {
  const { file, store, list } = load(args);
  const raw = readInput(args);
  const parsed = parseLongMemoryJson(raw);
  if (!parsed.ok) {
    // 这条分支是这套系统最重要的行为：解析失败绝不消费原料，也不写坏数据。
    console.error('解析失败：输出里没有可用的 JSON 数组。');
    console.error('这批原料没有被动过，修好提示词或换个模型重跑即可。');
    process.exit(1);
  }
  if (!parsed.items.length) { console.log('模型明确表示没有值得记的内容（[]），本轮无新增。'); return; }
  let added = 0; let updated = 0; let retired = 0; let skipped = 0; let blocked = 0; let closed = 0;
  for (const item of parsed.items) {
    const r = upsertLongMemory(list, item, { maxEntries: Number(args.max) || 1000 });
    if (!r.ok) { if (r.reason === 'sensitive') blocked += 1; else skipped += 1; continue; }
    retired += (r.retired || []).length;
    closed += (r.resolved || []).length + (r.action === 'resolved' ? 1 : 0);
    if (r.action === 'created') added += 1;
    else if (r.action === 'revived') added += 1;
    else updated += 1;
    const marks = [
      (r.retired || []).length ? '  ← 取代了旧条目' : '',
      (r.resolved || []).length ? '  ✓ 结案旧条目' : '',
      r.action === 'revived' ? '  ↺ 归档后复活' : '',
      r.action === 'resolved' ? '  ✓ 本条已结案' : ''
    ].join('');
    console.log(`  + ${r.item.kind.padEnd(8)} w${r.item.weight}  ${r.item.text}${marks}`);
  }
  if (added || updated || retired) save(file, store);
  console.log(`\n写入完成：新增 ${added}，更新 ${updated}，取代 ${retired}，结案 ${closed}，拦截 ${blocked}，跳过 ${skipped}，现生效 ${activeList(list).length} 条`);
}

function cmdAdd(args) {
  const { file, store, list } = load(args);
  const text = args.text && args.text !== true ? String(args.text) : '';
  if (!text) { console.error('缺少 --text'); process.exit(2); }
  const tags = args.tags && args.tags !== true ? String(args.tags).split(/[,，、\s]+/).filter(Boolean) : [];
  const dueRaw = args.due && args.due !== true ? String(args.due) : '';
  const r = upsertLongMemory(list, {
    text,
    kind: args.kind && args.kind !== true ? String(args.kind) : 'fact',
    weight: args.weight && args.weight !== true ? Number(args.weight) : 3,
    tags,
    supersedes: args.supersedes && args.supersedes !== true ? String(args.supersedes) : undefined,
    dueAt: dueRaw ? normalizeDueAt(dueRaw) : null
  }, { maxEntries: Number(args.max) || 1000 });
  if (!r.ok) { console.error(`未写入：${r.reason === 'sensitive' ? '命中敏感信息' : r.reason}`); process.exit(1); }
  save(file, store);
  console.log(`${r.action === 'created' ? '已新增' : '已更新'}：${r.item.text}`);
  if (r.item.dueAt?.ts) console.log(`  跟进时间：${r.item.dueAt.when || r.item.dueAt.date || new Date(r.item.dueAt.ts).toLocaleDateString()}`);
  for (const old of r.retired || []) console.log(`  已取代：${old.text}`);
}

function cmdForget(args) {
  const { file, store, list } = load(args);
  const got = removeLongMemory(list, { id: args.id, text: args.text });
  if (!got) { console.error('没找到这条记忆'); process.exit(1); }
  save(file, store);
  console.log(`已删除（物理删除，不可恢复）：${got.text}`);
  console.log('如果只是想让它不再被提起，用 organize 归档，或 add --supersedes 显式取代。');
}

function cmdOrganize(args) {
  const { file, store, list } = load(args);
  const now = Date.now();
  const before = activeList(list).length;
  if (args['dry-run']) {
    const copy = JSON.parse(JSON.stringify(list));
    const r = organizeLongMemories(copy, {
      now,
      archiveBelow: Number(args['archive-below']) || 0.6,
      consolidate: !args['no-merge']
    });
    for (const m of copy) {
      const old = list.find((x) => x.id === m.id);
      if (old && old.status !== m.status) {
        console.log(`  ${m.status === 'archived' ? '归档' : '合并'}  ${m.text}`);
      }
    }
    console.log(`\n试运行：生效 ${r.before} → ${r.after}（归档 ${r.archived}，合并 ${r.merged}）。去掉 --dry-run 即真正执行。`);
    return;
  }
  const r = organizeLongMemories(list, {
    now,
    archiveBelow: Number(args['archive-below']) || 0.6,
    consolidate: !args['no-merge']
  });
  if (r.archived || r.merged) save(file, store);
  console.log(`整理完成：生效 ${before} → ${r.after}（归档 ${r.archived}，合并 ${r.merged}）。数据没删，只是不再主动提起。`);
}

function cmdDoctor(args) {
  const { list } = load(args);
  const now = Date.now();
  const active = activeList(list);
  const issues = [];
  for (let i = 0; i < active.length; i += 1) {
    const a = active[i];
    if (a.text.length > 60) issues.push(['过长', `${a.text.length} 字：${a.text.slice(0, 40)}…`, '一条只记一件事，拆开']);
    else if ((a.text.match(/[；;。]/g) || []).length >= 2) issues.push(['多事件', a.text.slice(0, 40), '用「；」拼了多件事，拆开更利于检索']);
    if (!(a.tags || []).length) issues.push(['无标签', a.text.slice(0, 40), '标签参与检索，建议补 2~3 个']);
    if (memoryStrength(a, now) < 1) issues.push(['濒临归档', `${memoryStrength(a, now).toFixed(2)}：${a.text.slice(0, 34)}`, '要么补新信息刷新，要么让它淡出']);
    if (!a.hits) issues.push(['从未被想起', a.text.slice(0, 40), '可能写得不像平时的问法，或本来就不重要']);
    for (let j = i + 1; j < active.length; j += 1) {
      const b = active[j];
      if (a.kind === b.kind && overlapRatio(a.text, b.text) >= 0.8) {
        issues.push(['疑似重复', `${a.text.slice(0, 26)} ／ ${b.text.slice(0, 26)}`, '跑 organize 会自动合并']);
      }
    }
  }
  console.log(`体检 ${active.length} 条生效记忆`);
  if (!issues.length) { console.log('没有发现问题。'); return; }
  const byType = {};
  for (const [t] of issues) byType[t] = (byType[t] || 0) + 1;
  console.log(Object.entries(byType).map(([k, v]) => `${k} ${v}`).join('  |  '));
  console.log('');
  const show = args.all ? issues : issues.slice(0, Number(args.limit) || 20);
  for (const [type, detail, hint] of show) console.log(`  [${type}] ${detail}\n        → ${hint}`);
  if (show.length < issues.length) console.log(`\n还有 ${issues.length - show.length} 条，加 --all 看全部`);
}

function cmdExport(args) {
  const { list } = load(args);
  const now = Date.now();
  const active = activeList(list);
  const lines = ['# 长期记忆清单', '', `导出时间：${new Date(now).toLocaleString()}　生效 ${active.length} 条`, ''];
  for (const k of KIND_ORDER) {
    const rows = active.filter((m) => m.kind === k);
    if (!rows.length) continue;
    lines.push(`## ${KIND_LABEL[k]}`, '', '| 权重 | 强度 | 想起 | 记录时间 | 内容 | 标签 |', '|---|---|---|---|---|---|');
    for (const m of rows.sort((a, b) => (b.weight || 3) - (a.weight || 3))) {
      lines.push(`| ${m.weight || 3} | ${memoryStrength(m, now).toFixed(2)} | ${m.hits || 0} | ${new Date(m.createdAt || now).toLocaleDateString()} | ${m.text} | ${(m.tags || []).join('、')} |`);
    }
    lines.push('');
  }
  const hist = list.filter((m) => m.status !== 'active');
  if (hist.length) {
    lines.push('## 已下架 / 已结案（仍保留在文件中）', '', '| 状态 | 内容 | 备注 |', '|---|---|---|');
    for (const m of hist) lines.push(`| ${{ archived: '归档', superseded: '已取代', resolved: '已完成' }[m.status] || m.status} | ${m.text} | ${m.resolveNote || ''} |`);
    lines.push('');
  }
  const out = lines.join('\n');
  if (args.out && args.out !== true) {
    fs.writeFileSync(String(args.out), out, 'utf8');
    console.log(`已导出：${path.resolve(String(args.out))}`);
  } else {
    console.log(out);
  }
}

// 调试用：把一次查询的打分过程打出来，回答“为什么这条没被想起”
function cmdWhy(args) {
  const { list } = load(args);
  const query = args.query && args.query !== true ? String(args.query) : '';
  if (!query) { console.error('缺少 --query'); process.exit(2); }
  const pool = recallableList(list); // 已完成也参与检索，解释打分时要一起看
  const terms = tokenize(query);
  const scored = scoreDocs(buildIndex(pool), terms, Date.now()).sort((a, b) => b.score - a.score);
  console.log(`查询「${query}」切成词：${terms.join(' / ') || '（无）'}\n`);
  console.log(`${pad('得分', 8)}${pad('相关', 8)}${pad('权重', 5)}原文`);
  for (const { m, rel, score } of scored) {
    console.log(`${pad(score.toFixed(2), 8)}${pad(rel.toFixed(2), 8)}${pad(m.weight || 3, 5)}${m.text.slice(0, 46)}`);
  }
  console.log('\n得分 = 相关度×12 + (权重-3)×2 + 新近度（0~6）');
}

// ── 分发 ─────────────────────────────────────────────────────────────────

const HELP = `小鲸鱼记忆系统 · 命令行

  status                        体检总览（分类、强度、长度、命中）
  list [--status active|resolved|archived|superseded|all] [--kind fact]
                                列出条目
  render [--query 文本] [--limit 12] [--chars 1200] [--no-touch]
                                生成注入块（会记录命中）
  prompt [--file chat.txt]      生成提炼提示词（chat.txt 每行「昵称：内容」）
  ingest [--file model.txt]     解析模型输出并写入
  add --text "..." [--kind fact|pref|promise|event] [--weight 1-5] [--tags a,b]
      [--supersedes "旧记忆原文"] [--due "2026-11-01"]
                                                手工加一条（--due 设跟进时间）
  forget [--text "..."] [--id lm-xxx]
                                物理删除一条（慎用）
  organize [--dry-run] [--archive-below 0.6] [--no-merge]
                                衰减归档 + 重复合并
  due                            列出到期还没提醒的跟进项
  done [--text "..."] [--id lm-x] [--note "过了"]
                                结案：约定兑现/事情有结果（不删数据，仍可检索）
  doctor [--all]                找问题：过长、多事件、无标签、重复、从未被想起
  export [--out 文件.md]        导出可读清单
  why --query "..."             看检索打分，回答「为什么这条没被想起」

通用：--store <路径>（默认 ./data/long-memory.json）
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const table = {
    status: cmdStatus, list: cmdList, render: cmdRender, prompt: cmdPrompt, ingest: cmdIngest,
    add: cmdAdd, forget: cmdForget, organize: cmdOrganize, due: cmdDue, done: cmdDone,
    doctor: cmdDoctor, export: cmdExport, why: cmdWhy
  };
  // --help / -h 当第一个参数时也要能出帮助（以前会落到「未知命令」分支）
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) { console.log(HELP); return; }
  const fn = table[cmd];
  if (!fn) { console.error(`未知命令：${cmd}\n`); console.log(HELP); process.exit(2); }
  fn(args);
}

main().catch((error) => { console.error(error?.message ?? error); process.exit(1); });

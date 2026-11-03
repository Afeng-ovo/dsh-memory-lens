// 内核 ↔ 宿主 契约核对探针（只读核对，不改 lib/ 一行）。
//
// captain 2026-11-03 指定的 5 个契约点，逐条自动核。设计原则：
//   · 静态项用源码扫描 —— 「有没有用错字段名」「catch 有没有吞」这类问题
//     跑测试测不出来（测试里不会真的让 save() 抛错），必须看源码。
//   · 动态项用真实读盘链路 —— 自己造条目对象测不算数，
//     必须走 MemoryStore 读盘，否则测的是「我造的对象对不对」而不是「链路对不对」。
//
// 用法：node test/_probe-contract-host.mjs
// 任一契约点失败 → exit 1，并打印具体位置。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../lib/store.js';
import {
  recallableList,
  selectLayeredMemories,
  upsertLongMemory
} from '../lib/core/long-memory.js';
import { auditStore } from '../lib/core/audit.js';

// import.meta.url 里的中文路径会被百分号编码（工作之神 → %E5%B7%A5…），
// 不 decode 就永远 ENOENT，全部契约点都会被 SKIP 掉 —— 看起来「没问题」，
// 其实是「没检查」。这种假绿必须自己先堵死。
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const out = [];
let failed = 0;
const check = (name, cond, extra = '') => {
  out.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failed += 1;
};
const skip = (name, why) => out.push(`SKIP  ${name} — ${why}`);

const readSrc = (rel) => {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
  } catch {
    return null;
  }
};
const indexSrc = readSrc('lib/index.js');
const toolsSrc = readSrc('lib/tools.js');

// ══════════════════════════════════════════════════════════════════════════
// 契约点 1：loadError 的字段名（不能误用 lastError）
// ══════════════════════════════════════════════════════════════════════════
{
  if (!indexSrc) {
    skip('契约1 loadError', '读不到 lib/index.js');
  } else {
    // 去掉注释再看，否则注释里提到 lastError 会误判
    const stripComments = (s) =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const code = stripComments(indexSrc);

    const usesLoadError = /\.loadError\b/.test(code);
    check('契约1 index.js 使用了 store.loadError', usesLoadError,
      usesLoadError ? '有使用点' : '**没有**任何 loadError 使用点 → 读失败不会上报');

    // 误用检查：lastError 只能出现在「写盘原因」语境，不能拿来判读失败
    const lastErrorHits = [...code.matchAll(/[^\n]*\.lastError\b[^\n]*/g)].map((m) => m[0].trim());
    const suspicious = lastErrorHits.filter(
      (line) => /readOnly|读失败|红条|loadFail|loadError|locked|已拒绝写入/.test(line)
    );
    check('契约1 没有把 lastError 当读失败信号', suspicious.length === 0,
      suspicious.length ? suspicious.join(' | ') : `${lastErrorHits.length} 处 lastError，均为写盘语境`);

    // 反向：loadError 不该被写盘路径赋值（那会让它变成 lastError 的重复）
    const assignsLoadError = [...code.matchAll(/\.loadError\s*=[^=]/g)].length;
    check('契约1 loadError 只由读路径赋值（index.js 不写它）', assignsLoadError === 0,
      `index.js 里 ${assignsLoadError} 处赋值`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 契约点 2：9 处 save() 是否都接住异常，且没有吞掉
// ══════════════════════════════════════════════════════════════════════════
{
  if (!indexSrc) {
    skip('契约2 save 异常', '读不到 lib/index.js');
  } else {
    const lines = indexSrc.split('\n');
    const saveLines = [];
    lines.forEach((l, i) => {
      if (/\bstore\.save\(\)/.test(l)) saveLines.push(i + 1);
    });
    check('契约2 找到 9 处 store.save()', saveLines.length === 9, `${saveLines.length} 处：${saveLines.join(',')}`);

    // 判断每一处是否在 try 块内：向上找最近的 try，且中间没有闭合的 }
    const inTry = (ln) => {
      let depth = 0;
      for (let i = ln - 2; i >= 0; i -= 1) {
        const line = lines[i];
        for (let c = line.length - 1; c >= 0; c -= 1) {
          const ch = line[c];
          if (ch === '}') depth += 1;
          else if (ch === '{') {
            if (depth === 0) {
              // 找到块开头，看它是不是 try 的块
              const before = line.slice(0, c);
              return /\btry\s*$/.test(before.trim()) || /\btry\s*\{/.test(before);
            }
            depth -= 1;
          }
        }
      }
      return false;
    };

    const unprotected = saveLines.filter((ln) => !inTry(ln));
    check('契约2 9 处 save() 全部在 try 块内', unprotected.length === 0,
      unprotected.length ? `未接住：L${unprotected.join(', L')}` : '全部已接住');

    // 「吞掉」检查：空 catch、catch 里只有注释、catch 里 return 成功
    const emptyCatch = [...indexSrc.matchAll(/catch\s*(?:\([^)]*\))?\s*\{\s*\}/g)].length;
    check('契约2 没有空 catch 块（吞异常）', emptyCatch === 0, `${emptyCatch} 处`);

    // catch 里只有注释也算吞
    const commentOnlyCatch = [...indexSrc.matchAll(/catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\/[^\n]*\s*)*\}/g)].length;
    check('契约2 没有「只有注释」的 catch 块', commentOnlyCatch === 0, `${commentOnlyCatch} 处`);

    // 每个接住 save() 的 try 必须有对应 catch，且 catch 里要留痕（logger 或 sendJson 错误）
    const hasLogInCatch = /catch[\s\S]{0,400}?logger\.(error|warn)/.test(indexSrc);
    check('契约2 catch 里至少有一处 logger.error/warn 留痕', hasLogInCatch,
      hasLogInCatch ? '有留痕' : '**没有任何** catch 写日志 → 静默丢数据风险');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 契约点 3：注入视图用 store.recallable()，不自写过滤
// ══════════════════════════════════════════════════════════════════════════
{
  if (!indexSrc) {
    skip('契约3 注入视图', '读不到 lib/index.js');
  } else {
    const usesRecallable = /store\.recallable\('shared'\)/.test(indexSrc);
    const usesActive = /store\.active\('shared'\)/.test(indexSrc);
    check('契约3 注入视图用 store.recallable()', usesRecallable,
      usesRecallable ? '已改' : '**仍是** store.active() → resolved 进不了注入');
    check('契约3 不再用 store.active() 做注入视图', !usesActive,
      usesActive ? '仍有 store.active(\'shared\') 调用' : '已无');

    // 自写过滤检查：**注入路径**不该出现手写的 status 过滤。
    // 注意别把 /snapshot 的计数代码算进来 —— `counts: { archived: all.filter(...) }`
    // 只是统计展示，不参与注入决策，把它算成违规是误报（我第一版就误报了）。
    // 所以只扫「注入相关行」：附近 30 行内出现 selectLayeredMemories 或 text: (context)
    // 或 formatLongMemoryBlock 的地方。
    const lines = indexSrc.split('\n');
    const injectRanges = [];
    lines.forEach((l, i) => {
      if (/selectLayeredMemories|formatLongMemoryBlock|text:\s*\(context\)/.test(l)) {
        injectRanges.push([Math.max(0, i - 30), Math.min(lines.length - 1, i + 30)]);
      }
    });
    const inInjectRange = (i) => injectRanges.some(([a, b]) => i >= a && i <= b);
    const selfFilter = [];
    lines.forEach((l, i) => {
      if (!inInjectRange(i)) return;
      if (/^\s*\/\//.test(l)) return;
      if (/status\s*(?:===|!==)\s*'(?:archived|superseded)'/.test(l)) selfFilter.push(`L${i + 1}: ${l.trim()}`);
    });
    check('契约3 注入路径没有自写 archived/superseded 过滤（应统一走 recallableList）',
      selfFilter.length === 0, selfFilter.length ? selfFilter.join(' | ') : '无');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 契约点 4：改 recallable 后 archived 仍不进注入（动态，真实读盘链路）
// ══════════════════════════════════════════════════════════════════════════
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract4-'));
  const file = path.join(dir, 'memory.json');
  const store = new MemoryStore(file);
  store.load();
  const bucket = store.bucket('shared');
  // 造 8 条、maxEntries=3 → 3 active + 5 archived
  for (let i = 1; i <= 8; i += 1) {
    upsertLongMemory(bucket, { text: `契约核对归档第 ${i} 条`, kind: 'fact' }, { maxEntries: 3, maxArchived: 200 });
  }
  store.save();

  const reread = new MemoryStore(file);
  reread.load();
  const all = reread.all('shared');
  const archived = all.filter((m) => m.status === 'archived');
  check('契约4 前提：磁盘上有 archived 条目', archived.length === 5, `${archived.length} 条`);

  // recallable 视图不能含 archived
  const rec = recallableList(all);
  check('契约4 recallableList 不含 archived',
    rec.every((m) => m.status !== 'archived'), rec.map((m) => m.status).join(','));
  check('契约4 store.recallable() 与 recallableList 结果一致',
    reread.recallable('shared').length === rec.length,
    `${reread.recallable('shared').length} vs ${rec.length}`);

  // 注入（用归档原文当查询词，最容易被误召回）
  const injected = selectLayeredMemories(reread.recallable('shared'), '契约核对归档第 1 条', { limit: 12 });
  const picked = injected.picked ?? injected;
  const ids = new Set((Array.isArray(picked) ? picked : []).map((m) => m.id));
  const leaked = archived.filter((m) => ids.has(m.id));
  check('契约4 archived 不漏进注入（用归档原文当查询词）', leaked.length === 0,
    leaked.length ? `泄漏 ${leaked.length} 条` : '零泄漏');

  // 如果宿主真的用了 store.active()（而不是 recallable），resolved 会进不了注入 ——
  // 这里顺带验证 recallable 确实比 active 多收了 resolved
  const list2 = [];
  upsertLongMemory(list2, { text: '契约核对已结案的一条', kind: 'event' });
  list2[0].status = 'resolved';
  list2[0].resolvedAt = Date.now();
  check('契约4 recallable 能收到 resolved（active 收不到）',
    recallableList(list2).length === 1 && list2.filter((m) => m.status === 'active').length === 0,
    `recallable=${recallableList(list2).length} active=${list2.filter((m) => m.status === 'active').length}`);
}

// ══════════════════════════════════════════════════════════════════════════
// 契约点 5：textLength 与 audit 一致（真实读盘链路 156 字 → 截到 120 → 仍报）
// ══════════════════════════════════════════════════════════════════════════
{
  const longText =
    '阿风说他下周要去北京出差，顺便见一下那边的老朋友，然后可能还要去趟天津看一个同学，' +
    '中间大概会在北京待三天左右，住的地方还没定，说要看看有没有离地铁近一点的酒店，' +
    '另外他提到这次出差可能要带不少东西，问我要不要帮他想一下行李清单，还有回来之后想约个时间一起吃饭。';
  check('契约5 测试正文确实超过 120 字', longText.length > 120, `${longText.length} 字`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract5-'));
  const file = path.join(dir, 'memory.json');
  // 直接把长文写进磁盘（模拟「用户手工编辑 / 老版本写入」的真实形态）
  fs.writeFileSync(
    file,
    JSON.stringify(
      { version: 3, buckets: { shared: [{ id: 'lm-c5', text: longText, kind: 'fact', createdAt: 1700000000000 }] }, meta: {} },
      null,
      2
    ),
    'utf8'
  );

  const store = new MemoryStore(file);
  store.load();
  const m = store.bucket('shared')[0];
  check('契约5 读盘后正文被截到 ≤120', m.text.length <= 120, `${m.text.length} 字`);
  check('契约5 读盘后 textLength 记下原始长度', m.textLength === longText.length,
    `textLength=${m.textLength}，原文 ${longText.length}`);

  const res = auditStore(store.all('shared'));
  const hit = res.findings.find((f) => f.code === 'text-truncated');
  check('契约5 audit 在真实读盘链路上仍报 text-truncated', !!hit,
    hit ? hit.message : '**没报** → 这条检查又变成死代码');
  check('契约5 报告里带原始长度', hit && Number(hit.textLength) === longText.length,
    String(hit?.textLength));
  check('契约5 报告带「怎么办」', !!hit?.fix, String(hit?.fix).slice(0, 28));
}

console.log(out.join('\n'));
const pass = out.filter((l) => l.startsWith('PASS')).length;
const failCount = out.filter((l) => l.startsWith('FAIL')).length;
const skipCount = out.filter((l) => l.startsWith('SKIP')).length;
console.log(
  `\n契约核对：${pass} 通过 · ${failCount} 失败 · ${skipCount} 跳过` +
    (failCount === 0 ? '（全部对齐）' : '（有未对齐项，见上）')
);
if (failCount > 0) process.exitCode = 1;

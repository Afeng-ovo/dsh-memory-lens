// 静态断言：禁止 DSH 不支持的 schema 写法。
//
// 【为什么需要这个文件】
// 2026-11-03 的 404 事故根因是 tools.js 里写了 `type: ['string','null']`。
// 但 test/_dsh-tools-stub.mjs 把 defineTool 换成了 `(def) => def` —— 真正的
// schema 校验在 CI 里从来没跑过。所以那个 bug 能在 CI 全绿的情况下发布出去。
//
// 这个文件补上那道闸：直接扫源码，禁止已知会让 DSH 抛 JsonSchemaError 的写法。
// 它不需要 defineTool，所以不受替身影响。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\//, '');
const LIB = join(ROOT, 'lib');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '\n      ' + detail : ''}`); }
};

// 递归收集 lib/ 下所有 .js，并剥掉注释行。
// 为什么必须剥注释：本仓库的注释里大量引用了「错误写法长什么样」当反面教材
// （比如 index.js 里就写着 `type: ['string','null']` 是错的），不剥的话
// 断言会把注释当成真代码，报出一堆假红 —— 而假红会让人习惯性忽略这个测试。
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.js')) files.push(p);
  }
};
walk(LIB);

// 把注释替换成等量空白（保留换行，行号才对得上）
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));

console.log(`扫描 ${files.length} 个文件\n`);

// ── 规则 1：禁止 type 数组 ────────────────────────────────────────────
// DSH 的 schema.js 只接受单一字符串：`type: 'string'`。
// `type: ['string','null']` 会被 assertSupportedJsonSchema 拒绝。
{
  const bad = [];
  for (const f of files) {
    const src = stripComments(readFileSync(f, 'utf8'));
    const re = /\btype\s*:\s*\[\s*['"]/g;
    let m;
    while ((m = re.exec(src))) {
      const line = src.slice(0, m.index).split('\n').length;
      bad.push(`${f.replace(ROOT, 'lib')}:${line}  ${src.slice(m.index, m.index + 60).split('\n')[0]}`);
    }
  }
  check('lib/ 下没有 `type: [...]` 数组写法', bad.length === 0, bad.join('\n      '));
}

// ── 规则 2：object 类型的 schema 必须显式写 additionalProperties ──────
// DSH 的 schema.js:150 要求 object 节点必须有布尔 additionalProperties。
{
  const bad = [];
  for (const f of files) {
    const src = stripComments(readFileSync(f, 'utf8'));
    const re = /\btype\s*:\s*['"]object['"]/g;
    let m;
    while ((m = re.exec(src))) {
      const window = src.slice(m.index, m.index + 400);
      if (!/additionalProperties\s*:/.test(window)) {
        const line = src.slice(0, m.index).split('\n').length;
        bad.push(`${f.replace(ROOT, 'lib')}:${line}  type:'object' 附近未见 additionalProperties`);
      }
    }
  }
  check('object 类型的 schema 都显式声明了 additionalProperties',
    bad.length === 0, bad.join('\n      '));
}

// ── 规则 3：裸 type:'null' 要改用 oneOf ──────────────────────────────
//
// 注意：`oneOf: [{ type: 'string' }, { type: 'null' }]` 是**正确**写法，
// 必须放行。只有把 'null' 直接当 type 用（`type: 'null'` 或 `type: ['null']`）
// 才是问题 —— 但那种写法规则 1 已经拦了，规则 3 只是把单值写法也堵上。
{
  const bad = [];
  for (const f of files) {
    const src = stripComments(readFileSync(f, 'utf8'));
    const re = /\btype\s*:\s*['"]null['"]/g;
    let m;
    while ((m = re.exec(src))) {
      const line = src.slice(0, m.index).split('\n').length;
      // 判断是否处在某个 `oneOf: [` 的方括号内：往前找最近的 `oneOf: [`，
      // 再看它到当前位置之间方括号是否已经闭合。
      const before = src.slice(0, m.index);
      const lastOneOf = before.lastIndexOf('oneOf');
      let inOneOf = false;
      if (lastOneOf !== -1) {
        const seg = before.slice(lastOneOf);
        // 数方括号：还没闭合说明仍在 oneOf 数组里
        let depth = 0;
        for (const ch of seg) {
          if (ch === '[') depth++;
          else if (ch === ']') depth--;
        }
        inOneOf = depth > 0;
      }
      if (inOneOf) continue;  // oneOf 分支里的 type:'null' 是正确写法，放行
      bad.push(`${f.replace(ROOT, 'lib')}:${line}  type:'null'（可空应改用 oneOf）`);
    }
  }
  check("lib/ 下没有裸 type:'null'（可空必须用 oneOf）", bad.length === 0, bad.join('\n      '));
}

console.log(`\n${'='.repeat(50)}`);
console.log(`通过 ${pass}，失败 ${fail}`);
process.exit(fail > 0 ? 1 : 0);

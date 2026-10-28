// 工具层自检：用假 ctx 收集注册的工具，然后真的调用 execute()。
// 不连 DSH 也能跑 —— 工具逻辑本身就该能在宿主之外验证，否则每次改动都要
// 重启 DSH 才看得见结果，改三个字等半分钟，没人愿意这么干活。
//
// `@deepseek-ai/dsh-tools` 是宿主（Electron asar 内部）提供的包，纯 node 里解析不到。
// 替身装在 ./_dsh-tools-stub.mjs 里（和 host.test.mjs 共用一份，**不往发布包里塞 node_modules**）。
import './_dsh-tools-stub.mjs';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { MemoryStore } = await import('../lib/store.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memlens-tools-'));
const file = path.join(tmp, 'memory.json');
fs.writeFileSync(file, JSON.stringify({ version: 1, buckets: { shared: [] } }));

const registered = new Map();
const ctx = {
  tools: {
    register(tool) {
      registered.set(tool.name, tool);
    }
  }
};

const { registerMemoryTools } = await import('../lib/tools.js');
const store = new MemoryStore(file);
registerMemoryTools(ctx, { store, config: { maxEntries: 1000 } });

const out = [];
const check = (name, cond, extra = '') => {
  out.push(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
};

check('注册了三个工具', registered.size === 3, [...registered.keys()].join(','));
check('工具名正确', ['remember', 'recall', 'forget'].every((n) => registered.has(n)));

const call = async (name, args) => {
  const tool = registered.get(name);
  return await tool.execute({ args });
};

// 1. remember 新建
const r1 = await call('remember', {
  text: '阿风在准备考研，目标是计算机专业',
  kind: 'fact',
  tags: ['学业', '考研'],
  weight: 4
});
check('remember 新建成功', r1.ok === true && r1.action === 'created', JSON.stringify(r1));
check('返回了 id', typeof r1.id === 'string' && r1.id.startsWith('lm-'));

// 2. 落盘验证
const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
check('已落盘', onDisk.buckets.shared.length === 1);
check('落盘内容正确', onDisk.buckets.shared[0].text.includes('考研'));
check('标签已保存', (onDisk.buckets.shared[0].tags ?? []).includes('考研'));

// 3. remember 带 dueAt
const r2 = await call('remember', {
  text: '阿风答应周六之前把简历发给学长',
  kind: 'promise',
  tags: ['约定'],
  dueAt: '2026-11-01'
});
check('带 dueAt 成功', r2.ok === true, JSON.stringify(r2));
const withDue = store.bucket('shared').find((m) => m.id === r2.id);
check('dueAt 归一成 {when,date,ts}', !!withDue?.dueAt && typeof withDue.dueAt.ts === 'number', JSON.stringify(withDue?.dueAt));

// 4. recall 检索
const r3 = await call('recall', { query: '考研' });
check('recall 命中', r3.ok === true && r3.count >= 1, `count=${r3.count}`);
check('recall 第一条相关', r3.items[0].text.includes('考研'), r3.items[0]?.text);
check('recall 的 dueAt 是字符串或 undefined', r3.items.every((it) => it.dueAt === undefined || typeof it.dueAt === 'string'));

// 5. recall 检索会 touch（hits 增加）
const before = store.bucket('shared').find((m) => m.id === r1.id).hits;
await call('recall', { query: '考研' });
const after = store.bucket('shared').find((m) => m.id === r1.id).hits;
check('recall 会记「用过了」', after > before, `${before} → ${after}`);

// 6. 敏感信息拦截
const r4 = await call('remember', { text: '阿风的手机号是 13812345678' });
check('拦截手机号', r4.ok === false && /敏感|脱敏|手机号/.test(r4.error ?? ''), r4.error);

// 7. 空文本
const r5 = await call('remember', { text: '   ' });
check('空文本被拒', r5.ok === false);

// 8. supersedes 取代旧条
const r6 = await call('remember', {
  text: '阿风考研目标改成了软件工程',
  kind: 'fact',
  tags: ['学业', '考研'],
  supersedes: [r1.id]
});
check('supersedes 成功', r6.ok === true, JSON.stringify(r6.action));
const oldOne = store.bucket('shared').find((m) => m.id === r1.id);
check('旧条目标为已取代', oldOne?.status === 'superseded', oldOne?.status);
check('旧条目没被删除', !!oldOne);

// 9. forget resolve
const r7 = await call('forget', { id: r2.id, mode: 'resolve', note: '已经发了' });
check('resolve 结案成功', r7.ok === true && r7.action === 'resolved', JSON.stringify(r7));
const resolvedOne = store.bucket('shared').find((m) => m.id === r2.id);
check('状态变 resolved', resolvedOne?.status === 'resolved', resolvedOne?.status);
check('结案备注已存', resolvedOne?.resolveNote === '已经发了', resolvedOne?.resolveNote);

// 10. 重复结案要报错
const r8 = await call('forget', { id: r2.id, mode: 'resolve' });
check('重复结案报错', r8.ok === false, r8.error);

// 11. forget delete
const r9 = await call('forget', { text: '软件工程', mode: 'delete' });
check('delete 删除成功', r9.ok === true && r9.action === 'deleted', JSON.stringify(r9));
check('真的从库里消失', !store.bucket('shared').some((m) => m.text.includes('软件工程')));

// 12. delete 不存在的要报错而不是静默成功
const r10 = await call('forget', { text: '这条根本不存在', mode: 'delete' });
check('删不存在报错', r10.ok === false);

// 13. 重新加载后数据还在（模拟重启）
const store2 = new MemoryStore(file);
check('重启后能读回', store2.bucket('shared').length === store.bucket('shared').length, `${store2.bucket('shared').length} 条`);

// 14. 宿主渲染契约。
//
// 这一组是补一个真实的漏洞：0.1.0 发布时三个工具都只写了 `output.schema`、没写
// `output.render`，而宿主 `defineTool` 里是 `const userRender = options.output.render;`
// —— undefined 被带进闭包，等到真渲染时抛
// `tool "remember" returned invalid output: output.render failed: userRender is not a function`。
// 更糟的是 execute 已经跑完、记忆已经落盘，用户收到的却是错误 → 以为没记上 → 再说一遍 → 库里两条。
//
// 原来 26 项为什么全绿却漏掉它：`call()` 只调 `tool.execute()`，从没碰过 `tool.output.render`。
// 测的是「逻辑对不对」，没测「宿主认不认」—— 而用户遇到的恰恰是后者。
const walkLossless = (value) => {
  // 照抄宿主 @deepseek-ai/dsh-util-values 的 walkJsonValue 判定：
  // undefined / 函数 / 符号 / 非有限数 / -0 / 环引用 / 非纯原型 一律不是无损 JSON。
  // 测试里必须自带一份，因为宿主包在 Electron asar 内部，CI 上拿不到。
  const tasks = [{ kind: 'visit', value }];
  const ancestors = new Set();
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.kind === 'leave') {
      ancestors.delete(task.source);
      continue;
    }
    if (task.kind === 'array-item') {
      if (!Object.prototype.hasOwnProperty.call(task.source, task.index)) return false;
      tasks.push({ kind: 'visit', value: task.source[task.index] });
      continue;
    }
    if (task.kind === 'object-property') {
      tasks.push({ kind: 'visit', value: task.source[task.key] });
      continue;
    }
    const current = task.value;
    if (current === null) continue;
    if (typeof current === 'boolean' || typeof current === 'string') continue;
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || Object.is(current, -0)) return false;
      continue;
    }
    if (typeof current !== 'object') return false;
    if (ancestors.has(current)) return false;
    ancestors.add(current);
    tasks.push({ kind: 'leave', source: current });
    if (Array.isArray(current)) {
      if (Object.getPrototypeOf(current) !== Array.prototype) return false;
      for (let i = current.length - 1; i >= 0; i--) tasks.push({ kind: 'array-item', source: current, index: i });
      continue;
    }
    if (Object.getPrototypeOf(current) !== Object.prototype) return false;
    for (const key of Object.keys(current)) tasks.push({ kind: 'object-property', source: current, key });
  }
  return true;
};

const isContentBlocks = (value) =>
  Array.isArray(value) && value.length > 0 && value.every((b) => b && typeof b === 'object' && typeof b.type === 'string');

check(
  '三个工具都声明了 output.render',
  ['remember', 'recall', 'forget'].every((n) => typeof registered.get(n).output?.render === 'function'),
  '缺 render 会让每次调用在渲染阶段失败'
);

// 无期限的记忆（绝大多数）与有期限的记忆都要跑一遍 —— 第二个缺陷只在没有 dueAt 时触发。
const rDue = await call('remember', { text: '下周三提醒阿风交实验报告', kind: 'promise', dueAt: '2026-11-04' });
check('写入带期限的约定', rDue.ok === true, JSON.stringify(rDue));
const rPlain = await call('remember', { text: '阿风家窗外有棵玉兰', kind: 'fact' });
check('写入无期限的事实', rPlain.ok === true, JSON.stringify(rPlain));

for (const [name, args] of [
  ['remember', { text: '阿风喜欢在深夜写代码', kind: 'pref' }],
  ['recall', { query: '阿风' }],
  ['recall', { query: '完全不存在的关键词zzz' }],
  ['forget', { id: rPlain.id, mode: 'resolve' }],
  ['forget', { text: '根本没有这条', mode: 'delete' }]
]) {
  const tool = registered.get(name);
  const value = await tool.execute({ args });
  // ① execute 的返回值必须无损 —— `{ dueAt: undefined }` 就是在这里被判死的
  check(`${name} 返回值是无损 JSON`, walkLossless(value), JSON.stringify(value).slice(0, 120));
  // ② render 必须能跑通并交出内容块数组（宿主 assertRenderedContent 的同一把尺）
  let rendered;
  try {
    rendered = tool.output.render(args, value);
  } catch (error) {
    check(`${name} render 不抛错`, false, error.message);
    continue;
  }
  check(`${name} render 不抛错`, true);
  check(`${name} render 返回内容块数组`, isContentBlocks(rendered), JSON.stringify(rendered).slice(0, 120));
  check(`${name} render 结果是无损 JSON`, walkLossless(rendered));
}

// 15. 失败路径也要能渲染 —— 报错时若 render 崩了，用户看到的是宿主错误而不是真正的原因
const failed = await call('remember', { text: '   ' });
check('空正文写入失败', failed.ok === false);
const failedRender = registered.get('remember').output.render({ text: '   ' }, failed);
check('失败结果也能渲染出可读文字', isContentBlocks(failedRender) && failedRender[0].text.includes('没记住'), failedRender?.[0]?.text);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(out.join('\n'));
console.log(`\n${out.filter((l) => l.startsWith('✓')).length}/${out.length} 项通过`);

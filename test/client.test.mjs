// 客户端半的装配自检。
//
// 为什么值得单独写一个：客户端半的产物格式（window.__ModuleLoader__.load + factory）
// 是 DSH 的私有约定，写错了不会在构建期报错 —— 浏览器里只会静默不出现那个设置页，
// 而开发者看到的日志是干净的。所以这里用假 loader / 假 React 把 factory 真跑一遍，
// 至少保证「模块能求值、apply 会注册、注册的字段名对得上宿主投影」。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8');

// ── 假 React：只要能让组件定义阶段不炸就行，这里不渲染 ────────────────────
function fakeReact() {
  const passthrough = (tag) => function Stub(props) {
    return { $$typeof: Symbol.for('react.element'), type: tag, props };
  };
  const React = {
    createElement: (type, props, ...children) => ({
      $$typeof: Symbol.for('react.element'),
      type,
      props: { ...props, children: children.length <= 1 ? children[0] : children }
    }),
    Fragment: Symbol.for('react.fragment'),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (init) => ({ current: init }),
    useCallback: (fn) => fn,
    useLayoutEffect: () => {},
    memo: (c) => c,
    forwardRef: (c) => c,
    startTransition: (fn) => fn()
  };
  React.default = React;
  for (const tag of ['div', 'span', 'button', 'input', 'select', 'option', 'label', 'p', 'h1', 'h2', 'h3', 'ul', 'li', 'canvas', 'table', 'tbody', 'tr', 'td', 'th', 'details', 'summary', 'textarea']) {
    React[tag] = passthrough(tag);
  }
  return React;
}

// ── 假 __ModuleLoader__：把 factory 求值出来，并记录 load 的元信息 ──────────
const loads = [];
const sandbox = {
  window: {},
  document: { baseURI: 'http://dsh.internal/', getElementById: () => null },
  console,
  setTimeout,
  clearTimeout,
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  URL,
  fetch: async () => ({ json: async () => ({ ok: true }), ok: true }),
  devicePixelRatio: 1,
  Intl,
  Date,
  Math
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.window.__ModuleLoader__ = {
  load(meta) {
    loads.push(meta);
    return meta;
  }
};

vm.createContext(sandbox);
vm.runInContext(SRC, sandbox, { filename: 'lib/client.js' });

// ── 断言 1：模块契约 ─────────────────────────────────────────────────────
assert.equal(loads.length, 1, 'lib/client.js 必须只调用一次 __ModuleLoader__.load');
const meta = loads[0];
assert.equal(typeof meta.id, 'string', 'load() 必须带 id');
assert.ok(meta.id.length > 0, 'load() 的 id 不能为空');
assert.equal(typeof meta.factory, 'function', 'load() 必须带 factory 函数');

// ── 断言 2：factory 能被求值，返回带 apply 的模块 ───────────────────────
const module = meta.factory((spec) => {
  if (spec === 'react') return fakeReact();
  throw new Error(`未知依赖 ${spec}`);
});
assert.equal(typeof module, 'object', 'factory 必须返回模块对象');
assert.equal(typeof module.apply, 'function', '客户端模块必须导出 apply(ctx)');
assert.ok(Array.isArray(module.inject), '模块应声明 inject');
assert.ok(module.inject.includes('slots'), '模块必须声明依赖 slots');

// ── 断言 3：apply 会往 settings.section 注册，且字段符合宿主投影 ────────
const registered = [];
const ctx = {
  slots: {
    inject(slot, fn) {
      assert.equal(slot, 'settings.section', '必须挂到 settings.section');
      return fn();
    },
    register(options, Component) {
      registered.push({ options, Component });
      return () => {};
    }
  },
  effect(fn) {
    return fn();
  },
  logger: { warn() {}, info() {}, error() {} }
};
module.apply(ctx);

assert.equal(registered.length, 1, 'apply 应注册且只注册一个 settings.section');
const { options, Component } = registered[0];
assert.equal(options.name, 'settings.section', 'register 的 name 必须是 settings.section');
assert.equal(typeof options.id, 'string', 'settings.section 必须有 id（导航 key）');
assert.ok(options.id.length > 0, 'id 不能为空');
assert.equal(typeof options.order, 'number', 'order 必须是数字，否则排序未定义');
assert.ok(options.label !== undefined, 'label 必须存在（导航文案）');
const labelValue = typeof options.label === 'function' ? options.label() : options.label;
assert.equal(typeof labelValue, 'string', 'label 求值后必须是字符串');
assert.ok(labelValue.length > 0, 'label 不能是空字符串');
assert.equal(typeof Component, 'function', '第二个参数必须是组件函数');

// 宿主只投影 id / order / label / locale 四个字段，多写的字段不会生效 ——
// 这里显式盯一下，避免以后误以为能靠自定义字段改行为。
const projected = new Set(['id', 'order', 'label', 'locale']);
const extra = Object.keys(options).filter((k) => !projected.has(k) && k !== 'name');
assert.deepEqual(extra, [], `settings.section 上有宿主不投影的字段：${extra.join(', ')}`);

// ── 断言 4：渲染循环不许无条件续帧 ──────────────────────────────────────
// 为什么这条必须存在：原来 frame() 每帧无条件 requestAnimationFrame，力学早就收敛、
// 画面完全静止，却仍然 60 次/秒重画几百个点。真机量出来静置就吃掉 12%~36% 主线程
// （332 条记忆、暂停旋转后仍是 36.8%），用户感知就是「装上这个插件之后很卡」。
// 这种缺陷单元测试抓不到（不渲染就不跑帧），只能静态盯住「续帧必须被条件包住」。
const frameStart = SRC.indexOf('const frame = (');
assert.ok(frameStart > 0, 'lib/client.js 里必须能找到 frame 定义');
const frameEnd = SRC.indexOf('\n        };', frameStart);
assert.ok(frameEnd > frameStart, 'frame 函数体必须能被定位（缩进变了就要同步改这里）');
const frameBody = SRC.slice(frameStart, frameEnd);
assert.ok(
  frameBody.includes('if (needsFrame()) P.raf = requestAnimationFrame(frame);'),
  'frame() 末尾必须用 needsFrame() 包住续帧 —— 无条件续帧会让静止的画面也一直重绘'
);
// 裸续帧 = 整行只有这一句（前面没有任何条件），逐行判，别用「以它结尾」这种松判据：
// 正确写法 `if (needsFrame()) P.raf = requestAnimationFrame(frame);` 也以它结尾。
const bareContinue = frameBody
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line === 'P.raf = requestAnimationFrame(frame);');
assert.deepEqual(bareContinue, [], 'frame() 里不能有裸的 requestAnimationFrame 续帧（会被判定为「永远有下一帧」）');

const needsStart = SRC.indexOf('const needsFrame = ()');
assert.ok(needsStart > 0, '必须有 needsFrame() 来判定「画面还会不会变」');
const needsEnd = SRC.indexOf('\n        };', needsStart);
const needsBody = SRC.slice(needsStart, needsEnd);
for (const [needle, why] of [
  ['P.drag || P.orbit', '拖拽/转视角时必须续帧，否则跟不了手'],
  ['P.alpha > 0.004', '力学还在收敛时必须续帧'],
  ['spinRef.current', '自动旋转时必须续帧'],
  ['selRef.current', '选中节点时涟漪在动，必须续帧'],
  ['P.camWant', '相机还在推进时必须续帧，否则停在中途']
]) {
  assert.ok(needsBody.includes(needle), `needsFrame() 少了条件：${why}（缺 ${needle}）`);
}

// 自动旋转时降到 30fps：画面一直在变但没必要每秒重画 60 次。收敛期与拖拽不降。
assert.ok(
  /const minGap = P\.drag \|\| P\.orbit \|\| P\.alpha > 0\.004 \? 0 : 33;/.test(frameBody),
  'frame() 必须有 30fps 限帧（33ms），且收敛期/拖拽时不限帧'
);

// 所有会让画面变的地方都要踢一脚，否则静止后画面停在旧状态。
assert.ok(SRC.includes('P.kick = kick;'), '必须把 kick 挂到 P 上，供各处唤醒');
// 直接 kick() 与经引用调用的 kick?.() 都算唤醒点（拖拽起手/松手、滚轮、双击、尺寸变化、
// 选中或旋转状态切换、复位）。
const kickCalls = SRC.match(/kick\(\)|kick\?\.\(\)/g) || [];
assert.ok(
  kickCalls.length >= 7,
  `唤醒点太少（${kickCalls.length} 处）：拖拽起手/松手、滚轮、双击、尺寸变化、选中或旋转状态切换、复位都要唤醒，否则停帧后画面停在旧状态`
);

// ── 断言 5：包清单与产物对得上 ──────────────────────────────────────────
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
assert.equal(pkg.name, 'dsh-memory-lens');
assert.equal(pkg.exports['./client'].default, './lib/client.js', 'exports["./client"] 必须指向客户端产物');
assert.ok(Array.isArray(pkg.dsh?.client?.inject), 'package.json 必须声明 dsh.client.inject');
assert.equal(pkg.dsh?.manifestVersion, 1, 'manifestVersion 必须是 1');
assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml', '必须声明 bundle patch 文件');
assert.ok(fs.existsSync(path.join(ROOT, 'cordis.patch.yml')), 'cordis.patch.yml 必须存在');

// loader entry 的 id 必须等于 settings 命名空间，否则设置页写入会抛
// `No configurable plugin entry`。这条错在运行期才暴露，所以在这里静态对一下。
const patch = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8');
const idMatch = patch.match(/^\s*-\s*id:\s*(\S+)/m);
assert.ok(idMatch, 'cordis.patch.yml 里必须有 insert entry');
const entryId = idMatch[1];
const indexSrc = fs.readFileSync(path.join(ROOT, 'lib/index.js'), 'utf8');
const nsMatch = indexSrc.match(/NAMESPACE\s*=\s*['"]([^'"]+)['"]/);
assert.ok(nsMatch, 'lib/index.js 必须导出 NAMESPACE 常量');
assert.equal(entryId, nsMatch[1], `cordis.patch.yml 的 entry id (${entryId}) 必须等于 NAMESPACE (${nsMatch[1]})`);

console.log('客户端半装配自检：全部通过');
console.log(`  · 模块 id        ${meta.id}`);
console.log(`  · 注册 slot      ${options.name} / ${options.id}（order ${options.order}，文案「${labelValue}」）`);
console.log(`  · 依赖声明       ${module.inject.join(', ')}`);
console.log(`  · loader entry   ${entryId} = NAMESPACE`);

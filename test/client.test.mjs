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

// ── 断言 5：星图能推到很近（放大倍率）──────────────────────────────────
// 为什么要盯这几条：星图的放大倍率完全由两个数决定 —— 滚轮能推到的 dist 下限，
// 和透视投影里的 zc 地板。原来 dist 下限 0.45、zc 地板 140，滚轮滚到底也只放大约
// 2.2 倍（k ∝ 1/zc ∝ 1/dist，1/0.45 ≈ 2.2），用户反馈「放大倍率不够，看不清」。
// 这类退化不会报错、也不会让别的测试变红 —— 只是「滚到底还是那么大」，所以只能静态守住。
function bodyOf(name) {
  const start = SRC.indexOf(name);
  assert.ok(start > 0, `lib/client.js 里必须能找到 ${name}`);
  // 函数体结束位置按「声明行自身的缩进」来找，不能写死 8 个空格：
  // 这个文件里既有 8 空格缩进的箭头函数（project/draw），也有 4 空格缩进的
  // function 声明（falloutOf/falloutTone）。写死 8 的话，falloutOf 会被截到
  // 下一个 8 空格闭合处 —— 把 ItemCard 整段也吞进来，于是「去掉 active 判断」
  // 之后断言依然通过（因为 ItemCard 里另有一处 item.status !== 'active'）。
  // 反向验证当场抓到了这个假阳性。
  // 两种收尾都要试：箭头函数是 `};`，function 声明是 `}`。取靠前的那个。
  const lineStart = SRC.lastIndexOf('\n', start) + 1;
  const indent = SRC.slice(lineStart, start);
  const candidates = [`\n${indent}};`, `\n${indent}}`]
    .map((t) => SRC.indexOf(t, start))
    .filter((i) => i > start);
  assert.ok(candidates.length > 0, `${name} 的函数体必须能被定位（缩进变了就要同步改这里）`);
  const end = Math.min(...candidates);
  return SRC.slice(start, end);
}

// 注释里会提到旧值（「从 0.45 放宽到 0.12」这类说明是要留着的），所以比数值前先剥注释，
// 只比真正会被执行的那几行，否则这条断言会被自己的解释文字顶死。
const codeOnly = (text) => text.replace(/\/\/[^\n]*/g, '');

const wheelCode = codeOnly(bodyOf('const onWheel = (event) => {'));
const distAssign = /P\.dist = Math\.max\([^;]+;/.exec(wheelCode);
assert.ok(distAssign, '滚轮处理器里必须有 `P.dist = Math.max(...)` 的缩放赋值');
const distNums = distAssign[0].match(/\d+(?:\.\d+)?/g) || [];
assert.ok(distNums.length >= 2, `滚轮缩放的「下限/上限」解析不出来（拿到：${distNums.join(', ')}）`);
const distMin = Number(distNums[0]);
const distMax = Number(distNums[1]);
assert.ok(
  distMin <= 0.12,
  `滚轮能推到的最近距离必须 ≤0.12（现在是 ${distMin}）：0.45 只放大约 2.2 倍，滚到底还是看不清`
);
assert.ok(
  distMax >= 3.2,
  `滚轮能拉到的最远距离必须 ≥3.2（现在是 ${distMax}）：上限收得太小，「拉远看全貌」就不够用`
);
assert.ok(!wheelCode.includes('0.45'), '滚轮不能再用 0.45 当缩放下限（旧值，只能放大 2.2 倍）');
assert.ok(!wheelCode.includes('2.6'), '滚轮不能再用 2.6 当缩放上限（旧值，拉远看全貌不够）');

// 底部提示条要说明「能推到很近」：能力做出来了但没人知道，等于没做。
assert.ok(
  /滚轮[^']*很近/.test(SRC),
  '底部提示条必须写明「滚轮缩放可推到很近」，否则用户不知道能放大到那么近'
);

const projectCode = codeOnly(bodyOf('const project = (node) => {'));
assert.ok(
  /zcRaw = z2 \+ P\.camDist/.test(projectCode),
  'project() 里必须用 zcRaw = z2 + P.camDist（behind 判定和 zc 地板都建在它上面）'
);
assert.ok(
  /const zc = Math\.max\(60,\s*zcRaw\);/.test(projectCode),
  'zc 地板必须是 60（`const zc = Math.max(60, zcRaw);`）：140 时相机推到最近焦距仍被地板卡住，放不大多少'
);
assert.ok(!/Math\.max\(140/.test(projectCode), 'zc 地板不能退回 140（旧值）');
assert.ok(
  /behind:\s*zcRaw\s*<\s*24/.test(projectCode),
  'project() 必须返回 behind 标记（zcRaw < 24 即节点已跑到相机背后），供绘制阶段裁掉'
);

// 裁掉「跑到相机背后」的东西不是可选项：z 越过相机后 k 会爆掉，
// 一个点就能以极大半径糊满整屏，连线也会拉成横穿画面的长条。
const drawCode = codeOnly(bodyOf('const draw = () => {'));
assert.ok(
  /\.filter\(\(it\) => !it\.p\.behind\)/.test(drawCode),
  'draw() 必须把跑到相机背后的节点滤掉（.filter((it) => !it.p.behind)），否则它糊住整屏'
);
assert.ok(
  /\.filter\(\(e\) => e\.pa && e\.pb && !e\.pa\.behind && !e\.pb\.behind\)/.test(drawCode),
  'draw() 必须把端点跑到相机背后的边滤掉（e.pa/e.pb 的 behind），否则连线会拉到错误的位置'
);

// ── 断言 6：剩余天数与「快过期」视图 ────────────────────────────────────
// 为什么要盯这些：这两件事都是「看得见才生效」的功能 —— 剩余天数算错了不会报错，
// 只是显示的数和归档逻辑对不上；「快过期」视图如果漏了 status 判断，就会给一条
// 早已被取代的记忆挂上「还有 23 天」，用户会以为它还会回来。全都静默，只能静态守。

// ① 天数绝不重算：snapshot 里的 falloutInDays 是内核算好的成品值（1 位小数）。
// 前端要是自己再推一遍半衰期，两边各算一遍必然分叉 —— 差几毫秒或以后有人调了阈值，
// 就会出现「它明明说还有 5 天，怎么就没了」。
const falloutBlock = SRC.slice(SRC.indexOf('const FALLOUT_NEAR'), SRC.indexOf('function ItemCard'));
assert.ok(falloutBlock.length > 0, 'lib/client.js 里必须能找到剩余天数的常量与辅助函数');
assert.ok(
  /const FALLOUT_NEAR = 7;/.test(falloutBlock),
  'FALLOUT_NEAR 必须是 7（≤7 天算「真的要管了」）'
);
assert.ok(
  /const FALLOUT_SOON = 30;/.test(falloutBlock),
  'FALLOUT_SOON 必须是 30 —— 这是用户明确要的口径（「＜30天的记忆」），不能为显得有内容就放宽'
);
// 重算的痕迹：客户端里出现半衰期表或 Math.pow(0.5, ...) 就说明它自己推了一遍。
assert.ok(
  !/Math\.pow\(0\.5/.test(codeOnly(SRC)),
  '客户端不得自己重算衰减（发现 Math.pow(0.5, ...)）：falloutInDays 直接用 snapshot 的成品值'
);
assert.ok(
  !/DEFAULT_HALF_LIFE_DAYS/.test(codeOnly(SRC)),
  '客户端不得内置半衰期表（发现 DEFAULT_HALF_LIFE_DAYS）：两处各算一遍必然和归档逻辑分叉'
);

// ② 只有 active 才倒计时。实测 34 条里有 2 条 superseded 也带着 falloutInDays（23.3 / 30.5），
// 给它们挂倒计时是纯误导。
const falloutOfBody = bodyOf('function falloutOf(item) {');
assert.ok(
  /item\.status !== 'active'/.test(codeOnly(falloutOfBody)) && /return null/.test(codeOnly(falloutOfBody)),
  'falloutOf() 必须对非 active 条目返回 null（已归档/已结案/已取代的条目不会因到期而淡出，挂倒计时是误导）'
);

// ③ 三档分色必须真的分出来，且文案不能把 0 天编造成「约 0 天后淡忘」。
const toneBody = codeOnly(bodyOf('function falloutTone(days) {'));
for (const [needle, why] of [
  ["'urgent'", '≤7 天必须是最急那一档（红）'],
  ["'warn'", '8~30 天必须是中间档（橙）'],
  ["'far'", '>30 天必须是中性档'],
  ['FALLOUT_NEAR', 'urgent 档必须以 FALLOUT_NEAR 为界，不能写死 7'],
  ['FALLOUT_SOON', 'warn 档必须以 FALLOUT_SOON 为界，不能写死 30']
]) {
  assert.ok(toneBody.includes(needle), `falloutTone() 少了 ${needle}：${why}`);
}
const textBody = codeOnly(bodyOf('function falloutText(days) {'));
assert.ok(
  /days <= 0/.test(textBody) && textBody.includes('已到淡忘线'),
  'falloutText() 对 0 或负数必须说「已到淡忘线」，不能说「约 0 天后淡忘」（那是句废话）'
);
assert.ok(
  textBody.includes('天后淡忘'),
  'falloutText() 必须输出「约 N 天后淡忘」这种能据以行动的话，而不是只给个抽象小数'
);

// ④ 钉住 ≠ 不会淡忘。pinLongMemory() 只写 pinned/pinnedAt/pinnedAuto，没碰 weight 和
// lastUsedAt，所以钉住前后 falloutInDays 一模一样；一条钉住但已衰减的条目照样会被
// organizeLongMemories() 归成 archived。钉住买到的是「每轮必进注入」，不是免死金牌。
assert.ok(
  !/不会淡忘/.test(codeOnly(SRC)),
  '不能写「不会淡忘」：实测钉住不豁免衰减（钉住前后 falloutInDays 相同，且照样会被归档）。应说「每轮必进」'
);
// 固定徽章那一行必须自己说清保证了什么。这里只截 pin-badge 那两行来判，
// 不能全局搜「每轮必进」—— 两处徽章文案都含这四个字，全局搜的话把其中一处
// 改回含糊说法也不会报错（反向验证抓到过这个假阳性）。
const badgeAt = SRC.indexOf("className: 'memlens-pin-badge'");
assert.ok(badgeAt > 0, 'ItemCard 必须有固定徽章（memlens-pin-badge）');
// 从 className 之后开始截，否则 className 自己那个字符串字面量也会被当成文案
// （它当然不含「每轮必进」，断言就假失败了）。
const badgeBodyAt = badgeAt + "className: 'memlens-pin-badge'".length;
const badgeSlice = codeOnly(SRC.slice(badgeBodyAt, SRC.indexOf('null,', badgeBodyAt)));
// 两种徽章（手动钉的、自动钉的）都要各自说清，所以把里面的字符串字面量都取出来
// 逐条判，而不是「整段里出现过一次就算」。否则只改坏其中一种也不报错
// （反向验证抓到过这个假阳性）。
const badgeTexts = badgeSlice.match(/'[^']*'/g) || [];
assert.ok(badgeTexts.length >= 2, `固定徽章应有手动/自动两种文案（实际 ${badgeTexts.length} 条）`);
for (const t of badgeTexts) {
  assert.ok(
    t.includes('每轮必进'),
    `固定徽章文案 ${t} 必须写清它到底保证了什么（「每轮必进」），而不是含糊地暗示不会淡忘`
  );
  assert.ok(
    !t.includes('不会淡忘'),
    `固定徽章文案 ${t} 不能写「不会淡忘」：钉住不豁免衰减，这么写是骗人`
  );
}

// ⑤ VIEWS 里要有「快过期」，且排在「记忆列表」之后 —— 用户看完总数，最自然的
// 下一问就是「哪些快没了」；放最后面的话，这条最该被看见的视图反而要点好几次才到。
const viewsStart = SRC.indexOf('const VIEWS = [');
assert.ok(viewsStart > 0, 'lib/client.js 里必须能找到 VIEWS 定义');
const viewsEnd = SRC.indexOf('];', viewsStart);
const viewsBody = SRC.slice(viewsStart, viewsEnd);
assert.ok(
  /key: 'soon', label: '快过期'/.test(viewsBody),
  "VIEWS 里必须有 { key: 'soon', label: '快过期' }"
);
const listAt = viewsBody.indexOf("key: 'list'");
const soonAt = viewsBody.indexOf("key: 'soon'");
assert.ok(listAt > -1 && soonAt > -1, 'VIEWS 必须同时含 list 与 soon');
assert.ok(
  soonAt > listAt,
  '「快过期」必须排在「记忆列表」之后（soonAt > listAt）：它是列表的预筛，不是并列的另一套'
);

// ⑥ 视图与渲染分支必须对得上：VIEWS 里加了 key 却没写分支，点上去就是一屏空白，
// 而且不报错 —— 这是最容易漏的一步。
const soonBranch = SRC.indexOf("view === 'soon'");
assert.ok(soonBranch > 0, "必须有 `view === 'soon'` 的渲染分支，否则点了「快过期」是空白一屏");

// ⑦ 过滤口径：active 且 falloutInDays < 30，按最急的排前面。
// 注意 soon 的 useMemo 定义在组件顶部（算 counts 那里），离渲染分支很远，
// 所以按名字定位它自己，别去截渲染分支前面那一小段 —— 截不到。
const soonStart = SRC.indexOf('const soon = useMemo(');
assert.ok(soonStart > 0, '必须有 `const soon = useMemo(` 来计算快过期清单');
const soonEnd = SRC.indexOf('}, [items]);', soonStart);
assert.ok(soonEnd > soonStart, 'soon 的 useMemo 必须能被定位（写法变了就要同步改这里）');
const soonFilter = codeOnly(SRC.slice(soonStart, soonEnd));
assert.ok(
  /m\.status === 'active'/.test(soonFilter),
  '「快过期」必须只列 active —— 已取代/已归档的条目也带 falloutInDays，但它们不会因到期而淡出'
);
assert.ok(
  /Number\(m\.falloutInDays\) < FALLOUT_SOON/.test(soonFilter),
  '「快过期」的阈值必须是 FALLOUT_SOON（30 天），且用 < 不是 ≤（用户要的是「＜30天」）'
);
assert.ok(
  /Number\(a\.falloutInDays\) - Number\(b\.falloutInDays\)/.test(soonFilter),
  '「快过期」必须按 falloutInDays 升序 —— 最急的排最前面，否则用户还得自己找'
);

// ⑧ 这一屏故意不接搜索框与状态筛选：它的意义是「一份固定口径的清单」，
// 一筛就不再是那个清单了。想看别的维度回「记忆列表」。
const soonViewSlice = SRC.slice(soonBranch, SRC.indexOf(": view === 'inject'", soonBranch));
assert.ok(soonViewSlice.length > 0, '「快过期」渲染分支必须能被定位（分支顺序变了就要同步改这里）');
for (const [needle, why] of [
  ['setQuery', '搜索框状态'],
  ['setStatusFilter', '状态筛选状态'],
  ['memlens-input', '搜索输入框'],
  ['memlens-select', '状态下拉']
]) {
  assert.ok(
    !soonViewSlice.includes(needle),
    `「快过期」不能接${why}（发现 ${needle}）：一筛就不再是那份固定口径的清单了`
  );
}

// ⑨ 空态要说人话。这个视图大部分时间本来就是空的（半衰期调过之后，30 天内会淡忘的
// 通常只有 0~1 条），只写「暂无数据」会让人以为坏了 —— 而它恰恰是好消息。
assert.ok(
  soonViewSlice.includes('最近一条还差') || soonViewSlice.includes('最近的一条还差'),
  '「快过期」的空态必须讲出「最近的一条还差多少天」，否则用户以为这个视图是死的'
);
assert.ok(
  !soonViewSlice.includes('暂无数据'),
  '「快过期」的空态不能只写「暂无数据」：空是正常结果、甚至是好消息，要说得让人不慌'
);

// ⑩ 数量按实际算，不写死。文案里的条数必须来自 soon.length，不能是常量。
// 只截「N 条记忆会在」那一句来判：全局搜 soon.length 的话，把文案写死成常量后
// 排序/过滤那些 useMemo 里还留着 soon.length，断言照样通过（反向验证抓到过）。
const soonCountText = soonViewSlice.slice(soonViewSlice.indexOf('`'), soonViewSlice.indexOf('条记忆会在'));
assert.ok(
  soonViewSlice.includes('${soon.length} 条记忆会在'),
  '「快过期」的数量必须来自 soon.length（按实际算），不能写死'
);

// ── 断言 7：包清单与产物对得上 ──────────────────────────────────────────
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

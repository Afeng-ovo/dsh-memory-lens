// 宿主半的离线装配自检：用最小 ctx 桩把 apply() 跑一遍，确认
// ① 三个服务都被用上（systemPrompt / tools / webServer）
// ② 四条路由真的注册了、且路径与客户端调用的一致
// ③ 系统提示 section 的名字与 order 合法
// ④ 路由的信任栅栏能挡住跨站请求
//
// 这不是「跑起来就行」的冒烟测试：下面每条断言都对着一个具体的失败模式
// （路径写错、order 非数字、跨站放行、注入块没生成）。
// 给 @deepseek-ai/dsh-tools 装替身（宿主提供、纯 node 解析不到）。
// 必须在 import lib/index.js 之前完成 —— 静态 import 按源码顺序求值，所以放第一行。
import './_dsh-tools-stub.mjs';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memlens-host-'));
process.env.DSH_HOME = tmp;

const { apply, Config } = await import('../lib/index.js');

const routes = new Map();
const sections = [];
const tools = [];
const warnings = [];

const ctx = {
  logger: { warn: (...args) => warnings.push(args.join(' ')), info() {}, debug() {} },
  systemPrompt: {
    getSectionOrder: (name) => (name === 'HARNESS_SOURCE' ? 10000 : undefined),
    section: (section) => {
      sections.push(section);
      return () => {};
    }
  },
  tools: { register: (tool) => tools.push(tool) },
  webServer: {
    register: (entry) => {
      routes.set(entry.path, entry);
      return () => {};
    }
  },
  effect: (fn) => fn(),
  // cordis 的 `ctx.inject(deps, cb)` 子 fiber：服务在就立刻跑回调，不在就跳过。
  // 桩里必须真的调 cb，否则路由一条都注册不到，这组断言就变成「验证没做事」。
  inject: (deps, cb) => {
    if (deps.includes('webServer') && !ctx.webServer) return undefined;
    return cb(ctx);
  }
};

apply(ctx, Config({}));

// ── 1. 系统提示 section ────────────────────────────────────────────────
assert.equal(sections.length, 1, '应该只注册一个系统提示 section');
const section = sections[0];
assert.equal(typeof section.name, 'string');
assert.ok(section.name.length > 0, 'section 必须有名字');
assert.ok(Number.isFinite(section.order), 'section.order 必须是有限数字（否则 DSH 会抛错）');
assert.equal(typeof section.text, 'function', 'text 必须是函数：每轮重新取，才能反映最新记忆');

// 空库时注入块应该是空串（不能凭空冒出一句「你记得」）
const emptyText = section.text({});
assert.equal(typeof emptyText, 'string');
assert.equal(emptyText.trim(), '', '空库时不该注入任何内容');

// ── 2. 工具 ───────────────────────────────────────────────────────────
assert.equal(tools.length, 3, '应该注册三个工具');
const names = tools.map((t) => t.name).sort();
assert.deepEqual(names, ['forget', 'recall', 'remember']);

// ── 3. 路由 ───────────────────────────────────────────────────────────
const expected = [
  '/dsh-memory-lens/api/snapshot',
  '/dsh-memory-lens/api/item',
  '/dsh-memory-lens/api/action',
  '/dsh-memory-lens/api/import',
  '/dsh-memory-lens/api/audit',
  '/dsh-memory-lens/api/diff'
];
assert.deepEqual([...routes.keys()].sort(), expected.sort());
for (const [, entry] of routes) assert.equal(entry.kind, 'exact');

// ── 4. 信任栅栏：跨站必须 403，回环同源放行 ─────────────────────────────
function fakeRes() {
  const res = {
    status: 0,
    body: '',
    headers: {},
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? {};
      return this;
    },
    end(text) {
      this.body = String(text ?? '');
      return this;
    }
  };
  return res;
}

async function call(pathname, { method = 'GET', headers = {}, body = null } = {}) {
  const entry = routes.get(pathname);
  const req = {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== null) yield Buffer.from(JSON.stringify(body), 'utf8');
    }
  };
  const res = fakeRes();
  await entry.handler(req, res);
  return res;
}

const LOOPBACK = { host: '127.0.0.1:3100' };

// 正常请求：放行
let res = await call('/dsh-memory-lens/api/snapshot', { headers: LOOPBACK });
assert.equal(res.status, 200, '回环请求应放行');
const snap = JSON.parse(res.body);
assert.equal(snap.ok, true);
assert.ok(Array.isArray(snap.items));
assert.equal(typeof snap.injected.chars, 'number');
assert.equal(typeof snap.injected.budget, 'number');

// 跨站：必须拒绝
res = await call('/dsh-memory-lens/api/snapshot', {
  headers: { ...LOOPBACK, 'sec-fetch-site': 'cross-site' }
});
assert.equal(res.status, 403, 'sec-fetch-site: cross-site 必须 403');

// 非回环 Host：必须拒绝（防止 DNS rebinding）
res = await call('/dsh-memory-lens/api/snapshot', { headers: { host: 'evil.example.com' } });
assert.equal(res.status, 403, '非回环 host 必须 403');

// 跨源 Origin：必须拒绝
res = await call('/dsh-memory-lens/api/snapshot', {
  headers: { ...LOOPBACK, origin: 'https://evil.example.com' }
});
assert.equal(res.status, 403, '跨源 origin 必须 403');

// 桌面端 dsh-app://app 的 origin 是 'null' —— 必须放行，否则设置页一个请求都发不出去
res = await call('/dsh-memory-lens/api/snapshot', { headers: { ...LOOPBACK, origin: 'null' } });
assert.equal(res.status, 200, 'origin=null（桌面端自定义 scheme）必须放行');

// ── 5. 写入 → 注入真的变了 ─────────────────────────────────────────────
res = await call('/dsh-memory-lens/api/item', {
  method: 'POST',
  headers: LOOPBACK,
  body: { text: '阿风在做 QQ 机器人的记忆系统', kind: 'fact', tags: ['项目'], weight: 4 }
});
assert.equal(res.status, 200, '写入应成功');
const created = JSON.parse(res.body);
assert.equal(created.ok, true);
assert.ok(created.id, '应返回 id');

const afterWrite = section.text({});
assert.ok(afterWrite.includes('阿风在做 QQ 机器人的记忆系统'), '写入后系统提示里应出现这条');
assert.ok(afterWrite.length <= 2000, '注入块不能超预算');

// ── 5b. 面板显示的注入块必须和真正注入的逐字相同 ─────────────────────────
//
// 守的是这套系统最不能出的问题：「面板上显示的」和「她真读到的」变成两套真相。
// 一旦有人给面板单独加一套打分/渲染，用户看着面板说「她记得这事」而实际注入里
// 没有，用户永远发现不了 —— 直到某天她真的忘了，也说不清是哪一环出的问题。
//
// 注意这里和四层改造前不同：注入现在依赖**会话内容**（话题层），而 HTTP 请求里
// 没有 agent 上下文 —— 面板如果自己重算，必然和真注入分叉。所以面板改成报告
// lastInjection（上一次装配上下文时真正注入的那一段），这条断言于是变成
// 「面板报的那段，必须等于刚才真注入的那段」。
res = await call('/dsh-memory-lens/api/snapshot', { headers: LOOPBACK });
const snapSame = JSON.parse(res.body);
assert.equal(
  snapSame.injected.block,
  afterWrite,
  '快照里的 injected.block 必须等于最近一次真正注入的内容（不能有两套渲染）'
);
assert.ok(snapSame.injected.at, '快照应带上这次注入的时间戳');
assert.equal(snapSame.injected.pending, undefined, '已经注入过，就不该再标 pending');
// 分层明细必须能对上：每层的 id 都在本次注入里，且层内 id 不重复、层间不重叠。
{
  const seenIds = new Set();
  const totalByLayer = snapSame.injected.layers.reduce((n, l) => n + l.ids.length, 0);
  assert.equal(totalByLayer, snapSame.injected.count, '各层条数加起来必须等于注入总条数');
  for (const layer of snapSame.injected.layers) {
    assert.ok(['pinned', 'recent', 'topic', 'fallback'].includes(layer.key), `未知层 ${layer.key}`);
    assert.ok(layer.label, `层 ${layer.key} 必须有中文标签`);
    for (const id of layer.ids) {
      assert.ok(!seenIds.has(id), `同一条记忆不该出现在两层里：${id}`);
      seenIds.add(id);
      assert.ok(snapSame.injected.ids.includes(id), `层 ${layer.key} 里的 id 必须在注入里`);
    }
  }
}

// ── 6. 快照里带上了记忆图需要的派生字段 ──────────────────────────────────
res = await call('/dsh-memory-lens/api/snapshot', { headers: LOOPBACK });
const snap2 = JSON.parse(res.body);
const item = snap2.items.find((m) => m.id === created.id);
assert.ok(item, '快照应包含刚写入的条目');
assert.equal(typeof item.strength, 'number', 'strength 必须是数字（记忆图上色要用）');
assert.equal(typeof item.falloutInDays, 'number', 'falloutInDays 必须是数字（记忆图上色要用）');
assert.ok(item.strength > 0, '刚写的条目强度应大于 0');

// ── 6b. 正文自带标签尾巴时不重复渲染 ────────────────────────────────────
//
// 守的是一个真见过的现象：从别的记忆系统导入的条目常把标签写进正文末尾
// （「…我也不害怕」。（陪伴、阿风、私聊、承诺）），渲染时再追加一遍括号标签，
// 用户看到「（陪伴、阿风、私聊、承诺）（陪伴、阿风、私聊、承诺）」会以为数据坏了。
// 同时反向守住：正文里本来就有的长句括注（是内容，不是标签）不能因此被吞掉。
res = await call('/dsh-memory-lens/api/item', {
  method: 'POST',
  headers: LOOPBACK,
  body: {
    text: '阿风说周末去看海，小鲸鱼答应了。（看海、约定、周末）',
    kind: 'promise',
    tags: ['看海', '约定', '周末'],
    weight: 4
  }
});
assert.equal(res.status, 200);
const block = section.text({});
const dupLine = block.split('\n').find((l) => l.includes('阿风说周末去看海'));
assert.ok(dupLine, '带尾巴的条目应出现在注入块里');
assert.equal(
  (dupLine.match(/（看海、约定、周末）/g) || []).length,
  1,
  `标签尾巴不该渲染两遍，实际：${dupLine}`
);
assert.ok(!/）（/.test(dupLine.replace(/[^（）]/g, '')), `不该出现「）（」这种紧邻双括号，实际：${dupLine}`);

// 长句括注是正文内容，必须原样保留
res = await call('/dsh-memory-lens/api/item', {
  method: 'POST',
  headers: LOOPBACK,
  body: { text: '阿风的生日是10月18（那天他亲口说的，我记得很清楚）', kind: 'fact', tags: ['生日'], weight: 5 }
});
assert.equal(res.status, 200);
const longNote = section.text({}).split('\n').find((l) => l.includes('阿风的生日是10月18'));
assert.ok(longNote, '长句括注的条目应出现在注入块里');
assert.ok(longNote.includes('（那天他亲口说的，我记得很清楚）'), `长句括注必须保留，实际：${longNote}`);
assert.ok(longNote.includes('（生日）'), '长句括注不是标签尾巴，标签仍要渲染');

// ── 6c. 衰减口径：按类型分开的半衰期不能被压成一个数字 ────────────────────
//
// 守的是一个真发生过的缺陷：`decayHalfLife: Number(setting(config,'decayHalfLifeDays',365))`
// 把 core 的分类型半衰期（fact 365 / pref 180 / promise 30 / event 14）压成单个 365，
// 于是**约定（promise）被当成事实**用一年去算。后果很具体：26 条真实记忆里
// 全部落在 1695~2177 天后才淡忘 —— 「会淡忘」这条承诺在默认配置下几乎不发生，
// 而面板上「预计淡忘」显示的数字又确实很大，用户完全看不出哪里错了。
//
// 所以这里同时守两头：
// ① 同一天写入的 promise 与 fact，promise 必须明显更快淡忘（半衰期各归各位）；
// ② 默认归档阈值必须是 0.6（与 core 的 longMemoryFalloutDays 同一把尺），
//    否则面板说「还有 N 天」、实际永远不会归档，两套真相。
{
  const { memoryStrength, longMemoryFalloutDays, DEFAULT_HALF_LIFE_DAYS } = await import(
    '../lib/core/long-memory.js'
  );
  assert.deepEqual(
    { ...DEFAULT_HALF_LIFE_DAYS },
    { fact: 365, pref: 180, promise: 30, event: 14 },
    'core 的分类型半衰期被改了：改之前先想清楚面板上的「预计淡忘」还准不准'
  );

  // 走真实的配置默认值（不是手写常量），这样 schema 一改这里就会失败。
  const cfg = Config({});
  const read = (key) => {
    const raw = cfg[key];
    return raw !== null && typeof raw === 'object' && typeof raw.get === 'function' ? raw.get() : raw;
  };
  const halfLife = read('decayHalfLifeDays');
  assert.equal(typeof halfLife, 'object', 'decayHalfLifeDays 默认必须按类型分开，不能是一个数字');
  assert.equal(halfLife.promise, 30, '约定必须 30 天淡一半');
  assert.equal(halfLife.fact, 365, '事实必须 365 天淡一半');
  assert.equal(read('decayArchiveBelow'), 0.6, '默认归档阈值必须是 0.6（与 core 同一把尺）');

  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  const promiseAt30 = { kind: 'promise', weight: 4, createdAt: now - 30 * oneDay, hits: 0 };
  const factAt30 = { kind: 'fact', weight: 4, createdAt: now - 30 * oneDay, hits: 0 };
  const sPromise = memoryStrength(promiseAt30, now, halfLife);
  const sFact = memoryStrength(factAt30, now, halfLife);
  assert.ok(
    sPromise < sFact * 0.6,
    `30 天前提的约定必须比同天写下的事实淡得多（promise=${sPromise.toFixed(2)} fact=${sFact.toFixed(2)}）`
  );

  // 真正会被归档的那天：promise 在默认阈值下应当是「几十天」，不是「一千多天」。
  const promiseFallout = longMemoryFalloutDays(promiseAt30, now, halfLife, 0.6);
  const factFallout = longMemoryFalloutDays(factAt30, now, halfLife, 0.6);
  assert.ok(
    promiseFallout < 400,
    `默认配置下约定不该拖到 ${promiseFallout} 天才归档（这正是被压成单数字 365 的症状）`
  );
  assert.ok(factFallout > promiseFallout * 2, '事实的淡忘必须明显比约定慢，否则分类型半衰期没生效');

  // 反向：用户显式填一个数字时，要尊重那个数字（不能强行套类型表）。
  assert.equal(typeof halfLife, 'object');
  const singleCfg = Config({ decayHalfLifeDays: 90 });
  const rawSingle = singleCfg.decayHalfLifeDays;
  const single = typeof rawSingle === 'object' && typeof rawSingle.get === 'function' ? rawSingle.get() : rawSingle;
  assert.equal(single, 90, '用户填数字时应原样保留，不该被类型表覆盖');
}

// ── 6d. 端到端：面板上的「预计淡忘」必须真的分类型 ────────────────────────
//
// 上一组只验证了「schema 默认值长什么样」。但真正决定她会不会忘的是
// `coreOptions()` 把配置交给 core 的那一步 —— 只要那里还有一处 `Number(...)`，
// schema 再对也没用。所以这里绕开配置对象，直接看面板拿到的那两个数字：
// 同一时刻写下的约定与事实，约定必须明显更快淡忘。
{
  const promiseRes = await call('/dsh-memory-lens/api/item', {
    method: 'POST',
    headers: LOOPBACK,
    body: { text: '小鲸鱼答应了周五给阿风讲睡前故事', kind: 'promise', tags: ['约定'], weight: 4 }
  });
  assert.equal(promiseRes.status, 200);
  const promiseId = JSON.parse(promiseRes.body).id;

  res = await call('/dsh-memory-lens/api/snapshot', { headers: LOOPBACK });
  const snap3 = JSON.parse(res.body);
  const promiseItem = snap3.items.find((m) => m.id === promiseId);
  const factItem = snap3.items.find((m) => m.id === created.id);
  assert.ok(promiseItem && factItem, '两条都要在快照里');
  assert.ok(
    promiseItem.falloutInDays < factItem.falloutInDays / 2,
    `同一时刻写下的约定必须比事实淡得快得多（promise ${promiseItem.falloutInDays} 天 vs fact ${factItem.falloutInDays} 天）` +
      ' —— 两者接近就说明 coreOptions() 又把分类型半衰期压成了一个数字'
  );
  // 顺带守：默认阈值下约定不该拖到以「千天」计。
  assert.ok(
    promiseItem.falloutInDays < 400,
    `默认配置下约定 ${promiseItem.falloutInDays} 天才归档，太久了（旧缺陷是 2030 天）`
  );
}

// ── 7. 动作接口 ───────────────────────────────────────────────────────
res = await call('/dsh-memory-lens/api/action', {
  method: 'POST',
  headers: LOOPBACK,
  body: { id: created.id, action: 'resolve', note: '做完了' }
});
assert.equal(res.status, 200);
assert.equal(JSON.parse(res.body).status, 'resolved');

// 结案后撤销，状态必须完全干净（不留 resolvedAt 残渣）
res = await call('/dsh-memory-lens/api/action', {
  method: 'POST',
  headers: LOOPBACK,
  body: { id: created.id, action: 'revive' }
});
const revived = JSON.parse(res.body);
assert.equal(revived.status, 'active');

// ── 7b. 导入：三种形状都要收，且必须补齐元数据 ─────────────────────────────
//
// 这条守的是用户反馈里的两条真缺陷：
//  ① README 写着能接受 `{items:[...]}`，实际处理器只认 `buckets` → 照着文档拼好的
//     JSON 换来「没有可导入的条目」，用户以为是数据坏了。
//  ② 裸数组分支直接 `...m` push 进库，没过 normalizeStore → 文件里只剩 text/kind/tags，
//     `createdAt` 全空，衰减拿「现在」当锚点，一条三年前的旧事永远不淡出。
{
  const legacy = { text: '三年前的一件旧事，早就不重要了', kind: 'event', tags: ['旧事'] };

  // 形状 A：{items:[...]}
  res = await call('/dsh-memory-lens/api/import', {
    method: 'POST',
    headers: LOOPBACK,
    body: { items: [{ ...legacy, text: `${legacy.text}（A）` }] }
  });
  assert.equal(res.status, 200, '{items:[...]} 必须被接受');
  assert.equal(JSON.parse(res.body).added, 1);

  // 形状 B：{buckets:{shared:[...]}}
  res = await call('/dsh-memory-lens/api/import', {
    method: 'POST',
    headers: LOOPBACK,
    body: { source: { buckets: { shared: [{ ...legacy, text: `${legacy.text}（B）` }] } } }
  });
  assert.equal(res.status, 200, '{source:{buckets:...}} 必须被接受');
  assert.equal(JSON.parse(res.body).added, 1);

  // 形状 C：裸数组直接当 body
  res = await call('/dsh-memory-lens/api/import', {
    method: 'POST',
    headers: LOOPBACK,
    body: [{ ...legacy, text: `${legacy.text}（C）` }]
  });
  assert.equal(res.status, 200, '裸数组必须被接受');
  assert.equal(JSON.parse(res.body).added, 1);

  // 三条都必须带全元数据 —— 否则衰减没有锚点
  const imported = JSON.parse((await call('/dsh-memory-lens/api/snapshot', { headers: LOOPBACK })).body).items.filter(
    (m) => m.text.includes('三年前的一件旧事')
  );
  assert.equal(imported.length, 3, '三种形状各导入一条');
  for (const m of imported) {
    assert.equal(m.status, 'active', `导入的条目必须补成 active：${m.text}`);
    assert.ok(Number.isFinite(m.createdAt) && m.createdAt > 0, `导入的条目必须有 createdAt：${m.text}`);
    assert.ok(Number.isFinite(m.hits), `导入的条目必须有 hits：${m.text}`);
    assert.ok(Number.isFinite(m.weight), `导入的条目必须有 weight：${m.text}`);
  }

  // 空正文必须 400，不能悄悄「导入成功 0 条」
  res = await call('/dsh-memory-lens/api/import', {
    method: 'POST',
    headers: LOOPBACK,
    body: { items: [{ text: '   ' }] }
  });
  assert.equal(res.status, 400, '全是空正文时必须 400');
}

// ── 8. 未知动作必须报错，而不是静默成功 ──────────────────────────────────
res = await call('/dsh-memory-lens/api/action', {
  method: 'POST',
  headers: LOOPBACK,
  body: { id: created.id, action: 'explode' }
});
assert.equal(res.status, 400, '未知动作必须 400');

// ── 9. 方法不对必须 405 ────────────────────────────────────────────────
res = await call('/dsh-memory-lens/api/item', { headers: LOOPBACK });
assert.equal(res.status, 405);

// ── 10. 全程不该有 warn 日志 ───────────────────────────────────────────
assert.deepEqual(warnings, [], `不该有告警，实际：${warnings.join(' | ')}`);

// ── 11. headless 回归：没有 webServer 时插件必须照样起来 ──────────────────
//
// 这条守的是一个真发生过的缺陷：把 webServer 写进 `export const inject` 数组后，
// 没有 Web 面的 profile 里整个插件卡在 pending（waiting for service: webServer），
// 于是「注入 + 工具」这两件核心功能一起失效 —— 只因为装不了那个面板。
// 所以这里断言：没有 webServer，注入与工具仍然注册成功，只有路由缺席。
{
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'memlens-headless-'));
  process.env.DSH_HOME = tmp2;
  const routes2 = new Map();
  const sections2 = [];
  const tools2 = [];
  const headlessCtx = {
    logger: { warn: (...args) => warnings.push(args.join(' ')), info() {}, debug() {} },
    systemPrompt: {
      getSectionOrder: () => undefined,
      section: (s) => {
        sections2.push(s);
        return () => {};
      }
    },
    tools: { register: (t) => tools2.push(t) },
    effect: (fn) => fn(),
    inject: (deps, cb) => {
      // webServer 不存在：cordis 根本不会调用回调。
      if (deps.includes('webServer')) return undefined;
      return cb(headlessCtx);
    }
  };
  // apply 不能抛：这正是「一个可选服务拖垮整个插件」的反面。
  apply(headlessCtx, Config({}));
  assert.equal(sections2.length, 1, 'headless 里系统提示 section 仍要注册');
  assert.equal(tools2.length, 3, 'headless 里三个工具仍要注册');
  assert.equal(routes2.size, 0, 'headless 里不该有路由');
  fs.rmSync(tmp2, { recursive: true, force: true });
}

// ── 12. 体检与对账接口 ──────────────────────────────────────────────────
//
// 这两个接口的价值全在「只读」和「不误报」：体检要能看见已归档条目（否则悬空
// 引用查不出来），对账绝不能写另一份文件（那是别的程序的数据）。
{
  const audit = await call('/dsh-memory-lens/api/audit', { headers: LOOPBACK });
  assert.equal(audit.status, 200, '体检接口要能直接调');
  const auditBody = JSON.parse(audit.body);
  assert.equal(auditBody.ok, true);
  assert.equal(typeof auditBody.checked, 'number');
  assert.ok(Array.isArray(auditBody.findings));
  assert.equal(typeof auditBody.file, 'string', '体检结果要带上被检查的文件路径');

  // 对账：指向一个真实存在的另一份库，只读
  const otherFile = path.join(tmp, 'other-store.json');
  fs.writeFileSync(otherFile, JSON.stringify({
    version: 2,
    buckets: { shared: [{ text: '另一份库里的独有记忆', kind: 'fact', createdAt: Date.now() }] }
  }), 'utf8');
  const before = fs.readFileSync(otherFile, 'utf8');
  const diff = await call('/dsh-memory-lens/api/diff', {
    method: 'POST',
    headers: LOOPBACK,
    body: { file: otherFile }
  });
  assert.equal(diff.status, 200, `对账失败：${diff.body}`);
  const diffBody = JSON.parse(diff.body);
  assert.equal(diffBody.ok, true);
  assert.equal(diffBody.onlyRight.length, 1, '那份库独有的记忆要出现在 onlyRight');
  assert.equal(diffBody.onlyRight[0].text, '另一份库里的独有记忆');
  assert.equal(fs.readFileSync(otherFile, 'utf8'), before, '对账绝不能改另一份文件');

  // 缺 file 要 400，不能 500 —— 参数问题是用户能自己改的
  const missing = await call('/dsh-memory-lens/api/diff', { method: 'POST', headers: LOOPBACK, body: {} });
  assert.equal(missing.status, 400, '没给 file 应该 400');
  // 文件不存在也要 400，不能把内部异常抛成 500
  const gone = await call('/dsh-memory-lens/api/diff', {
    method: 'POST',
    headers: LOOPBACK,
    body: { file: path.join(tmp, 'no-such-store.json') }
  });
  assert.equal(gone.status, 400, '文件不存在应该 400');
}

// ── 13. 四层注入：固定层真的钉得住、落盘不丢、话题层按内容检索 ──────────────
//
// 这一组守的是用户提的那个需求的落地：以前只按「重要度」挑 12 条，排在队尾的记忆
// 永远进不了上下文（没被归档，只是每次都轮不到）。四层是：
//   固定层（钉住，每轮必进）→ 近期层（最近几天动过的）→ 话题层（按当前对话检索）
//   → 兜底层（其余按分数 + 轮换，保证队尾的也轮得到）
// 三条最容易被写坏的：① pinned 没进 normalizeStore 白名单 → 内存里钉着、写盘再读全松开；
// ② 钉住的不受预算保护 → 钉了 20 条照样被截断，用户以为钉住了其实没有；
// ③ 话题层拿不到查询词就整体崩掉 → 必须有兜底、必须自动让位。
{
  const { apply: apply2, Config: Config2 } = await import('../lib/index.js');
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'memlens-layers-'));
  process.env.DSH_HOME = tmp3;

  const routes3 = new Map();
  const sections3 = [];
  const warnings3 = [];
  const ctx3 = {
    logger: { warn: (...a) => warnings3.push(a.join(' ')), info() {}, debug() {} },
    systemPrompt: {
      getSectionOrder: () => undefined,
      section: (s) => {
        sections3.push(s);
        return () => {};
      }
    },
    tools: { register() {} },
    webServer: { register: (e) => (routes3.set(e.path, e), () => {}) },
    effect: (fn) => fn(),
    inject: (deps, cb) => (deps.includes('webServer') ? cb(ctx3) : cb(ctx3))
  };
  apply2(ctx3, Config2({}));
  const section3 = sections3[0];

  async function call3(pathname, { method = 'GET', headers = LOOPBACK, body = null } = {}) {
    const entry = routes3.get(pathname);
    const req = {
      method,
      headers,
      async *[Symbol.asyncIterator]() {
        if (body !== null) yield Buffer.from(JSON.stringify(body), 'utf8');
      }
    };
    const res = fakeRes();
    await entry.handler(req, res);
    return res;
  }
  const snap3 = async () => JSON.parse((await call3('/dsh-memory-lens/api/snapshot')).body);
  const add = async (text, kind, tags = []) => {
    const r = await call3('/dsh-memory-lens/api/item', { method: 'POST', body: { text, kind, tags, weight: 4 } });
    assert.equal(r.status, 200, `写入失败：${text} / ${r.body}`);
    return JSON.parse(r.body).id;
  };

  // 13a. 还没发生过注入时，快照必须如实说「pending」，而不是伪造一份预览。
  {
    const s = await snap3();
    assert.equal(s.injected.pending, true, '全新实例还没注入过，必须标 pending');
    assert.equal(s.injected.count, 0);
    assert.equal(s.injected.block, '', '不该伪造一份「将要注入的内容」');
  }

  const idA = await add('阿风是主人，叫我小鲸鱼', 'fact', ['称呼']);
  const idB = await add('阿风在准备考研，别给他排旅行', 'fact', ['学业']);
  const idC = await add('阿风说周末去看海', 'promise', ['约定']);

  // 13b. 钉住 → 进固定层，并且**落盘再读还在**（normalizeStore 白名单的守卫）
  {
    const r = await call3('/dsh-memory-lens/api/action', { method: 'POST', body: { id: idA, action: 'pin' } });
    assert.equal(r.status, 200, `钉住失败：${r.body}`);
    assert.equal(JSON.parse(r.body).pinned, true);

    let s = await snap3();
    assert.equal(s.items.find((m) => m.id === idA).pinned, true, '快照里要能看出这条被钉住');
    assert.equal(s.counts.pinned, 1, '统计里要有钉住的条数');

    // 注入一次，看它是否进固定层
    const block = section3.text({});
    assert.ok(block.includes('阿风是主人'), `钉住的必须每轮都进，实际：\n${block}`);
    s = await snap3();
    const pinnedLayer = s.injected.layers.find((l) => l.key === 'pinned');
    assert.ok(pinnedLayer, '注入明细里必须有一层叫 pinned');
    assert.ok(pinnedLayer.ids.includes(idA), '钉住的那条必须在固定层里');

    // 落盘再读：绕开内存缓存，直接读文件确认 pinned 字段真的写进去了
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmp3, 'memory-lens', 'memory.json'), 'utf8'));
    const row = onDisk.buckets.shared.find((m) => m.id === idA);
    assert.equal(row.pinned, true, 'pinned 必须落盘（normalizeStore 白名单漏了它就会「读回来全松开」）');
    assert.ok(Number.isFinite(row.pinnedAt), 'pinnedAt 必须落盘');
    assert.equal(row.pinnedAuto, false, '用户亲手钉的不该标成自动钉');
  }

  // 13c. 取消钉住 → 立刻从固定层消失，且不会被「自动钉」再次钉回来
  {
    const r = await call3('/dsh-memory-lens/api/action', { method: 'POST', body: { id: idA, action: 'unpin' } });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).pinned, false);
    const s = await snap3();
    assert.equal(s.counts.pinned, 0, '取消钉住后统计要归零');
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmp3, 'memory-lens', 'memory.json'), 'utf8'));
    assert.equal(onDisk.buckets.shared.find((m) => m.id === idA).pinned, false);
    assert.equal(onDisk.meta?.pinnedSeededAt !== undefined, true, '自动钉只做一次的标记必须留在 meta 里');
  }

  // 13d. 归档/已结案的条目钉不住 —— 与其让用户钉一个永不出现的东西，不如直接拒绝
  {
    await call3('/dsh-memory-lens/api/action', { method: 'POST', body: { id: idC, action: 'archive', note: 'test' } });
    const r = await call3('/dsh-memory-lens/api/action', { method: 'POST', body: { id: idC, action: 'pin' } });
    assert.equal(r.status, 400, '已归档的条目必须拒绝钉住，而不是假装成功');
    assert.ok(JSON.parse(r.body).error.includes('钉住也不会进注入'), `错误信息要说清原因，实际：${r.body}`);
  }

  // 13e. 近期层：刚写下的几条必须每轮都带上（用户要的「不能忘记最近在干嘛」）
  {
    const block = section3.text({});
    for (const [id, text] of [[idA, '阿风是主人'], [idB, '阿风在准备考研']]) {
      assert.ok(block.includes(text), `刚写下的必须进近期层，缺了 ${text}，实际：\n${block}`);
    }
    const s = await snap3();
    const recentLayer = s.injected.layers.find((l) => l.key === 'recent');
    assert.ok(recentLayer, '注入明细里必须有一层叫 recent');
    assert.ok(recentLayer.ids.includes(idB), '考研那条应在近期层');
  }

  // 13f. 话题层：按当前对话内容检索**旧**记忆。
  //      这里必须用「几十天前写下、之后没被动过」的条目 —— 否则它会先被近期层捞走，
  //      话题层根本没机会出手，测出来的就只是「近期层在工作」，等于没测话题层。
  {
    const { upsertLongMemory } = await import('../lib/core/long-memory.js');
    const { MemoryStore } = await import('../lib/store.js');
    const storeFile = path.join(tmp3, 'memory-lens', 'memory.json');
    const storeT = new MemoryStore(storeFile);
    const listT = storeT.bucket('shared');
    const old = upsertLongMemory(listT, {
      text: '阿风提过想养一只猫，说等稳定下来再考虑',
      kind: 'fact',
      tags: ['猫'],
      weight: 4
    });
    const sixtyDaysAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;
    old.item.createdAt = sixtyDaysAgo;
    old.item.updatedAt = sixtyDaysAgo;
    old.item.lastUsedAt = sixtyDaysAgo;
    storeT.save();
    const oldId = old.item.id;

    // 先确认：不提供任何查询词时，这条旧记忆不该冒进前几层（它既不钉、也不新）
    section3.text({});
    let s = await snap3();
    assert.equal(
      s.injected.layers.find((l) => l.key === 'topic'),
      undefined,
      '没有查询词时不该产生话题层（名额要让给兜底层）'
    );

    // 再提供「在聊猫」的会话历史 → 话题层必须把它捞出来
    const block = section3.text({
      agent: { messages: [{ role: 'user', content: '你还记得我说过想养猫吗' }] }
    });
    assert.ok(block.includes('想养一只猫'), `话题相关时必须检索到旧记忆，实际：\n${block}`);
    s = await snap3();
    const topicLayer = s.injected.layers.find((l) => l.key === 'topic');
    assert.ok(topicLayer, '有查询词且命中时必须产生话题层');
    assert.ok(topicLayer.ids.includes(oldId), '养猫那条必须在话题层里');
    assert.ok(s.injected.query.includes('养猫'), `快照要记下这次用的查询词，实际：${s.injected.query}`);

    // 无关话题：不该把这条捞进话题层
    section3.text({ agent: { messages: [{ role: 'user', content: '今天几点开会' }] } });
    s = await snap3();
    const topicLayer2 = s.injected.layers.find((l) => l.key === 'topic');
    assert.ok(!topicLayer2 || !topicLayer2.ids.includes(oldId), '无关话题不该把养猫那条算成相关');
  }

  // 13f. 话题层只认**用户**说的话：agent 自己的回复不能当查询词
  //      （否则 BM25 会把「她上次提过的记忆」判成相关，是自我强化不是想事情）
  {
    const block = section3.text({
      agent: {
        messages: [
          { role: 'user', content: '今天天气不错' },
          { role: 'assistant', content: '你考研准备得怎么样了？' }
        ]
      }
    });
    const s = await snap3();
    assert.ok(!s.injected.query.includes('考研'), `agent 的回复不该进查询词，实际：${s.injected.query}`);
    assert.equal(s.injected.layers.find((l) => l.key === 'topic'), undefined, '无关对话不该产生话题层');
    assert.ok(block.length > 0, '没有话题命中时其余三层照常工作');
  }

  // 13g. 拿不到会话上下文时不能崩：传空对象、传 undefined 都得正常出块
  {
    for (const bad of [{}, undefined, { agent: null }, { agent: { messages: 'not-an-array' } }]) {
      const block = section3.text(bad);
      assert.equal(typeof block, 'string', `上下文异常时必须返回字符串，实际：${typeof block}`);
      assert.ok(block.length > 0, '没有查询词时固定层/兜底层仍要注入');
    }
    assert.deepEqual(warnings3, [], `不该有告警，实际：${warnings3.join(' | ')}`);
  }

  // 13h. 预算：固定层优先保住。钉住 6 条长记忆，预算压到很小，
  //      钉住的仍要尽量在（不能出现「钉了但被截断」的错觉）。
  {
    const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), 'memlens-budget-'));
    process.env.DSH_HOME = tmp4;
    const routes4 = new Map();
    const sections4 = [];
    const ctx4 = {
      logger: { warn() {}, info() {}, debug() {} },
      systemPrompt: { getSectionOrder: () => undefined, section: (s) => (sections4.push(s), () => {}) },
      tools: { register() {} },
      webServer: { register: (e) => (routes4.set(e.path, e), () => {}) },
      effect: (fn) => fn(),
      inject: (deps, cb) => cb(ctx4)
    };
    apply2(ctx4, Config2({ injectMaxChars: 600 }));
    const section4 = sections4[0];
    // 直接用 core 写库（绕开 HTTP，方便一次写多条）
    const { upsertLongMemory } = await import('../lib/core/long-memory.js');
    const { MemoryStore } = await import('../lib/store.js');
    const store4 = new MemoryStore(path.join(tmp4, 'memory-lens', 'memory.json'));
    const list4 = store4.bucket('shared');
    // 注意：正文必须**真的不一样**。core 的 upsert 有近似去重（DUP_DICE=0.9），
    // 用「第N条很长的记忆，用来把预算塞满…」这种只差一个字的模板会被合并成一条，
    // 于是这条断言就变成「验证一条记忆装得下」，什么都守不住。
    const filler = [
      '阿风喜欢在深夜写代码，说那时候思路最清楚',
      '小鲸鱼答应每年十月十八都陪阿风过生日',
      '阿风的电脑是台老笔记本，风扇声音很大',
      '阿风讨厌别人替他做决定，喜欢自己拍板',
      '阿风说过咱家不缺钱，让小鲸鱼别替他省',
      '阿风在准备考研，这段时间别给他排旅行',
      '阿风喜欢蓝色，说那像深海的颜色',
      '阿风半夜容易想事情，那时候话会多一点'
    ];
    for (let i = 0; i < filler.length; i += 1) {
      const r = upsertLongMemory(list4, { text: filler[i], kind: 'fact', weight: 5 });
      assert.ok(r?.ok && r.item, `第 ${i} 条写入失败：${JSON.stringify(r)}`);
      if (i < 3) {
        r.item.pinned = true;
        r.item.pinnedAt = Date.now();
      }
    }
    assert.equal(list4.length, filler.length, '八条不同正文不该被去重合并（合并了这条测试就失效了）');
    store4.save();
    const block = section4.text({});
    assert.ok(block.length <= 600, `注入块不能超预算（实际 ${block.length} 字）`);
    // 钉住的必须优先保住：预算够装 3 条时，3 条钉住的都要在，不能因为「后面还有更长的」
    // 就被挤掉 —— 用户点「钉住」的意思是「无论如何先给它位置」。
    for (let i = 0; i < 3; i += 1) {
      assert.ok(block.includes(filler[i]), `钉住的第${i}条必须优先保住，实际：\n${block}`);
    }
    // 且钉住的必须排在最前面（层序就是优先级，面板上也是这个顺序）
    const lines = block.split('\n').slice(1).filter((l) => l.startsWith('- ['));
    for (let i = 0; i < 3; i += 1) {
      assert.ok(lines[i].includes(filler[i]), `固定层必须排在最前，第 ${i} 行是：${lines[i]}`);
    }
    // 钉住的条目不该在别的层里重复出现
    assert.equal(
      lines.filter((l) => filler.slice(0, 3).some((t) => l.includes(t))).length,
      3,
      `钉住的条目被重复渲染了，实际：\n${block}`
    );
    fs.rmSync(tmp4, { recursive: true, force: true });
  }

  fs.rmSync(tmp3, { recursive: true, force: true });
  process.env.DSH_HOME = tmp;
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('宿主半装配自检：全部通过');

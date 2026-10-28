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
assert.ok(afterWrite.length <= 1200, '注入块不能超预算');

// ── 5b. 面板显示的注入块必须和真正注入的逐字相同 ─────────────────────────
//
// 守的是这套系统最不能出的问题：「面板上显示的」和「她真读到的」变成两套真相。
// 一旦有人给面板单独加一套打分/渲染，用户看着面板说「她记得这事」而实际注入里
// 没有，用户永远发现不了 —— 直到某天她真的忘了，也说不清是哪一环出的问题。
res = await call('/dsh-memory-lens/api/snapshot', { headers: LOOPBACK });
const snapSame = JSON.parse(res.body);
assert.equal(
  snapSame.injected.block,
  section.text({}),
  '快照里的 injected.block 必须和系统提示里注入的逐字相同（不能有两套渲染）'
);

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

fs.rmSync(tmp, { recursive: true, force: true });
console.log('宿主半装配自检：全部通过');

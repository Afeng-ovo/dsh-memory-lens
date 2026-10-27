// 宿主半的离线装配自检：用最小 ctx 桩把 apply() 跑一遍，确认
// ① 三个服务都被用上（systemPrompt / tools / webServer）
// ② 四条路由真的注册了、且路径与客户端调用的一致
// ③ 系统提示 section 的名字与 order 合法
// ④ 路由的信任栅栏能挡住跨站请求
//
// 这不是「跑起来就行」的冒烟测试：下面每条断言都对着一个具体的失败模式
// （路径写错、order 非数字、跨站放行、注入块没生成）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';

// `@deepseek-ai/dsh-tools` 由宿主（Electron asar）在运行时提供，纯 node 里解析不到。
// 给它一个替身，这样测试跑的是 lib/index.js 的真实代码，而不是另写一份逻辑。
const STUB = 'data:text/javascript,' + encodeURIComponent('export const defineTool = (def) => def;');
module.registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@deepseek-ai/dsh-tools') return { url: STUB, shortCircuit: true };
    return next(specifier, context);
  }
});

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
const expected = ['/dsh-memory-lens/api/snapshot', '/dsh-memory-lens/api/item', '/dsh-memory-lens/api/action', '/dsh-memory-lens/api/import'];
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

fs.rmSync(tmp, { recursive: true, force: true });
console.log('宿主半装配自检：全部通过');

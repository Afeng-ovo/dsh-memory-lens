// 记忆透镜（Memory Lens）—— DSH 宿主半。
//
// 这个插件让 agent **跨会话记得用户**：三条工具（remember/recall/forget）负责写与查，
// 每轮系统提示里注入一段「你一直记得的事」负责让它自己想起来，设置页里的一块面板
// 负责让用户看得见、改得动、删得掉。
//
// 三个设计立场，写在最前面，因为它们决定了下面所有代码的形状：
//
// ① **记忆归插件自己存**（$DSH_HOME/memory-lens/memory.json），不寄生在别的服务里。
//    开源之后别人装上就能用，不需要先有 QQ 桥接、不需要开某个会话。换机器时
//    拷这一个 JSON 就够 —— 数据是用户的，不该被锁在某个进程的内存里。
//
// ② **注入与检索共用同一个打分函数**（core/long-memory.js 的 selectLongMemories）。
//    如果面板显示「她此刻会想起这 9 条」用的是 A 算法，而真正注入用的是 B 算法，
//    那这个面板就是一块漂亮的谎言。宁可面板跟着真逻辑走，也不要一个看起来更聪明的副本。
//
// ③ **注入必须有预算**。长期记忆一旦无节制增长，它会挤掉真正重要的上下文，
//    而模型不会告诉你「你给我的提示太长了」。所以按字符数硬截断，超了就少注入几条，
//    并在面板上明确显示「1200 字预算 / 已用 1171」。
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import { auditStore, compareStores } from './core/audit.js';
import {
  DEFAULT_HALF_LIFE_DAYS,
  buildLongMemoryPrompt,
  formatLongMemoryBlock,
  longMemoryFalloutDays,
  memoryStrength,
  normalizeStore,
  organizeLongMemories,
  readLongMemoryStore,
  selectLongMemories,
  upsertLongMemory,
  writeLongMemoryStore
} from './core/long-memory.js';
import { MemoryStore, resolveStoreFile } from './store.js';
import { registerMemoryTools } from './tools.js';

export const name = 'dsh-memory-lens';

/**
 * settings 命名空间名。
 *
 * 必须与 cordis.patch.yml 里 loader entry 的 `id` 完全一致：DSH 的 settings.write()
 * 用 `configEditor.entries().find((row) => row.options.id === ns)` 定位可写目标，
 * 找不到就抛 `No configurable plugin entry "..."`。这条约束在运行期才暴露，
 * 所以 test/client.test.mjs 里做了一次静态比对。
 */
export const NAMESPACE = 'memory-lens';

// systemPrompt 和 tools 缺一不可：没有前者注入不进去（等于白记），
// 没有后者 agent 自己没法记。
//
// webServer **不写在这里**：它是可选的。记忆的核心价值是「注入 + 工具」，
// 这两件事根本不需要 HTTP。headless / TUI 这类没有 Web 面的 profile 里，
// 一旦把 webServer 列进 inject，整个插件会永远卡在 pending
// （`waiting for service: webServer`）—— 于是连记都记不了，只因为装不了那个面板。
// 面板是加分项，不该成为前置条件。路由挂在下面 `ctx.inject(['webServer'], ...)` 子 fiber 里。
export const inject = ['systemPrompt', 'tools'];

/**
 * 插件配置。这些字段会被 DSH 设置系统自动渲染成表单。
 *
 * 每个字段都必须带 `.extra('volatile', true)`：
 * DSH 的 `volatileForm(schema)` 只保留带这个标记的字段，一个都没有就抛
 * "Plugin entry ... has no volatile fields"，整个设置命名空间会连读都读不到。
 * 这里刻意用 `.extra()` 而不是 `.volatile()` —— 后者在 schemastery 的某些版本里
 * 不存在，会让插件在别人的机器上直接 TypeError，而 `.extra()` 行为完全一致。
 */
export const Config = z.object({
  storeFile: z
    .string()
    .default('')
    .description('记忆文件路径。留空用默认位置（$DSH_HOME/memory-lens/memory.json），相对路径按 $DSH_HOME 展开。')
    .extra('volatile', true),
  injectEnabled: z
    .boolean()
    .default(true)
    .description('是否在每轮系统提示里注入「你一直记得的事」。关掉后记忆仍然保存，只是不主动提醒。')
    .extra('volatile', true),
  injectLimit: z
    .number()
    .default(12)
    .description('每轮最多注入几条记忆。条数不是越多越好 —— 十几条之后边际收益趋零，还会挤占上下文。')
    .extra('volatile', true),
  injectMaxChars: z
    .number()
    .default(1200)
    .description('注入块的字数预算。超出时按重要度少注入几条，不会截断单条正文。')
    .extra('volatile', true),
  decayHalfLifeDays: z
    .union([
      z.number().description('所有类型共用一个半衰期'),
      z
        .object({
          fact: z.number().default(DEFAULT_HALF_LIFE_DAYS.fact),
          pref: z.number().default(DEFAULT_HALF_LIFE_DAYS.pref),
          promise: z.number().default(DEFAULT_HALF_LIFE_DAYS.promise),
          event: z.number().default(DEFAULT_HALF_LIFE_DAYS.event)
        })
        .description('按类型分别指定半衰期')
    ])
    .default({ ...DEFAULT_HALF_LIFE_DAYS })
    .description(
      '记忆强度半衰期（天）。默认按类型分开：事实 365、偏好 180、约定 30、事件 14 —— ' +
        '一件事和一条偏好本来就该以不同速度淡去。也可以直接填一个数字，表示所有类型共用。'
    )
    .extra('volatile', true),
  decayArchiveBelow: z
    .number()
    .default(0.6)
    .description(
      '强度低于这个值时归档（0~1）。默认 0.6，与 core 的 longMemoryFalloutDays 同一个阈值 —— ' +
        '面板上「预计淡忘」显示的正是它真正被归档的那天。归档不是删除，仍然可以被检索到。'
    )
    .extra('volatile', true),
  maxEntries: z
    .number()
    .default(1000)
    .description('库容量上限。超出时淘汰最弱的一条，避免文件无限增长。')
    .extra('volatile', true)
});

const API_PREFIX = '/dsh-memory-lens/api';

/**
 * 读一个配置项的值。
 *
 * 为什么不能直接 `config.injectMaxChars`：带 `.extra('volatile', true)` 的字段
 * 会被 DSH 的 volatile 机制包成**访问器对象**（`{get, Symbol(cosmokit.volatile.write)}`），
 * 不是裸值。直接读拿到的是对象，`Number(obj)` 得到 NaN ——
 * 于是预算、半衰期、条数上限全部静默失效，而且不报任何错。
 * 这是本插件最容易「装上就坏、还查不出来」的地方，所以统一从这里取值。
 */
function setting(config, key, fallback) {
  const raw = config?.[key];
  if (raw !== null && typeof raw === 'object' && typeof raw.get === 'function') {
    try {
      const value = raw.get();
      return value === undefined ? fallback : value;
    } catch {
      return fallback;
    }
  }
  return raw === undefined ? fallback : raw;
}

/**
 * 把半衰期配置整理成 core 认识的形状。
 *
 * core 的 `halfLifeOf()` 同时接受「单个数字」和「按类型分的对象」两种形态，
 * 但这里**不能**图省事用 `Number(...)` 压成一个数字：那样 promise（约定）会被
 * 当成 fact（事实）用 365 天算，而设计上它 30 天就该淡去 —— 于是「会淡忘」这条
 * 承诺在默认配置下几乎不会发生（实测 26 条真实记忆全部落在 1695~2177 天后才淡忘）。
 * 用户填数字时尊重数字，填对象时按类型来，缺哪类就补 core 的默认值。
 */
function halfLifeOption(raw) {
  if (raw !== null && typeof raw === 'object') {
    return {
      fact: Number(raw.fact) || DEFAULT_HALF_LIFE_DAYS.fact,
      pref: Number(raw.pref) || DEFAULT_HALF_LIFE_DAYS.pref,
      promise: Number(raw.promise) || DEFAULT_HALF_LIFE_DAYS.promise,
      event: Number(raw.event) || DEFAULT_HALF_LIFE_DAYS.event
    };
  }
  const single = Number(raw);
  return Number.isFinite(single) && single > 0 ? single : { ...DEFAULT_HALF_LIFE_DAYS };
}

/** 把注入预算、衰减等配置整理成 core 认识的形状（全部走 setting() 取裸值）。 */
function coreOptions(config) {
  return {
    decayHalfLife: halfLifeOption(setting(config, 'decayHalfLifeDays', DEFAULT_HALF_LIFE_DAYS)),
    decayArchiveBelow: Number(setting(config, 'decayArchiveBelow', 0.6)) || 0.6,
    maxEntries: Number(setting(config, 'maxEntries', 1000)) || 1000,
    injectLimit: Number(setting(config, 'injectLimit', 12)) || 12,
    injectMaxChars: Number(setting(config, 'injectMaxChars', 1200)) || 1200,
    injectEnabled: Boolean(setting(config, 'injectEnabled', true))
  };
}

/** 统一的 JSON 响应。所有接口都走它，避免各处手写 header 写出不一致的编码。 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(text);
}

/** 读请求体。上限 1MB —— 这是个本地面板，没有上传大文件的需求，超了直接拒。 */
async function readJsonBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (total === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * 信任栅栏：只允许本机回环访问，且写操作必须同源。
 *
 * 为什么必须自己检查：DSH 的 webServer 路由是**裸 HTTP**，没有 connection 那层的
 * 浏览器鉴权。这个面板能读写用户的长期记忆 —— 一份「关于我的一切」的清单，
 * 让任意网页跨站 POST 进来改它，比泄露聊天记录更糟。
 */
function rejectionFor(req) {
  try {
    const headers = req?.headers ?? {};
    const host = String(headers.host ?? '');
    let hostUrl;
    try {
      hostUrl = new URL(`http://${host}`);
    } catch {
      return 403;
    }
    const hostname = hostUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const loopback =
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname === '::1' ||
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
    if (!loopback) return 403;
    if (String(headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return 403;
    const origin = headers.origin;
    if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
      let originUrl;
      try {
        originUrl = new URL(origin);
      } catch {
        return 403;
      }
      if (originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase()) return 403;
    }
    return null;
  } catch {
    return 403;
  }
}

/** 一条记忆对面板要展示的全部字段（面板不该自己去算强度，那会变成第二套真相）。 */
function itemView(m, now, options) {
  return {
    id: m.id,
    text: m.text,
    kind: m.kind,
    tags: m.tags ?? [],
    weight: m.weight,
    status: m.status,
    dueAt: m.dueAt?.when ?? m.dueAt?.date ?? null,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    lastUsedAt: m.lastUsedAt ?? null,
    hits: m.hits ?? 0,
    resolvedAt: m.resolvedAt ?? null,
    resolveNote: m.resolveNote ?? null,
    archivedAt: m.archivedAt ?? null,
    supersededBy: m.supersededBy ?? null,
    // 记忆图要按「还记不记得」上色，这两个派生值必须由 core 算：
    // 面板自己算就会变成第二套真相 —— 图上绿油油的点，实际下一轮就淡出了。
    strength: Math.round(memoryStrength(m, now, options.decayHalfLife) * 100) / 100,
    falloutInDays: Math.round(longMemoryFalloutDays(m, now, options.decayHalfLife, options.decayArchiveBelow) * 10) / 10
  };
}

export function apply(ctx, config) {
  const store = new MemoryStore(resolveStoreFile(config));
  const options = coreOptions(config);

  // ── 系统提示注入 ──────────────────────────────────────────────────────
  // 用 section 而不是 context：context 会被 `suppressRuntimeContext()` 整体抑制
  // （某些精简部署会关掉全部运行时事实），而「你记得用户什么」不是可选装饰，
  // 关掉它这个插件就只剩一个记事本。
  //
  // order 取 950：落在 FILE_REFERENCE(900) 之后、TOOL_BASH(1000) 之前。
  // 也就是「先说清楚我是谁、我面对谁，再给工具手册」—— 记忆属于前一半。
  if (options.injectEnabled) {
    ctx.systemPrompt.section({
      name: 'memory-lens:long-memory',
      order: 950,
      text: () => {
        try {
          const list = store.active('shared');
          if (list.length === 0) return '';
          const picked = selectLongMemories(list, '', options.injectLimit, options.injectMaxChars, Date.now(), false);
          if (picked.length === 0) return '';
          // touch=false 是有意的：注入不等于「用到了」。每轮都算一次使用的话，
          // hits 会变成「说了多少轮话」而不是「这条记忆真的被想起来过几次」，
          // 强度曲线和面板上的数字就全失真了。
          return formatLongMemoryBlock(picked, Date.now());
        } catch (error) {
          // 注入失败不能把整轮对话带崩 —— 宁可这一轮少一段记忆，
          // 也不能让用户看到「插件报错导致对话发不出去」。
          ctx.logger?.warn?.('memory-lens: 注入长期记忆失败', error);
          return '';
        }
      }
    });
  }

  // ── 衰减整理 ──────────────────────────────────────────────────────────
  //
  // 这一步是整个插件的核心承诺：**记得住，也放得下**。没有它，半衰期和归档阈值
  // 只影响面板上显示的数字，记忆本身永远不会淡出 —— 库只会越记越多，最后变成一个
  // 什么都记得、等于什么都不重要的记事本。
  //
  // 什么时候跑：启动时跑一次，之后每次写入后跑一次（写入是最可能改变「该沉谁」的
  // 时刻：新记忆进来会挤占注入预算）。不挂定时器 —— 一个插件在后台悄悄改数据文件，
  // 用户既看不见也没法阻止，这种设计不该出现在别人的记忆里。
  //
  // maxArchivePerRun 固定 3：一次最多沉三条。衰减本来就慢，某天突然沉掉几十条，
  // 多半是参数被改错（半衰期调太短）或误触，等发现时已经「失忆」了。
  let lastOrganizeAt = 0;
  const organize = (reason) => {
    const now = Date.now();
    // 一分钟内不重复整理：连着写十条不该整理十次。
    if (now - lastOrganizeAt < 60_000) return null;
    try {
      const list = store.bucket('shared');
      const result = organizeLongMemories(list, {
        now,
        halfLife: options.decayHalfLife,
        archiveBelow: options.decayArchiveBelow,
        maxArchivePerRun: 3,
        consolidate: true
      });
      if (result.archived > 0 || result.merged > 0) {
        store.save();
        ctx.logger?.info?.(
          `memory-lens: 整理完成（${reason}）归档 ${result.archived} 条、合并 ${result.merged} 条，生效 ${result.before} → ${result.after}`
        );
      }
      lastOrganizeAt = now;
      return result;
    } catch (error) {
      // 整理失败不能影响主流程：宁可这一轮不整理，也不能让写入报错。
      ctx.logger?.warn?.('memory-lens: 衰减整理失败', error);
      return null;
    }
  };
  organize('启动');

  // ── 工具 ─────────────────────────────────────────────────────────────
  registerMemoryTools(ctx, { store, config, afterWrite: () => organize('写入') });

  // ── 设置面板接口 ──────────────────────────────────────────────────────
  //
  // webServer 是**可选**服务：headless / TUI 这类 profile 根本没有 HTTP 面。
  // 一旦把它列进上面的 `inject` 数组，cordis 会让整个插件停在 pending
  // （`waiting for service: webServer`）—— 于是连「注入 + 工具」这两件核心功能
  // 都跑不起来，只因为装不了那个面板。面板是加分项，不该成为前置条件。
  //
  // 正解是 `ctx.inject(['webServer'], (webCtx) => {...})`：父插件照常启动，
  // 服务真出现时再进回调挂路由，不出现就永远不挂。
  // 不能直接读 `ctx.webServer` —— cordis 会拦未声明服务的属性访问，
  // 抛 `cannot get property "webServer" without inject`。
  ctx.inject(['webServer'], (webCtx) => {

    const route = (path, handler) => {
      webCtx.webServer.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          const rejection = rejectionFor(req);
          if (rejection !== null) {
            res.writeHead(rejection);
            res.end(rejection === 403 ? 'forbidden' : 'unauthorized');
            return;
          }
          try {
            await handler(req, res);
          } catch (error) {
            webCtx.logger?.warn?.(`memory-lens: ${path} 处理失败`, error);
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
          }
        }
      });
    };

    // 全量快照：条目 + 统计 + 当前注入预览。面板一次请求拿到所有东西，
    // 避免「列表已刷新、统计还是旧的」这种半新半旧的状态。
    route(`${API_PREFIX}/snapshot`, async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const now = Date.now();
      const list = store.active('shared');
      const picked = selectLongMemories(list, '', options.injectLimit, options.injectMaxChars, now, false);
      const block = formatLongMemoryBlock(picked, now);
      const all = store.all('shared');
      sendJson(res, 200, {
        ok: true,
        items: all.map((m) => itemView(m, now, options)),
        injected: {
          count: picked.length,
          chars: block.length,
          budget: options.injectMaxChars,
          over: Math.max(0, block.length - options.injectMaxChars),
          block,
          ids: picked.map((m) => m.id)
        },
        counts: {
          total: all.length,
          active: all.filter((m) => m.status === 'active').length,
          resolved: all.filter((m) => m.status === 'resolved').length,
          archived: all.filter((m) => m.status === 'archived').length,
          superseded: all.filter((m) => m.status === 'superseded').length
        },
        config: {
          storeFile: store.file,
          injectEnabled: options.injectEnabled,
          injectLimit: options.injectLimit,
          injectMaxChars: options.injectMaxChars,
          decayHalfLifeDays: options.decayHalfLife,
          decayArchiveBelow: options.decayArchiveBelow,
          maxEntries: options.maxEntries
        }
      });
    });

    // 写入一条（新建或改正文）。用 core 的 upsert 而不是自己拼对象 ——
    // 去重、合并、敏感词、dueAt 归一都在那里，绕过它就会产生「看起来能存、实际半残」的条目。
    route(`${API_PREFIX}/item`, async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const body = await readJsonBody(req);
      const list = store.bucket('shared');

      // 带 id 是编辑：改正文/标签/权重，**不改状态**。
      // 状态变更走 /action，两条路径分开，用户点「保存」时不会意外把已结案的条目重新激活。
      if (body.id) {
        const target = list.find((m) => m.id === body.id);
        if (!target) return sendJson(res, 404, { ok: false, error: '没有这条记忆' });
        if (typeof body.text === 'string') {
          const text = body.text.trim();
          if (!text) return sendJson(res, 400, { ok: false, error: '正文不能为空' });
          target.text = text;
        }
        if (Array.isArray(body.tags)) target.tags = body.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 6);
        if (Number.isFinite(Number(body.weight))) target.weight = Math.min(5, Math.max(1, Number(body.weight)));
        if (typeof body.kind === 'string' && ['fact', 'pref', 'promise', 'event'].includes(body.kind)) target.kind = body.kind;
        // 时间戳必须是**数字毫秒**：core 全程用 Number(x.createdAt) 读它，
        // 写 ISO 字符串会得到 NaN，强度算出来就是 NaN，整张记忆图一起瞎掉。
        target.updatedAt = Date.now();
        store.save();
        return sendJson(res, 200, { ok: true, action: 'updated', id: target.id });
      }

      const result = upsertLongMemory(
        list,
        {
          text: body.text,
          kind: body.kind,
          tags: body.tags,
          weight: body.weight,
          dueAt: body.dueAt,
          supersedes: body.supersedes
        },
        { maxEntries: options.maxEntries }
      );
      if (!result?.ok || !result.item) {
        return sendJson(res, 400, { ok: false, error: result?.reason === 'sensitive' ? '这段内容含手机号/证件号/密钥，不写入' : '写入失败' });
      }
      store.save();
      // 面板写入也触发整理：用户在设置页新加一条记忆，同样会改变「谁该淡出」的排序。
      // 只在新建时整理，改正文/标签不整理 —— 编辑不改变条目数量与相对强度。
      organize('面板新增');
      sendJson(res, 200, { ok: true, action: result.action, id: result.item.id });
    });

    // 状态动作。每个动作都有明确语义，不做「万能 update」——
    // 面板按钮和接口一一对应，读代码的人不需要猜某个字段能不能直接改。
    route(`${API_PREFIX}/action`, async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const body = await readJsonBody(req);
      const list = store.bucket('shared');
      const target = list.find((m) => m.id === body.id);
      if (!target) return sendJson(res, 404, { ok: false, error: '没有这条记忆' });
      // 同 /item：数字毫秒。core 的衰减、强度、排序全都按 Number(ts) 读，
      // 这里写成 ISO 字符串会让「续命」失效（hits 涨了但强度没变）。
      const now = Date.now();
      const action = String(body.action ?? '');

      switch (action) {
        case 'hit':
          // 「续命」：用户主动确认这条还成立。和 recall 的自动 touch 不同，
          // 这是人工加权 —— 人说了「对，就这样」，比检索命中一次更可信。
          target.lastUsedAt = now;
          target.hits = (target.hits ?? 0) + 1;
          target.weight = Math.min(5, (target.weight ?? 3) + 0.5);
          break;
        case 'resolve':
          target.status = 'resolved';
          target.resolvedAt = now;
          target.resolveNote = String(body.note ?? '').trim() || null;
          break;
        case 'archive':
          target.status = 'archived';
          target.archivedAt = now;
          target.archiveReason = String(body.note ?? '').trim() || 'manual';
          break;
        case 'revive':
          // 结案和归档都必须能撤销。一个只能进不能出的状态，用户就不敢用 ——
          // 结错了只能删掉重记，那等于把「结案」做成陷阱。
          target.status = 'active';
          target.resolvedAt = null;
          target.resolveNote = null;
          target.archivedAt = null;
          target.archiveReason = null;
          target.revivedAt = now;
          break;
        case 'delete': {
          const index = list.indexOf(target);
          if (index >= 0) list.splice(index, 1);
          store.save();
          return sendJson(res, 200, { ok: true, action: 'deleted', id: body.id });
        }
        default:
          return sendJson(res, 400, { ok: false, error: `未知动作 ${action}` });
      }
      target.updatedAt = now;
      store.save();
      sendJson(res, 200, { ok: true, action, id: target.id, status: target.status });
    });

    // 从 QQ 桥接的库导入。开源版自己不带历史数据，但老用户手里有 ——
    // 给一个明确的导入入口，比让他手工拼 JSON 靠谱得多。
    route(`${API_PREFIX}/import`, async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const body = await readJsonBody(req);
      // 三种形状都收：{source:{...}}（脚本用法）、{source:[...]}、以及把库直接当 body 传。
      const source = body.source ?? body;
      if (!source || typeof source !== 'object') {
        return sendJson(res, 400, {
          ok: false,
          error: '缺少 source（接受 {items:[...]} / {buckets:{shared:[...]}} / 裸数组）'
        });
      }

      // 三种形状：`{items:[...]}`、完整的 store（带 buckets）、裸数组。
      //
      // `{items:[...]}` 这一支是 README 里写过的形状，但以前只认 buckets ——
      // 用户照着文档拼好 JSON 发过来，拿到的是「没有可导入的条目」，还以为是数据坏了。
      const rawList = Array.isArray(source)
        ? source
        : Array.isArray(source.items)
          ? source.items
          : source.buckets?.shared;
      if (!Array.isArray(rawList)) {
        return sendJson(res, 400, {
          ok: false,
          error: '找不到条目列表（接受 {items:[...]} / {buckets:{shared:[...]}} / 裸数组）'
        });
      }

      // **无论哪种形状都必须过一遍 normalizeStore。**
      //
      // 它会补上 status / createdAt / lastUsedAt / updatedAt / hits / weight。
      // 少了这一步，从别的系统倒进来的老数据在文件里只剩 text/kind/tags：
      // 内存里 activeList 靠 `status ?? 'active'` 还能认出来（所以「看着导入成功了」），
      // 但衰减没有锚点 —— `lastUsedAt || updatedAt || createdAt` 全空时取「现在」，
      // 于是一条三年前的旧事会显示「还有 32 天才淡忘」，归档永远不会把它沉下去。
      // 用户反馈里的「导入不写元数据，衰减和归档算不了」就是缺这一行的后果。
      const incoming = normalizeStore({ buckets: { shared: rawList } }).buckets.shared ?? [];
      if (incoming.length === 0) {
        return sendJson(res, 400, { ok: false, error: '没有可导入的条目（每条至少要有非空的 text）' });
      }

      const list = store.bucket('shared');
      const existing = new Set(list.map((m) => `${m.text}|${m.kind}`));
      let added = 0;
      let skipped = 0;
      for (const m of incoming) {
        if (!m || typeof m.text !== 'string' || !m.text.trim()) {
          skipped += 1;
          continue;
        }
        // 按「正文+类型」去重。同一句话换个类型是两条不同的记忆
        // （「喜欢猫」是偏好，「家里养了猫」是事实），不能当成重复。
        const key = `${m.text.trim()}|${m.kind ?? 'fact'}`;
        if (existing.has(key)) {
          skipped += 1;
          continue;
        }
        existing.add(key);
        list.push({
          ...m,
          text: m.text.trim(),
          id: m.id ?? `lm-${Math.random().toString(36).slice(2, 14)}`
        });
        added += 1;
      }
      store.save();
      sendJson(res, 200, { ok: true, added, skipped, total: list.length });
    });

    // ── 体检：这个库自己有没有问题 ─────────────────────────────────────
    //
    // 为什么要有这个接口：面板上的「体检」标签页早就在了，但它只在前端算
    // 「正文太长 / 约定没被想起」两条，而且只看得到 items。库里真正会坏的地方
    // —— id 重复、正文存了两份、说被某条取代而那一条不存在、时间戳写成秒、
    // 衰减整理从来没跑过 —— 前端一条都看不见，因为它们需要**完整视图 + 内核算法**。
    // 把这些判断放在前端，就等于让面板猜；放在这里，面板只是把结论显示出来。
    route(`${API_PREFIX}/audit`, async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const now = Date.now();
      const all = store.all('shared');
      // 必须传**全部**条目（含已归档/已取代）：只传生效的会把「取代目标不存在」
      // 这类悬空引用全报成误报 —— 目标往往正是已归档的那条。
      const report = auditStore(
        all.map((m) => ({
          ...m,
          strength: memoryStrength(m, now, options.decayHalfLife)
        })),
        { now, archiveBelow: options.decayArchiveBelow }
      );
      // 注意顺序：report 里也有一个 ok（含义是「这份库没问题」），先展开再写 ok:true。
      // 反过来写会被 report.ok 覆盖成 false，而面板的 api() 看到 ok:false 就当请求失败 ——
      // 结果就是「一有问题就报错、看不到问题」。两个 ok 含义不同，所以这里改名为 clean。
      sendJson(res, 200, { ...report, clean: report.ok, ok: true, file: store.file });
    });

    // ── 对账：和另一份库比，看有没有对不上的 ──────────────────────────
    //
    // 典型用法：这台机器上还有另一个程序在用同一个记忆（QQ 桥接、旧版本、同步盘里的
    // 备份）。两个程序各存各的，界面上看着都有记忆，实际上可能是两份不同的东西 ——
    // 「星图里的记忆 AI 不知道」「聊了一整天条数没变」都是这么来的。
    //
    // 这个接口不改任何数据，只回答三件事：哪些只有这边有、哪些只有那边有、
    // 哪些两边都有但字段不一样。**按「正文+类型」配对，不按 id** —— 两个系统
    // 各自生成 id，按 id 比会把「同一条」全报成「只在一侧」。
    route(`${API_PREFIX}/diff`, async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const body = await readJsonBody(req);
      const target = String(body.file ?? '').trim();
      if (!target) return sendJson(res, 400, { ok: false, error: '缺少 file（另一份记忆文件的路径）' });

      // 只读另一份文件，绝不写它。
      // 理由：那份文件属于另一个程序，插件没有资格替它做决定 —— 哪怕发现它「不对」。
      // 对账的价值在于「让人看见」，不在于「自动修好」。自动修会在用户不知情时
      // 改动另一份数据，那比不一致本身更糟。
      let otherStore;
      try {
        otherStore = readLongMemoryStore(target);
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: `读不到那个文件：${String(error?.message ?? error)}` });
      }
      const otherList = otherStore.buckets?.shared ?? [];
      if (otherList.length === 0) {
        // 空文件 / 形状不对都要说清楚，否则用户会以为「对账通过了」。
        return sendJson(res, 400, {
          ok: false,
          error: '那个文件里没有可识别的记忆条目（需要 {buckets:{shared:[...]}} 或裸数组）'
        });
      }
      const report = compareStores(store.all('shared'), otherList, {
        leftName: '当前库',
        rightName: path.basename(target)
      });
      sendJson(res, 200, { ...report, clean: report.ok, ok: true, file: store.file, otherFile: target });
    });
  });

}

export { MemoryStore, resolveStoreFile };
export { readLongMemoryStore, writeLongMemoryStore, buildLongMemoryPrompt };

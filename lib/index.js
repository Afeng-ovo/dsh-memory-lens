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
// ② **注入与检索共用同一个打分函数**（core/long-memory.js 的 selectLayeredMemories）。
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
  pinLongMemory,
  readLongMemoryStore,
  seedPinnedOnce,
  selectLayeredMemories,
  unpinLongMemory,
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
    .description('每轮最多注入几条记忆（四层加起来的总上限）。条数不是越多越好 —— 十几条之后边际收益趋零，还会挤占上下文。')
    .extra('volatile', true),
  injectMaxChars: z
    .number()
    .default(2000)
    .description('注入块的字数预算（四层共用）。超出时按层依次少注入几条，不会截断单条正文。')
    .extra('volatile', true),
  injectRecentDays: z
    .number()
    .default(3)
    .description(
      '「近期层」往回看几天：这几天内新建、更新或被兑现的记忆，每轮优先带上，' +
        '保证「最近你们之间在干嘛」永远有位置。'
    )
    .extra('volatile', true),
  injectTopicEnabled: z
    .boolean()
    .default(true)
    .description(
      '「话题层」开关：按本次对话内容去库里检索相关记忆并带上。' +
        '拿不到会话内容时这一层自动空着，名额让给兜底层。'
    )
    .extra('volatile', true),
  injectRotateSlots: z
    .number()
    .default(2)
    .description(
      '每轮给「冷门记忆」留几个名额（0=关掉轮换）。库比注入上限大时，排序靠后的条目' +
        '本来永远进不了上下文；留几个名额就能让它们按小时轮着进来一次。只挤占排在后半段的，不动高分条目。'
    )
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

/**
 * 数值型配置取值：**合法数字就原样用，包括 0**，只有 NaN/缺失才回落默认值。
 *
 * 为什么不能写成 `Number(setting(...)) || 默认值`：`||` 把 0 和 NaN 当成同一件事，
 * 于是「用户把 injectLimit 设成 0 想彻底关掉注入」被静默改回 12 条，
 * 「decayArchiveBelow 设成 0 想关掉自动归档」被改回 0.6 —— 记忆照常沉下去。
 * 配置生效了却看起来没生效，比配置不生效更难查。同一文件里
 * `injectRecentDays`/`injectRotateSlots` 早就用的是正确的 `Number.isFinite` 写法，
 * 两种写法并存本身就是疏忽。tools.js 里也有一处同样的取值，走同一个形状。
 */
function numberOption(config, key, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = setting(config, key, fallback);
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** 把注入预算、衰减等配置整理成 core 认识的形状（全部走 setting() 取裸值）。 */
function coreOptions(config) {
  return {
    decayHalfLife: halfLifeOption(setting(config, 'decayHalfLifeDays', DEFAULT_HALF_LIFE_DAYS)),
    // 0 是合法值：强度永远 ≥ 0，阈值 0 时不会有条目「跌破 0」，等于关掉自动归档。
    decayArchiveBelow: numberOption(config, 'decayArchiveBelow', 0.6, { min: 0 }),
    maxEntries: numberOption(config, 'maxEntries', 1000, { min: 1 }),
    // 0 是合法值：用户可以把注入条数关到 0（只留固定层以外的其它功能照常）。
    injectLimit: numberOption(config, 'injectLimit', 12, { min: 0 }),
    injectMaxChars: numberOption(config, 'injectMaxChars', 2000, { min: 0 }),
    injectRecentDays: numberOption(config, 'injectRecentDays', 3, { min: 0 }),
    injectTopicEnabled: setting(config, 'injectTopicEnabled', true) !== false,
    injectRotateSlots: numberOption(config, 'injectRotateSlots', 2, { min: 0 }),
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

/**
 * 拿一个**一定存在**的 logger。
 *
 * 为什么不能直接 `ctx.logger.error(...)`：logger 是宿主提供的服务，某些精简 profile
 * 会把它裁掉。写盘失败本来只是「这次没存下去」，如果记日志这一步反而抛 TypeError，
 * 就成了「为了记错误而制造一个更大的错误」—— catch 块里再抛异常会把原始原因整个盖掉。
 * 所以这里退化成空实现，宁可少一行日志，也不让错误处理路径本身变成故障源。
 */
function safeLogger(ctx) {
  const logger = ctx?.logger;
  if (logger && typeof logger.error === 'function') return logger;
  return { error: () => {}, warn: () => {}, info: () => {} };
}

/**
 * 写盘失败 → 一条**用户看得懂**的响应。
 *
 * 为什么必须单独做：以前写盘抛错就一路冒到 route() 的兜底 catch，
 * 变成 `500 {"ok":false,"error":"..."}` —— 面板把它显示成「服务器错误」。
 * 可实际上什么都没坏：文件读不出来时 P0-1 会**拒绝写入以保护原文件**，
 * 锁超时时**磁盘上的内容一个字都没动**。用户需要知道的是「我的记忆没被改坏、
 * 该去修什么」，而不是一个 500。
 *
 * 所以：读失败保护 / 锁超时 → 503（服务暂时不能写，数据完好），带 `protected` 标记和
 * 一句怎么办；其它写盘异常 → 500，但同样说清「磁盘上的记忆没有被改动」。
 * **绝不吞**：吞掉异常等于让用户以为存成功了，那比 500 糟得多。
 */
function sendWriteFailure(res, error, what) {
  const message = String(error?.message ?? error);
  const guarded = /已拒绝写入|读取失败/.test(message);
  const locked = /无法在 \d+ms 内获得记忆文件锁/.test(message);
  const status = guarded || locked ? 503 : 500;
  sendJson(res, status, {
    ok: false,
    action: 'write-failed',
    what,
    error: message,
    // 面板据此显示红条，而不是把它当成普通报错。
    protected: guarded,
    hint: guarded
      ? '记忆文件读取失败，已拒绝写入以免覆盖原文件。请检查该文件是否损坏、权限是否正常，修好后重载即可恢复。'
      : locked
        ? '另一个进程正在写记忆文件，稍等一会儿重试即可；磁盘上的记忆没有被改动。'
        : '写入失败，磁盘上的记忆没有被改动。'
  });
  return status;
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
    // 固定层：被钉住的记忆每轮必进，不受分数和轮换影响。面板要能看出「这条为什么老在」。
    pinned: m.pinned === true,
    pinnedAt: m.pinnedAt ?? null,
    pinnedAuto: m.pinnedAuto === true,
    // 记忆图要按「还记不记得」上色，这两个派生值必须由 core 算：
    // 面板自己算就会变成第二套真相 —— 图上绿油油的点，实际下一轮就淡出了。
    strength: Math.round(memoryStrength(m, now, options.decayHalfLife) * 100) / 100,
    falloutInDays: Math.round(longMemoryFalloutDays(m, now, options.decayHalfLife, options.decayArchiveBelow) * 10) / 10
  };
}

/**
 * 从装配上下文里取出「这次在聊什么」的查询词，给话题层用。
 *
 * 只取**用户说的话**：把 agent 自己的回复也算进来，会让查询词带上大量模型自己写过的
 * 词汇，BM25 于是把「她上次提到过的记忆」当成相关 —— 那是在自我强化，不是在想事情。
 *
 * 为什么要 try/catch 到底：`AssembleContext` 的 .d.ts 声明里根本没有 `agent`
 * （声明写的是 `{ scope?, signal? }`），但运行时实测是带 agent 的。也就是说这个能力
 * 属于「能用但不保证」，任何一个版本变化都可能让它变成 undefined。
 * 拿不到就返回空串 —— 话题层空着，其余三层照常工作。这是唯一不会让功能整体崩掉的写法。
 *
 * 上限取最近 4 条用户消息、每条截 200 字：查询词太长会把 BM25 稀释成「什么都沾一点」，
 * 那和没有查询词是一样的效果，还白花 CPU。
 */
function deriveQuery(context) {
  try {
    const messages = context?.agent?.session?.deriveMessages?.() ?? context?.agent?.messages ?? [];
    if (!Array.isArray(messages) || !messages.length) return '';
    const userTexts = [];
    for (let i = messages.length - 1; i >= 0 && userTexts.length < 4; i -= 1) {
      const m = messages[i];
      if (!m) continue;
      const role = String(m.role ?? m.author ?? m.type ?? '');
      if (role !== 'user' && role !== 'human') continue;
      const text = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.filter((c) => c && typeof c.text === 'string').map((c) => c.text).join(' ')
          : '';
      const trimmed = String(text).trim().slice(0, 200);
      if (trimmed) userTexts.push(trimmed);
    }
    return userTexts.reverse().join('\n');
  } catch {
    return '';
  }
}

/**
 * 注入里给「已完成」留多少条：`limit` 的 1/4（向下取整），**至少 1 条**。
 *
 * 【为什么必须有配额】
 * 一条记忆结案之后仍然可以被提起（`RECALLABLE = ['active', 'resolved']`），
 * 这本身是对的 —— 「上次那件事后来怎么样了」是最自然的一句追问。
 * 但 `resolved` 的排序有个副作用：`stampOf()` 会取 `resolvedAt` 的最大值，
 * 也就是**结案这个动作本身让条目重新变「新」**。库里一旦积累了几十条历史，
 * 它们会在近期层反复出现，把真正待办的事挤出预算 —— 实测 20 条 resolved
 * 加 3 条 active 时，注入的 12 条里 9 条是历史（75%），3 条待办只剩角落里。
 * 所以给「已完成」一个硬上限：12 条预算里最多 3 条。
 *
 * 为什么下限是 1 而不是 0：只留 active 会让「结案」变成「再也想不起来」，
 * 那和删除没区别；用户结案的意思是「这件事完了」，不是「这件事不许再提」。
 */
function resolvedInjectionQuota(limit) {
  const value = Number(limit);
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.max(1, Math.floor(value / 4));
}

/**
 * 把候选集里的「已完成」裁到配额以内，生效中的条目原样保留。
 *
 * 【为什么在候选集上裁，而不是在挑完之后裁】
 * 挑完再删会留下一个空位：core 已经按「12 条」挑好了，删掉 6 条历史并不会
 * 自动补 6 条 active 进来（补位要重跑整轮挑选，还得重算预算）。结果是
 * 「历史被压到 25% 了，但注入只剩 6 条」，用户看到的是记忆变少了。
 * 在候选集上先裁掉多余的历史，core 的 `limit` 就自然落在 active 身上。
 *
 * 【留哪几条历史】三条优先级，依次是：
 *   1. 被钉住的（用户亲手钉的历史条目必须保住，否则「钉住」这个承诺就破了）；
 *   2. 和这轮对话沾边的（查询词命中越多越靠前 —— 这正是「按对话内容命中」
 *      这个最合理的进入理由；拿不到查询词时这一条自然全部并列）；
 *   3. 更新的（按 `stampOf` 同口径的时间戳）。
 * 不按强度排：强度低正是「它已经过去了」的证据，按强度裁等于专挑刚结案的留下。
 */
function capResolvedCandidates(list, query, quota) {
  if (!Array.isArray(list) || !list.length) return Array.isArray(list) ? list : [];
  const resolved = list.filter((m) => m?.status === 'resolved');
  if (resolved.length <= quota) return list;
  const stampOf = (m) => Math.max(
    Number(m.updatedAt) || 0,
    Number(m.lastUsedAt) || 0,
    Number(m.createdAt) || 0,
    Number(m.resolvedAt) || 0
  );
  const terms = String(query ?? '')
    .toLowerCase()
    .split(/[\s，。！？、,.!?;；:：()（）"'“”]+/)
    .filter((t) => t.length >= 2);
  const hits = (m) => {
    if (!terms.length) return 0;
    const hay = String(m.text ?? '').toLowerCase();
    return terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
  };
  const ranked = [...resolved].sort((a, b) => (hits(b) - hits(a))
    || ((b.pinned === true) - (a.pinned === true))
    || (stampOf(b) - stampOf(a)));
  const keep = new Set(ranked.slice(0, quota).map((m) => m.id));
  return list.filter((m) => m?.status !== 'resolved' || keep.has(m.id));
}

/**
 * 反复挑选，直到「已完成」的**实际占比**也落在 1/4 以内。
 *
 * 【为什么一次裁剪不够 —— 这是实测出来的，不是想出来的】
 * 配额按 `limit` 算是 `floor(12/4) = 3`，看起来正好。但候选集被裁过之后只剩
 * 3 条待办 + 3 条历史 = 6 条，core 的 `limit: 12` 会把这 6 条**全挑走**，
 * 于是历史占比 = 3/6 = 50% —— 配额明明生效了，占比照样超标。
 * 分母不是 `limit`，是「最终真的注入了多少条」，而那个数字在挑之前不知道。
 *
 * 所以先挑一次，拿到实际条数 `n`，把配额收紧到 `floor(n/4)` 再挑一次。
 * 条数只会变少不会变多（裁得更狠 → 候选更少），因此这个循环单调收敛，
 * 实测两轮就到 1/4 以内；`MAX_ROUNDS` 只是防止将来 core 改算法后转不出来。
 *
 * 下限仍然是 1 条：宁可占比略超，也不能把「已完成」全删掉 ——
 * 那等于让「结案」变成「再也想不起来」，和删除没有区别。
 */
const QUOTA_MAX_ROUNDS = 3;
function pickWithResolvedQuota(pick, list, query, quota) {
  let current = quota;
  let result = null;
  for (let round = 0; round < QUOTA_MAX_ROUNDS; round += 1) {
    const candidates = capResolvedCandidates(list, query, current);
    result = pick(query, candidates);
    const picked = result?.picked ?? [];
    if (!picked.length) return result;
    const doneCount = picked.filter((m) => m.status === 'resolved').length;
    const allowed = Math.max(1, Math.floor(picked.length / 4));
    // 已经达标，或者配额已经压到下限、再收紧也没有意义 —— 都停。
    if (doneCount <= allowed || current <= allowed) return result;
    current = allowed;
  }
  return result;
}

export function apply(ctx, config) {
  const store = new MemoryStore(resolveStoreFile(config));
  const options = coreOptions(config);
  // 宿主一定给 logger 时直接用；万一被裁掉也有个空实现兜着，
  // 免得「为了记错误而抛 TypeError」把真正的失败原因盖掉。
  const logger = safeLogger(ctx);

  // ── 第一次运行：按「理解」替用户钉一批固定层 ────────────────────────────
  //
  // 用户的原话是「第一次的条的选择你根据理解自动填入，之后可以被修改就行」。
  // 只做一次：靠 store.meta.pinnedSeededAt 记下「已经替用户钉过了」，
  // 之后用户取消哪条就哪条不再出现 —— 不做标记的话每次启动都会把他删掉的钉重新钉上。
  // 读盘和写盘分成两个 try：它们的失败含义完全不同 ——
  // 读不出来是「记忆文件坏了/没权限」，写不下去是「这次自动钉没保存」。
  // 合成一个 catch 的话，日志里只剩一句笼统的「自动钉失败」，
  // 用户不知道该去修文件还是该重试。
  let seeded = [];
  try {
    seeded = seedPinnedOnce(store.load(), store.bucket('shared'), { max: 5 });
  } catch (error) {
    logger.warn('memory-lens: 首次运行自动钉固定层时读取记忆失败（已保护原文件，不写入）', error);
  }
  if (seeded.length) {
    try {
      store.save();
      logger.info(
        `memory-lens: 首次运行，按理解自动钉住 ${seeded.length} 条固定记忆（可在面板里改）：${seeded.map((m) => m.text.slice(0, 12)).join(' / ')}`
      );
    } catch (error) {
      // 自动钉是「锦上添花」：存不下去也照样能用（内存里已经钉上了），
      // 用户没有丢任何东西，所以 warn 而不是 error。但**不能吞**：
      // 否则「自动钉没生效」这件事永远不出现在日志里。
      logger.warn('memory-lens: 首次运行自动钉固定层写盘失败（记忆文件可能读不出来）', error);
    }
  }

  // 最近一次**真实注入**的结果。面板显示它，而不是自己重算一遍 ——
  // 一旦注入依赖会话内容（话题层），HTTP 请求里没有 agent 上下文，
  // 面板重算必然和真注入分叉。宁可显示「上一次实际注入了什么」，
  // 也不要一个看起来更聪明、其实是另一套算法的副本。
  let lastInjection = null;

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
      text: (context) => {
        try {
          // 读盘失败要**在日志里留痕**，而不只是「这一轮没东西可注入」。
          // P0-1 让 store 在读失败时进入 readOnly 并拒绝写入（原文件保住了），
          // 但如果宿主侧一声不响，用户看到的只是「记忆突然空了」——
          // 他不知道记忆还在磁盘上、只是读不出来，也不知道该去修哪个文件。
          // 用 error 而不是 warn：这是「数据可能丢了」级别的事，默认日志配置下也要留得下来。
          // 注意读的是 loadError 而不是 lastError：lastError 会被写盘路径复用
          // （backup-failed / recovered-from-corrupt），拿它判读失败会误报。
          if (store.loadError) {
            ctx.logger?.error?.(
              `memory-lens: 记忆文件读取失败（${store.loadError}），本轮不注入记忆；` +
                `原文件已保护、拒绝写入：${store.file}`
            );
          }
          // injectLimit=0 是**合法配置**（用户想彻底关掉自动注入）。
          // 必须在宿主这一层短路：core 的 `Math.max(1, Number(limit) || 12)` 会把 0 抬成 1，
          // 交给他兜就等于「用户关了但还在注入一条」。
          if (!(options.injectLimit > 0)) return '';
          // 注入视图必须是**可被想起的**那一批，而不是「还在生效」的那一批。
          // `RECALLABLE = ['active', 'resolved']`（core 的权威定义）：结案不等于删除，
          // 「上次那件事后来怎么样了」是最自然的一句追问，把 resolved 排除在注入之外
          // 等于让「结案」变成「再也想不起来」。同时这也让注入和 `recall` 工具
          // 走同一个集合 —— 同一个库两个视图，用户会以为插件在骗他。
          // 归档/已取代仍然进不来：`store.recallable()` 内部就是 `recallableList`，
          // 过滤只在这一个地方做，注入路径不自己写 status 判断。
          const list = store.recallable('shared');
          if (list.length === 0) return '';
          const now = Date.now();
          // 话题层的查询词：从会话历史里取最近几条用户发言。
          //
          // 为什么用历史而不是「这一轮刚说的那句」：section 的 text 在装配上下文时求值，
          // 那一刻本轮的新消息还没进 session（pre-step 在装配之后才跑）。所以这里拿到的是
          // 上一轮及之前的话 —— 对「最近在聊什么」完全够用，而全新会话的第一条拿不到时，
          // 话题层自动空着、名额让给兜底层，不会让整体变差。
          // 整个包 try/catch：不同版本宿主的 agent 形状不一致，取不到就当作没有查询词。
          const query = deriveQuery(context);
          // 「已完成」配额：在**候选集**上先把历史裁到 1/4，再交给 core 挑四层。
          // 为什么不在挑完再裁：core 已经按 limit 挑满了，事后删几条历史不会自动补
          // 等量的 active 进来（补位要重跑整轮挑选并重算预算），结果会变成
          // 「历史占比达标了，但注入只剩一半」—— 用户看到的是记忆变少了。
          // 裁掉的只是 resolved，active 原样全留；归档/已取代本来就不在候选集里
          // （`store.recallable()` 已经滤过），这里绝不自己写 status 判断。
          // 话题层关掉时查询词不参与挑选，配额排序也就按「钉住 > 新近」来。
          //
          // 【为什么还要按实际条数再挑一轮】
          // 候选被裁之后条目总数可能不到 limit（3 条待办 + 3 条历史 = 6 条），
          // core 会把这 6 条全挑走，历史占比就成了 3/6 = 50%。
          // 分母永远是「最终注入了多少条」，不是 limit —— 见 pickWithResolvedQuota。
          const quota = resolvedInjectionQuota(options.injectLimit);
          const pick = (q, candidates) => selectLayeredMemories(candidates, q, {
            maxChars: options.injectMaxChars,
            limit: options.injectLimit,
            now,
            recentDays: options.injectRecentDays,
            rotateSlots: options.injectRotateSlots
          });
          const render = (result) => (result.picked.length ? formatLongMemoryBlock(result.picked, now) : '');
          // 话题层关掉时把它并进兜底层：查询词不参与挑选，等于三层。
          if (!options.injectTopicEnabled) {
            const flat = pickWithResolvedQuota(pick, list, '', quota);
            const block = render(flat);
            // 面板要显示「上一次实际注入了什么」，所以 block 必须跟着一起记 ——
            // 少了它，面板会显示「注入了 N 条」却拿不到注入文本，用户以为注入坏了。
            lastInjection = { ...flat, query: '', now, block };
            return block;
          }
          // touch=false 是有意的：注入不等于「用到了」。每轮都算一次使用的话，
          // hits 会变成「说了多少轮话」而不是「这条记忆真的被想起来过几次」，
          // 强度曲线和面板上的数字就全失真了。
          const result = pickWithResolvedQuota(pick, list, query, quota);
          const block = render(result);
          lastInjection = { ...result, query, now, block };
          return block;
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
    //
    // 返回一个**有形状的**对象而不是 null：调用方要能分清三种结局 ——
    //   节流跳过（正常，什么都不用做）、真的整理了、写盘失败（要上报）。
    // 以前三种都返回 null/undefined，于是「跳过」和「失败」在调用方眼里长得一模一样，
    // 谁也没法为失败做点什么。
    if (now - lastOrganizeAt < 60_000) return { skipped: true, reason: 'throttled' };
    // 计算和写盘分成两段接住 —— 它们的失败含义完全不同：
    // 算法抛错是「这一轮不整理」，写盘抛错是「整理结果没落盘，磁盘可能已经读不出来」。
    // 合成一个 catch 的话，两种结局在调用方眼里长得一模一样，谁也没法为失败做点什么。
    let result;
    try {
      const list = store.bucket('shared');
      result = organizeLongMemories(list, {
        now,
        halfLife: options.decayHalfLife,
        archiveBelow: options.decayArchiveBelow,
        maxArchivePerRun: 3,
        consolidate: true
      });
    } catch (error) {
      // 整理失败不能影响主流程：宁可这一轮不整理，也不能让写入报错。
      logger.warn(`memory-lens: 衰减整理（${reason}）失败`, error);
      return { skipped: true, reason: 'failed', error: String(error?.message ?? error) };
    }
    // 【物理删除必须有日志】plan-v2.md:236 规定「归档区超过 maxArchived 时删最老的归档」
    // 是唯一允许的硬删路径，**且必须留日志**。用户看不见的删除最危险：
    // 「我明明记过」而库里已经没有了，而且没有任何痕迹可查。
    // 这里用 logger.error（不是 info/debug）：删除不可逆，级别要够高，
    // 默认日志配置下也得留得下来。写法和 tools.js 的 remember 路径保持一致，
    // 同一个事件在两处出现时，日志长得一样才方便一起查。
    const purged = result.purged ?? [];
    if (purged.length) {
      logger.error(
        `[memory-lens] 归档区超过 maxArchived，物理删除了 ${purged.length} 条最老的归档记忆（整理原因：${reason}）：` +
          purged.map((m) => `${m.id}「${String(m.text).slice(0, 30)}」(${m.archiveReason ?? 'unknown'})`).join('、')
      );
    }
    // purged 也要触发写盘：物理删除改的是磁盘上的内容，不落盘等于删了个寂寞
    // （内存里没了、文件里还在，下次启动又全回来了）。
    if (result.archived > 0 || result.merged > 0 || purged.length > 0) {
      try {
        store.save();
      } catch (error) {
        // 读失败保护（readOnly）抛的错到这里 —— 这是**数据层出事了**，
        // 用 error 级别并写明「原文件已保护」。只记 warn 的话，
        // 用户看到的只是「记忆好像不会淡出了」这种毫无线索的现象。
        const message = String(error?.message ?? error);
        logger.error(
          `memory-lens: 衰减整理（${reason}）写盘被拒绝，原文件已保护（${store.file}）：${message}`,
          error
        );
        return { skipped: true, reason: store.readOnly ? 'read-only' : 'failed', error: message };
      }
      logger.info(
        `memory-lens: 整理完成（${reason}）归档 ${result.archived} 条、合并 ${result.merged} 条` +
          (purged.length ? `、物理删除 ${purged.length} 条` : '') +
          `，生效 ${result.before} → ${result.after}`
      );
    }
    lastOrganizeAt = now;
    return result;
  };
  organize('启动');

  // ── 工具 ─────────────────────────────────────────────────────────────
  //
  // 【为什么必须包 try/catch】曾经踩过一次：tools.js 里一个 schema 写成了
  // DSH 不支持的 `type: ['string','null']`，defineTool 抛 JsonSchemaError，
  // registerMemoryTools 中断 → 下面的 ctx.inject(['webServer']) 根本没执行到
  // → 六条路由一条都没注册 → 设置页面板整个变成 404，所有计数器归零。
  //
  // 一个 schema 写错，代价是**整个插件不可用**，而且症状（面板 404）离病根
  // （一行 schema）十万八千里，排查时被误导了很久。
  //
  // 包住之后：工具注册失败只丢工具，注入和面板照常工作，日志里能看到真正的
  // 错误原因。宁可少三个工具，也不能让面板和记忆注入一起死。
  try {
    registerMemoryTools(ctx, { store, config, afterWrite: () => organize('写入') });
  } catch (error) {
    ctx.logger?.error?.('memory-lens: 注册工具失败（注入与面板不受影响）', error);
  }

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

    // 全量快照：条目 + 统计 + 最近一次真实注入。面板一次请求拿到所有东西，
    // 避免「列表已刷新、统计还是旧的」这种半新半旧的状态。
    //
    // 注入预览**不再在这里重算**：四层里的「话题层」取决于会话内容，而 HTTP 请求里
    // 没有 agent 上下文 —— 在这里重算只能拿到固定层/近期层/兜底层，跟真注入必然分叉，
    // 那面板就成了一句漂亮的谎话。改成报告 lastInjection（上一次装配上下文时真正
    // 注入的那一段），并明确标出「还没发生过注入」的情况，让面板能如实说
    // 「下一次对话时才会注入」。
    // 路径写成 `API_PREFIX + '/snapshot'` 而不是模板串：`'/snapshot'` 这样才是源码里
    // 一个真实存在的字面量，路由表能被静态检索到（审计脚本、契约探针都按字符串找路径）。
    // 模板串 `${API_PREFIX}/snapshot` 里的路径片段在文本层面是隐形的。
    route(API_PREFIX + '/snapshot', async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      // 读失败必须在**响应里**可见，这是 P0-1 的配套要求。
      // P0-1 让 store 在读失败时进入 readOnly 并拒绝写入（原文件保住了），
      // 但如果面板拿不到这件事，用户看到的只是一个「空的记忆列表」——
      // 他不知道记忆还在磁盘上、只是读不出来，也不知道该去修哪个文件。
      // 所以这一行要放在处理函数最前面：任何分支（包括下面提前 return 的）都带上它。
      // 取的是 store.loadError 而不是 lastError —— lastError 会被写盘路径复用
      // （backup-failed / recovered-from-corrupt），拿它判读失败会误报。
      const loadError = store.loadError ?? null;
      const now = Date.now();
      const all = store.all('shared');
      const layerNames = { pinned: '固定', recent: '近期', topic: '话题', fallback: '兜底' };
      const injected = lastInjection
        ? {
            count: lastInjection.picked.length,
            chars: lastInjection.chars,
            budget: lastInjection.budget || options.injectMaxChars,
            over: Math.max(0, lastInjection.chars - options.injectMaxChars),
            block: lastInjection.block,
            ids: lastInjection.picked.map((m) => m.id),
            at: lastInjection.now,
            query: lastInjection.query,
            // 只报**真的装进了东西**的层。空层留在面板上会让人以为「话题层在工作但没命中」，
            // 而实际可能是这一轮根本没拿到查询词 —— 两种情况在面板上没必要区分，
            // 但「这条记忆属于哪一层」必须看得见，所以层内 id 一个都不能少。
            layers: Object.entries(lastInjection.layers)
              .filter(([, ids]) => Array.isArray(ids) && ids.length > 0)
              .map(([key, ids]) => ({ key, label: layerNames[key] || key, ids }))
          }
        : {
            // 还没发生过注入：给个空壳但说明原因，而不是伪造一份「将要注入的内容」。
            count: 0,
            chars: 0,
            budget: options.injectMaxChars,
            over: 0,
            block: '',
            ids: [],
            at: null,
            query: '',
            layers: [],
            pending: true
          };
      sendJson(res, 200, {
        ok: true,
        // 读盘失败的原文（成功时为 null）。面板据此显示红条 + 「原文件已保护」，
        // 而不是把一个空的记忆列表当成「用户没记过东西」。
        loadError,
        items: all.map((m) => itemView(m, now, options)),
        injected,
        counts: {
          total: all.length,
          active: all.filter((m) => m.status === 'active').length,
          resolved: all.filter((m) => m.status === 'resolved').length,
          archived: all.filter((m) => m.status === 'archived').length,
          superseded: all.filter((m) => m.status === 'superseded').length,
          pinned: all.filter((m) => m.status === 'active' && m.pinned === true).length
        },
        config: {
          storeFile: store.file,
          injectEnabled: options.injectEnabled,
          injectLimit: options.injectLimit,
          injectMaxChars: options.injectMaxChars,
          injectRotateSlots: options.injectRotateSlots,
          injectRecentDays: options.injectRecentDays,
          injectTopicEnabled: options.injectTopicEnabled,
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
        // 写盘必须单独接住：readOnly（读失败保护）和锁超时都会抛，
        // 直接冒到 route() 的兜底 catch 会变成面板上一句「服务器错误」——
        // 可实际什么都没坏，用户需要看到的是「原文件已保护 / 稍后重试」。
        try {
          store.save();
        } catch (error) {
          logger.error(`memory-lens: 面板编辑记忆写盘失败（${target.id}）`, error);
          return sendWriteFailure(res, error, 'updated');
        }
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
      try {
        store.save();
      } catch (error) {
        logger.error(`memory-lens: 面板新增记忆写盘失败（${result.item.id}）`, error);
        return sendWriteFailure(res, error, 'created');
      }
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
        case 'pin':
        case 'unpin': {
          // 固定层：钉住 = 每轮必进，不看分数、不参与轮换。用户说「这条得一直记着」，
          // 那就别让 BM25 去替他决定。取消钉住时把 pinnedAuto 一并清掉 ——
          // 否则下次启动的自动钉逻辑会以为「这条是系统钉的」，又给他钉回去。
          const result = action === 'pin'
            ? pinLongMemory(list, { id: body.id, text: body.text, now })
            : unpinLongMemory(list, { id: body.id, text: body.text, now });
          if (!result) {
            return sendJson(res, 400, {
              ok: false,
              error: '没找到这条记忆，或它已归档/已结案/已取代（钉住也不会进注入）'
            });
          }
          try {
            store.save();
          } catch (error) {
            logger.error(`memory-lens: 面板 ${action} 写盘失败（${result.id}）`, error);
            return sendWriteFailure(res, error, action);
          }
          // 用户一旦亲手钉过或取消过，就算「这件事他已经表过态」—— 把自动钉的标记写死，
          // 否则会撞上这样一个坑：装插件时库还是空的（自动钉按新规则不落标记），之后导入
          // 记忆、用户取消掉自动钉，下次启动自动钉又跑一遍，把他取消的又钉回来。
          // 用户的意图永远比系统的引导优先。
          if (!Number(store.state?.meta?.pinnedSeededAt)) {
            store.state.meta = {
              ...(store.state.meta || {}),
              pinnedSeededAt: now,
              pinnedSeededCount: store.bucket('shared').filter((m) => m.pinned === true).length
            };
            // 这是第二次写盘（落「已表过态」标记）。失败也不回滚钉住动作 ——
            // 用户要的是「这条被钉住了」，标记只是防止下次启动重复自动钉；
            // 少一个标记最多让自动钉多跑一次，而回滚会让用户的点击白费。
            // 但必须上报：否则「标记没落下」这件事没有任何痕迹。
            try {
              store.save();
            } catch (error) {
              logger.error('memory-lens: 写盘失败，自动钉标记未落下（下次启动可能重复自动钉）', error);
              return sendWriteFailure(res, error, action);
            }
          }
          return sendJson(res, 200, { ok: true, action, id: result.id, pinned: result.pinned });
        }
        case 'delete': {
          const index = list.indexOf(target);
          if (index >= 0) list.splice(index, 1);
          try {
            store.save();
          } catch (error) {
            logger.error(`memory-lens: 删除记忆写盘失败（${body.id}）`, error);
            return sendWriteFailure(res, error, 'deleted');
          }
          return sendJson(res, 200, { ok: true, action: 'deleted', id: body.id });
        }
        default:
          return sendJson(res, 400, { ok: false, error: `未知动作 ${action}` });
      }
      target.updatedAt = now;
      try {
        store.save();
      } catch (error) {
        logger.error(`memory-lens: 面板 ${action} 写盘失败（${target.id}）`, error);
        return sendWriteFailure(res, error, action);
      }
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
      try {
        store.save();
      } catch (error) {
        logger.error(`memory-lens: 导入记忆写盘失败（本次 ${added} 条未落盘）`, error);
        return sendWriteFailure(res, error, 'imported');
      }
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

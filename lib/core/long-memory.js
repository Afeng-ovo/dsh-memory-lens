// 长期记忆：跨会话、不过期的事实卡。
//
// 与 social-v2.json 里的 activeTopics / pendingThoughts 的区别：
//   - 那两类带 TTL（话题 24h、想法 2h），只服务“当前在聊什么”
//   - 这里存的是应该一直记得的事：对方的稳定事实、偏好、约定、重要事件
//
// 独立文件（state/long-memory.json），不走 social-v2 的白名单式持久化 ——
// 那条路每加一个字段都要在 load/save 两处登记，漏一处就静默不落盘。
//
// v2 相对 v1 的三处升级（对齐 dsh-longterm-memory 的做法）：
//   1. 冲突不再静默合并。v1 用 overlap≥0.7 直接并成一条，而 min(|A|,|B|) 做分母会让
//      短句天然接近 1 —— “阿风在准备考研”和“阿风在准备考公”会被揉成一条，且 weight
//      取 max 之后永远淘汰不掉。现在只有“重述/补充”才合并，语义冲突一律双方并存，
//      由调用方用 supersedes 显式点名淘汰旧条目（旧的标 superseded，不删）
//   2. 检索换 BM25。v1 的纯字面重合在几十条时就退化成“字多的靠前”，且没有任何
//      区分度的概念（每条都出现的词和只出现一次的稀有词权重一样）。BM25 的 IDF 正好治这个
//   3. 写入前过敏感检测。v1 的 longTerm 链路绕过了 redactKnownTokensOnly，群友发的
//      手机号/卡号/token 有可能被提炼进来
import fs from 'node:fs';
import path from 'node:path';

export const KINDS = ['fact', 'pref', 'promise', 'event'];
const KIND_LABEL = { fact: '事实', pref: '偏好', promise: '约定', event: '事件' };
// 每种状态都要能被 normalizeStore 认回来。早先这里漏了 archived，
// 结果归档只在内存里有效：写盘再读一轮，归档的条目全部复活，整理等于白做。
//
// resolved 是「约定已兑现 / 事情有结果了」的终态，和 superseded 的区别是：
// 取代 = 这条信息不再成立（考研→考公，旧的作废）；结案 = 这件事真的发生过、做完了
// （周六电影看完了）。结案的事不该再被当待办追问，但仍然值得一提——「上次那个面试
// 过了」正是活人记忆里最自然的一句，所以它属于 RECALLABLE，照常参与检索和注入。
export const STATUS = ['active', 'superseded', 'archived', 'resolved'];

// 能被检索 / 注入的状态：active + resolved。
// superseded 和 archived 是「下架」，不再出现在任何注入里。分开两组而不是让
// activeList 承担两种语义，是因为「生效」和「可被想起」本来就不是一件事：
// 统计生效条数、跑衰减、挑到期项都只该看 active。
const RECALLABLE = ['active', 'resolved'];
const MAX_TEXT = 120;
const MAX_TAGS = 6;
const MAX_TAG_LEN = 12;
// 库文件格式版本。2 → 3 的迁移见 normalizeStore 里的说明。
// 导出是给探针核对版本号用的（验收要求能验证「迁移到当前版本」）。
export const STORE_VERSION = 3;

// rename 覆盖的重试窗口（毫秒）。见 writeLongMemoryStore 下面的说明：
// Windows 上目标文件被别的进程打开时 rename 会抛 EPERM，而那个窗口通常只有
// 几十毫秒（对方是 readFileSync 这种瞬时读）。500ms 足够覆盖真实竞争，
// 又不至于把「文件真的被长期占用」的调用方挂死。
const RENAME_RETRY_MS = 500;

/** 同步睡眠。写盘链路全是同步语义（9 处 store.save() 都是同步调用），不能改成 async。 */
function sleepSync(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // 忙等，单次最多 24ms，可接受
  }
}

// BM25 参数：k1 控制词频饱和，b 控制长度归一化强度（0=不归一，1=完全归一）
const BM25_K1 = 1.2;
const BM25_B = 0.75;

// 判重阈值：Dice 相似度 + 长度比。两个都满足才算“同一件事重述”，否则并存。
const DUP_DICE = 0.9;
const DUP_LEN_RATIO = 0.6;

// 【P0-4】判重曾经是「无条件包含即判同」：只要一条的文本被另一条完整包含，
// 就当成同一件事重述、只留信息更多的那条。看着很合理，实际会**吃掉真语义**：
//
//   「喜欢猫」   ⊂ 「不喜欢猫」     → 判同 → 「不喜欢」被丢掉，结论完全反过来
//   「条目 1」   ⊂ 「条目 10」      → 判同 → 10 条内容被并进 1 条
//   「阿风」     ⊂ 「阿风说他下周要出差」 → 判同 → 一句话把「这个人是谁」整个吞掉
//   「抖音」     ⊂ 「抖音群」       → 判同 → 两个不同对象被合并
//
// 这不是「判重太松」这种程度问题，是**信息被静默改写**：用户说「不喜欢猫」，
// 库里的结论变成「喜欢猫」，之后所有回答都反着来，而且没有任何报错。
//
// 所以包含关系不能单独作为判同证据，必须同时满足三个条件才算「同一件事重述」：
//   1. 长度比 ≥ DUP_LEN_RATIO（0.6）—— 两者规模相当，不是「一个词被一句吞掉」；
//   2. 被包含的那条**不是**包含者的完整前缀/后缀 —— 否则是「补充说明」而非重述；
//   3. 紧邻的那个字不是标点 —— 中文里「喜欢猫」和「喜欢猫，但不讨厌狗」的差别
//      全在标点后面，把标点当普通字符会让补充句被误判成重述。
//
// 【为什么不照抄 audit-core.md:482-491 的 C8a 修法】
// 那里的写法是「短句 ≤ MAX_TAG_LEN 且不含标点 → 不判同」。这个判据会打挂验收⑥：
// 「阿风在准备考研」7 字 ≤ 12 且无标点，正落在「关键词式短语」定义里，
// 于是它和「阿风在准备考研，目标计算机」被判成两条 —— 而这一对**必须**判同。
// 67 组穷举实测：C8a 字面修法只对 33 组、判错 34 条，所有「标点接缝」形态的用例
// 全部判错 —— 因为「有没有标点」和「接缝处是什么字符」是两件事，前者太粗。
// 所以必须用下面「前缀/后缀 + 紧邻标点」的判据，而不是长度阈值。
const DUP_PUNCT = new Set([...'，。！？；：、', ...',.;:!?']);
// 注意两段都必须展开（`...'，。！？；：、'` 和 `...',.;:!?'`）。写成
// `new Set([...'，。！？；：、', ',.;:!?'])` 会把第二段当成**一个整体字符串**，
// 于是 Set 里多出一个 6 字符的成员、而单个英文标点一个都不在里面 —— 判据失效。
// 空格**必须排除**：把空格也当分隔符能让「条目 1」/「条目 1 号」看起来是同一个
// 编号，但代价是把「条目 1」和「条目 1 号」判成同一条 —— 那正是从后门漏回丢数据
// 方向（编号 1 的记忆被编号 1 号的记忆吞掉，原文再也找不回来）。
// 实测：把空格纳入分隔会判错 4 条，收益为负，所以不纳。

/**
 * 短句是不是长句的「完整前缀/后缀」，以及接缝处是哪个字符。
 *
 * 为什么必须看接缝：同样是完整前缀，接缝是标点和接缝是字，含义完全不同。
 *   短='阿风在准备考研' 长='阿风在准备考研，目标计算机'
 *     前缀命中，接缝 '，' → 同一件事后面补了个从句 → 判同
 *   短='抖音' 长='抖音群'
 *     前缀命中，接缝 '群' → 长句是个**新对象**（抖音群 ≠ 抖音）→ 判两条
 *   短='小鲸鱼' 长='小鲸鱼说'
 *     前缀命中，接缝 '说' → 长句是「某人做了某事」→ 判两条
 *
 * @returns {{hit:boolean, seam:string|null}} hit 为 false 表示短句在长句中间、
 *          被别的词包住（不是完整前后缀）。
 */
function prefixSuffixOf(shortOne, longOne) {
  if (shortOne === longOne) return { hit: false, seam: null };
  if (longOne.startsWith(shortOne)) {
    return { hit: true, seam: longOne.charAt(shortOne.length) };
  }
  if (longOne.endsWith(shortOne)) {
    return { hit: true, seam: longOne.charAt(longOne.length - shortOne.length - 1) };
  }
  return { hit: false, seam: null };
}

/**
 * 判重前的矛盾守卫：数字与否定不一致时，一律判两条。
 *
 * 这里的判据不是拍脑袋定的，每条都对应一种「判同会静默改写用户结论」的真实形态：
 *
 * 【数字：短句的数字集合 ⊆ 长句的数字集合】
 * 不要求两边「完全相同」，因为真补充场景下长句会包含短句的全部数字：
 * 「会议定在 3 点」→「会议定在 3 点，改成 4 点」，后者是用户后来写的更完整表述，
 * 判同后合并取更长的正文，信息一点不丢；若判两条，库里会同时躺着已过期的「3 点」
 * 和新的「改成 4 点」，注入时两条互相矛盾 —— 那比合并糟得多。
 *
 * 但「短 ⊆ 长」只是判同的**必要**条件之一，不是充分条件：
 * 「条目 1」/「条目 10」这类靠「接缝紧随字符非标点」挡住（见 prefixSuffixOf），
 * 数字判据在这里只是冗余双保险。所以放宽这一条不会放开它们。
 *
 * 真正必须判两条的是「替换」而不是「补充」：`阿风有 2 只猫` vs `阿风有 3 只猫` ——
 * 数字集合 {2} ⊄ {3}，直接被挡。（`阿风有 2 只猫` / `阿风有 2 只猫和 1 只狗`
 * 是补充，{2} ⊆ {2,1}，判同。）
 *
 * 【否定：剥掉词内的「不」后仍然要比个数】
 * 「不喜欢猫」vs「喜欢猫」剥完后都是「喜欢猫」，但**剥之前**否定词数量不同 → 判两条。
 * 注意这条不能反向放宽：把否定判据放松会放过
 * 「喜欢猫」/「喜欢猫，但不讨厌狗」这种真语义翻转 —— 那是把用户的结论改掉，
 * 比多存一条重复严重得多。
 */
function hasContradiction(a, b) {
  const negCount = (s) => (String(s).match(/不/g) ?? []).length;
  if (negCount(a) !== negCount(b)) return true; // 否定词个数不同 → 语义可能翻转
  const digitsOf = (s) => new Set(String(s).match(/\d+/g) ?? []);
  const da = digitsOf(a);
  const db = digitsOf(b);
  // 小的集合必须被大的集合包含：允许补充（2 → 2 和 1），不允许替换（2 → 3）
  const small = da.size <= db.size ? da : db;
  const big = da.size <= db.size ? db : da;
  for (const d of small) if (!big.has(d)) return true;
  return false;
}

function blank() {
  return { version: STORE_VERSION, buckets: {}, meta: {} };
}

function cleanTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map((t) => String(t ?? '').trim().slice(0, MAX_TAG_LEN)).filter(Boolean))].slice(0, MAX_TAGS);
}

// dueAt 归一化：模型可能给三种形态，统一成 { when, date, ts }。
//   - 字符串：日期或相对时间，如 "2026-11-01" / "这周六" / "下个月"
//   - 数字：时间戳（毫秒）
//   - 对象：{ when: "这周六", date: "2026-11-01" } —— 保留原文 + 绝对日期
// 拿不准（既不是日期也不是时间戳）时返回 null，别硬塞一个错的时间。
export function normalizeDueAt(raw) {
  if (raw == null) return null;
  // 对象形态：只认 when / date / ts 三个键
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const when = String(raw.when ?? raw.date ?? '').trim();
    const date = String(raw.date ?? '').trim();
    const ts = Number(raw.ts ?? raw.timestamp ?? 0);
    const tsFinite = Number.isFinite(ts) && ts > 0 ? ts : null;
    const dateTs = parseDateTs(date);
    const finalTs = tsFinite ?? dateTs;
    if (!when && !date && !finalTs) return null;
    return { when: when || '', date, ts: finalTs };
  }
  // 数字：当成时间戳。>1e12 是毫秒，否则按秒补到毫秒（兼容模型偶尔给的秒）
  if (typeof raw === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    return { when: '', date: '', ts: n > 1e12 ? n : n * 1000 };
  }
  // 字符串：先按日期解析，解不出来就当纯「相对时间」文案（when 保留原文）
  const s = String(raw).trim();
  if (!s) return null;
  const ts = parseDateTs(s);
  return ts ? { when: s, date: s, ts } : { when: s, date: '', ts: null };
}

// 把 "YYYY-MM-DD" / "YYYY-MM-DD HH:mm" / "YYYY/M/D" 这类转成时间戳。
// 解析不出来返回 null。只用本地时区的当日 00:00（日期是「那天」不是「那秒」）。
function parseDateTs(s) {
  const str = String(s ?? '').trim();
  if (!str) return null;
  const m = str.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, Se] = m;
  const year = Number(Y);
  const month = Number(Mo) - 1;
  const day = Number(D);
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  const dt = new Date(year, month, day, Number(H || 0), Number(Mi || 0), Number(Se || 0));
  if (!Number.isFinite(dt.getTime())) return null;
  // 回读校验：JS 的 Date 会把不存在的日子往后顺延（2 月 31 日变成 3 月 3 日），
  // 于是一条「2026-02-31」的约定会在 3 月 3 日突然提醒。宁可判为解析不出，
  // 也不要记下一个错的日期 —— 那比没有更糟。
  if (dt.getFullYear() !== year || dt.getMonth() !== month || dt.getDate() !== day) return null;
  return dt.getTime();
}

function isActive(m) {
  return (m?.status ?? 'active') === 'active';
}

function isRecallable(m) {
  return !!m && RECALLABLE.includes(m?.status ?? 'active');
}

export function activeList(list) {
  return (Array.isArray(list) ? list : []).filter((m) => m && isActive(m));
}

// 检索 / 注入用的视图：生效 + 已完成。已完成的事还要能被提起，
// 否则「结案」就等于「删掉」——那正是另一套记忆方案被诟病的地方。
export function recallableList(list) {
  return (Array.isArray(list) ? list : []).filter(isRecallable);
}

// 加字段时最容易踩的坑：这个函数曾经是**逐字段白名单重建** —— 只有被显式写进来的
// 键才会活下来，其余全部静默丢弃。实测一条 23 字段的条目读回来只剩 12 个，
// 丢掉的包括 confidence / source / entityIds / quotes / strength / decay。
//
// 后果是连锁的，而且一个都不报错：
//   1. 任何新功能加的字段，写完 → 读盘 → 消失。想加「依据引文」「实体图谱」，
//      在旧机制下等于没加。
//   2. audit.js 的「该沉没沉」检查读 m.strength，而 strength 永远不存在 →
//      这条体检是死代码，用户库只增不减时它一声不吭。
//   3. 面板编辑正文（index.js 不截断）写 200 字 → 下次读盘被截到 120 →
//      用户看到"后半段没了"，无提示。
//
// 所以现在反过来：**默认保留一切，只显式拒绝危险键**，再对需要归一化的已知字段
// 逐项覆盖。加新字段从此不用改这里。
//
// 为什么要拒绝这几个：__proto__ / constructor / prototype 是原型链污染入口，
// 从 JSON 里读进来的对象一旦带这些键，赋值时会改到 Object.prototype 上，
// 影响整个进程（不只是这个库）。DENY_HEAVY 挡的是「已知的大字段」——
// 存储层保留 ≠ 该发给前端，itemView 那边仍是白名单（见 index.js）。
//
// 【DENY_HEAVY 的边界：它防的是**已知**重字段，不防未知大字段】
// reviewer 实测过：往一个**普通字段名**里灌 587KB 字符串，DENY_HEAVY 的 6 键黑名单
// 完全挡不住，文件照样变大 587KB。这是**方案本身的取舍**，不是实现缺陷：
//
//   · 黑名单只能枚举「我们已经知道会很大」的字段（embedding / vector / blob 这类
//     AI 生态里的标准重字段名）；
//   · 而默认保留其他一切字段，是为了**不丢用户数据** —— 这正是 P0-3 的目的。
//     如果为了防大字段改成白名单，就等于回到「写完读盘就消失」的老毛病。
//
// 要真正挡住「任意字段名 + 任意大体积」，需要的是**体积预算**（单条上限 / 总量上限 /
// 超限时拒写并告知用户），而不是再加几个黑名单键 —— 那只是把洞挪到下一个字段名。
// 体积预算**本批未实现**，记为后续批次。当前策略的适用面是「正常使用 + 已知重字段」，
// 恶意构造的超大普通字段不在 P0 范围内。
const DENY_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const DENY_HEAVY = new Set(['embedding', 'embeddings', 'vector', 'vectors', 'blob', 'raw']);

/** 把一条原始条目里「不该落盘」的键剔掉，其余原样留下。 */
function keepSafeFields(x) {
  const out = {};
  for (const [k, v] of Object.entries(x)) {
    if (DENY_KEYS.has(k) || DENY_HEAVY.has(k)) continue;
    // undefined 要保留成「键缺失」而不是 null：JSON.stringify 会把 null 写出去，
    // 而 audit.js 的跨库比对把「有 null」和「没这个键」当成两种状态，会误报差异。
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

export function normalizeStore(raw) {
  const base = blank();
  if (!raw || typeof raw !== 'object' || !raw.buckets || typeof raw.buckets !== 'object') return base;

  // 【P0-3 第 4 条】版本迁移。
  //
  // 原来 version 只是个写死的常量：blank() 写 STORE_VERSION，normalizeStore 却
  // 完全不看 raw.version —— 于是「版本号」既不能反映真实格式，也没有任何迁移能力。
  // 一个 0.4 时代写的 v1 文件（条目没有 status / pinned 等字段）读进来，靠的是
  // normalizeStore 里各字段的兜底值「顺手」补齐，而不是一段明确的迁移逻辑；
  // 一旦某个字段的兜底语义需要随版本变化（比如 v3 要把 pinned 从 boolean 改成
  // 带来源的对象），就没有任何地方能判断「这个文件是哪个年代写的」。
  //
  // 现在做两件事：
  //   1. 读进来的文件如果 version 缺失或小于当前版本，走显式迁移分支；
  //   2. 写出去的一律带 STORE_VERSION，让下次读能判断要不要迁移。
  //
  // 迁移必须是**幂等**的：同一个文件反复读写，结果要稳定。所以每个分支只做
  // 「把旧形态补成新形态」，不依赖时间、不依赖随机数。
  const fileVersion = Number(raw.version);
  const fromVersion = Number.isFinite(fileVersion) && fileVersion > 0 ? fileVersion : 1;

  // v1 → v2：条目没有 status（全部视为 active）、没有 pinned（全部 false）。
  // 这两个的兜底本来就在下面的逐字段归一化里，这里显式记一笔是为了让迁移可读：
  // 未来 v3 若把 status 拆成 lifecycle 对象，就要在这里补一段真正搬数据的逻辑。
  // v2 → v3：本次只新增了 meta 的自由键与顶层 schemaVersion，条目结构不变，
  // 因此不需要搬数据 —— 但**必须**把 base 的版本号写对，否则会一直被判为「需迁移」。
  for (const [key, list] of Object.entries(raw.buckets)) {
    if (!Array.isArray(list)) continue;
    const bucket = [];
    for (const x of list) {
      if (!x || typeof x.text !== 'string' || !x.text.trim()) continue;
      const createdAt = Number(x.createdAt) || Date.now();
      // v1 的条目没有 status 字段，这里统一补成 active —— 也就是迁移本身
      const status = STATUS.includes(x.status) ? x.status : 'active';
      // 先原样保留所有安全字段，再用下面这些「必须归一化」的字段覆盖它们。
      // 顺序很重要：spread 在前、覆盖在后，否则新加的字段会把归一化结果冲掉。
      bucket.push({
        ...keepSafeFields(x),
        id: String(x.id || `lm-${createdAt.toString(36)}${Math.random().toString(36).slice(2, 6)}`),
        kind: KINDS.includes(x.kind) ? x.kind : 'fact',
        text: String(x.text).trim().slice(0, MAX_TEXT),
        // 【P0-3 决策二】记录**原始**长度（截断前），供 audit 的 text-truncated 检查用。
        //
        // 为什么必须有这个字段：normalizeStore 把正文截到 120 字，于是 audit 从读盘链路
        // 拿到的文本永远 ≤ 120 —— `m.text.length > MAX_TEXT` 永不成立，那条检查是**死代码**。
        // 一个永远不报问题的体检项比没有它更糟：用户以为「体检通过了」，其实它没在检查。
        // 实测：把一段 150 字写进文件，读入后 text 被截成 120，audit 一声不吭。
        //
        // 记在 textLength 而不是靠别的间接推算（比如拿原文重算）：读盘链路里原文已经
        // 不存在了，只有归一化时才知道它原来多长。因为 P0-3 已改成「默认保留一切」，
        // 这个字段会被自动保留，不需要在 keepSafeFields 里特批。
        //
        // 老数据没有这个字段时 audit 退化为「看 text.length」，即永不误报（见 audit.js）。
        //
        // 【关键：这里不能用简单的 max】实测踩过（t11 自己引入的误报）：
        // 用户写了一条 129 字长记忆（被截到 120、textLength=129、体检报「太长了，拆一下」），
        // 然后**听从建议在面板上把它改短成 9 字**。若 textLength 一直是 max(旧值, 新长度)，
        // 这条会**永远**挂着 text-truncated —— 用户改也改不掉，只能删条目。
        // 「报了也修不好」的体检会迅速失去信任，比不报还糟。
        //
        // 正确的判据是「这次读入**是否真的发生了截断**」：
        //   · 文件里的 text 长度 >= MAX_TEXT → 可能是被截断过的（截断只会留下恰好
        //     MAX_TEXT 字），此时 textLength 取 max(声明值, 实际长度) —— 声明值可信；
        //   · 文件里的 text 长度 < MAX_TEXT  → **不可能**被截断（全文都在），
        //     此时任何更大的声明值都是历史残留（用户后来改短了），一律以实际长度为准。
        // 注意这里 `String(x.text).trim().length` 取的是**截断前**的长度（slice 在
        // 下面 text 字段里才发生），所以「磁盘上本来就有超长文本」这条路径靠它就能报。
        textLength: (() => {
          const rawLen = String(x.text).trim().length;
          const declared = Number(x.textLength) || 0;
          return rawLen >= MAX_TEXT ? Math.max(declared, rawLen) : rawLen;
        })(),
        tags: cleanTags(x.tags),
        weight: Math.min(5, Math.max(1, Number(x.weight) || 3)),
        status,
        supersededBy: x.supersededBy ? String(x.supersededBy) : null,
        supersededAt: Number(x.supersededAt) || null,
        // 归档要留审计痕迹：什么时候、因为什么淡出的，以后想捞回来才知道该找哪条
        archivedAt: Number(x.archivedAt) || null,
        // 归档原因。'cap' 是 v1 的旧写法（已定为笔误，见 plan-v2.md:117），
        // 这里在**读入时**把它规范成 'capacity'：否则 0.5.0 之前写下的旧库
        // 读进来仍是 'cap'，面板那段「库满了…可以捞回来」的专属提示就永远不触发 ——
        // 一个只影响老数据的静默失效，最难发现。写成等价的字符串比较而不是
        // 版本迁移，是因为它跟 schemaVersion 无关，老库新库都可能出现这个值。
        archiveReason: x.archiveReason
          ? (String(x.archiveReason) === 'cap' ? 'capacity' : String(x.archiveReason))
          : null,
        // 复活痕迹：归档后又被重新提起时，原来的 archivedAt 清掉，但留下 revivedAt，
        // 这样才能回答「这条为什么又回来了」
        revivedAt: Number(x.revivedAt) || null,
        // 结案痕迹：什么时候结的、结果是什么（"过了" / "看完了"），
        // 供回复时当话术素材（"上次那个面试不是说过了吗"）
        resolvedAt: Number(x.resolvedAt) || null,
        resolveNote: x.resolveNote ? String(x.resolveNote).slice(0, 80) : null,
        // dueAt 是「这件事有个时间点要跟进」的锚：主动提醒（"你上周说的面试怎么样了"）
        // 靠它触发。归一化成统一结构，挂 remind 状态用于结案，避免同一条反复提醒。
        dueAt: normalizeDueAt(x.dueAt),
        remindedAt: Number(x.remindedAt) || null,
        createdAt,
        lastUsedAt: Number(x.lastUsedAt) || createdAt,
        updatedAt: Number(x.updatedAt) || createdAt,
        hits: Math.max(0, Number(x.hits) || 0),
        // 固定层（📌）：用户亲手钉住的条目，每轮注入必定排在最前面。
        //
        // 为什么钉住要和「权重」分开：权重是「这件事有多重要」，钉住是「我要它每轮都在」。
        // 混成一个数就会出现「把生日权重调到 5，结果被一堆权重 5 的旧事挤掉」——
        // 而生日这类东西不该参与排序，它就该无条件在。
        //
        // normalizeStore 是**逐字段白名单重建**对象，新字段不加进这里就等于没存：
        // 内存里钉住有效、写盘再读一轮全部松开，用户会以为「我钉了但它又自己跑了」。
        pinned: x.pinned === true,
        pinnedAt: Number(x.pinnedAt) || null,
        // 自动钉的标记：区分「第一次按理解替用户钉的」和「用户自己钉的」。
        // 用户取消自动钉的那条，不该在下次启动时又被钉回来。
        pinnedAuto: x.pinnedAuto === true
      });
    }
    if (bucket.length) base.buckets[key] = bucket;
  }
  // meta 是库级的少量标记（最早只有「自动钉做过没有」，现在还有体检时间等）。
  // 必须原样带出来：它记的是「这个库发生过什么」，不是某条记忆的属性，
  // 丢掉就等于每次启动都重新自动钉一遍，用户取消过的钉会被钉回来。
  //
  // 和条目一样，这里也从白名单改成「默认保留 + 拒绝危险键」：原来只认
  // pinnedSeededAt / pinnedSeededCount 两个键，导致 lastOrganizeAt / schemaVersion /
  // totalWrites 这类库级标记写进去就读不回来，而 index.js:691 又依赖 meta 里的键存在。
  if (raw.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta)) {
    for (const [k, v] of Object.entries(raw.meta)) {
      if (DENY_KEYS.has(k) || DENY_HEAVY.has(k) || v === undefined) continue;
      base.meta[k] = v;
    }
  }

  // 落版本号：无论读进来的是什么年代，写出去的一律是当前版本。
  base.version = STORE_VERSION;
  // 迁移痕迹：让用户/体检能看到「这个库被迁移过」，而不是无声无息地换了格式。
  // 只在真的发生版本跃迁时记录，避免每次读写都刷新这个时间戳（那样它就没有信息量了）。
  if (fromVersion < STORE_VERSION) {
    base.meta.migratedFrom = fromVersion;
    base.meta.migratedAt = Date.now();
  }
  return base;
}

// ── 读 / 写 ────────────────────────────────────────────────────────────────
//
// 这一层是「记忆会不会丢」的全部入口，改动前请先读下面两段注释。
//
// 【为什么读要返回三态，而不是直接给一个空库】
// 原来是 `try { ... } catch { return blank() }` —— 任何异常都变成「空库」。
// 看起来是容错，实际是最坏的处理：**读失败和文件真的是空的，在代码里完全无法区分**。
// 于是任意一次 save() 就把空库写回去，原文件永久消失。实测：一个 163 字节的库
// 截断 40% 之后，readLongMemoryStore 返回 0 条，save() 后文件变成
// {"version":2,"buckets":{"shared":[]},"meta":{}}，26 条真实记忆全部蒸发，
// 而且没有异常、没有日志、没有备份。
//
// 触发这条路径的远不止「截断」：
//   · fs.readFileSync 的 EACCES（权限）
//   · 文件正在被 rename 的瞬间（ENOENT）
//   · Windows 上被别的程序独占打开
//   · **用户手工编辑时存成 UTF-8 with BOM** —— JSON.parse('\uFEFF{...}') 直接抛
// 最后这条尤其要命，因为 store.js:55-59 明确把「用户手工编辑这个 JSON」
// 当成正常用法写在注释里。
//
// 所以：只有 ENOENT（文件不存在）才算真空库，其余一律 ok:false，
// 由调用方决定「拒绝写」还是「报错」。见 store.js 的 readOnly 守卫。

/**
 * 读库，返回三态。
 * @returns {{ok:true, store:object, existed:boolean} | {ok:false, reason:string, error:Error, existed:boolean}}
 */
export function readLongMemoryStoreResult(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    // 文件不存在 = 全新安装，这是唯一「空库」的合法来源。
    if (error && error.code === 'ENOENT') {
      return { ok: true, store: blank(), existed: false };
    }
    return { ok: false, reason: 'read-failed', error, existed: true };
  }
  let parsed;
  try {
    // 去掉 BOM：Windows 记事本另存为 UTF-8 时默认带 BOM，这是最常见的
    // 「用户什么都没改，但库空了」的来源。
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (error) {
    return { ok: false, reason: 'parse-failed', error, existed: true };
  }
  return { ok: true, store: normalizeStore(parsed), existed: true };
}

/**
 * 兼容旧签名的读：返回 store 对象，失败时给空库。
 *
 * 注意：**这个函数会吞掉失败**，只适合「读坏了也不怕」的只读场景（比如体检
 * 对比另一份库）。凡是「读到什么就写回什么」的路径，必须走 readLongMemoryStoreResult，
 * 否则又会重演「一次读失败永久清库」。
 */
export function readLongMemoryStore(file) {
  const result = readLongMemoryStoreResult(file);
  return result.ok ? result.store : blank();
}

/** 把库序列化成写入用字符串（统一在这里决定缩进，方便测试比对）。 */
function serializeStore(store) {
  return JSON.stringify(store, null, 1);
}

/**
 * 原子写：先写临时文件再 rename。
 *
 * 临时文件名必须带 pid + 随机后缀。原来写死成 `${file}.tmp`，两个进程同时写
 * 会互相踩同一个临时文件 —— 一个进程刚写完 tmp、另一个也写了 tmp、然后各自
 * rename，结果其中一份数据凭空消失。实测两个进程各写 40 次，9 组里 7 组丢数据，
 * 最坏 80 条只剩 40 条，而且所有进程都正常退出、零异常零日志。
 */
export function writeLongMemoryStore(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, serializeStore(store), 'utf8');
    renameWithRetry(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 临时文件清理失败不重要，别盖住真正的错误
    }
    throw error;
  }
}

/**
 * rename 覆盖，带 Windows 专用的重试。
 *
 * 【为什么必须重试 —— 2026-11-03 本机实测】
 * 在 Windows 上，如果目标文件正被**另一个进程**打开着（哪怕只是读句柄），
 * `fs.renameSync(tmp, target)` 覆盖会直接抛 `EPERM: operation not permitted`。
 * 实测结论（Windows 11 / Node v24.22.0）：
 *   · 目标没人打开 → rename 成功
 *   · 另一个进程持着读 fd → rename 抛 EPERM
 *   · 先 unlink 目标再 rename → 成功（但**不能用**：中间有个文件不存在的窗口，
 *     读者会读到 ENOENT，而 ENOENT 在 P0-1 里等价于「全新安装 → 空库」，
 *     正好制造出我们要防的那场事故）
 *
 * 这个 EPERM 跟丢数据无关，但会把一次**本该成功**的写入变成失败：
 * 多进程探针实测 10 轮里 2 轮撞上（第 3、6 轮），每撞一次那个进程的剩余写入
 * 全部中止（41/80 条）。触发者是读者：`MemoryStore.load()` 读盘时**不持锁**
 * （它只是 stat + readFileSync，锁只保护写者），所以「A 正在 rename，B 正好在
 * 读」这个窗口真实存在，而且很窄 —— 正因为窄，才必须重试而不是报错。
 *
 * 重试窗口取 500ms：读句柄是 `readFileSync` 这种瞬时打开，几十毫秒内必然释放；
 * 真正长期占用的（杀毒软件扫描、用户用编辑器开着这个文件）等不到就如实抛错，
 * 而不是无限等待把调用方挂死。
 */
function renameWithRetry(tmp, file) {
  const deadline = Date.now() + RENAME_RETRY_MS;
  let attempt = 0;
  while (true) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (error) {
      const code = error && error.code;
      // 只对「目标被占用」这一类重试。别的错误（磁盘满、路径不存在、
      // 跨卷 rename）重试也不会好，直接抛。
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw error;
      if (Date.now() >= deadline) throw error;
      attempt += 1;
      // 递增退避 + 抖动，避免两个写者同步重试又撞在一起
      sleepSync(Math.min(20, attempt) + Math.floor(Math.random() * 4));
    }
  }
}

export function bucketOf(store, key) {
  if (!store.buckets[key]) store.buckets[key] = [];
  return store.buckets[key];
}

// ── 共享桶：同一只鲸鱼在私聊和所有群里用的是同一份记忆 ──────────────────────
//
// v2 早期是按会话 key 分桶的（private:123 / group:456 各一份）。结果是：在私聊里
// 记住的事，到了群里就"失忆"；换个群再问一遍同样的问题，还得重新交代。记忆应该是
// 这个角色本身的，不是某个聊天窗口的 —— 所以现在只留一个 SHARED_KEY 桶，其余旧桶
// 在读取时合并进来（mergeIntoShared），合并后删除旧桶，迁移只发生一次。
//
// 注意：**只共享记忆，不共享原始聊天记录**。recentMessages / unread / DSH 会话历史
// 仍然按会话隔离，否则私聊原话会被搬进群聊。
export const SHARED_KEY = 'shared';

export function sharedBucketOf(store) {
  if (!store.buckets || typeof store.buckets !== 'object') store.buckets = {};
  if (!Array.isArray(store.buckets[SHARED_KEY])) store.buckets[SHARED_KEY] = [];
  return store.buckets[SHARED_KEY];
}

/**
 * 把历史遗留的按会话分桶全部合并进共享桶，并删掉旧桶。
 * 返回 true 表示确实做了合并（调用方据此决定要不要落盘）。
 *
 * 合并是幂等的：同一条记忆（同 id 或同原文）只留一份，并把两边更有价值的信息
 * （weight / hits / lastUsedAt / tags / superseded 状态）合到一起，不会因为合并
 * 把「已被取代」的旧条目又变回生效状态。
 */
export function mergeIntoShared(store) {
  if (!store || typeof store !== 'object' || !store.buckets || typeof store.buckets !== 'object') return false;
  const stale = Object.keys(store.buckets).filter((k) => k !== SHARED_KEY);
  if (!stale.length) return false;
  const shared = sharedBucketOf(store);
  for (const key of stale) {
    const list = store.buckets[key];
    if (Array.isArray(list)) {
      for (const m of list) {
        if (!m || typeof m.text !== 'string' || !m.text.trim()) continue;
        const dup = shared.find((x) => x && (x.id === m.id || x.text === m.text));
        if (!dup) {
          shared.push(m);
          continue;
        }
        // 同一条记忆在两个会话里各有一份：信息取并集，不重复占位
        if ((Number(m.weight) || 0) > (Number(dup.weight) || 0)) dup.weight = m.weight;
        if ((Number(m.hits) || 0) > (Number(dup.hits) || 0)) dup.hits = m.hits;
        if ((Number(m.lastUsedAt) || 0) > (Number(dup.lastUsedAt) || 0)) dup.lastUsedAt = m.lastUsedAt;
        if ((Number(m.updatedAt) || 0) > (Number(dup.updatedAt) || 0)) dup.updatedAt = m.updatedAt;
        if (Number(m.createdAt) && (!Number(dup.createdAt) || Number(m.createdAt) < Number(dup.createdAt))) {
          dup.createdAt = Number(m.createdAt);
        }
        dup.tags = cleanTags([...(Array.isArray(dup.tags) ? dup.tags : []), ...(Array.isArray(m.tags) ? m.tags : [])]);
        // 状态取「信息更少的那一边」：合并只允许让记忆变得更下架，不允许借合并复活。
        // 优先级：取代 > 结案 > 归档 > 生效 —— 取代说明信息已作废（最强），
        // 结案说明事情有结果了（比"淡忘"更该记住），归档只是淡出。
        const rankOf = (s) => ({ superseded: 3, resolved: 2, archived: 1, active: 0 }[s ?? 'active'] ?? 0);
        if (rankOf(m.status) > rankOf(dup.status)) {
          dup.status = m.status ?? 'active';
          if (m.status === 'superseded') {
            dup.supersededBy = m.supersededBy ? String(m.supersededBy) : dup.supersededBy ?? null;
            dup.supersededAt = Number(m.supersededAt) || dup.supersededAt || null;
          } else if (m.status === 'resolved') {
            dup.resolvedAt = Number(m.resolvedAt) || dup.resolvedAt || null;
            dup.resolveNote = m.resolveNote ? String(m.resolveNote) : dup.resolveNote ?? null;
          } else if (m.status === 'archived') {
            dup.archivedAt = Number(m.archivedAt) || dup.archivedAt || null;
            dup.archiveReason = m.archiveReason ? String(m.archiveReason) : dup.archiveReason ?? null;
          }
        }
      }
    }
    delete store.buckets[key];
  }
  shared.sort((a, b) => (Number(a?.createdAt) || 0) - (Number(b?.createdAt) || 0));
  return true;
}

// 中文没有空格，用相邻二字（bigram）做字面重合度；英文/数字也走同一套，够用。
export function grams(text) {
  const s = String(text ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  const out = new Set();
  for (let i = 0; i + 1 < s.length; i += 1) out.add(s.slice(i, i + 2));
  if (s.length === 1) out.add(s);
  return out;
}

// Dice 系数：2|A∩B| / (|A|+|B|)。
// v1 用 min(|A|,|B|) 做分母，短句天然接近 1 —— 这正是“考研/考公”被判成重复的根因。
export function overlapRatio(a, b) {
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit += 1;
  return (2 * hit) / (ga.size + gb.size);
}

// 分词：中文按二字滑窗、ASCII 按整词，标点丢掉。
// 不能只按空格切（中文没空格）；也不能全走 bigram（`rtx4090` 会被切成 r/rt/tx/x4/40/09 一堆噪声）。
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase();
  const out = [];
  const ascii = s.match(/[a-z0-9]+/g);
  if (ascii) out.push(...ascii);
  const han = s.replace(/[^\u4e00-\u9fff]+/g, ' ').trim();
  if (han) {
    for (const seg of han.split(/\s+/)) {
      if (seg.length === 1) { out.push(seg); continue; }
      for (let i = 0; i + 1 < seg.length; i += 1) out.push(seg.slice(i, i + 2));
    }
  }
  return out;
}

const SENSITIVE_PATTERNS = [
  // OpenAI / GitHub / Slack 风格的 key
  /\b(?:sk|ghp|gho|ghs|ghr|xox[abposr])[-_][A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  // 18 位身份证（末位可为 X）
  /(?<!\d)\d{17}[\dXx](?!\d)/,
  // 15~19 位连续数字：卡号、长账号
  /(?<!\d)\d{15,19}(?!\d)/,
  // 11 位手机号
  /(?<!\d)1[3-9]\d{9}(?!\d)/,
  // “密码/验证码/token 是 xxx”这类明确的口令交付
  /(?:密码|口令|验证码|私钥|密钥|token|api[-_ ]?key|secret)\s*(?:是|为|[:：=])\s*\S{5,}/i
];

// 只拦“明确的凭证交付”，不拦正常聊天。
// 例如“我密码忘了”不会命中（后面没有 5 位以上的值）。
export function looksSensitive(text) {
  const s = String(text ?? '');
  if (!s.trim()) return false;
  return SENSITIVE_PATTERNS.some((re) => re.test(s));
}

// 导出是为了让探针能直接测判重本身（P0-4 的每条验收都是「某一对文本判同/判两条」，
// 通过 upsert 间接测会被下架/复活/容量等其它逻辑干扰，测不出判重对不对）。
export function sameThing(a, b) {
  const ta = String(a ?? '').trim();
  const tb = String(b ?? '').trim();
  if (!ta || !tb) return false;
  if (ta === tb) return true;

  // 否定/数字矛盾先拦：这两类一旦判同就是「静默改写用户结论」，后果比重复条目重得多。
  // 必须在包含判断**之前**，因为包含判断对它们是失效的（「不喜欢猫」包含「喜欢猫」）。
  if (hasContradiction(ta, tb)) return false;

  const ratio = Math.min(ta.length, tb.length) / Math.max(ta.length, tb.length);

  // 包含关系。这里是 P0-4 的核心：原来无条件判同，现在按「接缝」分两种。
  //
  //   接缝是标点 → 短句是长句的前缀/后缀 + 一个从句 → **判同**，且不受长度比限制。
  //     「阿风在准备考研」+「，目标计算机」：实测长度比只有 7/13 = 0.54，
  //     用 DUP_LEN_RATIO 卡会直接卡死验收⑥，而这是最明确的重述形态。
  //
  //   接缝是字 → 长句是**另一个对象/另一个命题**，判两条：
  //     「抖音」+「群」= 抖音群；「小鲸鱼」+「说」= 某人做了某事；
  //     「喜欢猫」前面加「不」= 结论翻转。这些判同都会静默改写用户的话。
  //
  // 短句被包在中间（不是完整前后缀）时，才退回长度比 + Dice 判断。
  if (ta.includes(tb) || tb.includes(ta)) {
    const shortOne = ta.length <= tb.length ? ta : tb;
    const longOne = ta.length <= tb.length ? tb : ta;
    const { hit, seam } = prefixSuffixOf(shortOne, longOne);
    if (hit) {
      return DUP_PUNCT.has(seam);
    }
    return ratio >= DUP_LEN_RATIO;
  }

  if (ratio < DUP_LEN_RATIO) return false;
  return overlapRatio(ta, tb) >= DUP_DICE;
}

/**
 * 建倒排索引。
 *
 * `includeArchived` 默认 false —— **索引默认只收 recallable 条目**，这是注入和
 * 主动 recall 都「看不见归档」的根本原因（不是靠上层再滤一遍）。
 *
 * 但「归档条目仍可被检索」（README:27）要求归档检索能走同一套 BM25 打分，
 * 所以这里开一个显式开关。实测踩过的坑：不传这个开关就把 archived 列表塞进来，
 * 索引里 `n === 0`，检索永远返回空 —— 看起来「函数没被调用」，其实是索引把
 * 传进来的条目全滤掉了。默认 false 保证既有调用方（注入、recall）行为不变。
 */
export function buildIndex(list, { includeArchived = false } = {}) {
  const docs = [];
  const postings = new Map();
  const lens = [];
  let totalLen = 0;
  for (const m of list) {
    if (!includeArchived && !isRecallable(m)) continue;
    if (includeArchived && !m) continue;
    const idx = docs.length;
    docs.push(m);
    const toks = tokenize(`${m.text} ${(m.tags || []).join(' ')}`);
    lens.push(toks.length);
    totalLen += toks.length;
    for (const t of toks) {
      let d = postings.get(t);
      if (!d) { d = new Map(); postings.set(t, d); }
      d.set(idx, (d.get(idx) || 0) + 1);
    }
  }
  return { docs, postings, lens, avgLen: docs.length ? totalLen / docs.length : 0, n: docs.length };
}

// 桶数组是原地复用（bucketOf 返回同一个引用），所以用 WeakMap 挂缓存。
// 签名里带上 updatedAt 总和：文本被合并时会写 updatedAt，缓存自然失效。
const indexCache = new WeakMap();

function signatureOf(list) {
  let active = 0;
  let stamp = 0;
  for (const m of list) {
    if (isActive(m)) active += 1;
    stamp += Number(m.updatedAt) || 0;
  }
  return `${list.length}:${active}:${stamp}`;
}

export function indexOf(list) {
  const sig = signatureOf(list);
  const hit = indexCache.get(list);
  if (hit && hit.sig === sig) return hit.index;
  const index = buildIndex(list);
  indexCache.set(list, { sig, index });
  return index;
}

export function bm25Scores(index, queryTerms) {
  const scores = new Array(index.n).fill(0);
  if (!index.n || !queryTerms.length) return scores;
  for (const term of new Set(queryTerms)) {
    const df = index.postings.get(term);
    if (!df) continue;
    const idf = Math.log(1 + (index.n - df.size + 0.5) / (df.size + 0.5));
    for (const [i, tf] of df) {
      const dl = index.lens[i] || 0;
      const norm = BM25_K1 * (1 - BM25_B + (BM25_B * dl) / (index.avgLen || 1));
      scores[i] += idf * ((tf * (BM25_K1 + 1)) / (tf + norm));
    }
  }
  return scores;
}

export function scoreDocs(index, queryTerms, now = Date.now()) {
  const rel = bm25Scores(index, queryTerms);
  return index.docs.map((m, i) => {
    const weightShift = ((m.weight || 3) - 3) * 2; // -4 ~ +4
    const ageDays = Math.max(0, (now - (m.lastUsedAt || m.createdAt || now)) / 86400000);
    const freshness = Math.max(0, 6 - ageDays * 0.2); // 0 ~ 6
    return { m, rel: rel[i], score: rel[i] * 12 + weightShift + freshness };
  });
}

// 正文末尾已经写着标签尾巴吗？
//
// 从别处导入的条目（比如从另一个记忆系统迁移过来）常把标签直接写进正文末尾：
// 「…记着了，一个人我也不害怕」。（陪伴、阿风、私聊、承诺）。渲染时再追加一遍
// 括号标签，屏幕上就成了「（陪伴、阿风、私聊、承诺）（陪伴、阿风、私聊、承诺）」——
// 用户看着像数据坏了，其实数据没错，是渲染重复了。
//
// 判定必须保守：只有「末尾括注的每一段都是短词，且至少两段能在 tags 里找到」才算
// 标签尾巴。正文里本来就有括注（「（阿风说那是我生日）」）是内容的一部分，长句一律
// 不当尾巴 —— 宁可多渲染一次括号，也不能把用户写进正文的话删掉。
export function embeddedTagTail(text, tags) {
  if (!Array.isArray(tags) || !tags.length) return false;
  const m = /（([^（）]*)）\s*$/.exec(String(text ?? ''));
  if (!m) return false;
  const parts = String(m[1]).split(/[、,，;；]/).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  if (parts.some((x) => x.length > MAX_TAG_LEN)) return false;
  const known = new Set(tags.map((t) => String(t).trim()));
  return parts.filter((x) => known.has(x)).length >= 2;
}

// 渲染用的标签串：正文自带尾巴时返回空串，避免双份。
function tagsSuffix(m) {
  if (!(m.tags || []).length) return '';
  return embeddedTagTail(m.text, m.tags) ? '' : `（${m.tags.join('、')}）`;
}

// 去掉正文末尾的标签尾巴，只留正文。
//
// 为什么需要它：从别的记忆系统迁移过来的条目，正文里带着「（陪伴、阿风、私聊、承诺）」。
// 同一个系统清理过之后（插件导入时会清），两边就变成「一句正文带尾巴、一句不带」——
// 按原样配对会把同一条记忆判成「这边少一条、那边多一条」，指错了地方。
// 所以跨库比对时先剥掉尾巴再比；剥不剥都不影响正文，因为它本来就不是正文。
export function stripTagTail(text, tags) {
  const raw = String(text ?? '');
  if (!embeddedTagTail(raw, tags)) return raw;
  return raw.replace(/（[^（）]*）\s*$/, '').trim();
}

// 注入块的表头。预算要把它算进去 —— 它也是实实在在占字数的。
const BLOCK_HEADER = '【长期记忆 · 这些是你一直记得的事】';

// 一行注入文本的实际渲染长度。**估算和渲染必须用同一个函数。**
//
// 早先 selectLongMemories 里用的是 `text.length + tags.join('').length + 8` 粗估，
// 而 formatLongMemoryBlock 每行实际还带 `- [约定] ` 前缀、`（标签）`的括号与顿号、
// ` · 10-23` 日期、以及到期/结案后缀，每行低估约 11 字。10 行下来预算说 1200
// 却注入了 1309 字。这个偏差在纯文本里看不见，只有把字数数出来才暴露 ——
// 所以宁可多算这一行，也不要让预算变成一句空话。
export function longMemoryLineLength(m, now = Date.now()) {
  if (!m) return 0;
  const tags = tagsSuffix(m);
  const when = shortDate(m.updatedAt || m.createdAt, now);
  const done = m.status === 'resolved'
    ? ` · 已完成${m.resolveNote ? `（${m.resolveNote}）` : ''}`
    : '';
  const due = m.status === 'resolved' ? '' : dueLabel(m, now);
  const dueStr = due ? ` · 约在 ${due}` : '';
  return `- [${KIND_LABEL[m.kind] || '事实'}] ${m.text}${tags}${when ? ` · ${when}` : ''}${dueStr}${done}`.length;
}

// 轮换的默认时间窗（毫秒）。一个窗口换一批「冷门」记忆。
export const ROTATE_WINDOW_MS = 60 * 60 * 1000;

// 从「按分数排在后半段、永远轮不到的」那批里，挑这一窗该轮到谁。
//
// 为什么按 id 固定排序 + 时间窗滑动，而不是记住「上次注入了哪几条」：
// 注入函数每轮都要跑，还要和面板显示的逐字相同。一旦记状态（写盘或内存计数器），
// 面板和真注入就会各自往前走一步，变成两套真相 —— 而这套系统最不能出的问题就是
// 「面板上显示的」不等于「她真读到的」。
// 时间窗 + 固定顺序可以在完全不记状态的前提下给出一个硬保证：
// 每 ceil(冷门数 / 名额数) 个窗口，每一条冷门记忆必定被注入过一次。
export function rotationSlice(coldSorted, want, now, windowMs = ROTATE_WINDOW_MS) {
  const n = Array.isArray(coldSorted) ? coldSorted.length : 0;
  const take = Math.max(0, Math.min(Number(want) || 0, n));
  if (!n || !take) return [];
  const wm = Number(windowMs) > 0 ? Number(windowMs) : ROTATE_WINDOW_MS;
  const windowIndex = Math.floor(Number(now) / wm);
  const rounds = Math.ceil(n / take);
  const start = (((windowIndex % rounds) + rounds) % rounds) * take % n;
  const out = [];
  for (let i = 0; i < take; i += 1) out.push(coldSorted[(start + i) % n]);
  return out;
}

// options.rotateSlots：给「冷门」记忆留几个名额（0=不轮换，行为与从前完全一致）。
// options.windowMs：轮换时间窗。
//
// 为什么需要轮换：查询为空时（注入就是这种情况）分数只剩「权重 + 新近度」，
// 于是排序长期稳定 —— 库里有 25 条、预算只放得下 10 条时，后 15 条**永远**进不了
// 上下文。它们不是被归档了，而是每次都在排队尾，等于不存在。
// 预留名额只挤占「分数排在后半段」的那批，不会把本该在的高分条目挤出去：
// 库比上限还小（没有冷门）时名额自动失效。
export function selectLongMemories(list, query, limit = 12, maxChars = 1200, now = Date.now(), touch = true, options = {}) {
  if (!Array.isArray(list) || !list.length) return [];
  const index = indexOf(list);
  if (!index.n) return [];
  const ranked = scoreDocs(index, tokenize(query), now).sort((a, b) => b.score - a.score);
  const picked = [];
  const relevance = new Map();
  let chars = 0;
  const budget = Number(maxChars) > 0 ? Number(maxChars) : 0;
  const limitN = Math.max(1, Number(limit) || 12);
  const rotateSlots = Math.max(0, Math.min(Number(options?.rotateSlots) || 0, limitN - 1));
  const mainLimit = rotateSlots > 0 ? Math.max(1, limitN - rotateSlots) : limitN;

  // 先把这一窗该轮到的冷门条目定下来，再按它们的实际字数预留预算。
  // 顺序反过来的话，主榜会先把 1200 字吃满，轮换永远分不到一行。
  const coldPool = rotateSlots > 0 ? ranked.slice(mainLimit) : [];
  const rotated = rotationSlice(
    [...coldPool].sort((a, b) => String(a.m?.id ?? '').localeCompare(String(b.m?.id ?? ''))),
    Math.min(rotateSlots, limitN - mainLimit),
    now,
    options?.windowMs
  );
  const reserved = rotated.reduce((sum, x) => sum + longMemoryLineLength(x.m, now) + 1, 0);

  const push = (m, rel, cap) => {
    // 第一行要连表头和换行一起算，之后每行多一个换行符
    const next = picked.length === 0
      ? BLOCK_HEADER.length + 1 + longMemoryLineLength(m, now)
      : chars + 1 + longMemoryLineLength(m, now);
    if (picked.length > 0 && next > cap) return false;
    picked.push(m);
    relevance.set(m, rel);
    chars = next;
    return true;
  };

  for (const { m, rel } of ranked.slice(0, mainLimit)) {
    if (!push(m, rel, budget - Math.min(reserved, budget))) break;
  }
  for (const { m, rel } of rotated) {
    if (!push(m, rel, budget)) break;
  }
  // 保持相关性降序输出：模型对靠前的内容注意力更强，而“权重高”不等于“此刻相关”
  // （权重 5 的旧事不该压着刚被问起的那件小事）。空查询时分数本身只剩权重和新近度。
  //
  // 只有真正沾边的条目才算“被想起”。否则当记忆条数少于注入上限（injectLimit）时，
  // 每次聊天都会把所有条目的 lastUsedAt 刷成刚刚，衰减永远不会生效 —— 淡忘机制
  // 在最需要它生效的早期就失效了，这是个很容易被忽略的死角。
  if (touch) {
    for (const m of picked) {
      if ((relevance.get(m) || 0) <= 0) continue;
      m.hits = (m.hits || 0) + 1;
      m.lastUsedAt = now;
    }
  }
  return picked;
}

/**
 * 在**归档条目**里按关键词检索 —— 兑现 README 的「归档条目仍可被检索」。
 *
 * 【为什么要单独一个函数，而不是把 archived 塞进 RECALLABLE】
 *
 * README 原文（`_pristine/README.md:27`）承诺的是「会淡忘，但淡忘不是删除……
 * 归档条目仍可被**检索**和复活」。这里有个容易混的地方：**「检索」和「每轮注入」
 * 是两条不同的路径**。
 *
 *   · 每轮注入（四层预算）：归档条目**不进**。归档的语义就是「不再每轮出现」，
 *     否则容量上限立刻失去意义 —— 归档等于还在，只是换了个状态名。
 *   · 主动检索（recall 工具）：归档条目**能被找到**，但要降权、要标注状态，
 *     让调用方一眼看出「这条是下架过的，不是当前生效的」。
 *
 * 如果把 archived 直接加进 RECALLABLE，两条路径会一起被打开，注入预算立刻被
 * 历史条目占满 —— 那正是 P0-5 想解决的「只增不减」。所以必须分开：
 * RECALLABLE 保持 ['active','resolved'] 不动，注入侧零改动；
 * 归档检索走这个独立函数，只在 recall 工具里显式调用。
 *
 * @param {Array} list 完整条目列表（**不是** recallableList 过滤后的）
 * @param {string} query 检索词
 * @param {object} opts `{ limit, now }`
 * @returns {Array} 命中的归档条目，按相关度降序，每条带 status/archiveReason
 */
export function searchArchivedMemories(list, query, { limit = 8, now = Date.now() } = {}) {
  const archived = (Array.isArray(list) ? list : []).filter((m) => m && m.status === 'archived');
  if (!archived.length) return [];
  const index = buildIndex(archived, { includeArchived: true });
  if (!index.n) return [];
  const ranked = scoreDocs(index, tokenize(query), now)
    // 只留**真正沾边**的：判据必须是 BM25 相关度 rel > 0，不能看 score。
    // score = rel * 12 + weightShift + freshness，后两项是「基础分」——
    // 完全不相干的条目 score 也会 > 0（一条 weight=5 的旧事能白拿 4 分），
    // 用 score > 0 当门槛等于没门槛，实测会把整库归档都报成「相关」。
    .filter((x) => x.rel > 0)
    .sort((a, b) => b.score - a.score);
  return ranked.slice(0, Math.max(1, Number(limit) || 8)).map((x) => x.m);
}

// 注入时带上日期：模型没有“现在几点”的概念，一条记忆如果只有内容、没有时间，
// 「上周说的面试」和「上个月说的面试」在它眼里是同一件事。只给 MM-DD，
// 跨年才给完整年份，尽量少占注入预算。
function shortDate(ts, now) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  const pad = (x) => String(x).padStart(2, '0');
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return sameYear
    ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 「约在什么时候」的短标签，给注入块用。
// 没有它，注入出来的约定只剩「说好周六看电影 · 10-27」——周六是哪天、约没约成，
// 模型一概不知道，dueAt 抽了也白抽。ts 优先（能算出 MM-DD），只有相对说法时用原文。
function dueLabel(m, now) {
  const due = m?.dueAt;
  if (!due) return '';
  const abs = due.ts ? shortDate(due.ts, now) : '';
  const when = String(due.when || '').trim();
  if (abs && when && when !== abs && when !== due.date) return `${when}·${abs}`;
  return abs || when || '';
}

export function formatLongMemoryBlock(list, now = Date.now()) {
  const live = recallableList(list);
  if (!live.length) return '';
  const lines = live.map((m) => {
    const tags = tagsSuffix(m);
    const when = shortDate(m.updatedAt || m.createdAt, now);
    // 结案的条目标出来，模型才知道这是「已经有过结果的事」，而不是待办
    const done = m.status === 'resolved'
      ? ` · 已完成${m.resolveNote ? `（${m.resolveNote}）` : ''}`
      : '';
    const due = m.status === 'resolved' ? '' : dueLabel(m, now);
    const dueStr = due ? ` · 约在 ${due}` : '';
    return `- [${KIND_LABEL[m.kind] || '事实'}] ${m.text}${tags}${when ? ` · ${when}` : ''}${dueStr}${done}`;
  });
  return `${BLOCK_HEADER}\n${lines.join('\n')}`;
}

// ── 四层注入 ────────────────────────────────────────────────────────────
//
// 为什么不再「按分数取前 12 条」：分数 = 相关性 + 权重 + 新近度，查询为空时相关性是 0，
// 排序就长期固定 —— 于是「谁进上下文」被权重和新近度永久决定。库有 28 条、预算只装得下
// 10 条时，剩下 18 条**每轮都在排队尾**，既没被归档也没被想起，等于不存在。
// 更难受的是「最近你们之间在干嘛」这种问题：刚发生的小事新近度才 +6，
// 永远压不过一条权重 5 的旧事实。
//
// 所以把「进上下文」这件事按**目的**拆成四层，每层各管一件事：
//   pinned   固定层：用户钉住的，每轮无条件在最前（人设/称呼/约定这类不该参与排序的东西）
//   recent   近期层：最近几天新建/更新/结案的，保证「最近在干嘛」永远有位置
//   topic    话题层：按本次对话内容做 BM25 检索，让「她主动想起相关旧事」成为可能
//   fallback 兜底层：剩下的按权重+新近度排，并保留轮换，保证队尾的也轮得到
//
// 每层有各自的字数上限，按顺序填充、按 id 去重（先到的层赢），总额不超过 maxChars。
// 分层而不是「各层独立算分再混排」：混排会退回原来的问题 —— 强项的那层照样挤掉弱项。
export const INJECT_LAYERS = ['pinned', 'recent', 'topic', 'fallback'];

// 自动钉的「理解」依据：人设、称呼、关系、答应过的事 —— 这些每轮都在用。
//
// **刻意不给「权重高」太大的话语权**（权重 5 只加 1 分），也不含「生日」这类一年只用一次
// 的事实：用户的原话是「按重要程度排上的那几条有的不用一直记着，比如我的生日……
// 但要有固定注入的几条比如人设日常称呼约定」。也就是说「重要」和「每轮都要在」是两件事，
// 生日很重要但一年只用一次，钉住它等于白占固定层的名额。所以这里按**用途**找，不按重要度找。
//
// 「主人」「名字」这类词曾经在名单里，后来删了：它们在引号、视频标题、别人的话里到处都是
// （真实库里就有一条「去抖音看《蓝色大肥鱼：主人！起床啦！》」因为标题里带「主人」被钉住），
// 命中一次就进固定层，等于把一次性待办永久供在固定层。真需要的那类记忆（「他是主人，
// 叫我小鲸鱼」）本来就带「称呼」标签，靠标签命中就够了。
const PIN_HINTS = ['称呼', '人设', '咱家', '关系', '口癖', '答应', '约定'];

// 反面名单：一年只用一次的纪念性事实，不管正文里命中多少用途词都不进固定层。
//
// 为什么需要这个：真实库里「10月18日……也是阿风的生日……小鲸鱼答应记住这天、每年一起过」
// 因为带「答应」二字命中了一次用途词，加上权重 5 正好到门槛，被自动钉进了固定层 ——
// 而用户的原话里「我的生日」正是他举的**反例**。光靠用途词正向匹配挡不住这种条目，
// 它确实「答应」过，但它不该每轮都在。这类条目交给话题层（聊到生日时检索出来）
// 和近期层（临近那天被提到时自然进上下文）就够了。
const NOT_PIN_HINTS = ['生日', '纪念日', '周年', '节日', '忌日'];


// 第一次运行时的自动钉（用户要求「第一次的条的选择你根据理解自动填入，之后可以被修改」）。
//
// 为什么要有这一步：全新用户打开面板看到的是一堆没钉的条目，他并不知道「钉」是干什么用的，
// 于是永远不钉，四层注入退化成三层 —— 固定层这个功能等于没做。
// 但自动钉必须**可撤销且不再自动补回来**：取消了的条目靠 meta.pinnedSeededAt 记住
// 「已经替用户钉过一次了」，否则每次启动都把他删掉的钉重新钉上，那是骚扰。
//
// 门槛 score >= 2：只命中一个泛词（比如正文里恰好出现「名字」二字）不足以进固定层，
// 至少要「用途词 + 权重/约定」两条证据。宁少勿滥 —— 自动钉错一条，用户就得自己去取消。
export function autoPinHeuristic(list, { max = 5 } = {}) {
  const scored = recallableList(list).map((m) => {
    const hay = `${m.text} ${(m.tags || []).join(' ')}`;
    if (NOT_PIN_HINTS.some((hint) => hay.includes(hint))) return { m, score: 0 };
    let score = 0;
    const weight = Number(m.weight) || 3;
    if (weight >= 5) score += 1;
    for (const hint of PIN_HINTS) if (hay.includes(hint)) score += 1;
    if (m.kind === 'promise') score += 1;
    return { m, score };
  });
  return scored
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score
      || (Number(b.m.createdAt) || 0) - (Number(a.m.createdAt) || 0))
    .slice(0, Math.max(0, Number(max) || 0))
    .map((x) => x.m);
}

// 四层挑选。返回 `{ picked, layers, chars, budget }`：
//   picked —— 真正要渲染进上下文的条目（按层顺序排列）
//   layers —— 每层各挑到哪些（面板分层显示用，id 数组）
//
// 参数默认值就是「人话版方案」里的那份：总预算 2000 字，固定层最多 45%，
// 近期层最多 35%，话题层最多 45%，兜底层吃掉剩下的。
export function selectLayeredMemories(list, query = '', {
  maxChars = 2000,
  limit = 12,
  now = Date.now(),
  recentDays = 3,
  // 固定层不设百分比上限：用户点「钉住」的意思就是「无论如何先给它位置」。
  // 按比例砍它（比如只给 45%）会造成最难受的那种失败 —— 面板上明明有 📌，
  // 注入里却没有，而用户完全不知道为什么。真装不下时宁可让别的层少装几条，
  // 并把「有几条钉住的没塞进去」报给面板（pinnedDropped）。
  pinnedCap = 1,
  recentCap = 0.35,
  topicCap = 0.45,
  rotateSlots = 2,
  windowMs = ROTATE_WINDOW_MS
} = {}) {
  const empty = {
    picked: [],
    layers: { pinned: [], recent: [], topic: [], fallback: [] },
    chars: 0,
    budget: 0,
    pinnedDropped: 0
  };
  if (!Array.isArray(list) || !list.length) return empty;
  const budget = Math.max(0, Number(maxChars) || 0);
  if (!budget) return empty;
  const cap = Math.max(1, Number(limit) || 12);

  const live = recallableList(list);
  if (!live.length) return empty;

  const picked = [];
  const seen = new Set();
  const layers = { pinned: [], recent: [], topic: [], fallback: [] };
  let chars = 0;

  // 按层填充：next 是第一行要算表头，之后每行多一个换行。
  // 超预算或超条数就停，不为了凑条数把最后一行硬塞进去（那正是老版本「预算超支」的来源）。
  const push = (m, layer, capChars) => {
    if (!m || seen.has(m.id)) return false;
    if (picked.length >= cap) return false;
    const next = picked.length === 0
      ? BLOCK_HEADER.length + 1 + longMemoryLineLength(m, now)
      : chars + 1 + longMemoryLineLength(m, now);
    if (next > capChars) return false;
    picked.push(m);
    seen.add(m.id);
    layers[layer].push(m.id);
    chars = next;
    return true;
  };
  const capOf = (ratio) => Math.min(budget, Math.max(0, Math.ceil(budget * ratio)));

  // ① 固定层：钉住的全部进，按权重降序。用户钉了就得在，除非预算真的塞不下。
  // 塞不下的要计数并报出去 —— 「钉了但没进去」是必须让用户看见的失败，
  // 而不是静默地少一行。
  const pinned = live
    .filter((m) => m.pinned === true)
    .sort((a, b) => (Number(b.weight) || 3) - (Number(a.weight) || 3));
  let pinnedDropped = 0;
  for (const m of pinned) {
    if (!push(m, 'pinned', capOf(pinnedCap))) {
      pinnedDropped += 1;
      // 预算已经满了：后面更短的也许还塞得下，所以继续试，不 break。
    }
  }

  // ② 近期层：最近 recentDays 天内「有动静」的条目。
  // 「有动静」取四个时间戳的最大值 —— 只看 createdAt 会漏掉「一条三年前的约定
  // 昨天刚被兑现」，而那正是最近最该被提起的事。
  const recentMs = Math.max(0, Number(recentDays) || 0) * 86400000;
  const recentFloor = now - recentMs;
  const stampOf = (m) => Math.max(
    Number(m.updatedAt) || 0,
    Number(m.lastUsedAt) || 0,
    Number(m.createdAt) || 0,
    Number(m.resolvedAt) || 0
  );
  const recent = live
    .filter((m) => !seen.has(m.id) && stampOf(m) >= recentFloor)
    .sort((a, b) => stampOf(b) - stampOf(a));
  for (const m of recent) {
    if (!push(m, 'recent', capOf(recentCap))) break;
  }

  // ③ 话题层：按这次对话内容检索。查询为空（拿不到会话内容）时这一层自动空着，
  // 名额让给兜底层 —— 拿不到会话不该让整体变差，只该让这一层缺席。
  const terms = tokenize(query);
  if (terms.length) {
    const index = indexOf(live);
    const rel = bm25Scores(index, terms);
    const topical = index.docs
      .map((m, i) => ({ m, rel: rel[i] }))
      .filter((x) => !seen.has(x.m.id) && x.rel > 0)
      .sort((a, b) => b.rel - a.rel);
    for (const { m } of topical) {
      if (!push(m, 'topic', capOf(topicCap))) break;
    }
  }

  // ④ 兜底层：剩下的按权重+新近度排，并把轮换名额留给「根本挤不进来的队尾」。
  // 这一步才真正该用原来的打分 —— 它已经是「前三层都没要的」那批，
  // 不会再把近期的小事压掉（那正是老版本唯一的问题）。
  const index = indexOf(live);
  const ranked = scoreDocs(index, [], now)
    .filter((x) => !seen.has(x.m.id))
    .sort((a, b) => b.score - a.score);
  const slots = Math.max(0, Number(rotateSlots) || 0);

  // 先空跑一遍，算出「按分数排能装下几条」，才知道队尾从第几条开始。
  // 直接拿 ranked.slice(slots) 当冷门池是错的：那等于把第 3 名之后全算成冷门，
  // 轮换就会把本该在的高分条目换掉 —— 而轮换的本意是「救那些永远轮不到的」。
  let dryChars = picked.length === 0 ? 0 : chars;
  let fit = 0;
  for (const { m } of ranked) {
    const next = dryChars === 0
      ? BLOCK_HEADER.length + 1 + longMemoryLineLength(m, now)
      : dryChars + 1 + longMemoryLineLength(m, now);
    if (next > budget) break;
    dryChars = next;
    fit += 1;
  }
  const rotated = slots > 0 && ranked.length > fit
    ? rotationSlice(
      [...ranked.slice(fit)].sort((a, b) => String(a.m?.id ?? '').localeCompare(String(b.m?.id ?? ''))),
      slots,
      now,
      windowMs
    )
    : [];
  // 给轮换条目预留字数：不留的话主榜会把预算吃满，轮换永远分不到一行。
  const reserved = rotated.reduce((sum, x) => sum + longMemoryLineLength(x.m, now) + 1, 0);
  const mainCap = Math.max(0, budget - Math.min(reserved, budget));

  for (const { m } of ranked) {
    if (!push(m, 'fallback', mainCap)) break;
  }
  for (const { m } of rotated) {
    if (!push(m, 'fallback', budget)) break;
  }

  return { picked, layers, chars, budget, pinnedDropped };
}

// ── 钉住 / 取消钉住 ────────────────────────────────────────────────────
//
// 钉住是「每轮都要在」的承诺，所以只对**可被想起**的条目生效：
// 归档/已取代的条目钉了也不会进注入（selectLayeredMemories 先过 recallableList），
// 与其让用户钉一个永远不出现的东西，不如直接说清楚。
export function pinLongMemory(list, { id, text, now = Date.now() } = {}) {
  const target = findLongMemory(list, { id, text });
  if (!target) return null;
  if (!isRecallable(target)) return null;
  target.pinned = true;
  target.pinnedAt = now;
  target.pinnedAuto = false; // 用户亲手钉的，不再是「自动猜的」
  target.updatedAt = now;
  return target;
}

export function unpinLongMemory(list, { id, text, now = Date.now() } = {}) {
  const target = findLongMemory(list, { id, text });
  if (!target) return null;
  target.pinned = false;
  target.pinnedAt = null;
  target.pinnedAuto = false;
  target.updatedAt = now;
  return target;
}

// 按 id 或原文片段定位一条。id 精确优先；原文走「包含」匹配，
// 因为用户/模型给的往往是记忆里的一小段话，不是完整原文。
function findLongMemory(list, { id, text } = {}) {
  if (!Array.isArray(list)) return null;
  if (id) {
    const byId = list.find((m) => m && String(m.id) === String(id));
    if (byId) return byId;
  }
  const needle = String(text ?? '').trim();
  if (!needle) return null;
  return list.find((m) => m && String(m.text).includes(needle)) ?? null;
}

// 第一次运行时自动钉一次，返回钉住的条目（已就地改好）。
//
// 用 `store.meta.pinnedSeededAt` 做「只做一次」的标记，而不是「没有任何条目被钉住就再钉一次」：
// 后者会让用户取消掉全部钉住之后，下次启动又被钉回来 —— 用户明确表达过的意图被系统覆盖，
// 是这套设计里最不该出现的事。
//
// 但「库还是空的」不能算做过一次。全新安装时插件先启动、记忆后进来（导入、remember、
// 从别的系统迁过来都是这样），如果这时就把标记写死，等记忆真到了，自动钉永远不会再跑，
// 用户得到的是一个「钉住功能在，但一条都没钉」的初始状态 —— 而这条规则的全部意义就是
// 给出一个说得过去的起点。所以空库时直接返回，一个字段都不写。
export function seedPinnedOnce(store, list, { now = Date.now(), max = 5 } = {}) {
  if (!store || !Array.isArray(list)) return [];
  if (Number(store.meta?.pinnedSeededAt)) return [];
  const already = list.filter((m) => m?.pinned === true);
  if (already.length) {
    // 用户/别处已经钉过了，就不越俎代庖；只记下「做过了」，免得以后又冒出来。
    store.meta = { ...(store.meta || {}), pinnedSeededAt: now, pinnedSeededCount: already.length };
    return [];
  }
  // 还没有可钉的东西（库空、或全归档/全结案）：不落标记，等真有记忆了再说。
  const candidates = activeList(list);
  if (!candidates.length) return [];
  const picked = autoPinHeuristic(candidates, { max });
  for (const m of picked) {
    m.pinned = true;
    m.pinnedAt = now;
    m.pinnedAuto = true;
    m.updatedAt = now;
  }
  store.meta = { ...(store.meta || {}), pinnedSeededAt: now, pinnedSeededCount: picked.length };
  return picked;
}


// 记忆系统只会「被问才答」的话，永远说不出「你上周说的面试怎么样了」。dueAt 就是
// 那个主动开口的锚：约定/计划里带时间点的条目，到了时候（或过期没下文）值得主动问一句。
//
// 采用「捎带式」检查，不用 setInterval 常驻定时器：机器人收到用户消息时顺手扫一遍，
// 有到期的就挑出来，由调用方决定要不要在回复里插一句。这样既不空转耗资源，也不会
// 在没人聊天时自言自语。
export function selectDueMemories(list, now = Date.now()) {
  if (!Array.isArray(list)) return [];
  return activeList(list).filter((m) => {
    if (!m.dueAt || !m.dueAt.ts) return false; // 没时间点（相对时间没日期）的无法判定到期
    if (m.remindedAt) return false; // 已经提醒过、等结案的，别再烦人
    return m.dueAt.ts <= now;
  });
}

// 提醒结案：调用方真的把提醒发出去后调这个，把 remindedAt 记上，避免同一条反复提醒。
export function markDueReminded(m, now = Date.now()) {
  if (!m) return m;
  m.remindedAt = Number(now) || Date.now();
  m.updatedAt = Number(now) || Date.now();
  return m;
}

// 按 id → 原文 → 模糊匹配的顺序找一条记忆（supersedes / remove 共用）
function findByRef(list, ref) {
  const needle = String(ref ?? '').trim();
  if (!needle) return null;
  const byId = list.find((m) => m.id === needle);
  if (byId) return byId;
  const exact = list.find((m) => m.text === needle);
  if (exact) return exact;
  // 模型复述原文时常常只抄前半句：包含关系是强证据，取最短的那个包含者
  if (needle.length >= 4) {
    const holders = list.filter((m) => m.text.includes(needle));
    if (holders.length) return holders.sort((a, b) => a.text.length - b.text.length)[0];
    const inside = list.filter((m) => needle.includes(m.text));
    if (inside.length) return inside.sort((a, b) => b.text.length - a.text.length)[0];
  }
  // 再退到 Dice 模糊匹配，但要求够高才认
  let best = null;
  let bestScore = 0;
  for (const m of list) {
    const s = overlapRatio(m.text, needle);
    if (s > bestScore) { bestScore = s; best = m; }
  }
  return bestScore >= 0.6 ? best : null;
}

// 【P0-5】超容量时原来是**物理删除**（list.splice），也就是「记忆被容量挤掉就永久消失」。
//
// 这跟产品承诺直接冲突：用户被告知「记得住，也放得下」——「放得下」指的是淡出、
// 还能捞回来，不是悄悄删掉。实测 maxEntries=3 写 8 条，被挤掉的 5 条连 id 都不剩，
// 面板里看不到、/diff 里看不到、audit 也报不出来，用户只会发现「我明明说过」。
//
// 现在改成：超容量的条目 status='archived' + archiveReason='capacity'，保留全文与时间戳，
// 归档条目仍能被**找回**（两条路径：① findByRef 精确引用；② 用户再提一次 → revived 分支
// 把它捞回来，不用重新记）。注意 RECALLABLE 里 archived **不在**，所以主动检索
// （recall / 注入）默认不返回它 —— 这是有意的：归档的语义就是「不再每轮出现」，
// 若能随手被 recall 到，「归档」就等于「还在」，容量上限也就没意义了。
//
// 但归档不能无界：否则「只增不减」从一个洞换成另一个洞，文件会无限长大。
// 所以加 maxArchived：归档条目数量超过它时，才真正删掉**最老的**归档条目。
// 这样容量仍然有界，只是「先归档、后删除」，中间那段用户还能捞回来。
const MAX_ARCHIVED = 200;

/**
 * 归档区裁剪 —— **唯一允许的物理删除路径**（plan-v2.md:236）。
 *
 * 为什么必须单独提出来（reviewer 的 F1）：原来这段逻辑长在 enforceCap 里，
 * 而 enforceCap 只有一个调用点 —— upsertLongMemory 的 created 分支。
 * organizeLongMemories 的 decay 归档**完全不经过它**，于是：
 *
 *   300 条弱 event 跑 100 轮 organize → archived=300 > MAX_ARCHIVED=200
 *
 * 这与上面那段注释「容量仍然有界」以及 tools.js 按「归档区有上限」设计的
 * purged 契约**直接矛盾**。不是「方案留白」，是实现自我矛盾：
 * 「只增不减」的洞只是从一个桶换到另一个桶，文件照样无限长大。
 *
 * 所以裁剪必须能**被任何归档路径独立调用**，而不是绑在某个调用点的副作用上。
 *
 * @returns {Array<{id,text,archiveReason,archivedAt}>} 被真删的条目（调用方必须记日志）
 */
export function pruneArchived(list, maxArchived = MAX_ARCHIVED) {
  if (!Array.isArray(list)) return [];
  const archCap = Math.max(0, Number(maxArchived) || 0);
  const archived = list.filter((m) => m && m.status === 'archived');
  if (archived.length <= archCap) return [];

  // 最老 = 归档时间最早；同时间戳时按 lastUsedAt，再按 createdAt，保证顺序确定。
  //
  // 【archivedAt 缺失不能当成时间戳 0 —— reviewer 的 R2-3】
  // 原来写的是 `(a.archivedAt || 0) - (b.archivedAt || 0)`。`normalizeStore:370` 把
  // 缺失的 archivedAt 补成 `null`，`null || 0` 就是 0 —— 而 0 在时间轴上等于
  // 「1970 年」，即**最老**。于是「归档时间未知」的条目会被判成最老、**优先被物理删除**。
  // 这是最激进而非最保守的默认：越不知道它多老，越先真删它。
  //
  // 实际触发面小（两条归档路径都写 archivedAt，normalizeStore 也会补），但历史库
  // （手工编辑过、早期版本写过、字段被裁剪过）里确实可能缺这个字段。
  // 物理删除不可逆，所以判据必须保守：
  //   ① 有 archivedAt → 用它（正常路径，绝大多数条目走这里）
  //   ② 没有但有 createdAt → 用 createdAt 兜底。归档一定发生在创建之后，所以
  //      createdAt 是「它最老可能有多老」的上界，用它排出来的顺序仍然合理，
  //      而不是把这条直接扔到队尾（扔队尾等于让它永久占位，也与「删最老」不一致）
  //   ③ 两者都没有 → 排到**最后**（Infinity）。这条连创建时间都没有，是损坏数据；
  //     无法证明它老，就不该优先真删它。比当 0 处理保守，也不破坏「删最老」的语义。
  const archiveAgeOf = (m) => {
    const archivedAt = Number(m.archivedAt) || 0;
    if (archivedAt > 0) return archivedAt;
    const createdAt = Number(m.createdAt) || 0;
    if (createdAt > 0) return createdAt;
    return Number.POSITIVE_INFINITY;
  };
  archived.sort(
    (a, b) =>
      archiveAgeOf(a) - archiveAgeOf(b) ||
      (a.lastUsedAt || 0) - (b.lastUsedAt || 0) ||
      (a.createdAt || 0) - (b.createdAt || 0)
  );
  const doomedItems = archived.slice(0, archived.length - archCap);
  const doomed = new Set(doomedItems.map((m) => m.id));
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (doomed.has(list[i].id)) list.splice(i, 1);
  }
  return doomedItems.map((m) => ({
    id: m.id,
    text: m.text,
    archiveReason: m.archiveReason ?? null,
    archivedAt: m.archivedAt ?? null
  }));
}

function enforceCap(list, maxEntries, maxArchived = MAX_ARCHIVED) {
  const cap = Math.max(1, Number(maxEntries) || 1000);
  const archCap = Math.max(0, Number(maxArchived) || 0);
  const now = Date.now();
  const capArchived = []; // 本轮因容量被归档的条目，供返回给调用方记录

  // 1) 超容量：不删，改成归档（保留原文，可捞回）
  //
  // 注意只对 active 条目做淘汰计数与挑选：resolved/archived/superseded 本来就不占
  // 「生效配额」，把它们卷进来会导致「结案的事被容量挤成归档」——而结案是真的，
  // 不该因为写了几条新记忆就被降级。
  while (list.filter(isActive).length > cap) {
    let idx = -1;
    let worst = null;
    for (let i = 0; i < list.length; i += 1) {
      const m = list[i];
      if (!isActive(m)) continue; // 非 active 的不参与淘汰
      const rank = [m.weight || 3, m.lastUsedAt || 0];
      if (!worst || rank[0] < worst[0] || (rank[0] === worst[0] && rank[1] < worst[1])) {
        worst = rank;
        idx = i;
      }
    }
    if (idx < 0) break;
    const m = list[idx];
    m.status = 'archived';
    // 取值是 'capacity' 而不是 'cap'：plan-v2.md:117/:234 已统一命名，
    // v1 里的 'cap' 视为笔误；面板按 archiveReason === 'capacity' 给专属提示（:237）。
    m.archiveReason = 'capacity';
    m.archivedAt = now;
    m.updatedAt = now;
    capArchived.push(m);
  }

  // 2) 归档区超限：真删最老的归档条目（容量必须有界）
  //
  // 这段逻辑已抽成独立的 pruneArchived()（见它的注释：organize 的 decay 归档
  // 也必须走同一个裁剪，否则归档区会无界）。这里只是复用它。
  //
  // 这是**唯一允许的物理删除路径**（plan-v2.md:236），所以必须有日志 ——
  // 用户看不见的删除最危险：「我明明记过」而库里已经没有了。
  // enforceCap 是纯函数、没有 logger，所以把删了哪些**返回**给调用方，
  // 由 upsertLongMemory 的调用链决定怎么记。返回而不是直接 console.log，
  // 是因为内核不该决定日志去哪（测试里也不该刷屏）。
  return {
    archivedByCap: capArchived.length,
    purged: pruneArchived(list, archCap)
  };
}

// input.supersedes: 字符串或数组，可填旧条目的 id 或原文片段。
// 只有模型/调用方明确说“这条取代了哪些”时才会下架旧记忆，其余情况一律并存。
//
// input.resolves: 同上，但语义是「这件事有结果了」——旧条目标 resolved 而不是
// superseded。周六的电影看完了、面试出结果了，都属于这种：信息没作废，事情结了。
// 结案后不再进到期提醒，但仍参与检索，能被当成旧事聊起。
export function upsertLongMemory(list, input, { maxEntries = 1000, maxArchived = MAX_ARCHIVED, now = Date.now() } = {}) {
  // 【P0-3 验收④ · 完整用户路径】截断时**必须**同时记下截断前的原始长度。
  //
  // 只改 normalizeStore 是不够的 —— 那只覆盖「磁盘上已经有超长文本」这一条路径。
  // 用户亲手写一条 200 字的长记忆走的是另一条：
  //
  //   原始 200 字 → 这里截到 120（textLength 没记）→ 落盘
  //              → 读回，normalizeStore 只看到 120 字
  //              → textLength = 120（原始长度**永久丢失**）
  //              → audit 判 textLength > 120 不成立 → text-truncated 一声不吭
  //
  // 后果很讽刺：**越是用户亲手写的长记忆，越报不出来** —— 而这正是这条检查
  // 该管的场景。所以原始长度必须在**截断发生的那一刻**就地记下来，
  // 因为这是全文长度最后一次可知的时刻，之后整条链路看到的都只有 120 字。
  const rawText = String(input?.text ?? '').trim();
  const rawTextLength = rawText.length;
  const text = rawText.slice(0, MAX_TEXT);
  if (!text) return { ok: false, reason: 'empty' };
  if (looksSensitive(text)) return { ok: false, reason: 'sensitive' };
  const kind = KINDS.includes(input?.kind) ? input.kind : 'fact';
  const tags = cleanTags(input?.tags);
  const weight = Math.min(5, Math.max(1, Number(input?.weight) || 3));

  const existing = list.find((m) => isActive(m) && sameThing(m.text, text));
  // 归档过的同一条又被提起了：复活它，而不是新建一条。
  // 否则「说 → 淡忘 → 再说 → 再淡忘」会在库里堆出一串同文本的重复条目，
  // 而 doctor 只检查 active，永远报不出来（实测过：1 条变 2 条）。
  const revived = existing ? null : list.find((m) => m.status === 'archived' && sameThing(m.text, text));
  // 已结案的同一条又被提起（"上次那个面试"）：就地刷新，别新建重复，也别把
  // resolved 改回 active —— 结案是真的，不能因为复述一遍就当它没发生过。
  const resolvedTwin = (existing || revived)
    ? null
    : list.find((m) => m.status === 'resolved' && sameThing(m.text, text));
  const target = existing || revived || resolvedTwin || null;
  const retired = [];
  const refs = Array.isArray(input?.supersedes)
    ? input.supersedes
    : (input?.supersedes ? [input.supersedes] : []);
  const resolveRefs = Array.isArray(input?.resolves)
    ? input.resolves
    : (input?.resolves ? [input.resolves] : []);

  // 1) 先按显式取代关系下架旧条目（不删，留痕）
  for (const ref of refs) {
    const old = findByRef(list, ref);
    if (!old || old === target || !isActive(old)) continue;
    old.status = 'superseded';
    old.supersededAt = now;
    old.updatedAt = now;
    retired.push(old);
  }

  // 2) 显式结案：旧条目标 resolved，保留原文与 dueAt 供回顾
  const resolvedItems = [];
  let resolveTarget = false;
  for (const ref of resolveRefs) {
    const old = findByRef(list, ref);
    if (!old || !isActive(old)) continue;
    if (old === target) { resolveTarget = true; continue; }
    old.status = 'resolved';
    old.resolvedAt = now;
    old.updatedAt = now;
    if (input?.resolveNote) old.resolveNote = String(input.resolveNote).slice(0, 80);
    resolvedItems.push(old);
  }

  if (target) {
    // 重述/补充：留下信息更多的那条，tags 并集，weight 取高
    //
    // 【P0-4 第 5 条】这里原来有个 `text.length > target.text.length + 4` 的门槛：
    // 新文本必须比旧的长 **4 个字以上**才覆盖。那个 +4 是凭感觉定的，后果是
    // 「阿风在准备考研」之后又说「阿风在准备考研。」（只多 1 字）→ 新内容整条丢掉，
    // 库里还是旧文本，**却照样返回 action:'updated'** —— 调用方以为写进去了。
    // 实测：这正是「我明明补充了，它还是老样子」的来源。
    //
    // 判据改成「新文本不是旧文本的前缀/子串就替换」（captain 拍板）：
    //   · 完全相同         → 不替换，走 unchanged（见下）
    //   · 新文本是旧的子串 → 不替换。新的是简写，保留信息更全的旧版
    //     （「阿风在准备考研」不该把「阿风在准备考研，目标计算机」缩回去）
    //   · 其余一切         → 替换。走到这里说明 sameThing 已认定是同一件事的重述/补充，
    //     而新文本既不是旧文的子集、又不是旧文本身 —— 那就是新信息或更完整的表述。
    //     注意这条**不要求新文本更长**：等长改写（「阿风明天出差」→「阿风明日出差」）
    //     也该采纳，用长度门槛会把它误挡在门外。
    const before = target.text;
    const newIsFragmentOfOld = text !== target.text && target.text.includes(text);
    if (!newIsFragmentOfOld) target.text = text;
    // 原始长度：只有**本次真的发生截断**（rawText 超过 MAX_TEXT）时才可能变大。
    // 若用户这次写的是短文本（rawTextLength < MAX_TEXT），说明全文都在，
    // 之前那个更大的 textLength 是历史残留（他改短了）→ 必须回落，
    // 否则体检会永远报「太长了」，用户改也改不掉（见 normalizeStore 那段注释）。
    target.textLength = rawTextLength >= MAX_TEXT
      ? Math.max(Number(target.textLength) || 0, rawTextLength)
      : target.text.length;
    target.tags = cleanTags([...(target.tags || []), ...tags]);
    target.weight = Math.max(target.weight || 3, weight);
    target.kind = kind;
    target.lastUsedAt = now;
    target.updatedAt = now;
    if (revived) {
      // 复活：清掉归档痕迹，但把「什么时候回来过」记下来，便于解释状态变化
      target.status = 'active';
      target.archivedAt = null;
      target.archiveReason = null;
      target.revivedAt = now;
    }
    // dueAt 变了（改约时间 / 新增跟进点）就更新，并清空 remindedAt：
    // 时间点换了，之前「提醒过」的结案状态作废，得重新提醒一次
    const newDue = normalizeDueAt(input?.dueAt ?? input?.due ?? input?.deadline);
    if (newDue !== null || Object.prototype.hasOwnProperty.call(input || {}, 'dueAt')) {
      target.dueAt = newDue;
      target.remindedAt = null;
    }
    if (resolveTarget) {
      target.status = 'resolved';
      target.resolvedAt = now;
      target.remindedAt = target.remindedAt || now;
      if (input?.resolveNote) target.resolveNote = String(input.resolveNote).slice(0, 80);
    }
    for (const old of retired) old.supersededBy = target.id;

    // 【P0-4 第 6 条】没真正写进去时必须返回 unchanged，不能无条件报 updated。
    // 「同样的文本再写一次」如果返回 updated，调用方无法区分「真的更新了」和
    // 「什么都没发生」—— 而这两种情况在 UI/日志上应当给出不同反馈（前者值得说
    // 「已更新」，后者应当沉默）。判断依据是**正文有没有变**：判重走到这里时
    // tags/weight 可能被并集更新了，但用户感知的「这条记忆还是那句话」取决于正文。
    const textChanged = target.text !== before;
    const action = resolveTarget
      ? 'resolved'
      : (revived ? 'revived' : (retired.length ? 'merged+retired' : (textChanged ? 'updated' : 'unchanged')));
    return { ok: true, action, item: target, retired, resolved: resolvedItems, revived: !!revived, textChanged };
  }

  const item = {
    id: `lm-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    kind,
    text,
    // 截断前的原始长度（见函数开头那段注释）。落盘后 normalizeStore 再读回来时
    // 只能看到 120 字，所以这个值必须现在就写进条目里，否则永久丢失。
    // 没超长时 textLength === text.length，写进去也无害（audit 判 > 120 不成立）。
    textLength: rawTextLength,
    tags,
    weight,
    status: 'active',
    supersededBy: null,
    supersededAt: null,
    dueAt: normalizeDueAt(input?.dueAt ?? input?.due ?? input?.deadline),
    remindedAt: null,
    createdAt: now,
    lastUsedAt: now,
    updatedAt: now,
    hits: 0,
    // 新条目一律不钉：钉住是用户/agent 的显式决定，不该在创建时顺手默认。
    pinned: false,
    pinnedAt: null,
    pinnedAuto: false
  };
  list.push(item);
  for (const old of retired) old.supersededBy = item.id;
  const capResult = enforceCap(list, maxEntries, maxArchived);
  return {
    ok: true,
    action: 'created',
    item,
    retired,
    resolved: resolvedItems,
    // 把归档/物理删除的结果带出去：物理删除是唯一允许的删除路径，
    // 调用方（tools.js / index.js）据此写日志。不在这里直接打日志，
    // 因为内核不该决定日志去哪（测试里也不该刷屏）。
    archivedByCap: capResult.archivedByCap,
    purged: capResult.purged
  };
}

// 手工 / 外部触发的结案：按 id 或原文找一条，标 resolved 并记下结果。
// CLI 的 done 命令和「用户说已经做完了」的接入点都用它。
export function resolveLongMemory(list, { id, text, note, now = Date.now() } = {}) {
  if (!Array.isArray(list)) return null;
  const target = id
    ? list.find((m) => m.id === String(id))
    : findByRef(list, text);
  if (!target || !isActive(target)) return null;
  target.status = 'resolved';
  target.resolvedAt = now;
  target.updatedAt = now;
  // 结案即「提醒的闭环」：到期列表里不该再出现它
  target.remindedAt = target.remindedAt || now;
  if (note) target.resolveNote = String(note).slice(0, 80);
  return target;
}

// ── 衰减与整理 ──────────────────────────────────────────────────────────
// 记忆只增不减是另一种形式的失忆：一年后库里躺着两百条「上周要交的作业」，
// 检索窗口却还是 12 条，真正重要的事会被这批陈年噪音挤掉。
//
// 这里用「强度」而不是「改权重」来表达淡忘：weight 是模型给的原始判断，
// 不该被时间悄悄改掉（否则以后再也说不清这条当初有多重要）。强度是算出来的，
// 随「最后一次被想起」的时间按类型半衰期衰减 —— 常被提起的自动保持鲜活，
// 从不被想起的才淡出。
export const DEFAULT_HALF_LIFE_DAYS = { fact: 365, pref: 180, promise: 30, event: 14 };

// 半衰期的两种形态都要认：分类型对象（默认值）和单个数字（用户把它配成一个数）。
//
// 为什么不直接在调用处写 `halfLife?.[m.kind] ?? halfLife?.fact ?? 365`：
// 用户一旦把半衰期配成一个数字，`halfLife?.[kind]` 拿到 undefined，就一路掉到
// 默认的 365 —— 用户以为改成 30 天了，实际还是按一年衰减，而且不会有任何报错。
// 配置生效了却看起来没生效，比配置不生效更难查。
function halfLifeOf(kind, halfLife) {
  if (typeof halfLife === 'number' && Number.isFinite(halfLife)) return Math.max(1, halfLife);
  return Math.max(1, Number(halfLife?.[kind] ?? halfLife?.fact ?? 365));
}

// 强度 ≈ 「权重 × 半衰期衰减」。3 分的 event 约 30 天后跌破 0.6，weight 5 的
// fact 两年后还有 1.25 —— 重要的人和事不会被淡忘，一次性的安排会。
export function memoryStrength(m, now = Date.now(), halfLife = DEFAULT_HALF_LIFE_DAYS) {
  const weight = Math.min(5, Math.max(1, Number(m?.weight) || 3));
  const last = Number(m?.lastUsedAt || m?.updatedAt || m?.createdAt || now);
  const ageDays = Math.max(0, (now - last) / 86400000);
  return weight * Math.pow(0.5, ageDays / halfLifeOf(m?.kind, halfLife));
}

// 还有几天会淡出：强度跌到阈值需要的天数减去已经过去的。
//
// 为什么不能只显示强度：强度是个抽象小数（0.87），用户看着它不知道意味着什么。
// 换成「23 天后」这种话，才能一眼判断要不要管它 —— 界面要给人能据以行动的信息。
export function longMemoryFalloutDays(m, now = Date.now(), halfLife = DEFAULT_HALF_LIFE_DAYS, threshold = 0.6) {
  const weight = Math.min(5, Math.max(1, Number(m?.weight) || 3));
  // 权重本身就低于阈值时永远跌不到（衰减只会变小），0 表示「已经在阈值之下」。
  if (weight <= threshold) return 0;
  const total = halfLifeOf(m?.kind, halfLife) * Math.log2(weight / threshold);
  const last = Number(m?.lastUsedAt || m?.updatedAt || m?.createdAt || now);
  const used = Math.max(0, (now - last) / 86400000);
  return Math.max(0, total - used);
}

// 原地整理：先按强度归档过期的，再合并「同一件事被记了两遍」的。
// 全程只改 status，不删数据 —— 归错的还能从文件里捞回来。
//
// maxArchivePerRun 是「防手滑」护栏：单次整理最多归档几条。记忆衰减本来就是
// 一个慢过程，某天突然一次性把几十条全沉下去，多半是参数被改错了（半衰期调太短）
// 或误触了一次整理，等发现时已经「失忆」。有了上限，最多沉几条，第二天整理时会
// 继续沉最弱的那批 —— 淡忘依然是渐进式的，只是不会一夜清空。
export function organizeLongMemories(list, {
  now = Date.now(),
  halfLife = DEFAULT_HALF_LIFE_DAYS,
  archiveBelow = 0.6,
  maxArchivePerRun = 3,
  consolidate = true,
  consolidateDice = 0.85,
  maxArchived = MAX_ARCHIVED
} = {}) {
  if (!Array.isArray(list)) {
    return { archived: 0, merged: 0, before: 0, after: 0, deferred: 0, purged: [] };
  }
  const before = activeList(list).length;
  let archived = 0;
  let merged = 0;

  // 先算出「哪些该沉」并按强度从弱到强排好，再只沉最弱的前 N 条。
  // 这样不会因为列表顺序（先遇到的先沉）而放过更强的条目。
  const due = [];
  for (const m of list) {
    if (!m || !isActive(m)) continue;
    // 有 dueAt 且还没到期的条目豁免衰减：一个还没兑现的约定，哪怕很久没被提起，
    // 也不该被当陈年噪音归档掉 —— 否则到期那天反而想不起来要提醒。
    if (m.dueAt && m.dueAt.ts && m.dueAt.ts > now) continue;
    const strength = memoryStrength(m, now, halfLife);
    if (strength >= archiveBelow) continue;
    due.push({ m, strength });
  }
  due.sort((a, b) => a.strength - b.strength); // 最弱的排最前
  const cap = Math.max(0, Number(maxArchivePerRun) || 0);
  const toArchive = cap === 0 ? due : due.slice(0, cap);
  for (const { m } of toArchive) {
    m.status = 'archived';
    m.archivedAt = now;
    m.archiveReason = 'decay';
    archived += 1;
  }

  if (consolidate) {
    const live = activeList(list);
    const dropped = new Set();
    for (let i = 0; i < live.length; i += 1) {
      const a = live[i];
      if (dropped.has(a)) continue;
      for (let j = i + 1; j < live.length; j += 1) {
        const b = live[j];
        if (dropped.has(b) || a.kind !== b.kind) continue;
        // 长度差太多就不是「同一件事的两种说法」，宁可留着也别乱并
        const ratio = Math.min(a.text.length, b.text.length) / Math.max(a.text.length, b.text.length);
        if (ratio < 0.6) continue;
        if (overlapRatio(a.text, b.text) < consolidateDice) continue;
        const keep = a.text.length >= b.text.length ? a : b;
        const drop = keep === a ? b : a;
        keep.text = keep.text.length >= drop.text.length ? keep.text : drop.text;
        keep.tags = cleanTags([...(keep.tags || []), ...(drop.tags || [])]);
        keep.weight = Math.max(keep.weight || 3, drop.weight || 3);
        keep.updatedAt = now;
        keep.lastUsedAt = Math.max(Number(keep.lastUsedAt) || 0, Number(drop.lastUsedAt) || 0) || now;
        drop.status = 'superseded';
        drop.supersededBy = keep.id;
        drop.supersededAt = now;
        dropped.add(drop);
        merged += 1;
      }
    }
  }

  return {
    archived,
    merged,
    before,
    after: activeList(list).length,
    // 本应归档但被 maxArchivePerRun 挡下的条数：调用方可以用它判断「是不是参数错了」
    // 或「是不是该提高上限」。正常情况下这个值应该接近 0。
    deferred: due.length - toArchive.length,
    // 【F1】归档区裁剪。decay 归档**必须**也走这里，否则归档区无界 ——
    // 原来裁剪逻辑长在 enforceCap 里、只有 upsert 的 created 分支会调，
    // 而 organize 的 decay 归档完全不经过它。reviewer 实测 300 条弱 event
    // 跑 100 轮 organize 得到 archived=300 > MAX_ARCHIVED=200，
    // 与「容量仍然有界」的承诺和 tools.js 的 purged 契约直接矛盾。
    // purged 非空时调用方（index.js 的 organize）必须记 logger.error ——
    // 这是唯一允许的物理删除路径，用户看不见的删除最危险。
    purged: pruneArchived(list, maxArchived)
  };
}

// ── 提炼提示词 ──────────────────────────────────────────────────────────
// 放在模块里而不是 bridge.js，是为了让 scripts/probe-long-memory-extract.mjs
// 能用同一份提示词做端到端验证 —— 提示词和解析器分居两处，正是上一版字段名
// 对不上（提示词要 text、解析器只认 content）却没人发现的原因。
export function buildLongMemoryPrompt(messages, existing) {
  const lines = (Array.isArray(messages) ? messages : [])
    .map((m, i) => `${i + 1}. ${m?.isOwner ? '【管理员】' : ''}${m?.sender ?? '某人'}：${m?.text ?? ''}`)
    .join('\n');
  const existingList = Array.isArray(existing) ? existing : [];
  const known = existingList.length
    ? existingList.slice(-60).map((m, i) => {
      const marks = [
        (m.tags || []).length ? `（${m.tags.join('、')}）` : '',
        m.status === 'resolved' ? '［已完成］' : ''
      ].join('');
      return `${i + 1}. ${m.text}${marks}`;
    }).join('\n')
    : '（暂无）';
  return `【任务指令优先】下面是一条数据整理任务，不是角色扮演。请忽略你的人物设定、性格和聊天习惯，不要用角色口吻回应，只做信息抽取并输出 JSON。

你是记忆整理员。从下面这段 QQ 聊天里提炼「值得长期记住」的信息，只输出 JSON 数组，不要任何解释、不要 markdown 代码块。

输出格式：[{"kind":"fact|pref|promise|event","text":"不超过60字","tags":["2到4个短标签"],"weight":1-5,"supersedes":["被取代的旧记忆原文"],"resolves":["已经了结的旧记忆原文"],"dueAt":{"when":"这周六","date":"2026-11-01"}}]

规则：
1. 只记稳定、以后还用得上的：某个人的事实（身份、学业、工作、住处、家庭）、偏好（喜欢/讨厌什么）、约定（说好要做的事、时间地点）、发生在对方身上的重要事件。
2. 不记：一次性闲聊、玩笑、情绪波动、天气、纯语气词、以及【已有记忆】里已经有的内容。
3. weight：4~5=长期有效且重要（身份、重大计划、承诺），3=一般，1~2=可有可无。
4. 宁缺勿滥。没有值得记的就输出 []，不要凑数，也不要写解释。
5. text 用第三人称写清是谁的事，例如“阿风在准备考研，目标是本校计算机”。
6. supersedes 只在「新信息让某条旧记忆不再成立」时填：把【已有记忆】里那条的原文照抄进去（抄关键片段即可），不要改写。例如旧记忆是“阿风在准备考研”，聊天里说他改考公了，就把旧的那句填进 supersedes。
7. 只是补充细节、或者两件事本来就并存（同时喜欢两个游戏）时，supersedes 留空——旧记忆会原样保留，不要试图覆盖。
8. 一条只写一件事。不要把两件事用「；」拼进同一条，宁可拆成两条。
9. 偏好（pref）和约定（promise）同样重要，别只记事件。
10. dueAt 只在这条记忆「有个明确时间点要跟进」时填：比如约定「这周六一起吃饭」「下周要交作业」「月底要还钱」。when 写原文里的相对说法（照抄），date 写你能确定的绝对日期（YYYY-MM-DD）。拿不准绝对日期就只填 when、date 留空字符串；完全没时间点就整个 dueAt 省略或填 null，不要编造时间。
11. resolves 只在「聊天里明确说了某件已有的事已经完成、有结果了」时填：把【已有记忆】里那条的原文照抄进去（抄关键片段即可）。例如旧记忆是「说好周六一起看电影」，聊天里说「看完了，挺好看」，就把旧的那句填进 resolves；旧记忆是「阿风下周面试」，聊天里说「面试过了」，也填进去。不要因为「过了几天」就填——必须有明确的结果表述。结案不等于取代：如果事情有了新变化（面试过了→要去上班），照常用 supersedes 处理那件事本身。

【已有记忆】
${known}

【最近聊天】
${lines}`;
}

// ── 提炼输出解析 ────────────────────────────────────────────────────────
// 提炼跑在聊天人格（qq-chat preset）+ 低配模型上，输出很少是纯净的 JSON：
// 常见的是包一层 ```json 代码块、前面带一句“好的，我整理一下”、或者把示例数组
// 混在正文里。所以不能直接 JSON.parse，而是把文本里所有配平的数组都抠出来试。
//
// 返回值必须能区分三种情况 —— 这是上一版静默丢数据的根源：
//   { ok: true,  items: [] }     → 模型明确输出了 []（真的没什么可记的），可以消费窗口
//   { ok: true,  items: [...] }  → 提炼成功，可以消费窗口
//   { ok: false, items: [] }     → 输出里根本没有可解析的数组（跑偏/报错/被截断），
//                                  绝不能消费窗口，否则这批原料就永久丢了
const KIND_ALIASES = {
  fact: 'fact', 事实: 'fact', identity: 'fact', profile: 'fact', info: 'fact',
  pref: 'pref', 偏好: 'pref', preference: 'pref', like: 'pref',
  promise: 'promise', 约定: 'promise', plan: 'promise', agreement: 'promise',
  event: 'event', 事件: 'event', milestone: 'event'
};

// 扫描 text 里所有括号配平的块。字符串内的括号不参与计数，
// 否则「阿风说[笑]」这类内容会把配对算歪。
function balancedBlocks(text, open, close) {
  const s = String(text ?? '');
  const out = [];
  let i = 0;
  while (i < s.length) {
    const start = s.indexOf(open, i);
    if (start < 0) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let j = start; j < s.length; j += 1) {
      const ch = s[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) { end = j; break; }
      }
    }
    if (end < 0) break; // 后面全是不完整内容，没必要继续找
    out.push(s.slice(start, end + 1));
    i = end + 1;
  }
  return out;
}

const balancedArrays = (text) => balancedBlocks(text, '[', ']');

function normalizeParsedItem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  // 兼容几种常见的字段漂移：提示词要 text，但模型有时会写 content/memory/summary
  const text = String(raw.text ?? raw.content ?? raw.memory ?? raw.summary ?? '').trim();
  if (!text) return null;
  const kindRaw = String(raw.kind ?? raw.type ?? '').trim();
  const kind = KIND_ALIASES[kindRaw.toLowerCase()] || KIND_ALIASES[kindRaw] || 'fact';
  const rawTags = raw.tags ?? raw.tag ?? [];
  const tags = (Array.isArray(rawTags) ? rawTags : String(rawTags ?? '').split(/[、,，;；\s]+/))
    .map((t) => String(t ?? '').trim())
    .filter(Boolean)
    .slice(0, 6);
  const weightNum = Number.parseInt(String(raw.weight ?? '').replace(/[^\d]/g, ''), 10);
  const weight = Number.isFinite(weightNum) ? Math.min(5, Math.max(1, weightNum)) : 3;
  const refList = (v) => (Array.isArray(v) ? v : [v])
    .map((x) => String(x && typeof x === 'object' ? (x.text ?? x.id ?? '') : x ?? '').trim())
    .filter(Boolean)
    .slice(0, 6);
  const supersedes = refList(raw.supersedes ?? raw.replaces ?? raw.supersede ?? []);
  // 结案引用：模型有时叫 resolves / done / finished / completed
  const resolves = refList(raw.resolves ?? raw.resolve ?? raw.done ?? raw.finished ?? raw.completed ?? []);
  const resolveNote = String(raw.resolveNote ?? raw.result ?? '').trim().slice(0, 80);
  // dueAt 拿不准时留 null（normalizeDueAt 自己会判），别为了凑字段硬造时间
  const dueAt = normalizeDueAt(raw.dueAt ?? raw.due ?? raw.deadline ?? raw.remindAt);
  return {
    text: text.slice(0, 120),
    kind,
    tags,
    weight,
    supersedes,
    resolves,
    resolveNote: resolveNote || undefined,
    dueAt
  };
}

export function parseLongMemoryJson(text) {
  for (const candidate of balancedArrays(text)) {
    let data = null;
    try { data = JSON.parse(candidate); } catch { continue; }
    if (!Array.isArray(data)) continue;
    // 明确输出 []：调用方可以安全消费窗口
    if (data.length === 0) return { ok: true, items: [] };
    const items = data.map(normalizeParsedItem).filter(Boolean);
    // 有数组但一条都认不出（字段名全错）→ 试下一个候选，
    // 全都认不出才算格式不符，避免「明明提取到了却当成无新增」
    if (!items.length) continue;
    return { ok: true, items: items.slice(0, 12) };
  }
  // 顶层单个对象：模型只抽到一条时经常直接吐 {"text":...}，不套数组。
  // 以前这种被判「格式不对」→ ok:false → 窗口永不消费 → 同一批原料无限重试。
  // 能认出来就是能认出来，别让格式洁癖变成死循环。
  for (const candidate of balancedBlocks(text, '{', '}')) {
    let data = null;
    try { data = JSON.parse(candidate); } catch { continue; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
    const arrKey = ['items', 'memories', 'data', 'result', 'results', 'list']
      .find((k) => Array.isArray(data[k]));
    if (arrKey) {
      if (!data[arrKey].length) continue;
      const items = data[arrKey].map(normalizeParsedItem).filter(Boolean);
      if (!items.length) continue;
      return { ok: true, items: items.slice(0, 12) };
    }
    const one = normalizeParsedItem(data);
    if (one) return { ok: true, items: [one] };
  }
  return { ok: false, items: [] };
}

export function removeLongMemory(list, { id, text } = {}) {
  const needle = String(text ?? '').trim();
  if (id) {
    const i = list.findIndex((m) => m.id === id);
    if (i >= 0) return list.splice(i, 1)[0];
  }
  if (needle) {
    const exact = list.findIndex((m) => m.text === needle);
    if (exact >= 0) return list.splice(exact, 1)[0];
    const near = findByRef(list, needle);
    if (near) {
      const j = list.indexOf(near);
      if (j >= 0) return list.splice(j, 1)[0];
    }
  }
  return null;
}

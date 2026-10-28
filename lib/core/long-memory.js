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
const STORE_VERSION = 2;

// BM25 参数：k1 控制词频饱和，b 控制长度归一化强度（0=不归一，1=完全归一）
const BM25_K1 = 1.2;
const BM25_B = 0.75;

// 判重阈值：Dice 相似度 + 长度比。两个都满足才算“同一件事重述”，否则并存。
const DUP_DICE = 0.9;
const DUP_LEN_RATIO = 0.6;

function blank() {
  return { version: STORE_VERSION, buckets: {} };
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

export function normalizeStore(raw) {
  const base = blank();
  if (!raw || typeof raw !== 'object' || !raw.buckets || typeof raw.buckets !== 'object') return base;
  for (const [key, list] of Object.entries(raw.buckets)) {
    if (!Array.isArray(list)) continue;
    const bucket = [];
    for (const x of list) {
      if (!x || typeof x.text !== 'string' || !x.text.trim()) continue;
      const createdAt = Number(x.createdAt) || Date.now();
      // v1 的条目没有 status 字段，这里统一补成 active —— 也就是迁移本身
      const status = STATUS.includes(x.status) ? x.status : 'active';
      bucket.push({
        id: String(x.id || `lm-${createdAt.toString(36)}${Math.random().toString(36).slice(2, 6)}`),
        kind: KINDS.includes(x.kind) ? x.kind : 'fact',
        text: String(x.text).trim().slice(0, MAX_TEXT),
        tags: cleanTags(x.tags),
        weight: Math.min(5, Math.max(1, Number(x.weight) || 3)),
        status,
        supersededBy: x.supersededBy ? String(x.supersededBy) : null,
        supersededAt: Number(x.supersededAt) || null,
        // 归档要留审计痕迹：什么时候、因为什么淡出的，以后想捞回来才知道该找哪条
        archivedAt: Number(x.archivedAt) || null,
        archiveReason: x.archiveReason ? String(x.archiveReason) : null,
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
        hits: Math.max(0, Number(x.hits) || 0)
      });
    }
    if (bucket.length) base.buckets[key] = bucket;
  }
  return base;
}

export function readLongMemoryStore(file) {
  try {
    return normalizeStore(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return blank();
  }
}

export function writeLongMemoryStore(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 1), 'utf8');
  fs.renameSync(tmp, file);
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

function sameThing(a, b) {
  const ta = String(a ?? '').trim();
  const tb = String(b ?? '').trim();
  if (!ta || !tb) return false;
  if (ta === tb) return true;
  // 一条完整包含另一条 ≈ 补充信息，留下信息更多的那条
  if (ta.includes(tb) || tb.includes(ta)) return true;
  const ratio = Math.min(ta.length, tb.length) / Math.max(ta.length, tb.length);
  if (ratio < DUP_LEN_RATIO) return false;
  return overlapRatio(ta, tb) >= DUP_DICE;
}

export function buildIndex(list) {
  const docs = [];
  const postings = new Map();
  const lens = [];
  let totalLen = 0;
  for (const m of list) {
    if (!isRecallable(m)) continue;
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

export function selectLongMemories(list, query, limit = 12, maxChars = 1200, now = Date.now(), touch = true) {
  if (!Array.isArray(list) || !list.length) return [];
  const index = indexOf(list);
  if (!index.n) return [];
  const ranked = scoreDocs(index, tokenize(query), now).sort((a, b) => b.score - a.score);
  const picked = [];
  const relevance = new Map();
  let chars = 0;
  for (const { m, rel } of ranked) {
    if (picked.length >= limit) break;
    // 第一行要连表头和换行一起算，之后每行多一个换行符
    const next = picked.length === 0
      ? BLOCK_HEADER.length + 1 + longMemoryLineLength(m, now)
      : chars + 1 + longMemoryLineLength(m, now);
    if (picked.length > 0 && next > maxChars) break;
    picked.push(m);
    relevance.set(m, rel);
    chars = next;
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

// ── 主动提醒 ────────────────────────────────────────────────────────────
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

function enforceCap(list, maxEntries) {
  const cap = Math.max(1, Number(maxEntries) || 1000);
  while (list.length > cap) {
    let idx = -1;
    let worst = null;
    for (let i = 0; i < list.length; i += 1) {
      const m = list[i];
      // 淘汰顺序：已下架（superseded/archived）→ 已完成 → 生效，同级内比权重、再比新近度。
      // 已完成排在已下架之后、生效之前：结案的事还有「上次那个后来呢」的回顾价值，
      // 但毕竟是历史，容量吃紧时先于待办被清。
      const tier = isActive(m) ? 2 : (m.status === 'resolved' ? 1 : 0);
      const rank = [tier, m.weight || 3, m.lastUsedAt || 0];
      if (
        !worst ||
        rank[0] < worst[0] ||
        (rank[0] === worst[0] && (rank[1] < worst[1] || (rank[1] === worst[1] && rank[2] < worst[2])))
      ) {
        worst = rank;
        idx = i;
      }
    }
    if (idx < 0) break;
    list.splice(idx, 1);
  }
}

// input.supersedes: 字符串或数组，可填旧条目的 id 或原文片段。
// 只有模型/调用方明确说“这条取代了哪些”时才会下架旧记忆，其余情况一律并存。
//
// input.resolves: 同上，但语义是「这件事有结果了」——旧条目标 resolved 而不是
// superseded。周六的电影看完了、面试出结果了，都属于这种：信息没作废，事情结了。
// 结案后不再进到期提醒，但仍参与检索，能被当成旧事聊起。
export function upsertLongMemory(list, input, { maxEntries = 1000, now = Date.now() } = {}) {
  const text = String(input?.text ?? '').trim().slice(0, MAX_TEXT);
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
    if (text.length > target.text.length + 4) target.text = text;
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
    const action = resolveTarget
      ? 'resolved'
      : (revived ? 'revived' : (retired.length ? 'merged+retired' : 'updated'));
    return { ok: true, action, item: target, retired, resolved: resolvedItems, revived: !!revived };
  }

  const item = {
    id: `lm-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    kind,
    text,
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
    hits: 0
  };
  list.push(item);
  for (const old of retired) old.supersededBy = item.id;
  enforceCap(list, maxEntries);
  return { ok: true, action: 'created', item, retired, resolved: resolvedItems };
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
  consolidateDice = 0.85
} = {}) {
  if (!Array.isArray(list)) return { archived: 0, merged: 0, before: 0, after: 0 };
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
    deferred: due.length - toArchive.length
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

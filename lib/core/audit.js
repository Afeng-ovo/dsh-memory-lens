// 记忆库体检：回答两个问题 ——
//   ① 这一个库自己有没有自相矛盾的地方？
//   ② 两份库之间有没有对不上的地方？
//
// 为什么单独成一个模块、而不是塞进 long-memory.js：long-memory.js 是「怎么记」，
// 这里是「记的东西对不对」。两者失败方式完全不同 —— 前者错了表现为记不上，
// 后者错了表现为「看着都在，其实是两份不同的记忆」。混在一起会让人不敢动内核。
//
// 三条判定原则，决定了下面所有代码的形状：
//
// ① **不靠 id 比对两份库**。两个系统各自生成 id（`lm-xxxx` 这种），同一条记忆在
//    两边 id 一定不同。按 id 比会得出「全部只在一侧」的荒谬结论 —— 那是把
//    「id 不同」误报成「记忆丢了」。所以跨库比对按「正文 + 类型」配对。
//
// ② **只报能确定的问题，不猜**。比如「正文重复但两条都生效」，这是确定的矛盾
//    （同一条记忆存了两份，注入时白占两份预算）；而「两条正文相似」不算问题 ——
//    相似可能正是用户想要的两个角度。宁可少报，也不要制造一堆要人工分辨的噪音，
//    噪音多了用户就不看了，那时候真问题也会被淹掉。
//
// ③ **每条问题都带「怎么办」**。只说「这里不对」的报告等于把工作推回给用户。
//    所以每条 finding 都带 fix 字段，说明可以怎么处理。
import { KINDS, STATUS, stripTagTail } from './long-memory.js';

const MAX_TEXT = 120;
const MAX_TAGS = 6;
const MAX_TAG_LEN = 12;

// 一天。时间戳检查都用它做容差，避免「刚写的条目因为几毫秒误差被报成时间倒错」。
const DAY = 86400000;

/**
 * 跨库配对用的键。
 *
 * 用「正文 + 类型」而不是 id：这是两个系统之间唯一稳定的东西。正文会被
 * normalizeStore 去空格、截断到 120 字，所以两边取的是同一份归一化结果。
 * 用 \u0000 分隔是为了不让「正文A + 类型B」和「正文AB + 类型」撞到一起。
 */
export function pairKey(m) {
  const tags = Array.isArray(m?.tags) ? m.tags : [];
  const text = stripTagTail(String(m?.text ?? ''), tags).trim();
  const kind = KINDS.includes(m?.kind) ? m.kind : 'fact';
  return `${text}\u0000${kind}`;
}

/** 把一条记忆压缩成「可比较的形态」：只留用户看得懂、也确实该一致的字段。 */
function comparable(m) {
  const tags = Array.isArray(m?.tags) ? m.tags.map((t) => String(t ?? '').trim()).filter(Boolean) : [];
  return {
    text: stripTagTail(String(m?.text ?? ''), tags).trim(),
    kind: KINDS.includes(m?.kind) ? m.kind : 'fact',
    status: STATUS.includes(m?.status) ? m.status : 'active',
    weight: Number(m?.weight) || 3,
    tags,
    createdAt: Number(m?.createdAt) || 0
  };
}

/** 两个数组当成集合比：忽略顺序。标签顺序不该算「不一致」。 */
function sameTags(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((x, i) => x === sb[i]);
}

/**
 * 单库体检。
 *
 * @param {Array} list 库里的全部条目（含已归档/已取代 —— 不完整的视图会漏掉悬空引用）
 * @param {object} opts `{ now, halfLife, archiveBelow }`，用于判断「该沉没沉」
 * @returns {{ok: boolean, checked: number, findings: Array}}
 */
export function auditStore(list, { now = Date.now(), archiveBelow = 0.6 } = {}) {
  const items = Array.isArray(list) ? list.filter((m) => m && typeof m === 'object') : [];
  const findings = [];
  const add = (severity, code, message, fix, extra = {}) => {
    findings.push({ severity, code, message, fix, ...extra });
  };

  // ── id 层 ────────────────────────────────────────────────────────────
  const byId = new Map();
  for (const m of items) {
    const id = String(m.id ?? '');
    if (!id) {
      add('high', 'missing-id', '有条记忆没有 id', '重新保存一次即可自动补上', { text: m.text });
      continue;
    }
    if (byId.has(id)) {
      add('high', 'duplicate-id', `id 重复：${id}`, '两条都要删掉一条或改 id，否则改一条会改到另一条', { id, text: m.text });
    } else {
      byId.set(id, m);
    }
  }

  // ── 正文重复：同一条记忆存了两份 ──────────────────────────────────────
  //
  // 只在「两条都还能被注入」时报。一条生效一条归档是正常的（复活过、或整理沉了一条），
  // 把那种情况也报出来，用户每次打开面板都会看到同一批红字，久了就无视了。
  const liveByKey = new Map();
  for (const m of items) {
    if (m.status !== 'active' && m.status !== 'resolved') continue;
    const key = pairKey(m);
    const prev = liveByKey.get(key);
    if (prev) {
      add('high', 'duplicate-text', `同一条记忆存了两份：${String(m.text).slice(0, 40)}…`,
        '留一条、删另一条。重复的条目会白占注入预算，而且改了一条另一条还是旧的',
        { ids: [prev.id, m.id], text: m.text });
    } else {
      liveByKey.set(key, m);
    }
  }

  // ── 引用完整性：状态说「被谁取代了」，那个「谁」必须真的存在 ────────────
  for (const m of items) {
    if (m.status === 'superseded' && m.supersededBy) {
      if (!byId.has(String(m.supersededBy))) {
        add('medium', 'dangling-supersededBy',
          `「${String(m.text).slice(0, 30)}…」说被 ${m.supersededBy} 取代，但那条不存在`,
          '把它改回生效，或重新做一次取代', { id: m.id });
      }
    }
    if (m.status === 'superseded' && !m.supersededBy) {
      add('low', 'superseded-without-target',
        `「${String(m.text).slice(0, 30)}…」是已取代状态，但没记是被谁取代的`,
        '多半是外部导入或手工编辑造成的，不影响使用', { id: m.id });
    }
  }

  // ── 状态与痕迹是否配套 ────────────────────────────────────────────────
  //
  // 「归档了却没有归档时间」这种，说明写入路径绕过了一次规范（手工改文件、
  // 或别的系统导入）。不影响读取，但面板上的「预计淡忘」会算不出来。
  for (const m of items) {
    const label = `「${String(m.text).slice(0, 30)}…」`;
    if (m.status === 'archived' && !Number(m.archivedAt)) {
      add('low', 'archived-without-time', `${label}已归档，但没有归档时间`, '补一个 archivedAt，或重新归档一次', { id: m.id });
    }
    if (m.status === 'resolved' && !Number(m.resolvedAt)) {
      add('low', 'resolved-without-time', `${label}已结案，但没有结案时间`, '补一个 resolvedAt，或重新结案一次', { id: m.id });
    }
  }

  // ── 时间戳 ────────────────────────────────────────────────────────────
  for (const m of items) {
    const label = `「${String(m.text).slice(0, 30)}…」`;
    const created = Number(m.createdAt) || 0;
    if (created <= 0) {
      add('medium', 'missing-createdAt', `${label}没有创建时间`, '没有它就排不出新近度，检索排序会把它当最老的', { id: m.id });
      continue;
    }
    if (created > now + DAY) {
      add('high', 'future-createdAt',
        `${label}的创建时间在未来（${new Date(created).toISOString().slice(0, 10)}）`,
        '时间戳多半被写成了别的单位（秒当成毫秒会差几十年），改成毫秒', { id: m.id });
    }
    const updated = Number(m.updatedAt) || 0;
    if (updated > 0 && updated < created - DAY) {
      add('medium', 'updated-before-created', `${label}的最后修改时间早于创建时间`, '时间戳来源不一致，检查是谁写的', { id: m.id });
    }
    const used = Number(m.lastUsedAt) || 0;
    if (used > 0 && used < created - DAY) {
      add('medium', 'used-before-created', `${label}的最后使用时间早于创建时间`, '时间戳来源不一致，检查是谁写的', { id: m.id });
    }
  }

  // ── 字段范围：被静默截断/夹紧过的值 ────────────────────────────────────
  //
  // normalizeStore 会把超长正文截到 120 字、标签截到 6 个、权重夹到 1~5。
  // 这些夹紧本身是对的（防止一条记忆吃掉整个预算），但如果**读进来的文件里
  // 本来就更长**，说明有一条信息已经被悄悄削掉了 —— 用户该知道。
  for (const m of items) {
    const label = `「${String(m.text).slice(0, 30)}…」`;
    if (!String(m.text ?? '').trim()) {
      add('high', 'empty-text', '有条记忆正文是空的', '删掉它，空正文没有任何意义', { id: m.id });
    }
    if (String(m.text ?? '').length > MAX_TEXT) {
      add('medium', 'text-truncated', `${label}正文超过 ${MAX_TEXT} 字`, '拆成两条，或删掉不重要的部分', { id: m.id });
    }
    const tags = Array.isArray(m.tags) ? m.tags : [];
    if (tags.length > MAX_TAGS) {
      add('low', 'too-many-tags', `${label}标签超过 ${MAX_TAGS} 个`, '删掉不常用的标签', { id: m.id });
    }
    if (tags.some((t) => String(t ?? '').length > MAX_TAG_LEN)) {
      add('low', 'tag-too-long', `${label}有标签超过 ${MAX_TAG_LEN} 字`, '标签是给检索用的，太长反而搜不到', { id: m.id });
    }
    const w = Number(m.weight);
    if (!Number.isFinite(w) || w < 1 || w > 5) {
      add('low', 'weight-out-of-range', `${label}权重是 ${m.weight}，超出 1~5`, '会被夹回 1~5，改成范围内的值', { id: m.id });
    }
    if (m.kind !== undefined && !KINDS.includes(m.kind)) {
      add('medium', 'unknown-kind', `${label}类型是「${m.kind}」，不在 fact/pref/promise/event 里`,
        '会被当成「事实」，改成四种之一', { id: m.id });
    }
    if (m.status !== undefined && !STATUS.includes(m.status)) {
      add('high', 'unknown-status', `${label}状态是「${m.status}」，不在 active/superseded/archived/resolved 里`,
        '会被当成「生效」，改成四种之一', { id: m.id });
    }
  }

  // ── 「该沉没沉」：整理到底跑没跑 ──────────────────────────────────────
  //
  // 这是最值得报的一类：强度已经低于归档阈值、却还是 active，说明 organizeLongMemories
  // 从来没被调用过（或一直失败）。表现是库只增不减 —— 而这个系统的核心承诺是
  // 「记得住，也放得下」。用户看不见这个数字，就只能看到「记忆越来越多」。
  //
  // 只在超过一定数量时报，避免刚导入一批老数据时刷屏（那是预期内的，整理一次就好）。
  const staleActive = items.filter((m) => {
    if (m.status !== 'active') return false;
    const strength = Number(m.strength);
    return Number.isFinite(strength) && strength > 0 && strength < archiveBelow;
  });
  if (staleActive.length >= 3) {
    add('medium', 'never-organized',
      `${staleActive.length} 条记忆的强度已经低于归档阈值 ${archiveBelow}，但还在生效状态`,
      '说明衰减整理没跑过。重启一次插件就会整理（一次最多沉 3 条）',
      { ids: staleActive.slice(0, 10).map((m) => m.id) });
  }

  // ── 到期没提醒 ────────────────────────────────────────────────────────
  const overdue = items.filter((m) => m.status === 'active' && m.dueAt?.ts && m.dueAt.ts <= now && !m.remindedAt);
  if (overdue.length) {
    add('low', 'due-not-reminded',
      `${overdue.length} 条约定已经到时间，但还没被提醒过`,
      '下次对话会捎带提一句；如果不想再提，直接结案',
      { ids: overdue.slice(0, 10).map((m) => m.id) });
  }

  const counts = { high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  return { ok: findings.length === 0, checked: items.length, counts, findings };
}

/**
 * 两份库对比。
 *
 * @param {Array} left  当前库
 * @param {Array} right 另一份库（比如另一个程序正在用的那个文件）
 * @param {object} opts `{ leftName, rightName }` 只用于报告里的措辞
 * @returns {{ok, onlyLeft, onlyRight, differing, identical, counts}}
 */
export function compareStores(left, right, { leftName = '当前库', rightName = '另一份' } = {}) {
  const L = (Array.isArray(left) ? left : []).filter((m) => m && typeof m.text === 'string');
  const R = (Array.isArray(right) ? right : []).filter((m) => m && typeof m.text === 'string');

  // 同一份库里可能本来就有重复正文（体检会单独报），所以配对用「键 → 数组」，
  // 按出现顺序一对一消耗。直接用 Map<key, item> 会让后一条覆盖前一条，
  // 于是「库里本来就两份」被报成「另一侧缺一条」，指错了地方。
  const rByKey = new Map();
  for (const m of R) {
    const key = pairKey(m);
    if (!rByKey.has(key)) rByKey.set(key, []);
    rByKey.get(key).push(m);
  }

  const onlyLeft = [];
  const differing = [];
  let identical = 0;
  const usedRight = new Set();

  for (const m of L) {
    const key = pairKey(m);
    const pool = rByKey.get(key);
    const match = pool && pool.find((x) => !usedRight.has(x));
    if (!match) {
      onlyLeft.push({ text: comparable(m).text, kind: comparable(m).kind, status: comparable(m).status, id: m.id });
      continue;
    }
    usedRight.add(match);
    const a = comparable(m);
    const b = comparable(match);
    const fields = [];
    // 正文和类型是配对键，能配对上就一定相同，所以只比其余字段。
    if (a.status !== b.status) fields.push({ field: 'status', left: a.status, right: b.status });
    if (a.weight !== b.weight) fields.push({ field: 'weight', left: a.weight, right: b.weight });
    if (!sameTags(a.tags, b.tags)) fields.push({ field: 'tags', left: a.tags, right: b.tags });
    // 创建时间差超过 1 天就算不同：同一件事在两个系统里被记下，时间可能差几秒
    // （几乎同时写），也可能差几天（一边早就有、一边后来才补记）—— 后者是真实差异。
    if (Math.abs(a.createdAt - b.createdAt) > DAY) {
      fields.push({
        field: 'createdAt',
        left: a.createdAt ? new Date(a.createdAt).toISOString().slice(0, 10) : null,
        right: b.createdAt ? new Date(b.createdAt).toISOString().slice(0, 10) : null
      });
    }
    if (fields.length) {
      differing.push({ text: a.text, kind: a.kind, id: m.id, otherId: match.id, fields });
    } else {
      identical += 1;
    }
  }

  const onlyRight = R.filter((m) => !usedRight.has(m)).map((m) => ({
    text: comparable(m).text,
    kind: comparable(m).kind,
    status: comparable(m).status,
    id: m.id
  }));

  return {
    ok: onlyLeft.length === 0 && onlyRight.length === 0 && differing.length === 0,
    leftName,
    rightName,
    identical,
    onlyLeft,
    onlyRight,
    differing,
    counts: {
      left: L.length,
      right: R.length,
      identical,
      onlyLeft: onlyLeft.length,
      onlyRight: onlyRight.length,
      differing: differing.length
    }
  };
}

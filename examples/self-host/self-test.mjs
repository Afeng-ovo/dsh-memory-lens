// 长期记忆 v2 自检：BM25 检索、冲突并存、显式取代、敏感拦截、旧数据迁移。
// 运行：node test/self-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SHARED_KEY,
  activeList,
  bucketOf,
  formatLongMemoryBlock,
  looksSensitive,
  markDueReminded,
  memoryStrength,
  mergeIntoShared,
  normalizeDueAt,
  normalizeStore,
  organizeLongMemories,
  overlapRatio,
  parseLongMemoryJson,
  readLongMemoryStore,
  recallableList,
  removeLongMemory,
  resolveLongMemory,
  selectDueMemories,
  selectLongMemories,
  sharedBucketOf,
  tokenize,
  upsertLongMemory,
  writeLongMemoryStore
} from '../../lib/core/long-memory.js';

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`✅ ${name}`);
}

// 1. 分词：中文二字滑窗 + ASCII 整词，标点丢掉
{
  const t = tokenize('阿风买了张 RTX4090，真香！');
  assert.ok(t.includes('rtx4090'), 'ASCII 应整词保留');
  assert.ok(t.includes('阿风') && t.includes('风买'), '中文按二字滑窗');
  assert.ok(!t.includes('，'), '标点应被丢掉');
  assert.deepEqual(tokenize(''), []);
  ok('tokenize：中文二字 + ASCII 整词，标点丢弃');
}

// 2. 相似度用 Dice 系数，短句不再虚高（v1 用 min 做分母，导致“考研/考公”被判重复）
{
  const near = overlapRatio('阿风在准备考研', '阿风在准备考公');
  assert.ok(near > 0.5 && near < 0.9, `短句重合度不应逼近 1（实际 ${near.toFixed(3)}）`);
  assert.equal(overlapRatio('同一句话', '同一句话'), 1);
  assert.equal(overlapRatio('', '任意'), 0);
  ok('overlapRatio：Dice 系数，短句重合不虚高');
}

// 3. 语义冲突不静默合并：两条都必须留下来
{
  const list = [];
  const a = upsertLongMemory(list, { text: '阿风在准备考研，目标是本校计算机', kind: 'fact', weight: 4 });
  const b = upsertLongMemory(list, { text: '阿风在准备考公', kind: 'fact', weight: 3 });
  assert.equal(a.action, 'created');
  assert.equal(b.action, 'created', '冲突信息不应被并进上一条');
  assert.equal(activeList(list).length, 2);
  assert.equal(list.length, 2);
  ok('冲突信息不静默合并，两条并存');
}

// 4. 显式 supersedes：旧条目标记下架而不是删除
{
  const list = [];
  upsertLongMemory(list, { text: '阿风在准备考研，目标是本校计算机', kind: 'fact', weight: 5 });
  const r = upsertLongMemory(list, {
    text: '阿风不考研了，改考公',
    kind: 'event',
    weight: 5,
    supersedes: ['阿风在准备考研，目标是本校计算机']
  });
  assert.equal(r.retired.length, 1, '应下架一条');
  assert.equal(list.length, 2, '旧条目留档，不物理删除');
  assert.equal(list.filter((m) => m.status === 'superseded').length, 1);
  assert.equal(r.retired[0].supersededBy, r.item.id, '应记下被谁取代');
  assert.equal(activeList(list).length, 1);
  ok('supersedes 显式取代：旧条标 superseded 且留档');
}

// 5. supersedes 能认出模型只抄了一半的原文
{
  const list = [];
  upsertLongMemory(list, { text: '阿风在准备考研，目标是本校计算机', weight: 5 });
  const r = upsertLongMemory(list, { text: '阿风改考公了', supersedes: ['阿风在准备考研'] });
  assert.equal(r.retired.length, 1, '原文片段也要能匹配上');
  assert.equal(activeList(list).length, 1);
  ok('supersedes 支持原文片段匹配');
}

// 6. 下架的条目不再出现在检索和注入块里
{
  const list = [];
  upsertLongMemory(list, { text: '旧的那条记忆', weight: 3 });
  upsertLongMemory(list, { text: '新的那条记忆', weight: 4, supersedes: ['旧的那条记忆'] });
  const picked = selectLongMemories(list, '记忆', 10, 1200);
  assert.ok(picked.every((m) => m.status === 'active'), '检索结果只能有 active');
  const block = formatLongMemoryBlock(list);
  assert.ok(block.includes('新的那条记忆'));
  assert.ok(!block.includes('旧的那条记忆'), 'superseded 不能进注入块');
  assert.ok(block.startsWith('【长期记忆'));
  assert.equal(formatLongMemoryBlock([]), '');
  ok('检索与注入块都排除 superseded 条目');
}

// 7. BM25 的 IDF：稀有词命中应排在常见词前面
{
  const list = [];
  const now = Date.now();
  upsertLongMemory(list, { text: '阿风养了只猫叫团子', weight: 3 }, { now });
  upsertLongMemory(list, { text: '阿风家的猫会自己开门', weight: 3 }, { now });
  upsertLongMemory(list, { text: '阿风还养了只柯基叫土豆', weight: 3 }, { now });
  const hit = selectLongMemories(list, '柯基', 3, 1200, now);
  assert.equal(hit[0].text, '阿风还养了只柯基叫土豆', '只出现一次的稀有词权重更高');
  ok('BM25：稀有词 IDF 让命中项排在前面');
}

// 8. 重复写入不该长出新条目
{
  const list = [];
  upsertLongMemory(list, { text: '阿风在准备考公', weight: 3 });
  const again = upsertLongMemory(list, { text: '阿风在准备考公', weight: 3 });
  assert.equal(again.action, 'updated');
  assert.equal(list.length, 1, '完全重复的文本不再建一条');
  ok('完全重复写入不新增条目');
}

// 9. 补充型信息合并到更长的那条
{
  const list = [];
  upsertLongMemory(list, { text: '阿风在准备考研', weight: 3 });
  const r = upsertLongMemory(list, { text: '阿风在准备考研，目标是本校计算机', weight: 4 });
  assert.equal(r.action, 'updated');
  assert.equal(list.length, 1);
  assert.equal(list[0].text, '阿风在准备考研，目标是本校计算机', '留存信息更多的那条');
  assert.equal(list[0].weight, 4, 'weight 取高');
  ok('同一件事的补充信息合并，保留更长文本');
}

// 10. 敏感内容拦截，正常记账不误杀
{
  assert.equal(upsertLongMemory([], { text: '他的密码是 abc123456' }).reason, 'sensitive');
  assert.equal(upsertLongMemory([], { text: '他手机号 13812345678' }).reason, 'sensitive');
  assert.equal(upsertLongMemory([], { text: '身份证 110101199001011234' }).reason, 'sensitive');
  assert.equal(upsertLongMemory([], { text: 'key 是 sk-abcdefghijklmnopqrstuvwx' }).reason, 'sensitive');
  assert.ok(looksSensitive('卡号 6222021234567890123'), '长卡号应命中');
  assert.ok(upsertLongMemory([], { text: '他买了张 4090 显卡，花了 5000 块' }).ok, '正常消费记录不该拦');
  assert.ok(upsertLongMemory([], { text: '他密码忘了，昨天还在问怎么找回' }).ok, '聊到“密码忘了”不该拦');
  assert.ok(upsertLongMemory([], { text: '阿风在用 Node 22 写脚本' }).ok);
  ok('敏感信息拦截：凭证/卡号/手机号/身份证；正常聊天不误杀');
}

// 11. 容量淘汰：先清已下架的，再按权重 / 新近度
{
  const list = [];
  for (let i = 0; i < 6; i += 1) upsertLongMemory(list, { text: `记忆条目编号 ${i} 号内容`, weight: 3 }, { maxEntries: 20 });
  upsertLongMemory(list, { text: '要被取代的旧条目', weight: 5 }, { maxEntries: 20 });
  assert.equal(list.length, 7);
  upsertLongMemory(list, { text: '最新的一条关键条目', weight: 5, supersedes: ['要被取代的旧条目'] }, { maxEntries: 4 });
  assert.equal(list.length, 4, `应压到容量上限（实际 ${list.length}）`);
  assert.ok(!list.some((m) => m.text === '要被取代的旧条目'), '已下架的条目最先被清掉');
  assert.ok(list.some((m) => m.text === '最新的一条关键条目'), '刚写入的条目要保住');
  ok('容量淘汰：先清 superseded，再按权重与新近度');
}

// 12. 注入预算按字符截断
{
  const list = [];
  for (let i = 0; i < 10; i += 1) upsertLongMemory(list, { text: `第${i}条记忆讲的是阿风的事情，内容比较长一些`, weight: 5 });
  const picked = selectLongMemories(list, '阿风', 10, 120);
  assert.ok(picked.length >= 1 && picked.length < 10, `应按字符预算截断（实际 ${picked.length} 条）`);
  ok('注入预算：injectMaxChars 截断生效');
}

// 13. 空查询退化为按权重排序
{
  const list = [];
  upsertLongMemory(list, { text: '低权重的琐碎小事', weight: 1 });
  upsertLongMemory(list, { text: '高权重的关键事件', weight: 5 });
  const out = selectLongMemories(list, '', 2, 1200);
  assert.equal(out[0].text, '高权重的关键事件');
  ok('空查询：退化为按重要性排序');
}

// 14. 被注入过的条目要更新 hits / lastUsedAt（v1 里 lastUsedAt 永远等于 createdAt）
{
  const list = [];
  const t0 = 1_700_000_000_000;
  const a = upsertLongMemory(list, { text: '阿风的猫叫团子', weight: 3 }, { now: t0 });
  assert.equal(a.item.hits, 0);
  const t1 = t0 + 86_400_000;
  // 查询要能切出词（中文至少两个字）；单字查询切不出 bigram，不算沾边。
  selectLongMemories(list, '团子', 3, 1200, t1);
  assert.equal(a.item.hits, 1, '被注入且沾边时应记一次命中');
  assert.equal(a.item.lastUsedAt, t1, 'lastUsedAt 要跟着更新');
  ok('命中计数：注入后 hits / lastUsedAt 更新，新近度才准');
}

// 15. 索引缓存必须在内容变更后失效
{
  const list = [];
  upsertLongMemory(list, { text: '最初写的是咖啡', weight: 3 });
  assert.equal(selectLongMemories(list, '咖啡', 1, 1200).length, 1);
  upsertLongMemory(list, { text: '改成写的是茶', weight: 3, supersedes: ['最初写的是咖啡'] });
  const after = selectLongMemories(list, '咖啡', 5, 1200);
  assert.ok(!after.some((m) => m.text === '最初写的是咖啡'), '缓存不失效就会把已下架的条目捞回来');
  assert.ok(after.some((m) => m.text === '改成写的是茶'));
  ok('索引缓存：内容变更后自动失效');
}

// 16. v1 旧数据迁移（没有 status 字段）
{
  const store = normalizeStore({
    buckets: { 'group:123': [{ id: 'a', kind: 'fact', text: 'v1 时代的旧条目', weight: 2, createdAt: 1000 }] }
  });
  assert.equal(store.version, 2);
  const item = store.buckets['group:123'][0];
  assert.equal(item.status, 'active', 'v1 条目迁移后应视为 active');
  assert.equal(item.supersededBy, null);
  assert.equal(item.updatedAt, 1000, '迁移不该改动时间戳');
  assert.equal(activeList(store.buckets['group:123']).length, 1);
  ok('旧数据迁移：v1 条目补 status=active 后照常可用');
}

// 17. 落盘与读回
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-lm-'));
  const file = path.join(dir, 'long-memory.json');
  const store = normalizeStore(null);
  const bucket = bucketOf(store, 'group:1');
  upsertLongMemory(bucket, { text: '落盘检查条目', weight: 4, tags: ['检查'] });
  writeLongMemoryStore(file, store);
  const back = readLongMemoryStore(file);
  assert.equal(back.version, 2);
  assert.equal(back.buckets['group:1'][0].text, '落盘检查条目');
  assert.equal(back.buckets['group:1'][0].status, 'active');
  assert.deepEqual(back.buckets['group:1'][0].tags, ['检查']);
  assert.equal(Object.keys(readLongMemoryStore(path.join(dir, '不存在.json')).buckets).length, 0, '文件缺失应返回空库');
  fs.rmSync(dir, { recursive: true, force: true });
  ok('持久化：原子写、读回字段完整、文件缺失不抛错');
}

// 18. 删除：id / 原文 / 找不到返回 null
{
  const list = [];
  const a = upsertLongMemory(list, { text: '要删的条目甲', weight: 3 });
  upsertLongMemory(list, { text: '要删的条目乙', weight: 3 });
  assert.equal(removeLongMemory(list, { id: a.item.id }).text, '要删的条目甲');
  assert.equal(removeLongMemory(list, { text: '要删的条目乙' }).text, '要删的条目乙');
  assert.equal(removeLongMemory(list, { text: '根本不存在的条目' }), null);
  assert.equal(list.length, 0);
  ok('removeLongMemory 支持 id / 原文，找不到返回 null');
}

// 19. 下架之后再写入同一件事，应能重新变成 active 的一条
{
  const list = [];
  upsertLongMemory(list, { text: '阿风住在城东', weight: 3 });
  upsertLongMemory(list, { text: '阿风搬到城西了', weight: 4, supersedes: ['阿风住在城东'] });
  assert.equal(activeList(list).length, 1);
  assert.equal(activeList(list)[0].text, '阿风搬到城西了');
  ok('取代链路：同一主题最终只留最新的 active 条目');
}

// 20. 共享桶：私聊与群里的记忆合成同一份，迁移只做一次且幂等
{
  const store = normalizeStore(null);
  const priv = bucketOf(store, 'private:111');
  const grp = bucketOf(store, 'group:222');
  upsertLongMemory(priv, { text: '阿风在准备考研', weight: 3 });
  upsertLongMemory(priv, { text: '阿风喜欢喝冰美式', weight: 2 });
  upsertLongMemory(grp, { text: '阿风在准备考研', weight: 5 }); // 同一件事，两个会话各记了一份
  upsertLongMemory(grp, { text: '群里那只猫叫布丁', weight: 2 });

  assert.equal(mergeIntoShared(store), true, '存在旧的分会话桶时应发生合并');
  assert.deepEqual(Object.keys(store.buckets), [SHARED_KEY], '合并后只剩共享桶');
  const shared = sharedBucketOf(store);
  assert.equal(shared.length, 3, '重复的那条只留一份');
  const exam = shared.find((m) => m.text === '阿风在准备考研');
  assert.equal(exam.weight, 5, '同一条记忆合并时取更高的权重');
  assert.equal(mergeIntoShared(store), false, '已合并过的库再合并应返回 false（幂等）');

  // 共享之后：任何会话 key 拿到的都是同一份，群和私聊不再"失忆"
  assert.equal(sharedBucketOf(store).length, 3);
  ok('共享桶：私聊与群记忆合并成一份，重复去重且幂等');
}

// 21. 合并不会让已下架的旧条目"复活"
{
  const store = normalizeStore(null);
  const priv = bucketOf(store, 'private:111');
  const grp = bucketOf(store, 'group:222');
  const old = upsertLongMemory(priv, { text: '阿风住在城东', weight: 3 });
  upsertLongMemory(priv, { text: '阿风搬到城西了', weight: 4, supersedes: ['阿风住在城东'] });
  // 群里的那份还留着旧的、仍是 active 的副本
  upsertLongMemory(grp, { text: '阿风住在城东', weight: 3 });
  mergeIntoShared(store);
  const shared = sharedBucketOf(store);
  const stale = shared.find((m) => m.text === '阿风住在城东');
  assert.equal(stale.status, 'superseded', '任一边已下架，合并后仍为下架');
  assert.equal(activeList(shared).length, 1);
  assert.equal(activeList(shared)[0].text, '阿风搬到城西了');
  assert.ok(old.item.id);
  ok('共享桶合并：已下架条目不会因合并复活');
}

// 22. 提炼输出解析（v2 修复的核心：解析失败必须和「没有值得记的」分开）
{
  // 干净数组
  const clean = parseLongMemoryJson('[{"kind":"fact","text":"阿风在准备考研","tags":["学业"],"weight":4}]');
  assert.equal(clean.ok, true);
  assert.equal(clean.items.length, 1);
  assert.equal(clean.items[0].kind, 'fact');
  assert.equal(clean.items[0].weight, 4);

  // ```json 代码块 + 前后解释：聊天人格最常吐的形态
  const fenced = parseLongMemoryJson('好的，我整理一下：\n```json\n[{"kind":"pref","text":"阿风讨厌下雨天","tags":["偏好"],"weight":3}]\n```\n还需要别的吗？');
  assert.equal(fenced.ok, true);
  assert.equal(fenced.items[0].text, '阿风讨厌下雨天');

  // 字段漂移：content / 中文 kind / 字符串 tags / 字符串 weight
  const drift = parseLongMemoryJson('[{"type":"事件","content":"阿风下周三面试","tags":"工作、面试","weight":"5"}]');
  assert.equal(drift.ok, true);
  assert.equal(drift.items[0].kind, 'event');
  assert.equal(drift.items[0].text, '阿风下周三面试');
  assert.deepEqual(drift.items[0].tags, ['工作', '面试']);
  assert.equal(drift.items[0].weight, 5);

  // 明确空数组 = 真的没有 → 可以消费窗口
  const empty = parseLongMemoryJson('[]');
  assert.equal(empty.ok, true);
  assert.equal(empty.items.length, 0);

  // 跑偏成自然语言 = 解析失败 → 绝不能消费窗口
  const prose = parseLongMemoryJson('我看了一下，这段聊天没什么值得记的。');
  assert.equal(prose.ok, false);
  assert.equal(prose.items.length, 0);

  // 单个对象（没套数组）= 模型只抽到一条时的常态。
  // 早先判「格式不对」→ ok:false → 窗口永不消费 → 同一批原料无限重试。
  // 能认出内容就该收下：格式洁癖不能变成死循环。
  const single = parseLongMemoryJson('{"kind":"fact","text":"阿风养猫"}');
  assert.equal(single.ok, true);
  assert.equal(single.items.length, 1);
  assert.equal(single.items[0].text, '阿风养猫');

  // 包装形态 {"items":[...]}
  const wrapped = parseLongMemoryJson('{"items":[{"text":"阿风搬家了"}]}');
  assert.equal(wrapped.ok, true);
  assert.equal(wrapped.items[0].text, '阿风搬家了');

  // 有括号但认不出任何一条（报错对象）→ 仍然算失败，不能当「无新增」
  assert.equal(parseLongMemoryJson('{"error":"upstream timeout"}').ok, false);

  // 正文里混了示例数组，但真正的那条在后面
  const mixed = parseLongMemoryJson('示例格式：[{"x":1}]\n实际结果：[{"kind":"promise","text":"周六一起看电影","supersedes":"上次的约定"}]');
  assert.equal(mixed.ok, true);
  assert.equal(mixed.items[0].text, '周六一起看电影');
  assert.deepEqual(mixed.items[0].supersedes, ['上次的约定']);
  ok('提炼解析：兼容代码块/字段漂移，且能区分「解析失败」与「明确为空」');
}

// 23. 注入块带日期（否则模型分不清「上周」和「上个月」）
{
  const now = new Date('2026-10-27T12:00:00+08:00').getTime();
  const list = [];
  upsertLongMemory(list, { text: '阿风在准备考研', tags: ['学业'] }, { now: new Date('2026-10-20T12:00:00+08:00').getTime() });
  const block = formatLongMemoryBlock(list, now);
  assert.ok(block.includes('10-20'), `注入块应带日期，实际：${block}`);
  assert.ok(block.includes('阿风在准备考研'));
  ok('注入块：每条记忆带 MM-DD 日期');
}

// 24. 衰减：常被想起的保持鲜活，久不提起的按类型淡出
{
  const day = 86400000;
  const now = new Date('2026-10-27T12:00:00+08:00').getTime();
  const event3 = { kind: 'event', weight: 3, lastUsedAt: now - 14 * day };
  const event3Old = { kind: 'event', weight: 3, lastUsedAt: now - 40 * day };
  const fact5 = { kind: 'fact', weight: 5, lastUsedAt: now - 365 * day };
  assert.ok(Math.abs(memoryStrength(event3, now) - 1.5) < 0.01, '3 分的 event 半衰期 14 天后应为 1.5');
  assert.ok(memoryStrength(event3Old, now) < 0.6, '3 分的 event 40 天后应跌破归档线');
  assert.ok(memoryStrength(fact5, now) > 2, '重要事实一年后仍然鲜活');
  assert.ok(
    memoryStrength({ kind: 'event', weight: 3, lastUsedAt: now }, now) > memoryStrength(event3, now),
    '最近被想起的强度更高'
  );
  ok('衰减：按类型半衰期，被想起的刷新，不常提的淡出');
}

// 25. 整理：过期归档、重复合并，但都不删数据
{
  const day = 86400000;
  const now = new Date('2026-10-27T12:00:00+08:00').getTime();
  // 直接构造条目，绕开 upsert 的写入期去重 —— 这里要验证的是「整理」而不是「写入」
  const mk = (id, kind, text, weight, ageDays) => ({
    id,
    kind,
    text,
    tags: [],
    weight,
    status: 'active',
    supersededBy: null,
    createdAt: now - ageDays * day,
    lastUsedAt: now - ageDays * day,
    updatedAt: now - ageDays * day,
    hits: 0
  });
  const list = [
    mk('a', 'event', '阿风上周三要去交实验报告', 3, 45),
    mk('b', 'fact', '阿风在准备考研，目标是本校计算机', 4, 45),
    mk('c', 'fact', '阿风养了只柯基叫土豆', 3, 0),
    mk('d', 'fact', '阿风养了只柯基叫土豆豆', 4, 0),
    mk('e', 'pref', '阿风养了只柯基叫土豆豆', 2, 0)
  ];
  const r = organizeLongMemories(list, { now });
  assert.equal(r.archived, 1, '只有过期的那条事件被归档');
  assert.equal(r.merged, 1, '同类别、几乎同文的两条合并成一条');
  assert.equal(list.length, 5, '归档与合并都不物理删除，历史留档');
  assert.equal(list.filter((m) => m.status === 'archived').length, 1);
  assert.equal(list.filter((m) => m.status === 'superseded').length, 1);
  const kept = activeList(list).find((m) => m.id === 'c' || m.id === 'd');
  assert.equal(kept.kind, 'fact', '不同类别的不合并');
  assert.ok(activeList(list).some((m) => m.id === 'e'), 'pref 那条说法相近但不是同一类别，应保留');
  assert.ok(activeList(list).some((m) => m.text.includes('考研')), '长期有效的事实不该被淡出');
  assert.equal(activeList(list).length, 3);
  ok('整理：过期归档 + 重复合并，只改状态不删数据');
}

// 26. 归档必须能扛过一次读写：早先 STATUS 里漏了 archived，
// 写盘再读回时被 normalizeStore 归一成 active，整理等于白做。
{
  const day = 86400000;
  const now = new Date('2026-10-27T12:00:00+08:00').getTime();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-lm-archive-'));
  const file = path.join(dir, 'long-memory.json');
  const store = normalizeStore(null);
  const list = sharedBucketOf(store);
  upsertLongMemory(list, { text: '阿风上周要去交实验报告', kind: 'event', weight: 3 }, { now: now - 60 * day });
  upsertLongMemory(list, { text: '阿风在准备考研', kind: 'fact', weight: 5 }, { now: now - 60 * day });
  for (const m of list) m.lastUsedAt = m.createdAt;
  const r = organizeLongMemories(list, { now });
  assert.equal(r.archived, 1, '60 天前的事件应被归档');
  writeLongMemoryStore(file, store);
  const back = readLongMemoryStore(file);
  const restored = back.buckets[SHARED_KEY];
  assert.equal(restored.find((m) => m.text.includes('实验报告')).status, 'archived', '读回后仍是归档');
  assert.ok(restored.find((m) => m.text.includes('实验报告')).archivedAt > 0, '归档时间要保留');
  assert.equal(activeList(restored).length, 1, '归档条目不应重新算作生效');
  assert.equal(restored.find((m) => m.text.includes('考研')).status, 'active', '长期事实不受影响');
  fs.rmSync(dir, { recursive: true, force: true });
  ok('归档持久化：写过盘再读回，仍然淡出且保留归档时间');
}

// 27. 注入只刷新真正沾边的条目。
// 记忆条数少于注入上限时，如果把整批被注入的条目都记成「刚被想起」，
// 那么衰减永远不会生效 —— 这是淡忘机制最容易失效的死角。
{
  const day = 86400000;
  const now = new Date('2026-10-27T12:00:00+08:00').getTime();
  const list = [];
  upsertLongMemory(list, { text: '阿风在准备考研，目标是本校计算机', kind: 'fact', weight: 5 }, { now: now - 30 * day });
  upsertLongMemory(list, { text: '阿风讨厌下雨天，出门必带伞', kind: 'pref', weight: 3 }, { now: now - 30 * day });
  for (const m of list) { m.lastUsedAt = m.createdAt; m.hits = 0; }

  const picked = selectLongMemories(list, '考研准备得怎么样', 12, 1200, now, true);
  assert.equal(picked.length, 2, '上限大于条数时两条都会被注入');
  const kaoyan = list.find((m) => m.text.includes('考研'));
  const rain = list.find((m) => m.text.includes('下雨'));
  assert.equal(kaoyan.hits, 1, '相关条目命中 +1');
  assert.equal(kaoyan.lastUsedAt, now, '相关条目新近度刷新');
  assert.equal(rain.hits || 0, 0, '无关条目不该被误记命中');
  assert.equal(rain.lastUsedAt, now - 30 * day, '无关条目的新近度不能被顺手刷掉');
  ok('注入计分：只有沾边的条目才算被想起，无关条目不刷新新近度');
}

// 28. dueAt 归一化：对象 / 字符串日期 / 时间戳 / 相对时间四种形态
{
  const obj = normalizeDueAt({ when: '这周六', date: '2026-11-01' });
  assert.equal(obj.when, '这周六');
  assert.equal(obj.date, '2026-11-01');
  assert.ok(obj.ts > 0, '对象形态应解析出时间戳');

  const str = normalizeDueAt('2026-11-01');
  assert.ok(str.ts > 0, '字符串日期应解析出时间戳');
  assert.equal(str.when, '2026-11-01');

  const rel = normalizeDueAt('下个月');
  assert.equal(rel.ts, null, '纯相对时间无日期，ts 应为 null');
  assert.equal(rel.when, '下个月', '相对时间原文要保留');

  const num = normalizeDueAt(1761955200);
  assert.equal(num.ts, 1761955200000, '秒级时间戳补到毫秒');

  assert.equal(normalizeDueAt(null), null, '空值返回 null');
  assert.equal(normalizeDueAt(''), null);
  ok('dueAt 归一化：对象/日期/时间戳/相对时间都归成统一结构');
}

// 29. 提炼输出能解析 dueAt，且拿不准时留 null
{
  const parsed = parseLongMemoryJson(
    '[{"kind":"promise","text":"阿风下周交作业","dueAt":{"when":"下周","date":"2026-11-03"}}]'
  );
  assert.equal(parsed.ok, true);
  assert.ok(parsed.items[0].dueAt.ts > 0, '对象形态 dueAt 应解析出时间戳');

  const noDue = parseLongMemoryJson('[{"kind":"fact","text":"阿风在准备考研"}]');
  assert.equal(noDue.items[0].dueAt, null, '没给 dueAt 就保持 null');
  ok('提炼解析：dueAt 正确解析，缺省保持 null');
}

// 30. 主动提醒：到期被挑出、提醒后结案、未到期不打扰
{
  const day = 86400000;
  const now = new Date('2026-10-27T12:00:00+08:00').getTime();
  const list = [];
  upsertLongMemory(list, {
    kind: 'promise', text: '阿风周六请喝奶茶',
    dueAt: { when: '周六', date: '2026-10-25' }
  }, { now });
  upsertLongMemory(list, {
    kind: 'promise', text: '阿风下个月还钱',
    dueAt: { when: '下个月', date: '2026-11-20' }
  }, { now });

  const due = selectDueMemories(list, now);
  assert.equal(due.length, 1, '只有到期的那条被挑出');
  assert.equal(due[0].text, '阿风周六请喝奶茶');

  markDueReminded(due[0], now);
  assert.equal(selectDueMemories(list, now).length, 0, '提醒后结案，不再重复');
  assert.equal(due[0].remindedAt, now, 'remindedAt 要记上');

  // 更新 dueAt（改了约定时间）应清空 remindedAt，允许再次提醒
  upsertLongMemory(list, { text: '阿风周六请喝奶茶', dueAt: { when: '周六', date: '2026-11-01' } }, { now });
  const again = list.find((m) => m.text.includes('奶茶'));
  assert.equal(again.remindedAt, null, 'dueAt 变更后重置提醒状态');
  ok('主动提醒：到期挑出、结案不重复、改期可再提醒');
}

// 31. 未到期条目豁免衰减归档
{
  const day = 86400000;
  const now = new Date('2026-10-27T12:00:00+08:00').getTime();
  const list = [];
  // 一条很久没被想起、本应被归档的约定，但它的 dueAt 在未来 → 豁免
  upsertLongMemory(list, {
    kind: 'promise', text: '阿风年底要一起去旅行',
    dueAt: { when: '年底', date: '2026-12-31' }
  }, { now: now - 90 * day });
  const m = list[0];
  m.lastUsedAt = m.createdAt; // 模拟 90 天没被想起，promise 半衰期 30 天早就该淡出

  const r = organizeLongMemories(list, { now });
  assert.equal(r.archived, 0, '未到期的约定不该被衰减归档');
  assert.equal(activeList(list).length, 1);
  ok('衰减豁免：dueAt 未到期的约定不被归档');
}

// 32. 归档护栏：单次整理最多归档 N 条，防止一次性沉太多导致「失忆」
{
  const day = 86400000;
  const now = new Date('2026-10-27T12:00:00+08:00').getTime();
  const list = [];
  for (let i = 0; i < 10; i += 1) {
    upsertLongMemory(list, { kind: 'event', text: `陈年事件${i}`, weight: 3 }, { now: now - 60 * day });
  }
  for (const m of list) m.lastUsedAt = m.createdAt; // 都 60 天没被想起

  // 不设上限：一次性全沉
  const noCap = organizeLongMemories(list.map((x) => ({ ...x })), { now, maxArchivePerRun: 0 });
  assert.equal(noCap.archived, 10, 'maxArchivePerRun=0 表示不设上限，全部归档');
  assert.equal(noCap.deferred, 0);

  // 设上限 3：只沉最弱的 3 条，其余挡下
  const capped = organizeLongMemories(list, { now, maxArchivePerRun: 3 });
  assert.equal(capped.archived, 3, '单次最多归档 3 条');
  assert.equal(capped.deferred, 7, '其余 7 条被护栏挡下，留到下次');
  assert.equal(capped.after, 7, '剩余 7 条仍是 active');
  ok('归档护栏：单次最多归档 N 条，被挡下的留待下次');
}

// 33. 归档过的同一条又被提起：复活原条目，而不是新建一条重复的
// （以前的行为：库里 1 条变 2 条，「说→淡忘→再说→再淡忘」无限堆同文本，
//   而 doctor 只扫 active，永远报不出来）
{
  const day = 86400000;
  const now = new Date('2026-10-27T12:00:00+08:00').getTime();
  const list = [];
  upsertLongMemory(list, { kind: 'event', text: '阿风这周三要交实验报告', weight: 3 }, { now: now - 60 * day });
  organizeLongMemories(list, { now, archiveBelow: 0.6 });
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'archived', '先确认它真的被归档了');

  const r = upsertLongMemory(list, { kind: 'event', text: '阿风这周三要交实验报告', weight: 3 }, { now });
  assert.equal(r.action, 'revived', '同一条再被提起应当复活，而不是新建');
  assert.equal(list.length, 1, '不该长出第二条');
  assert.equal(list[0].status, 'active');
  assert.equal(list[0].archivedAt, null, '归档时间要清掉');
  assert.equal(list[0].revivedAt, now, '但要留下「什么时候回来过」的痕迹');
  ok('归档复活：再被提起时复活原条目，不堆重复');
}

// 34. 注入块要带约定时间点（dueAt）
// 只带 createdAt 的话，注入出来是「说好周六看电影 · 10-27」——周六是哪天、
// 约没约成，模型一概不知道，dueAt 抽了也白抽。
{
  const now = new Date('2026-10-27T12:00:00+08:00').getTime();
  const list = [];
  upsertLongMemory(list, {
    kind: 'promise',
    text: '说好周六一起看电影《流浪地球3》',
    dueAt: { when: '这周六', date: '2026-10-31' },
    weight: 4
  }, { now });
  const block = formatLongMemoryBlock(list, now);
  assert.ok(block.includes('约在'), `注入块应标出约定时间，实际：${block}`);
  assert.ok(block.includes('10-31'), '应带上绝对日期');
  assert.ok(block.includes('这周六'), '相对说法也该保留，回复时更好用');
  ok('注入块：带 dueAt（相对说法 + 绝对日期）');
}

// 35. 结案：约定兑现后标 resolved，从到期列表消失，但还能被检索到
// 「结案即消失」是另一套记忆方案被诟病的坑——聊到旧事时她又失忆了。
{
  const day = 86400000;
  const now = new Date('2026-10-27T12:00:00+08:00').getTime();
  const list = [];
  upsertLongMemory(list, {
    kind: 'promise',
    text: '说好周六一起看电影《流浪地球3》',
    dueAt: { when: '这周六', date: '2026-10-25' },
    weight: 4
  }, { now: now - 3 * day });
  assert.equal(selectDueMemories(list, now).length, 1, '到期时应被挑出来');

  const target = resolveLongMemory(list, { text: '说好周六一起看电影', note: '看完了' , now});
  assert.ok(target, '应能按原文片段找到并结案');
  assert.equal(target.status, 'resolved');
  assert.equal(target.resolvedAt, now);
  assert.equal(target.resolveNote, '看完了');
  assert.equal(selectDueMemories(list, now).length, 0, '结案后不该再被当待办追问');
  assert.equal(activeList(list).length, 0, '不再算生效条目');

  const picked = selectLongMemories(list, '周末看电影吗', 5, 1200, now, false);
  assert.equal(picked.length, 1, '结案的事仍要能被检索到');
  const block = formatLongMemoryBlock(picked, now);
  assert.ok(block.includes('已完成'), `注入块要标出已完成，实际：${block}`);
  assert.ok(block.includes('看完了'), '结果备注要带上');
  ok('结案：退出到期提醒，但仍可检索且标注已完成');
}

// 36. 提炼输出里的 resolves 也能直接结案（不用手工 done）
{
  const now = new Date('2026-10-27T12:00:00+08:00').getTime();
  const list = [];
  upsertLongMemory(list, { kind: 'promise', text: '阿风下周面试', weight: 4, dueAt: '2026-10-26' }, { now });
  const parsed = parseLongMemoryJson(
    '[{"kind":"fact","text":"阿风的面试过了","resolves":["阿风下周面试"],"result":"过了"}]'
  );
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.items[0].resolves, ['阿风下周面试']);
  const r = upsertLongMemory(list, parsed.items[0], { now });
  assert.equal(r.resolved.length, 1, '旧约定应被结案');
  assert.equal(list[0].status, 'resolved');
  assert.equal(activeList(list).length, 1, '新事实仍是生效的');
  assert.equal(activeList(list)[0].text, '阿风的面试过了');
  ok('提炼 resolves：从聊天里自动结案旧约定');
}

// 37. 已完成之后再来一遍整理，不该被衰减归档
// 结案是「有结果」，不是「不重要」——归档掉等于又把结案记录弄丢了。
{
  const day = 86400000;
  const now = new Date('2026-10-27T12:00:00+08:00').getTime();
  const list = [];
  const r = upsertLongMemory(list, { kind: 'event', text: '阿风的面试过了', weight: 3 }, { now: now - 200 * day });
  resolveLongMemory(list, { id: r.item.id, now: now - 200 * day });
  organizeLongMemories(list, { now, archiveBelow: 0.6 });
  assert.equal(list[0].status, 'resolved', '已完成不该被衰减归档');
  ok('结案豁免衰减：已完成的事不会被归档掉');
}

// 38. 不存在的日期不能被顺延成另一天
// JS 的 Date 会把 2 月 31 日滚成 3 月 3 日 —— 那样一条约定会在错的日期提醒。
{
  assert.equal(normalizeDueAt('2026-02-31').ts, null, '2 月 31 日应判为解析不出');
  assert.notEqual(normalizeDueAt('2026-02-28').ts, null, '正常的日期仍要能解析');
  assert.equal(normalizeDueAt('2026-13-01').ts, null);
  ok('日期校验：不存在的日子不顺延，留给 when 文案兜底');
}

// 39. 容量淘汰优先级：已下架 → 已完成 → 生效
{
  const list = [];
  const a = upsertLongMemory(list, { kind: 'event', text: '已完成的历史条目', weight: 5 }, { maxEntries: 20 });
  resolveLongMemory(list, { id: a.item.id });
  upsertLongMemory(list, { kind: 'fact', text: '一条长期有效的事实', weight: 5 }, { maxEntries: 20 });
  upsertLongMemory(list, { kind: 'fact', text: '另一条长期有效的事实', weight: 5 }, { maxEntries: 20 });
  upsertLongMemory(list, { kind: 'fact', text: '压容量用的新条目', weight: 5 }, { maxEntries: 2 });
  assert.equal(list.length, 2);
  assert.ok(!list.some((m) => m.text === '已完成的历史条目'), '容量吃紧时先清已完成，再动生效条目');
  assert.equal(activeList(list).length, 2);
  ok('容量淘汰：已完成排在生效之前，但晚于已下架');
}

// 40. 已结案的同一条再被复述：就地刷新，不新建重复，也不把结案状态改回去
{
  const list = [];
  const a = upsertLongMemory(list, { kind: 'fact', text: '阿风面试过了', weight: 3 });
  resolveLongMemory(list, { id: a.item.id, note: '过了' });
  const again = upsertLongMemory(list, { kind: 'fact', text: '阿风面试过了', weight: 4 });
  assert.equal(list.length, 1, '不该新建重复条目');
  assert.equal(again.item.status, 'resolved', '结案是事实，复述一遍不能当它没发生');
  assert.equal(again.item.weight, 4, '权重仍取高');
  assert.equal(again.item.resolveNote, '过了', '结果备注不能被冲掉');
  ok('已结案条目：复述时就地刷新，不重复、不回退');
}

// 41. 轮换：库比注入上限大时，排在后半段的冷门条目也要轮到
//
// 守的是一个不容易被发现的死角：查询为空时分数只剩「权重 + 新近度」，排序长期稳定。
// 库里 28 条、预算只放得下 9 条时，后面 19 条**永远**进不了上下文 ——
// 它们没被归档，只是每次都在队尾，等于不存在。用户会觉得「我明明记过这事」。
{
  const list = [];
  for (let i = 0; i < 30; i += 1) {
    upsertLongMemory(list, { kind: 'fact', text: `第 ${i} 条用来占位的记忆内容`, weight: 3 }, { maxEntries: 100 });
  }
  const HOUR = 3600000;
  const base = Date.UTC(2026, 9, 28, 12, 0, 0);
  const seen = new Set();
  for (let h = 0; h < 20; h += 1) {
    for (const m of selectLongMemories(list, '', 12, 1200, base + h * HOUR, false, { rotateSlots: 2 })) {
      seen.add(m.id);
    }
  }
  assert.equal(seen.size, list.length, '轮换开着时，足够多的窗口内每一条都该轮到过一次');

  // 关掉轮换（rotateSlots=0）必须与从前完全一致：一条冷门都进不来。
  const fixed = new Set();
  for (let h = 0; h < 20; h += 1) {
    for (const m of selectLongMemories(list, '', 12, 1200, base + h * HOUR, false, { rotateSlots: 0 })) {
      fixed.add(m.id);
    }
  }
  assert.ok(fixed.size < list.length, 'rotateSlots=0 时不轮换，行为与从前一致');

  // 库比上限还小的时候，轮换名额必须自动失效 —— 不能因为「留了名额」而少注入。
  const few = list.slice(0, 3);
  const all = selectLongMemories(few, '', 12, 1200, base, false, { rotateSlots: 2 });
  assert.equal(all.length, 3, '库比上限小时，轮换不该挤掉任何条目');
  ok('轮换：库比上限大时冷门条目也能轮到，库小时名额自动失效');
}

console.log(`\n全部通过：${passed} 项`);
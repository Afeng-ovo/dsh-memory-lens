# 接进你自己的机器人

这套模块不认识 QQ、DSH、Telegram 或任何框架。它只要求你提供两样东西：**一段聊天文本**，以及**一个能调用的模型**。

下面按接入顺序给五个点。每段都是可以抄的。

## 接入点 1 · 初始化

```js
import { readLongMemoryStore, writeLongMemoryStore, mergeIntoShared, sharedBucketOf } from '../../lib/core/long-memory.js';

const MEMORY_FILE = './state/long-memory.json';
let store = readLongMemoryStore(MEMORY_FILE);

// 老版本按会话分桶，加载时一次性合并进共享桶
if (mergeIntoShared(store)) writeLongMemoryStore(MEMORY_FILE, store);

const memories = sharedBucketOf(store);   // 之后所有读写都走这个数组

function save() {
  writeLongMemoryStore(MEMORY_FILE, store);
}
```

放在进程启动时，只做一次。`readLongMemoryStore` 在文件不存在或损坏时返回空库，不会抛错——所以第一次运行不需要手动建文件。

**建议加一行启动日志**，让每次重启都能一眼确认记忆系统的状态：

```js
import { activeList } from '../../lib/core/long-memory.js';
console.log(`记忆库：${activeList(memories).length} 条生效 | 整理每 24h`);
```

## 接入点 2 · 收集待提炼的消息

每条用户消息进来时，追加到窗口：

```js
const windows = new Map();   // conversationKey -> [{sender, text, isOwner, at}]

function noteMessage(key, { sender, text, isOwner }) {
  const win = windows.get(key) ?? [];
  win.push({ sender, text, isOwner: Boolean(isOwner), at: Date.now() });
  windows.set(key, win);
}
```

有三件事必须做对，否则提炼质量会很差：

**① 只收真人的话**。机器人自己说的话不要进窗口。模型看到自己说的「好的我记住啦」，会把客套话提炼成记忆。

**② 用自己的消息优先**。群聊里有十几个人说话，全都提炼会让记忆变成「群友大全」。建议给主人说的话打 `isOwner: true`，在提示词里体现（模板已经带了 `【管理员】` 前缀）。

**③ 窗口要能跨会话累积**。别在会话重置时清空窗口——原料是聊天内容，不是会话状态。

## 接入点 3 · 触发提炼

```js
import { activeList, buildLongMemoryPrompt, parseLongMemoryJson, upsertLongMemory } from '../../lib/core/long-memory.js';

const MIN_MESSAGES = 20;        // 攒够 20 条才提炼
const COOLDOWN_MS = 10 * 60_000; // 两次提炼至少隔 10 分钟
let lastRunAt = 0;
let chain = Promise.resolve();   // 串行链，防止并发提炼

function maybeExtract(key) {
  if (Date.now() - lastRunAt < COOLDOWN_MS) return;
  const win = windows.get(key) ?? [];
  if (win.length < MIN_MESSAGES) return;

  const batch = win.slice(0, MIN_MESSAGES);
  lastRunAt = Date.now();
  chain = chain
    .then(() => extract(key, batch))
    .catch((error) => console.error('提炼失败', error));
}

async function extract(key, batch) {
  const prompt = buildLongMemoryPrompt(batch, activeList(memories));

  // ↓ 换成你自己的模型调用：拿一段文本，返回一段文本
  const raw = await callModel(prompt);

  const parsed = parseLongMemoryJson(raw);
  if (!parsed.ok) {
    // 关键：解析失败时不消费窗口，这批原料留到下一轮
    console.warn(`提炼解析失败（${key}），原料保留`);
    return;
  }

  // 解析成功（包括模型明确返回 []）才消费
  windows.set(key, (windows.get(key) ?? []).slice(batch.length));

  if (!parsed.items.length) return;

  let added = 0;
  for (const item of parsed.items) {
    const r = upsertLongMemory(memories, item, { maxEntries: 1000 });
    if (r.ok) added += 1;
  }
  if (added) save();
  console.log(`提炼完成：新增 ${added}，生效 ${activeList(memories).length} 条`);
}
```

### 提炼会话的四条配置

这四条不是可选项，是踩过坑的结论：

| 配置 | 值 | 为什么 |
|---|---|---|
| preset | 无人物设定的（如 `minimal`） | 用聊天人格会「忍不住」用角色口吻回一句，把 JSON 淹掉 |
| 模型 | 便宜的、稳定的 | 这是后台任务，不需要贵模型；但**不能跟随聊天用的模型源** |
| 超时 | 180 秒 | 默认 120 秒在低配模型上经常不够 |
| 重试 | 1~2 次，带退避 | 失败后**不要重建会话**——重建会撞上 provider 对新会话的故障 |

提示词第一句是 `【任务指令优先】…不是角色扮演`，就是为这件事准备的。如果模型还是不肯输出 JSON，把 `buildLongMemoryPrompt` 里的规则 4 改成更强的措辞，或者换模型。

### 一个最小的模型适配层

```js
async function callModel(prompt) {
  const res = await fetch('https://你的网关/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.API_KEY}` },
    body: JSON.stringify({
      model: '某个便宜模型',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2   // 抽取任务，越低越稳
    })
  });
  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? '';
}
```

`temperature` 建议 0.2~0.3。太高会让模型自由发挥，太低（0）有时会让某些模型陷入重复。

## 接入点 4 · 注入

每轮对话开始前，取记忆、拼进 prompt：

```js
import { selectLongMemories, formatLongMemoryBlock, activeList } from '../../lib/core/long-memory.js';

function memoryBlock(userMessage, now = Date.now()) {
  const picked = selectLongMemories(
    memories,
    userMessage,   // 用当前这条消息做查询
    12,            // 最多 12 条
    1200,          // 最多 1200 字
    now,
    true           // 记录命中（hits / lastUsedAt）
  );
  return picked.length ? formatLongMemoryBlock(picked, now) : '';
}
```

### 注入位置

**放在 system prompt 的末尾**，紧挨着对话历史。原因：模型对靠后的内容注意力更强，而记忆是「此刻要用的资料」，不是「角色设定」。

```js
const system = [
  rolePrompt,                              // 人设
  socialContext,                           // 当前群/对象
  memoryBlock(userMessage)                 // ← 记忆放最后
].filter(Boolean).join('\n\n');
```

### 注入后记得落盘

`selectLongMemories` 的 `touch=true` 会修改内存里的 `hits` 和 `lastUsedAt`，但**不会写文件**。落盘时机有两个选择：

- 每条消息后都写：数据最新，但 IO 频繁（一个 JSON 文件几百 KB，可以接受）
- 攒着，等提炼或整理时一起写：IO 少，但进程被强杀会丢几次命中

生产里用的是后者——命中数据不重要到值得每条消息写盘。

### 什么时候不要注入

- 记忆为空时，`memoryBlock` 返回空字符串，不要拼一个空标题进去
- 纯粹的指令类消息（「/help」「/reset」）不需要注入，省 token
- 已经在长上下文里的会话，重复注入反而会让模型困惑——如果换会话时已经注入了「交接回忆」，这一轮可以不注入事实卡

## 接入点 5 · 定时整理

```js
import { organizeLongMemories, activeList } from '../../lib/core/long-memory.js';

const ORGANIZE_INTERVAL = 24 * 3600_000;
let lastOrganizeAt = 0;

function maybeOrganize() {
  if (Date.now() - lastOrganizeAt < ORGANIZE_INTERVAL) return;
  lastOrganizeAt = Date.now();
  const r = organizeLongMemories(memories, {
    archiveBelow: 0.6,      // 强度低于这个值就淡出
    consolidate: true,      // 合并重复
    consolidateDice: 0.85
  });
  if (r.archived || r.merged) save();
  if (r.archived || r.merged) {
    console.log(`整理：归档 ${r.archived}，合并 ${r.merged}，生效 ${activeList(memories).length} 条`);
  }
}
```

调用时机：放在消息处理循环里（每条消息检查一次是否该整理），比 `setInterval` 可靠——进程休眠、重启都不会漏掉，只是延后。

`lastOrganizeAt` 建议持久化。否则每次重启都会整理一次，虽然幂等（归档过的不会重复归档），但会多写文件。

## 接入点 6 · 主动提醒

记忆系统「被问才答」的话，永远说不出「你上周说的面试，今天有结果了吗」。`dueAt` 让机器人能自己找话头。

提炼提示词已经会抽取带时间点的约定（规则 10），`parseLongMemoryJson` 也把 `dueAt` 归一好了。你只需要在收到消息时**顺手扫一遍到期项**：

```js
import { selectDueMemories, markDueReminded } from '../../lib/core/long-memory.js';

function maybeRemind() {
  const due = selectDueMemories(memories, Date.now());
  if (!due.length) return '';
  const lines = due.map((m) => {
    const when = m.dueAt.when || m.dueAt.date || new Date(m.dueAt.ts).toLocaleDateString();
    markDueReminded(m);   // 结案：提醒过就不再重复
    return `有件事之前约好了：${m.text}（${when}），现在怎么样了？`;
  });
  save();
  return lines.join('\n');
}
```

把 `maybeRemind()` 的返回值拼进你给模型的输入（或直接当开场白发出去）。三个要点：

- **捎带式触发**：在「收到用户消息」的处理函数里调用，不要开 `setInterval`——没人聊天时自言自语很吓人。
- **结案**：`markDueReminded` 记下 `remindedAt`，同一条不会反复追问。用户改约了时间（`upsert` 更新 `dueAt`）会自动重置，允许再提醒一次。
- **过期话术**：`selectDueMemories` 同时返回「今天到期」和「已经过期」的，过期的话术可以换成「有件事之前约好了…现在怎么样了」，别催。

手工加一条带跟进时间的记忆，方便测试：

```bash
node cli.mjs add --text "阿风周六请喝奶茶" --kind promise --due "2026-11-01"
node cli.mjs due     # 列出到期还没提醒的
```

### 提醒之后：结案

只提醒不结案，约定会一直挂在到期列表里（`remindedAt` 只挡「重复催同一句」）。事情办完要有终点：

```js
import { resolveLongMemory } from '../../lib/core/long-memory.js';

// 用户说「看完了 / 过了 / 已经办好了」，或者你在回复里确认过结果
resolveLongMemory(memories, { text: '说好周六一起看电影', note: '看完了' });
save();
```

结案的条目是 `resolved`：**不再进到期列表，但仍在检索库里**——聊到「上次那个电影」她还答得上来，不会因为结了案就失忆。

两条自动路径，任选其一：

- 提炼时让模型填 `resolves`（提示词规则 11 已包含）：聊天里出现「面试过了」，抽出的新记忆带 `"resolves":["阿风下周面试"]`，`upsertLongMemory` 会自动把旧约定结案。
- 手工/脚本 `node cli.mjs done --text "..." --note "..."`。

注意 `resolved` 和 `superseded` 不是一回事：结案 = 这事结束了（电影看完了），取代 = 这条信息作废了（考研改考公）。前者还在检索里，后者不再出现。

## 可选 · 给模型一个记忆工具

如果你用的框架支持工具调用，可以给模型两个工具，让它自己决定什么时候记、什么时候查：

```js
const tools = [
  {
    name: 'memory_append',
    description: '记住一件以后还用得上的事。只在用户明确说了稳定的个人信息、偏好、约定时使用。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '第三人称，一句话，不超过 60 字' },
        kind: { type: 'string', enum: ['fact', 'pref', 'promise', 'event'] },
        weight: { type: 'number', description: '1-5，身份和重大计划给 4~5' },
        tags: { type: 'array', items: { type: 'string' } },
        supersedes: { type: 'array', items: { type: 'string' }, description: '被这条新信息取代的旧记忆原文' }
      },
      required: ['text']
    }
  },
  {
    name: 'memory_search',
    description: '查一下以前记过什么。不确定对方说过某件事时先用这个。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query']
    }
  }
];
```

两个注意点：

- **工具描述里要写清「什么时候用」**，不只是「是什么」。模型不会因为工具存在就调用它。
- **手动写和自动提炼要分工**。如果人设里写着「系统会自动提炼，你不用管」，模型就真的不写了——而自动提炼一旦失效，两条路同时断。生产的做法是：人设里鼓励模型在「用户明确要求记住」时调用工具，其余交给后台提炼。

## 先验证，再接入

不要一上来就全量接入。按这个顺序：

**第 1 步：手工塞 10 条，看回话有没有变化**

```bash
node cli.mjs add --text "阿风在准备考研" --kind fact --weight 5 --tags 学业
# ... 再加 9 条 ...
node cli.mjs render --query "最近压力大吗"
```

把渲染出来的块手工贴进 system prompt，聊几轮。如果她的回话明显不一样了（会主动提考研、会说「你上次说压力大」），说明注入位置和格式是对的。

顺带看一眼格式：带 `dueAt` 的条目应该长这样——`- [约定] 说好周六看电影 · 10-27 · 约在 这周六·10-31`。约定时间点没出现在注入块里，就等于她只知道「约过电影」而不知道「约在周六」，主动开口会说得含糊。

如果没变化，问题通常在注入位置：放在 system 开头会被后面的长上下文冲掉。

**第 2 步：只开注入，不开自动提炼**

跑一周。看 `status` 里的 `hits` 分布：

- 大部分条目 hits > 0：查询词和记忆文本能对上，检索正常
- 大部分 hits = 0：要么记忆写得不像平时的问法，要么查询用的不是用户原话

**第 3 步：开自动提炼，但先只记录不写入**

把 `extract()` 里的 `upsert` 换成打印，跑一周，人工看提炼质量。常见问题：

- 提炼出「今天天气很热」这类废话 → 提示词规则 2 不够强
- 一条里塞了三件事 → 规则 8 不够强
- 全是 event，没有 pref / promise → 规则 9 不够强

**第 4 步：全量开，每周体检一次**

```bash
node cli.mjs doctor        # 过长、多事件、无标签、重复、从未被想起
node cli.mjs organize --dry-run
```

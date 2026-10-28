# 运维手册

## 配置项

生产环境（`config.json` 里的 `socialV2.longMemory`）用到的全部配置。改完需要重启进程。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关，关掉后不注入也不提炼 |
| `autoExtract` | `true` | 关掉后只保留注入，不再自动提炼 |
| `maxEntries` | `1000` | 容量上限，超出按「已下架 → 低权重 → 最久未用」物理删除 |
| `injectLimit` | `12` | 单次注入最多几条 |
| `injectMaxChars` | `1200` | 单次注入最多几个字 |
| `extractMinMessages` | `20` | 攒够多少条消息才提炼一次 |
| `extractCooldownMs` | `600000` | 两次提炼的最小间隔（10 分钟） |
| `extractTimeoutMs` | `180000` | 单次提炼超时，低于 120 秒在低配模型上经常不够 |
| `extractRetries` | `1` | 失败重试次数，上限 3 |
| `extractProvider` | 无 | 提炼专用模型源，**不要跟随聊天** |
| `extractModel` | 无 | 同上 |
| `extractReasoningEffort` | `low` | 抽取任务不需要深度思考 |
| `decay` | `{fact:365, pref:180, promise:30, event:14}` | 各类型半衰期（天） |
| `decayArchiveBelow` | `0.6` | 强度低于此值归档 |
| `maxArchivePerRun` | `3` | 单次整理最多归档几条（防手滑；0=不设上限） |
| `consolidateEnabled` | `true` | 是否合并重复 |
| `consolidateDice` | `0.85` | 合并的相似度阈值，调高更保守 |
| `organizeIntervalMs` | `86400000` | 整理间隔（24 小时） |
| `remindEnabled` | `true` | 主动提醒开关（到期项捎带提醒），见「主动提醒」一节 |

### 调参建议

**记忆太少、她总是忘事**：

- 先把 `decay.promise` 从 30 调到 60，`decay.event` 从 14 调到 30
- 再考虑降 `decayArchiveBelow` 到 0.4（更少归档）
- 不要先动 `injectLimit`——注入太多会稀释注意力，12 条已经够

**记忆太多、注入里全是废话**：

- `injectLimit` 降到 8，`injectMaxChars` 降到 800
- `decayArchiveBelow` 提到 0.8（更积极归档）
- 检查 `doctor` 输出的「多事件」条数，把长条目拆开比调参数有效

**提炼质量差**：

- 先看是不是模型问题：同一批聊天换模型跑一次对比
- 再看提示词：`doctor` 里「多事件」「无标签」的比例高，说明规则没被遵守
- `temperature` 建议 0.2~0.3

## 日志：看这几行就够了

```
长期记忆：21 条生效 | 提炼 deepseek-account/deepseek-flash | 衰减半衰期 事实 365d / 偏好 180d / 约定 30d / 事件 14d | 整理每 24h
```

启动时打印。**看到这行就说明新代码生效了**，同时能确认提炼用的哪个模型源。

```
长期记忆提炼：private:123 新增 3，更新 1，取代 1，拦截 0，跳过 0，现有 24 条
```

正常提炼。重点看「新增」和「取代」：

- 连续多次「新增 0」但聊天很活跃 → 提示词太保守，或者模型没理解任务
- 「取代」频繁 → 提示词的 supersedes 规则可能太激进，会让旧记忆过早下架

```
长期记忆提炼：private:123 本轮无新增
```

模型明确表示没什么可记（输出了 `[]`）。偶尔出现正常，连续出现要看提炼质量。

```
长期记忆提炼失败 (private:123): ...
```

失败。看错误内容分情况处理，见下面的故障表。

```
整理：归档 3，合并 1，生效 24 条
```

每日整理。如果连续多天都是「归档 0，合并 0」，有两种可能：记忆都很新（正常），或者衰减没生效（异常，见故障表）。

## 故障排查

### 症状：提炼一直「本轮无新增」，但聊天很活跃

**先确认是不是真的没有可记的**。用 CLI 手工跑一次：

```bash
node cli.mjs prompt --file 最近的聊天.txt > ask.txt
# 把 ask.txt 发给模型
node cli.mjs ingest --file reply.txt
```

如果手工跑能提炼出来，说明是自动化链路的问题；如果手工也提炼不出来，是提示词或模型的问题。

**自动化链路的常见原因**：

| 原因 | 判断方法 | 处理 |
|---|---|---|
| 提示词要 `text`、解析器认 `content` | 打印模型原始输出，看字段名 | 用 `parseLongMemoryJson`（兼容多种别名），不要自己写 `JSON.parse` |
| 模型被聊天人格带偏，回了句「好的」 | 原始输出里没有 `[` | 换无人物设定的 preset，或在提示词首行加强指令 |
| 窗口没攒够 | 日志里连「提炼」都没出现 | 检查 `extractMinMessages` 和窗口写入点 |
| 提炼会话建不起来 | 日志有「会话创建失败」 | 见下一条 |

### 症状：提炼报 `502` / `acp-proxy failure` / `turn error`

模型源对**新建会话**故障，对老会话正常。典型表现：聊天正常，只有提炼失败。

**处理**：给提炼单独配 provider / model，不要跟随聊天。

```json
"extractProvider": "另一个可用的源",
"extractModel": "对应模型",
"extractReasoningEffort": "low"
```

同时确认失败后**不要重建会话**——重建只会再撞一次同样的错。

### 症状：整理跑了很多次，一条都没归档

按可能性排序：

1. **记忆都很新**（正常）。`status` 看强度范围，如果最低值也 > 0.6，确实没有该归档的。
2. **衰减没生效**：注入时把所有被选中的条目都记成「刚被想起」，`lastUsedAt` 永远是现在。检查 `selectLongMemories` 里是否有 `rel > 0` 的判断。
3. **归档状态没持久化**：`STATUS` 常量缺少 `'archived'`，写盘再读回被归一成 `active`。用 `list --status archived` 确认——如果整理后能看到、重启后消失，就是这个原因。

第 2、3 条都不会报错，只能靠观察。

### 症状：一件事办完了，机器人还天天追着问

说明那条约定还是 `active`，`remindedAt` 只挡住「重复提醒同一句」，不代表事情结束。

```bash
node cli.mjs due                                    # 看到到期项
node cli.mjs done --text "说好周六一起看电影" --note "看完了"
node cli.mjs due                                    # 应该空了
```

结案后条目变成 `resolved`：不再进到期列表，但仍留在检索库里（`list --status resolved` 能看到，聊旧事还接得上）。如果它反复被提炼成新的约定，去看提炼提示词的规则 11 是否被删改过。

### 症状：记忆条目突然暴增

- **重复提炼同一批消息**：窗口没有在提炼成功后正确消费。检查 `windows.set(key, win.slice(batch.length))` 是否执行。
- **多个进程同时提炼**：没有串行链。每次提炼前用 `chain = chain.then(...)` 排队。
- **`upsertLongMemory` 的去重失效**：`sameThing` 的阈值被改过。默认 Dice ≥ 0.9 且长度比 ≥ 0.6。

用 `doctor` 看「疑似重复」的数量，能快速判断是哪种。

### 症状：注入块是空的

```bash
node cli.mjs status                    # 生效条数是 0 吗
node cli.mjs list --status archived    # 是不是全被归档了
node cli.mjs list --status resolved    # 或者都结案了
node cli.mjs render --query "随便一句话" --no-touch
```

按顺序排除：

1. 生效 0 条 → 确实没记忆，或全被结案/归档/取代（`list --status all` 一眼看清）
2. 生效 > 0 但 `render` 为空 → `injectLimit` 或 `injectMaxChars` 配成了 0
3. `render` 有内容但模型没反应 → 注入位置不对，应该放在 system prompt 末尾

### 症状：私聊说的事出现在了群里

**这是单桶设计的预期行为**，不是 bug。所有记忆共用一个桶，注入时不看会话。

如果这不可接受，需要给记忆加 `scope` 字段（`global` / `private:uid` / `group:gid`），注入时按作用域过滤。设计上不难，但会推翻「一个脑子」的设定，见 [DESIGN.md](DESIGN.md#还没做的)。

### 症状：文件损坏 / 记忆全没了

先别慌，按顺序找：

```bash
ls -la state/long-memory.json*        # 有没有 .tmp 或 .bak
cat state/long-memory.json.tmp        # 上次写一半的内容
```

- `.tmp` 文件存在且能解析 → 上次写入被中断，`mv` 回正式文件名
- 有 `.bak-时间戳` → 直接复制回来
- 都没有 → 检查是不是被 `maxEntries` 淘汰了（超过 1000 条会物理删除）

**预防**：`organize` 改成归档不删数据，就是为了让误操作可恢复。真正会丢数据的只有 `forget` 和 `maxEntries` 淘汰。

### 症状：CLI 改的东西 bot 看不到，或反过来

两个进程同时读写同一个文件，后写的覆盖前写的。**没有文件锁**。

约定：改库之前先停服务。只读命令（`status` / `list` / `render --no-touch` / `doctor`）随时可以跑。

## 日常巡检

每周一次，五条命令：

```bash
node cli.mjs status                    # 总量、分类、强度范围、命中分布
node cli.mjs doctor                    # 过长、多事件、无标签、重复、从未被想起
node cli.mjs organize --dry-run        # 如果现在整理，会发生什么
node cli.mjs list --status archived    # 最近归档了什么（判断是不是归错了）
node cli.mjs due                       # 到期还没提醒的跟进项
node cli.mjs export --out memory.md    # 导出一份可读清单，存个档
```

看什么：

| 指标 | 健康范围 | 异常说明 |
|---|---|---|
| 生效条数 | 20~100 | < 10 说明提炼没在工作；> 200 说明半衰期太长 |
| 强度最低值 | > 0.6 | 长期在 0.6 以下说明整理没跑 |
| 从未被想起 | < 30% | 太高说明记忆写得不像平时的问法 |
| 平均文本长度 | 20~60 字 | > 80 字说明提炼没遵守「一条一事」 |
| 多事件条目 | < 10% | 高了会让检索变钝 |

## 备份与恢复

### 自动备份（每日，推荐）

```bash
# 手动跑一次（备份到 backups/state/<时间戳>/，保留 7 天）
node scripts/backup-state.mjs

# 改保留天数
node scripts/backup-state.mjs --keep 14

# 看会备份什么、不真的写
node scripts/backup-state.mjs --dry-run
```

bridge 存活时会**每天自动触发一次**（双保险），失败只记日志不中断。但备份的价值在于「主程序出事时它还在」，所以这个脚本是独立的，bridge 挂了也能手动跑。

备份内容（丢了就回不来的那几类）：
- `long-memory.json` 长期记忆、`social-v2.json` 社交状态、`session-handoff.json` 交接回忆、`slang.json` 黑话、`sessions*.json` 会话、`config.json` 配置、`current-role.json`/`mode.json` 角色模式

**注意**：备份目录 `backups/` 含真实记忆/会话/token，已进 `.gitignore`，绝不能提交到 git。

### 手工备份

```bash
# 一次性
cp state/long-memory.json "backup/long-memory-$(date +%F).json"
```

### 恢复

```bash
# 停服务
cp backup/long-memory-2026-10-20.json state/long-memory.json
node cli.mjs status --store state/long-memory.json   # 确认
# 起服务
```

恢复后 `lastUsedAt` 会回到备份时的状态，所以强度也回到那时——意味着备份之后被「想起」过的事会显得更旧。如果备份很旧，可以先跑一次 `render --query ""` 把常用条目刷新一遍，再让 `organize` 归档。

### 迁移到另一台机器

```bash
# 旧机器
node cli.mjs export --out memory.md     # 人可读版本，用于核对
scp state/long-memory.json new-host:./state/

# 新机器
node cli.mjs status --store ./state/long-memory.json
```

JSON 里没有任何机器相关的字段（没有绝对路径、没有会话 id），可以直接搬。

**注意**：旧版本按会话分桶的文件也能直接读，`readLongMemoryStore` 会自动归一化，`mergeIntoShared` 会合并旧桶。但合并前建议先备份——合并会删除旧桶。

## 主动提醒

到期项靠 `dueAt` 字段触发，机器人收到消息时捎带扫一遍（不开定时器）。

```bash
node cli.mjs due          # 看当前有哪些到期没提醒的
node cli.mjs list         # 每条后面的「跟进」列显示 dueAt 日期
node cli.mjs add --text "阿风周六请喝奶茶" --kind promise --due "2026-11-01"
                          # 手工加一条带跟进时间的
```

**提醒后自动结案**（`remindedAt` 记上），同一条不会反复追问。用户改约时间（`upsert` 更新 `dueAt`）会自动重置，允许再提醒一次。

**排查「怎么没提醒」**：

1. `cli.mjs due` 有内容但 bot 没开口 → 检查 `remindEnabled` 和 `maybeRemind` 是否真的接进了消息处理函数
2. `cli.mjs list` 里那条的「跟进」列是空 → 提炼时没抽出时间点，或手工加时没写 `--due`
3. 有日期但一直不提醒 → 看 `dueAt.ts` 是不是在未来（没到期）；只有相对时间（「下个月」）没有绝对日期的条目**无法判定到期**，需要模型给出 `date`

## 日记层（生产端）

日记是「按天沉淀、永不衰减」的兜底检索库，和长期记忆的分工是：长期记忆要轻要准，日记要全要能翻。

```bash
node scripts/diary.mjs                # 列出所有日记（新日期在前）
node scripts/diary.mjs --search 考研   # 按关键词搜历史日子
```

- 每天凌晨（默认 4 点）自动写一页当天小结，存 `state/diary.json`。
- **永不衰减、永不删**，只做容量上限兜底（`maxEntries`，默认 2000 条摘要）。
- 注入时**只在查询命中时**才带进 prompt（`injectLimit` 默认 5 天），平时不占 token。
- 日记已加入每日备份清单（`backup-state.mjs`）。

## 数据格式变更

`version` 字段当前是 2。加字段时注意：

1. `normalizeStore` 要给新字段默认值，旧数据才能读
2. 如果新字段是状态类（像 `archived`），**必须加进 `STATUS` 常量**，否则写盘再读会被重置
3. 加完跑一遍 `test/self-test.mjs`，第 17 项（落盘与读回）和第 26 项（归档持久化）会抓到大部分问题

本次（dueAt）新增字段：`dueAt`（`{when,date,ts}` 或 `null`）、`remindedAt`（时间戳或 `null`）。都是可空字段，旧数据读回自动补 `null`，无需迁移。

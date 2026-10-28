# dsh-memory-lens · 记忆透镜

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/Afeng-ovo/dsh-memory-lens/blob/main/LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://github.com/Afeng-ovo/dsh-memory-lens/blob/main/package.json)
[![CI](https://github.com/Afeng-ovo/dsh-memory-lens/actions/workflows/ci.yml/badge.svg)](https://github.com/Afeng-ovo/dsh-memory-lens/actions/workflows/ci.yml)

给 [DeepSeek Harness](https://github.com/deepseek-ai) 的长期记忆插件。让 agent 跨会话记住你的事：稳定事实、偏好、答应过的约定、发生过的事件。重启之后她仍然记得。

自带存储、自带工具、自带设置页，**不依赖任何其他插件或服务**。

> 名字叫「透镜」是因为它的重点不在存，而在**看清楚存了什么**：哪些事她记得牢、哪些快淡忘了、哪些之间有牵连。记忆系统最怕的不是忘，是「你以为她记得，其实她早就不提了」。

---

## 它解决什么问题

LLM 的上下文是会话级的。你今天告诉它「我在准备考研，别在这期间给我排旅行」，明天开个新会话，这句话就不存在了。

常见的补法是「把历史对话全塞回去」或者「自动抽取每轮对话存成记忆」。前者会把上下文撑爆，后者会把「嗯」「好的」「我看看」这类废话也存进库 —— 噪音一多，检索质量断崖式下跌，用户最后干脆把这个功能关掉。

这个插件走第三条路：

- **记忆由 agent 自己判断要不要记**。三个工具 `remember` / `recall` / `forget`，代价是它得多想一步，好处是库里每一条都有人为它负责。
- **注入有硬预算**。每轮最多 1200 字、12 条，超了按重要度少注入几条，绝不截断单条正文。上下文是稀缺资源，无节制的注入等于慢性自杀。
- **注入和检索用同一个打分函数**。否则「面板上显示的」和「她真读到的」会变成两套真相，而这恰恰是记忆系统最不能出的问题。
- **会淡忘，但淡忘不是删除**。强度低于阈值自动归档，归档条目仍可被检索和复活。
  半衰期**按类型分开**（事实 365 天 / 偏好 180 天 / 约定 30 天 / 事件 14 天），
  因为一件事和一条约定本来就该以不同速度淡去 —— 全用同一个数字的话，
  「周五给你讲睡前故事」会像「我在准备考研」一样挂两年。
  整理在**启动时**和**每次写入后**各跑一次（同一分钟内不重复），一次最多沉 3 条 ——
  衰减本来就慢，某天突然沉掉几十条，多半是半衰期被调错了，等发现时已经「失忆」。
  刻意不挂后台定时器：一个插件悄悄改你的记忆文件、你既看不见也没法阻止，这种事不该发生。

---

## 安装

**不用手动改 `package.json`。** `dsh plugin add` 装完会自动把包名写进 `dsh.profile.bundles`，重启就生效。

### 图形界面（最省事）

设置 → **插件** → **添加插件** → 填 `dsh-memory-lens` → 安装 → 重启 DSH。

也可以填 GitHub 地址（`https://github.com/Afeng-ovo/dsh-memory-lens`）、tarball 地址，或本机绝对路径。

### 命令行

```bash
# 装到默认 profile
dsh plugin add dsh-memory-lens

# 装到指定 profile
dsh plugin --profile desktop add dsh-memory-lens
```

三种来源都认：

```bash
dsh plugin add dsh-memory-lens                        # npm 包
dsh plugin add github:Afeng-ovo/dsh-memory-lens       # GitHub 仓库
dsh plugin add /绝对/路径/到/dsh-memory-lens           # 本地目录（开发用）
```

> **CLI 的前置条件**：`dsh plugin` 把参数转发给 `pnpm`，所以 `pnpm` 必须在 PATH 里。
> 桌面版内置了 pnpm（`resources/runtime/primary-runtime/dependencies/pnpm`），
> 但从终端直接跑 CLI 时它不一定在你的 PATH 中 —— 报 `'pnpm' 不是内部或外部命令` 就是这个原因。
> 遇到就装个 pnpm（`npm i -g pnpm`），或者改用上面的图形界面。

装完**重启 DSH**。设置页左侧会出现「记忆」分区。

### 卸载

```bash
dsh plugin remove dsh-memory-lens
```

记忆文件留在 `$DSH_HOME/memory-lens/memory.json`，不会被卸载带走 —— 重装回来还是那些记忆。
不想要了就手动删这个文件。

**配置**：装好就能用，全部有默认值。要改的话两种方式 ——

图形界面：设置 → **插件** → `dsh-memory-lens` 那一行的 **配置**，改完即时生效。

或写进 `~/.dsh/profiles/<profile>/cordis.patch.yml`：

```yaml
- id: memory-lens            # 必须等于插件的 settings 命名空间，别改
  name: dsh-memory-lens
  config:
    storeFile: ''            # 空 = $DSH_HOME/memory-lens/memory.json
    injectEnabled: true
    injectLimit: 12
    injectMaxChars: 1200
    injectRotateSlots: 2   # 每轮给「冷门记忆」留几个名额（0=不轮换）
    decayHalfLifeDays:      # 半衰期（天）。也可以直接写一个数字，表示所有类型共用
      fact: 365
      pref: 180
      promise: 30
      event: 14
    decayArchiveBelow: 0.6  # 强度低于它就归档（0~1）
    maxEntries: 1000
```

`decayArchiveBelow` 默认 **0.6**，与 core 计算「预计淡忘 N 天后」用的是同一个阈值 —— 面板上显示的那天，就是它真正沉下去的那天。按默认半衰期，一条刚写下、权重 3 的记忆大约在这样的时候归档：事件 33 天、约定 70 天、偏好 418 天、事实 848 天（权重每高一分寿命更长：权重 5 的事实约 1116 天）。**约定比事实淡得快得多是故意的**：答应了却两个月没动静的事，不该像「我在准备考研」那样挂两年。

`injectRotateSlots` 默认 **2**：库里的条数超过注入上限时，排序靠后的条目本来**永远**进不了上下文（查询为空时分数只剩「权重 + 新近度」，排序长期稳定）—— 它们没被归档，只是每次都在队尾，等于不存在。留两个名额，每小时换一批，让每一条都有机会进来一次。**只挤占排在后半段的**，不会把本该在的高分条目顶出去；库比上限还小时名额自动失效。

---

## 三个工具

| 工具 | 用途 | 关键点 |
| --- | --- | --- |
| `remember` | 记一件事 | 同一件事换个说法时传 `supersedes` 指向旧条目，旧条目标为「已取代」而不是删掉 |
| `recall` | 按关键词查 | 和注入共用打分函数，`touch=true` 会更新「想起次数」 |
| `forget` | 忘掉一条 | `mode=resolve` 结案（仍可被提起）· `mode=delete` 真删 |

**它不会自己偷偷记。** 如果你希望 agent 主动记住某事，在对话里说一句「这个记一下」就行。

---

## 设置页「记忆」

装好后：设置 → 左侧导航 **记忆**。一个页面五块：

- **KPI 四格**：生效中 / 已结案 / 已归档 / 本轮注入（注入超预算时这一格变红并显示超出多少字）
- **记忆列表**：按状态筛选、搜正文或标签，每条可续命 / 结案 / 归档 / 编辑 / 删除
- **她会想起什么**：直接显示后端算出的注入块原文 —— 不是「大概会想起这些」，是真的那一整段
- **记忆图**：三维星图。每条记忆是一个光点，共享标签的记忆之间连边。红色＝快淡忘了，绿色＝记得很牢，灰色＝标签节点。点一下看详情和关联，拖空白转视角，滚轮推拉远近，「暂停旋转」停住它，方便点中某个点。
- **体检**：点一下，用内核算法把整个库过一遍 —— id 重复、同一句话存了两份、说被某条取代而那一条不存在、时间戳写成秒、衰减整理从来没跑过、到期没提醒的约定……**每条问题都带「怎么办」**，而且只报能确定的，不猜、不评分
- **对账**：填另一份记忆文件的路径，看两份库差在哪 —— 一致多少条、只在这边多少条、只在那边多少条、两边都有但字段不同。**按「正文 + 类型」配对而不是按 id**（两个系统各自生成 id，按 id 比会把同一条全报成「只在一侧」），而且**只读，绝不改那份文件**

星图是 canvas 2D 手写透视投影，**零外部依赖** —— 不引 three.js 是刻意的：多一个依赖就多一个「打不开」的理由。

![记忆图](docs/screenshot-graph.png)

---

## 数据

默认存在 `$DSH_HOME/memory-lens/memory.json`。`$DSH_HOME` 跟着 DSH 自己的数据根目录走，换机器、换盘都不会丢。

```jsonc
{
  "version": 1,
  "buckets": {
    "shared": [
      {
        "id": "lm-mvjb07iln17s",
        "kind": "fact",              // fact | pref | promise | event
        "text": "阿风在准备考研",
        "tags": ["学业"],
        "weight": 4,                 // 1~5
        "status": "active",          // active | resolved | archived | superseded
        "dueAt": { "when": "2026-12-20", "ts": 1797000000000 },
        "createdAt": 1791000000000,
        "hits": 3,                   // 被想起过几次
        "lastUsedAt": 1792000000000
      }
    ]
  }
}
```

**纯 JSON，可读可改可同步。** 想放进坚果云/OneDrive 做多机同步，把 `storeFile` 指过去就行。文件被外部改动时插件会自动重新加载，不会拿着内存里的旧副本装作没事。

---

## 面板里能做的事

- 记一条 / 编辑 / 续命 / 结案 / 撤销结案 / 归档 / 复活 / 删除（删除有二次确认）
- 按状态筛选、按正文或标签搜索
- 想看原始数据就直接开 `$DSH_HOME/memory-lens/memory.json` —— 想备份、想同步、想手改，就那一个文件

**从别的记忆系统迁移**（没有按钮，走接口）：

```bash
# 三种形状都收：{ "source": {...} }（脚本用法）、{ "items": [...] }、或把库直接当 body 传
curl -X POST http://127.0.0.1:<端口>/dsh-memory-lens/api/import \
  -H 'content-type: application/json' \
  --data-binary @old-memory.json
```

- 条目列表可以放在 `items` 里、也可以放在 `buckets.shared` 里、或者就是一个裸数组。
- 每条至少要有非空的 `text`；其余字段缺了会自动补 —— `status` 补 `active`，
  `createdAt`/`lastUsedAt`/`updatedAt` 补成导入那一刻，`weight` 补 3，`hits` 补 0。
  **补 `createdAt` 不是为了好看**：衰减要靠它算「这件事多久没被提起了」，
  缺了就只能当成刚写下的，一条三年前的旧事会一直不淡出。
- 按「正文 + 类型」去重，重复的跳过；返回 `{ ok, added, skipped, total }`。

**检查一致性 / 和另一份库对账**（面板「体检」标签页里也能点，这里是对应的接口）：

```bash
# 体检：只读。返回 { checked, clean, counts:{high,medium,low}, findings:[{code,severity,message,fix}] }
curl http://127.0.0.1:<端口>/dsh-memory-lens/api/audit

# 对账：只读那份文件。返回 { identical, onlyLeft, onlyRight, differing, counts }
curl -X POST http://127.0.0.1:<端口>/dsh-memory-lens/api/diff \
  -H 'content-type: application/json' \
  -d '{"file":"D:\\\\qq-bridge\\\\state\\\\long-memory.json"}'
```

两条设计取舍值得先说清楚：

- **对账按「正文 + 类型」配对，不按 id。** 两个记忆系统各自生成 id（`lm-xxx`），
  按 id 比会把「同一条记忆」全报成「只在一侧」—— 报错了地方比不报更糟。
- **对账只读另一份文件，绝不写它。** 那份数据属于另一个程序，插件没有资格替它做决定，
  哪怕发现它「不对」。自动修会在用户不知情时改动别人的数据，比不一致本身更糟。

---

## 开发

```bash
node test/tools.test.mjs    # 工具层：55 项
node test/host.test.mjs     # 宿主半装配：12 组
node test/client.test.mjs   # 客户端半装配：4 组
node test/audit.test.mjs    # 体检与对账：26 项
node examples/self-host/self-test.mjs   # 内核自检：41 项
```

三个测试都是**跑真实代码**（最小桩，不是复制一份逻辑），因为这类插件的失败模式大多是「装上了，但什么都没发生」—— 没有异常、没有日志，只是那个页面不出现。

> **关于 `output.render`**：`@deepseek-ai/dsh-tools` 的 `defineTool` 里有一句
> `const userRender = options.output.render;`，`output` 少了 `render` 它不报错，
> 而是把 `undefined` 带进闭包，等你真去渲染时抛
> `tool "remember" returned invalid output: output.render failed: userRender is not a function`。
> 0.1.0 就是这样发出去的：三个工具都只写了 `schema`。更麻烦的是 `execute` 已经执行完、
> 记忆已经落盘，用户收到的却是错误 —— 他会以为没记住，再说一遍，库里就多一条重复。
> 所以 `test/tools.test.mjs` 现在会把每个工具真的 `render` 一遍，检查返回的是内容块数组。
>
> 另一条同类的坑：工具返回值必须是 **lossless JSON**。`{ dueAt: undefined }` 会被
> `JSON.stringify` 丢掉那个键，宿主据此判定「值不是无损 JSON」，整次调用报
> `value is not lossless JSON`。没有期限的记忆占绝大多数，所以这条几乎必踩。
> 修法是条件展开（`dropUndefined`），不是写个 `undefined` 占位。

### 结构

```
lib/
  index.js          宿主半：systemPrompt 注入 + 衰减整理 + 4 条 HTTP 路由 + Config
  tools.js          三个工具
  store.js          存储（原子写 + mtime 感知外部改动）
  core/long-memory.js   纯逻辑：打分 / 衰减 / 检索 / 去重（零 IO 依赖，可单测）
  client.js         客户端半：设置页分区（含三维星图）
cordis.patch.yml    loader entry
```

`core/` 刻意不碰 `ctx`、不碰 `fs`，只有纯函数。这样打分和衰减逻辑可以脱离 DSH 单独验证 —— 这两块一旦算错，整个插件的行为就全错了，而它们最容易在「看起来正常」的表象下悄悄算错。


### 想自己搭机器人？

[`examples/self-host/`](examples/self-host/) 是同一份内核的另一种接法：命令行（`cli.mjs`）、一周演示（`demo.mjs`）、提炼提示词、日记检索、定时备份，以及接进你自己 bot 的六个接入点。

它**不是第二份实现** —— 导入的就是 `lib/core/long-memory.js`，和插件跑的是同一套打分与衰减代码。想先看看这东西怎么工作、又不想装 DSH，从那里开始最快：`cd examples/self-host && node demo.mjs`。

---

## 已知边界

- **不做自动抽取**。这是设计选择，不是还没做。
- **单桶**（`shared`）。core 支持多桶，但一个 agent 一个记忆库就够了，多桶只会让「她到底记得什么」变模糊。
- **不加密**。文件是明文 JSON。密钥、证件号这类东西在写入前会被 `looksSensitive()` 拦掉，但拦的是模式匹配，不是保险箱。真有敏感信息需求，请用 `storeFile` 指向一个你自己加密的盘。
- **中文优化**。分词按字 + 二元组做，英文检索能用但不如中文准。

---

## License

MIT

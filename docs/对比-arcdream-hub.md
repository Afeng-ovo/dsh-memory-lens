# 对比评价：ArcDream Hub / dsh-arc-hub vs dsh-memory-lens

写于 2026-11-01。对象是用户给的抖音视频简介里提到的两个仓库：

- `github.com/499596849-jpg/arcdream-hub`（主程序，HTML，4997 KB，★0）
- `github.com/499596849-jpg/dsh-arc-hub`（DSH 插件，JavaScript，15 KB，★0）

对照对象是我们自己的 `dsh-memory-lens`（★3，675 KB，v0.4.1）。

---

## 0. 前提：一条没证实的事，先说清楚

**简介里那个 GitHub 链接是否就是这两个仓库，我没有 100% 证实。** 抖音页面正文拿不到（需要登录态和客户端接口），我只能看到链接字符串本身。间接证据是吻合的：仓库名 `arcdream-hub` 与「弧梦」对得上；`dsh-arc-hub` 的 topics 里有 `deepseek-harness` / `dsh-plugin`；两个仓库的 created 时间都是 2026-10-31，与视频发布时间接近；仓库里的 `examples/persona/hela-role-card.md` 提到「海拉」这一人设名。但**这是推断，不是确认**。如果视频指向的是同名/同作者的另一个仓库，下面所有关于「它」的描述仍然对这两个仓库成立，但「视频里演示的就是这套」这句不成立。

其余所有事实都能对上一个文件或一次 API 调用，文末有索引。

---

## 1. 它到底是什么

一句话：**一个跑在本机的 Node 小服务 + 一个 141 KB 的单文件网页 + 一个可选 DSH 插件**。它不是记忆系统，是一个「本地文件中枢 + 数字人聊天壳」。

### 形态

| 部分 | 是什么 | 证据 |
| --- | --- | --- |
| 后端 | `app/server.mjs`，508 行，127.0.0.1:8799，零 npm 依赖，Node 22+，索引用 `node:sqlite` 的 `DatabaseSync` | `server.mjs:15-26`、`server.mjs:185` |
| 前端 | `app/public/index.html`，141558 B / 2575 行，内联 CSS+JS，无构建步骤 | 文件树 |
| 插件 | `dsh-arc-hub`：Host 半 `index.js`（236 行，注册 4 个工具 + 一段 systemPrompt 锚点卡）+ Client 半 `client.js`（167 行，设置页分区 + 右下角粒子球） | `index.js:131/149/166/191`、`index.js:218-235` |
| 安装 | `install/install.ps1`：Windows 原生 `FolderBrowserDialog` 选数据目录 + 工作区目录，解压 zip、写 `data-dir.txt`、建桌面快捷方式、启动 | `install.ps1` 全文 |
| 两种模式 | `multimodal`（多工作区/检索/星图）/ `single`（单工作区 + 常驻聊天） | `README.md:15`、`index.html:513` |

### 数据存哪

默认 `%USERPROFILE%\ArcDreamHub`（或安装时选的目录），`ARC_HUB_DATA` 可覆盖，`app/data-dir.txt` 指针优先（`server.mjs:19-25`）。目录内容：

- `config.json`（mode、workspaceDirs）
- `model.json`（模型配置，Key 用 DPAPI 加密）
- `index\hub.db`（SQLite，**只有一张表 `files`**，`server.mjs:185`）
- `persona\`（人设卡 md，或 `.enc` + `.dpapi` 密钥）

**开源代码里没有记忆库。** `server.mjs` 全文 grep `memory` / `记忆` / `mem_` / `shared` 全部零命中，`CREATE TABLE` 只有 `files` 一张。这一点是这份报告最重要的结论，后面会反复用到。

### 账号 / 云端

无账号、无云同步。模型 Key 用户自填（DeepSeek / 豆包火山方舟 / OpenAI / 任意 OpenAI 兼容），只在聊天时才 `base + '/chat/completions'`（`server.mjs:30` 起的 `PROVIDERS` 表、`server.mjs:423-431`）。没 Key 也能用搜索、星图、H5，聊天回退本地规则并标「模型未连上」（`README.md` 快速上手一节）。**这一点它做得干净**：不需要注册，没有遥测，Key 用 DPAPI CurrentUser 加密且 GET 永不回显（`server.mjs:396-398`）。

### 但有一堆「宣称了却没实现」的东西

这些不是吹毛求疵，它们直接影响「这套东西能不能真的用」：

1. **`arc_hub_search` 工具不存在。** `dsh-arc-hub/README.md:22` 与 `arcdream-hub/README.md:98` 都写「Host 工具：…`arc_hub_search`（真实 SQLite 索引）」，`index.js` 实际只注册 4 个：`arc_hub_status` / `arc_hub_persona` / `arc_hub_mode` / `arc_hub_open_dir`（`index.js:131/149/166/191`）。
2. **`.github/workflows/` 不存在。** `README.md:93` 的目录树写着「└─ .github/workflows/ 打 tag 自动打包 Release」，contents API 查 `.github` 返回 404，仓库 28 条提交里也没有。
3. **`helper` 不存在。** 前端 `index.html:1942` 定义 `API_BASE` 在 `file://` 下回退到 `http://127.0.0.1:8795`，`index.html:2016` 调 `/hub/start`，插件 `index.js:19` 定义 `HELPER_BASE = 'http://127.0.0.1:8795'` 并在失败时提示「请先双击 helper\打开中枢助手.cmd」——仓库里没有 `helper/` 目录，`server.mjs` 里没有 `/hub/start` 路由（`server.mjs:485` 的 endpoints 清单里也没有），8795 端口无人监听。`RELEASE_NOTES-0.1.2.md` 还把「助手 `/hub/start` 兜底」写进了「修复」。
4. **端口自相矛盾。** 插件 README 第 28 行说「插件只访问本机 `http://127.0.0.1:8799`」，`client.js` 主数据确实走 8799（`client.js:6`），但同一份 `client.js:92` 的「打开中枢」按钮又打 `http://127.0.0.1:8795/hub/start`，`index.js` 的 `arc_hub_open_dir` 也打 8795。**两处都越界，不止 Host 半。**
5. **人设卡路径自相矛盾。** 服务端读 `DATA_DIR/persona/hela-role-card.enc`（`server.mjs:435`），`DATA_DIR` 由 `app/data-dir.txt` 指针解析（`server.mjs:20-25`）；插件读 `HUB_ROOT/data/persona/hela-role-card.enc`（`index.js:16-18`），而 `HUB_ROOT` 只认 `ARC_HUB_ROOT` 环境变量或 cordis 配置里的 `hubRoot`（`index.js:15`、`:128`），**根本不读 `data-dir.txt`**。安装脚本把示例卡复制到 `$root\data\persona\`（`install.ps1:36-40`），`$root` 是用户选的目录 —— 于是服务端能读到，插件默认读不到，除非用户额外去设 `hubRoot`。这不是「两边都配一下就行」，是**插件的发现机制与服务端的选择机制根本没接上**。
6. **`tools/build_release.mjs` 不存在。** `docs/PRIVACY.md` 与 `docs/ARCHITECTURE.md` 都说发布前由它做隐私扫描（「出现本机路径、公司名…即打包失败」），contents API 404。
7. **文档被控制字符污染。** `docs/ARCHITECTURE.md` 里有 `\x0c`（`ode:sqlite` 前）和 `\x07`（`pp/public/index.html` 前），`QUICKSTART.md`（4 处）/ `CONTRIBUTING.md`（2 处）/ `RELEASE_NOTES`（2 处）同类。是 `\a` / `\f` 转义被吃掉了：`node app\server.mjs` 变成 `ode app\server.mjs`。读者复制命令会直接失败。
8. **示例人设卡带真实公司名。** `examples/persona/hela-role-card.md` 里有「南京新弧网络艺术科技」、`owner_company` 字段、`source: 海拉角色卡-填写表.docx（2026-10-31 老板填写）`。而 `README.md` 写「本仓库和发布包不含任何真实路径、公司名、项目名、人设卡」，`docs/PRIVACY.md` 写「出现…公司名…即打包失败」。**自己破了自己定的规矩。**

---

## 2. 记忆机制：逐条对照

先给结论：**它没有记忆系统。** 下面这张表里「它有」的格子几乎全是空的，原因不是它做得差，而是这一层根本不存在。

| 机制 | 我们有 | 它有 | 判断 |
| --- | --- | --- | --- |
| 写入 | `remember` 工具（`lib/tools.js:137`），带 `supersedes` / `pin` / `kind` / `tags` / `weight` | 无。唯一的「写入」是 `arc_hub_mode` 写 `config.json` 的 mode 字段 | 它有 0 |
| 存储 | `$DSH_HOME/memory-lens/memory.json`，明文 JSON，`{version,buckets.shared[],meta}` | 无记忆文件。`hub.db` 只有 `files` 表 | 它有 0 |
| 检索 | `recall`（`lib/tools.js:253`）+ 注入共用同一个打分函数；中文按字 + 二元组分词 | `/api/search` 只做 `name LIKE ? OR path LIKE ?`（`server.mjs:238-243`），**只搜文件名/路径，不搜正文** | 它换了个做法：把「检索」定义成文件名匹配 |
| 注入 | `systemPrompt.section`，四层 + 2000 字 / 12 条硬预算 | `systemPrompt.section`（`index.js:218-235`），**一段固定文本锚点卡**：中枢路径、模式、人设摘要、工具清单、安全协议 | 它有一层，但内容恒定，不随对话/记忆变化 |
| 会话上下文 | 宿主自己管 | `let chatLog = []`（`index.html:2274`），内存变量，超 24 条 `slice(-24)`（`index.html:2343`） | 它连「上次聊到哪」都不落盘，关页面即失 |
| 衰减 | `memoryStrength = weight * 0.5^(age/halfLife)`，半衰期按 kind 分开（fact 365 / pref 180 / promise 30 / event 14，`lib/core/long-memory.js:1133-1152`） | 无 | 它有 0 |
| 归档 | `archiveBelow = 0.6`，`status='archived'` + `archiveReason='decay'`，一次最多沉 3 条，启动时 + 每次写入后各跑一次，**刻意不挂后台定时器**（`lib/core/long-memory.js:1178-1208`） | 无 | 它有 0 |
| 复活 | 归档条目仍可检索，`revivedAt`（`lib/core/long-memory.js:1008-1059`） | 无 | 它有 0 |
| 记忆图 | canvas 2D 手写透视投影，每条记忆一个光点，共享标签连边，红=快淡忘绿=记得牢，可暂停旋转，滚轮可推到很近（`dist` 下限 0.12，约 8 倍；**这条是工作区未提交的改动**，HEAD 的下限还是 0.45 / 约 2.2 倍） | **有星图，但不是记忆图**：节点来自文件系统（真实模式 `server.mjs:293-344`）或硬编码 88 个演示节点（演示模式，默认）；`buildGraph()` 里没有任何记忆条目参与 | 它做了个更漂亮的东西，但装的是另一件事 |
| 体检 | `auditStore`：共 20 类检查，含 id 重复 / 同句两份 / 被取代的条目不存在 / 时间戳写成秒（`future-createdAt`）/ 衰减从没跑过 / 到期没提醒的约定，每条带「怎么办」，只报能确定的（`lib/core/audit.js:73`，路由 `lib/index.js:793`） | 无 | 它有 0 |
| 对账 | `compareStores`（`lib/core/audit.js:241`），按「正文 + 类型」配对而非 id，只读不改（调用在 `lib/index.js:845`） | 无 | 它有 0 |
| 轮换 | `injectRotateSlots`（默认 2）：库比注入上限大时，只从「按分数根本挤不进来」的那批里抽，不顶掉高分条目（`README.md:127`） | 无 | 它有 0 |
| 纯逻辑内核 | `lib/core/long-memory.js`（71948 B）不碰 `ctx`、不碰 `fs`，只有纯函数，可脱离 DSH 单测（`README.md:298`） | `server.mjs` 的索引/星图逻辑与 HTTP 层混在一个文件里 | 它没有这一层 |
| 用户可见可改 | 设置页（HEAD 是五块：KPI / 记忆列表（每条可 📌固定·续命·结案·归档·编辑·删除）/「她会想起什么」（**最近一次真实注入原文**）/ 记忆图 / 体检 / 对账；工作区未提交的改动已扩到七块，多出「快过期」）；数据是明文 JSON，可手改可同步，外部改动 mtime 重读 | 设置页只有「中枢在线/离线、模式切换、人设卡状态、模型状态、打开中枢/H5」——**没有任何一条记忆的列表、编辑、删除** | 关键分野 |

### 它那个星图到底是什么

这是最容易误判的地方，值得单说。从截图看它像一个「记忆星图」：四层节点（`LN = ['核心','高频','信息','沉淀']`，`index.html:538`）、11 个星团（含 `cl_mem 记忆会话`、`cl_arch 归档星团`、`cl_diary 日记星系`，`index.html:543-555`，每个带 `layer/ax/ar/spread/anchor`）、顶部 KPI 有「61 记忆 / 25,562 粉丝 / 386 高频 / 38.5 GB」（`index.html:312` 起，38.5 GB 那格在 `:319`）。

但代码里：

- 星图的**默认模式是演示**（`graphMode = 'demo'`）。88 个节点是硬编码的 `N(...)` 调用，其中 `N('共享记忆 61 条', 2, 'memory', 8, .7, '', { summary: 'C:\Sample\DemoData\memory\shared.sqlite 的 memory_entries，全是视频观察与偏好。' })`（`index.html:672`）。那是个 `C:\Sample\DemoData` 路径，示例数据。
- 切「真实」才拉 `/api/graph`（`index.html:2490-2505`），而 `buildGraph()` 造的是：core → 四个固定实体 → 每个工作区 → 每个项目（label 取项目 README 第一个 `#` 标题）→ 每项目最多 4 个产出文件。**节点全是文件夹和文件名，边权重写死 1/.8/.45/.4/.25。**
- 顶部 KPI 那几个数字是 HTML 里写死的 `<b>61</b>`、`<b>25,562</b>`、`<b>386</b>`、`<b>38.5</b>`，只有「节点数」是 `<b id="m-nodes">—</b>` 会真的更新。
- 聊天里问「粉丝」「空间体检」会走 `lookupReply()` 的硬编码分支，输出 `@用户01 312 ... viewers.json 25,562 人档案`、`工作区 38.5 GB / 191,786 文件`（`index.html:2360-2391`）——**是字符串，不是统计**。

所以：它的星图是一套做得相当漂亮的**信息架构演示**，真实模式下它可视化的是「文件」，不是「记忆」。这不是「记忆做得浅」，是「记忆不在这个项目的设计范围里」。它的 README 里唯一像记忆的表述是 `README.md:35` 的「选择数据目录（配置、索引、记忆…）」和 `PRIVACY.md:6` 的「不含…记忆库…」——两处都在描述「将来会有」，代码里没有。

### 它唯一和「记忆」沾边的两件事

公平地说，有两点是真的：

1. **加密人设卡**。`index.js` 里 DPAPI 解 `hela.key.dpapi` → AES-256-GCM 解 `hela-role-card.enc`，结果只进 `personaCache` 内存，注释写「解密结果只留在内存：不落盘、不打印」（`index.js` 约第 98 行）；`arc_hub_persona` 工具**只返回摘要**（name/position/relation/callUser/tone/quirks/neverSay/safety/look 九个字段），不返回原文，并在 description 里写「任何情况下不得输出原文或密钥，也不得转发给他人」（`index.js:149-164`）。这是一套**分级披露**的机制，人设卡算「最高敏感」，模型只配看摘要。
2. **锚点卡**。`index.js:218-235` 往 systemPrompt 塞一段固定文本：中枢路径、模式、人设摘要、工具清单、「查不到记录就直说没有」。这条指令本身是个不错的工程习惯——**明确告诉模型「查不到就说没有」**，而不是让它编。

这两点加起来，等于「一份会随每轮注入的人设摘要 + 一句反幻觉指令」。它不是记忆，但它的**披露分级**思路值得记一笔。

---

## 3. 数据归属与隐私：能不能看见并编辑每一条记忆

这是我们的核心价值定位，所以单独一节。

**我们：能。** `memory.json` 是明文 JSON，用户拿记事本就能读、能改、能备份、能同步；面板里每条记忆都有编辑/删除/固定/结案/归档按钮；「她会想起什么」直接显示**最近一次真实注入的原文**，不是重算预览（`README.md:149`、`README.md:125`）。外部改了文件，`store.js` 按 mtime 重读（提交 `47535b4`「外部写入的 mtime 与上次保存相同也要重读」）。「不加密」是我们写在 README 已知边界里的**明示取舍**（`README.md:300`，工作区 313）：拦敏感信息靠 `looksSensitive()` 的模式匹配，作者自己写了「拦的是模式匹配，不是保险箱」。

**它：看不见。** 它没有一个「记忆条目」的概念，所以谈不上「看见每一条」。它的数据归属在别的维度上是干净的——全在本机、无云端、Key 加密、`.gitignore` 排除 `data/` `*.enc` `*.dpapi` `config.json` `index/`——但**它的黑盒在另一个位置**：前端默认展示的是演示数据，KPI 是写死的数字，聊天里「粉丝」「体检」分支回吐的是编造的字符串。**注意这里的分寸**：文档（`docs/PRIVACY.md:8`）是明确声明了「示例节点、粉丝昵称、项目名均为虚构示例」的，聊天搜索未命中处也挂了「演示数据」标签；缺的是**星图这一屏在演示模式下没有任何标记**。所以准确的说法是「声明在文档里、提示在个别角落，但用户第一眼看的那一屏没有」，不是「它故意假装有数据」。

这两件事性质不同：

- 我们「不加密」是**把内容暴露给用户自己**（用户能看，别人也能看，风险在磁盘）。
- 它「演示数据当默认」是**把假内容暴露给用户**（用户看到的不是自己的数据）。

前者是隐私取舍，后者是认知污染。**用户分不清屏幕上哪些是真的**，这比「记忆藏在用户看不见的地方」更麻烦——因为连「有没有记忆」都判断不了。这一点在我们的设计里是被刻意反着做的：没发生过注入，面板显示「—」而不是编一个预览（`README.md:149`）。

### 它确实做对的安全项（要承认）

- 只绑 `127.0.0.1`（`server.mjs:17`）。
- `/api/file` 限定已登记工作区内、≤512KB（`server.mjs:244-252`）。
- `/api/model` GET 只回 `hasKey`，永不回显 Key（`server.mjs:396-398`）。
- `readBody` 限 1e6 字节（`server.mjs:57`）。
- 人设卡换 Windows 用户或换机器解不开（DPAPI CurrentUser 绑定）。

### 它的两个真实安全缺口（不是理论问题）

1. **CORS 写死 `Access-Control-Allow-Origin: *`**（`server.mjs:44-48` 的 `cors(res)`）。任意网页（含恶意页面）都能跨源打 `127.0.0.1:8799`。配上第 2 条就更值得说。
2. **`/api/open` 和 `/api/reveal` 不校验路径归属**。`server.mjs:449-455`：`path.resolve(raw)` 之后只要 `fs.existsSync(target)` 就 `openExplorer(target)`——**任何本机已存在的路径都能被打开**，不看是不是在已登记工作区里。`ARCHITECTURE.md` 的「安全边界」只写了 `/api/file` 受限，没提这两个。单独看只是「弹个资源管理器」，和 CORS `*` 组合起来就是「任意网页可以让你的机器弹出任意目录」，且 `arc_hub_open_dir` 工具的描述还写着「只允许本机已存在的路径」——这条件等于没条件。

---

## 4. 工程成熟度

| 维度 | 我们 dsh-memory-lens | 它 arcdream-hub / dsh-arc-hub |
| --- | --- | --- |
| 测试 | 5 个文件 **1778 行**（HEAD：`test/host.test.mjs` 932 / `tools` 297 / `client` 204 / `audit` 300 / stub 45；工作区 `client.test.mjs` 因放大倍率那条改动涨到 453 行，合计 2027），`audit.test.mjs` 实际跑 26 项断言（grep `test(` 得 27 是把 `function test(name, run)` 定义行算进去了） | **0**。无测试目录，无断言 |
| CI | `.github/workflows/ci.yml`：node [20,22,24] × os [ubuntu, windows]，9 个文件 `node --check` + 3 套自检 + pack check | **无**。`.github` 404；README 却写着有 workflows |
| Release | 5 个（v0.1.1 → v0.4.1，2026-10-28 至 10-29） | arcdream-hub 1 个（v0.1.2，2026-10-31），资产 3 个（主 zip 5096936 B / 插件 zip 10571 B / install.ps1）；dsh-arc-hub **0 个 release、0 个 tag** |
| 提交历史 | 26 条，近 20 条里 **12** 条是 fix/feat，信息密度高（「记忆图静止时停帧，别再每秒重画 60 次」「外部写入的 mtime 与上次保存相同也要重读（CI 在 Linux 上抓到的）」） | arcdream-hub 28 条，其中 **27 条是 2026-10-31 16:36–16:37 一分半内 `add <file>` 式上传**；dsh-arc-hub 12 条，11 条同一批上传，只有 1 条真改动（`docs: add install command, dependency and screenshots`，11-01 05:27）。**这两个仓库没有「迭代史」，只有「一次成型」** |
| 文档 | README **307 行**（HEAD；工作区未提交改动后是 320 行）+ `docs/DESIGN.md` **17044 B**（HEAD；工作区 27913 B）+ 3 张截图 | README 125 行 + ARCHITECTURE 36 + PRIVACY 21 + QUICKSTART 36 + RELEASE_NOTES 24 + CONTRIBUTING 12 + SECURITY 17 + PUBLISH 2501 B。**章节齐、但内容与实际不符**（见 §1 八条）；`PUBLISH.md:73` 的自查清单里明明写着「- 文档里的 `YOUR_NAME` 已替换」，可 `README.md:30` 和 `docs/QUICKSTART.md:9` 的安装命令里 `YOUR_NAME` 原样没换 —— **自查项存在但没执行**；另有控制字符污染多处 |
| 代码量 | 6 个文件约 233 KB：`core/long-memory.js` 71948 B、`client.js` **78856 B**（HEAD 69704 B）、`index.js` 42398 B、`tools.js` 17576 B、`core/audit.js` 15797 B、`store.js` 6699 B | `server.mjs` 26376 B（508 行）+ `index.html` 141558 B（2575 行）+ 插件 **18302 B**（`index.js` 10082 + `client.js` 8220）。单文件占比极高，`index.html` 一个文件就装了 CSS+JS+88 个演示节点 |
| 依赖 | `dependencies` 只有 `@deepseek-ai/schemastery ^3.18.5`；6 个 peerDependencies 全标 optional；engines node>=20 | 运行时 **0 依赖**（CONTRIBUTING 明写「零依赖：不要引入运行时 npm 依赖」）。`node:sqlite` 要 Node 22+ |
| 安装 | `dsh plugin add` / 从 npm | `irm ... install.ps1 | iex` 一行；或解压 zip 双击 `启动.cmd` |
| ★ / fork / issue | 3 / 0 / 0 | 0 / 0 / 0（两个仓库都是） |
| 建仓时间 | 2026-10-28T02:52:37Z | 2026-10-31T16:14:48Z（arcdream-hub）/ 16:15:16Z（dsh-arc-hub） |

关于 ★0 和 10-31 建仓，我把它们写进来但不拿它们当论据：这两个事实只说明「这套东西还没被外部检验过」，**真正的判断在机制层面**——没有测试、没有 CI、文档宣称与实现不符、提交历史是一次性上传。这四条才是可验证的问题。

顺带一个诚实的自我对照：我们的 5 个 release 集中在 10-28、10-29 两天，**仓库最后一次提交是 2026-10-29 22:08（`d39ef21`），之后再没动过** —— 严格说我们也不算「长期跑过」，只是有测试和 CI 兜着，改动敢动。

---

## 5. 诚实的评价

### 它真正的强项（具体到机制，不客套）

1. **星图的「思维聚焦钻取」（`enterMind`，`index.html:1170`）。** 点一个节点，不是弹个详情框了事，而是把它的**一级邻居按圆周排开**（`R = 218`，最多 9 个），再给每个一级邻居挂 1–2 个同星团兄弟（`kidBudget = 12`），相机推近到 `tz = 1.0`（窄屏 980px 以下是 `.68`，`buildMind` 里那句三元），同时把聊天气泡收起来。这是一套**「从全局星云钻到局部思维图」**的交互，比单纯缩放强。我们的记忆图现在是全局球壳：点一条之后**邻居会高亮、其余淡出**（`lib/client.js:436-447` 的 `hot`），详情卡里还会按共享标签数排前 8 条关联（`:449-462` 的 `relate`）——但**没有「把其余节点真的筛掉、按圆周排开、相机推近」这一档**。差别不在「有没有关联」，在「有没有把它变成一次钻取」。
2. **星团的层级 + 半径分层布局。** `CLUSTERS` 每个都有 `layer`（0/1/2/3 对应核心/高频/信息/沉淀）、`ax`（角度）、`ar`（半径）、`spread`（散布）、`anchor`（锚点 id）（`index.html:543-555`），节点按所属星团落在不同半径的环上。我们的图是按标签连边 + 球壳均匀分布，**没有语义分组和分层半径**。这两条加起来，它的图「一眼能看出结构」，我们的图「一眼能看出密度」。这是真实的差距。
3. **力导向 + 边界约束的收敛实现。** 同一段里对每个点做「离中心 < 165 就往外推、> 420 就拉回」的软约束，保证不塌缩、不飞散。细节不惊艳，但这是能用肉眼看出「它动起来不乱」的原因。
4. **零依赖 + 单文件 UI + 无构建。** 下载即跑，改完刷新页面即可。对一个要发给别人双击用的东西，这是最省摩擦的形态。我们做不到（DSH 插件必须走 loader + 打包），但这是形态差异，不是我们输了。
5. **安装向导。** 原生 `FolderBrowserDialog` 选数据目录 + 多选工作区目录，写 `data-dir.txt` 指针，建桌面快捷方式，启动。**非技术用户零命令行**。我们只有 `dsh plugin add`。
6. **H5 手机访问。** `/m` 与 `/` 同一份页面（`server.mjs:489-494`）。一行代码，一个能力。我们没有。
7. **披露分级。** 人设卡「完整卡加密、工具只回摘要、内存解密不落盘」（见 §2 末尾）。如果哪天我们要存「用户明确要求加密」的记忆，这是现成范式。
8. **「查不到记录就直说没有」写进注入文本。** 一句反幻觉指令，成本一行，收益是少一次编造。

### 我们的强项（同样具体）

1. **它是真的记忆系统，它不是。** 写入 / 存储 / 检索 / 注入 / 衰减 / 归档 / 复活 / 轮换 / 体检 / 对账 / 可视化，十一条链路都有实现。**测试覆盖要如实说**：写入与检索（`test/tools.test.mjs`）、存储与四层注入（`test/host.test.mjs` 13a–13j）、衰减强度（`host.test.mjs`）、归档（`test/client.test.mjs`）、复活（`host.test.mjs` 的 `revive` 断言）、体检与对账（`test/audit.test.mjs`）都有断言；**`rotationSlice` 没有直接单测**（`lib/core/long-memory.js:503`，grep 测试文件 0 命中），记忆图那部分只有静态源码断言（`test/client.test.mjs:180-245` 盯 `dist` 下限 / `zc` 地板 / `behind`），不是渲染快照测试。面板入口也不是十一条都有——「轮换」是注入内部机制，面板上没有开关，只在设置项 `injectRotateSlots` 里配。这不是「我们做得更全」，是「这一层它没有」。
2. **注入有硬预算，且绝不截断单条正文。** 2000 字 / 12 条四层共用，装不下就少装几条，`pinnedDropped` 计数如实上报（`README.md:24`、`:122`）。很多记忆插件死在「注入把上下文撑爆」上，我们这里是显式约束。
3. **注入与检索共用同一个打分函数。** 否则「面板上显示的」和「她真读到的」会变成两套真相（`README.md:26`、`:136` 的工具表）。这条是为了**可验证性**，不是为了性能。
4. **半衰期按类型分开，且约定比事实淡得快得多。** fact 365 / pref 180 / promise 30 / event 14 天（`lib/core/long-memory.js:1133`）。「答应了却两个月没动静的事，不该像『我在准备考研』那样挂两年」（`README.md:107`）。这是一个**有观点的取舍**，不是拍脑袋的默认值。
5. **衰减刻意不挂后台定时器。** 一次最多沉 3 条，启动时 + 每次写入后各跑一次。README 的原话是「一个插件悄悄改你的记忆文件、你既看不见也没法阻止，这种事不该发生」。**这是把「可解释性」放在了「省事」之上。**
6. **四层改为「该在的在」而非「重要的都在」。** 固定层不设百分比上限、拿不到会话内容时话题层自动空着、第一次运行自动钉一批但排除生日/纪念日（`NOT_PIN_HINTS`，`README.md:124`）。最后这条是踩过坑修出来的（提交 `732b278`）。
7. **「她会想起什么」显示真实注入原文，没发生过显示「—」。** 见 §3。
8. **纯逻辑内核可脱离宿主单测。** `core/` 不碰 `ctx`、不碰 `fs`（`README.md:298`）；`examples/self-host/` 导入的是同一份内核，不是第二份实现。
9. **工程纪律。** 1778 行测试（HEAD；工作区 2027 行）、3×2 CI matrix、`node --check` 9 个文件、提交信息写得像人话。

### 我们该从它身上学什么（按优先级）

1. **记忆图的「聚焦钻取」。** 给记忆图加一档：点一条记忆 → 只显示它 + 共享标签的邻居 + 二级关联，按圆周排开，相机推近，其余淡出。这是**唯一一个我认为我们现在就该抄的交互**。它解决的是我们的实际痛点：全局球壳上 300+ 个点，点中一条之后周围还是糊的。
2. **按 kind / status 分环。** 它用 `layer + 半径` 让「核心/高频/信息/沉淀」落在不同圈层。我们完全可以按 `kind`（fact/pref/promise/event）或 `status`（active/pinned/archived）分半径——现在只有颜色区分淡忘程度。
3. **披露分级（如果要做敏感记忆）。** 双钥匙（DPAPI 保护主密钥 + AES-GCM 加密内容）+ 工具只回摘要。但要写清：这和我们 README 明示的「不加密」是**冲突的取舍**，不能偷偷改。
4. **安装摩擦。** 如果哪天要给不用 DSH 的人用（比如 `examples/self-host` 那条线），一个原生目录框 + 桌面快捷方式的向导，比让人敲命令行强。
5. **H5。** 如果 self-host 那条线要上手机，`/m` 是最低成本的做法。

### 我们不该学的

1. **默认塞演示数据。** `graphMode = 'demo'`（`index.html:2506`）+ 88 个硬编码节点 + 写死的 `61 / 25,562 / 386 / 38.5 GB`。用户第一眼看到的不是自己的东西。**提示只做了一半**：`docs/PRIVACY.md:8` 在文档里明确写了「UI 里的示例节点、粉丝昵称、项目名均为虚构示例」，聊天里文件搜索没命中时也会挂一枚「演示数据（未命中真实索引）」标签（`index.html:2385`），但**星图本身切到演示模式时没有任何提示**，只 toast 一句「已切回预设星图」——用户看着满屏节点，没有任何东西告诉他这些不是自己的文件。我们的做法是反的：没数据就显示「—」。
2. **用硬编码字符串冒充查询结果。** `lookupReply` 的「午饭 未记录」「@用户01 312」「38.5 GB / 191,786 文件」分支。这是**把编造写进产品逻辑**，比没有功能坏得多。
3. **CORS `*` 打本地端口 + `/api/open` 不校验工作区。** 本地服务只要能被网页跨源访问，就等于给了任何网页一个「本机能力」句柄。
4. **文档宣称超出实现。** `arc_hub_search`、`.github/workflows`、`helper`、`build_release.mjs`、8795/8799——五个独立的不一致点。文档一旦开始骗人，后面的文档就没人信了。
5. **一次成型、无测试、无 CI。** 28 条提交里 27 条是同一分半钟的上传，等于没有迭代史，也就没有「改坏过又修回来」的记录。这种仓库不能给别人用。

---

## 6. 一句话结论

它是一套**形态成熟、机制空心的本地数字中枢**：星图交互、安装向导、零依赖分发、加密人设卡这四件事做得比我们细；但「记忆」这一层它没有——没有记忆库、没有记忆 API、没有记忆工具、没有衰减、没有可视化记忆、没有可编辑的条目，星图可视化的是文件而不是记忆，而默认展示的还是演示数据。

我们的记忆链路是完整的、有测试的、可验证的、数据在用户手里的；我们的短板在**交互形态**（没有聚焦钻取、没有语义分环、没有手机端、安装要命令行）和**敏感数据的披露分级**。

**该抄的是它的交互和分发，不该抄的是它的演示数据和文档习惯。**

---

## 附：事实索引

| 论断 | 证据 |
| --- | --- |
| 服务端无记忆存储 | `server.mjs` grep `memory` / `记忆` / `mem_` / `shared` 零命中；`CREATE TABLE` 仅 `files`（`server.mjs:185`） |
| 检索只匹配文件名/路径 | `server.mjs:238-243` `WHERE name LIKE ? OR path LIKE ?` |
| 星图节点来自文件系统 | `server.mjs:293-344` `buildGraph()`；`index.html:2490-2505` `loadRealGraph()` |
| 默认演示模式 + 88 个硬编码节点 | `index.html:543-555` CLUSTERS、`index.html:672` `N('共享记忆 61 条'…)` |
| 顶部 KPI 写死 | `index.html:312` 起 `<b>61</b>` / `<b>25,562</b>` / `<b>386</b>` / `<b>38.5</b>`；只有 `m-nodes` 会更新 |
| 聊天硬编码分支 | `index.html:2360-2391` |
| 会话不落盘 | `index.html:2274` `let chatLog = []`、`index.html:2343` `slice(-24)` |
| 插件只注册 4 个工具 | `index.js:131/149/166/191`；README 宣称的 `arc_hub_search` 不存在 |
| 唯一注入是固定锚点卡 | `index.js:218-235` |
| 人设卡只回摘要 | `index.js:149-164`；解密只在内存 |
| CORS `*` | `server.mjs:44-48` |
| `/api/open` 不校验工作区 | `server.mjs:449-455` |
| 请求体上限 1e6 | `server.mjs:57` |
| `/api/model` GET 不回显 Key | `server.mjs:396-398` |
| H5 同页 | `server.mjs:489-494` |
| 无 CI | contents API `GET /repos/499596849-jpg/arcdream-hub/contents/.github?ref=main` → 404 |
| 无 `tools/build_release.mjs`、无 `helper/` | contents API 同法 → 均 404 |
| 提交史是一次性上传 | commits API：arcdream-hub 28 条，27 条落在 2026-10-31T16:35–16:37；dsh-arc-hub 12 条，11 条同批 |
| Release 与资产 | releases API：arcdream-hub v0.1.2，assets 3 个（5096936 / 10571 / 2887 B，downloads 查询时为 30 / 4 / 7）；dsh-arc-hub 0 个 |
| 元数据（★/fork/issue/size/created） | repos API 各一次 |
| 示例人设卡带真实公司名 | `examples/persona/hela-role-card.md`；对照 `README.md` 隐私段与 `docs/PRIVACY.md` |
| 文档控制字符污染 | `docs/ARCHITECTURE.md` 含 `\x0c`、`\x07`；`QUICKSTART.md` / `CONTRIBUTING.md` / `RELEASE_NOTES-0.1.2.md` 同类 |
| 我们：四层注入 / 2000 字预算 | `README.md:24-25`、`:109-127`、`cordis.patch.yml` |
| 我们：半衰期与归档 | `lib/core/long-memory.js:1133-1152`、`:1178-1208`、`:1008-1059` |
| 我们：体检与对账 | `lib/core/audit.js:73`、`lib/index.js:793`、`:845` |
| 我们：面板（HEAD 五块 / 工作区七块） | `README.md:145-155` |
| 我们：不加密是明示取舍 | `README.md:300`（工作区 313） |
| 我们：测试与 CI | `test/` 5 文件 1778 行（HEAD）、`.github/workflows/ci.yml` |
| 抖音链接未证实 | 见 §0；抖音页面正文不可得，仅有链接字符串 |

**未确认项**（不能当事实用）：

- 视频简介的链接是否就是这两个仓库（§0）。
- 前端演示数据里出现的 `memory/shared.sqlite` 的 `memory_entries` 表，是否对应作者本机一套**未开源**的记忆实现。仓库内无任何对应代码，因此无法判断这是「本地有、没上传」还是「纯文案」。按现有证据只能算**未确认**。
- Release 资产的下载数（查询时为 30 / 4 / 7）是查询时刻的快照，会变。

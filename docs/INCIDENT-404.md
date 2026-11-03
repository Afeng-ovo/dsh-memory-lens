# 事故复盘：装上新版后「记忆」面板报 404

- 日期：2026-11-03
- 影响：`dsh-memory-lens` 插件完全加载失败，三个工具（`remember`/`recall`/`forget`）消失，六条 API 路由全部未注册，设置页「记忆」面板显示 `请求失败 (HTTP 404)`，所有计数器为 0。
- 修复：`lib/tools.js:338` 一行 schema 语法。
- 耗时：用户重启 DSH 共 6 次。其中前 5 次是白重启——都在追一个错误的问题。

---

## 一、根因（一句话）

**新版给 `recall` 工具的输出 schema 写了一个 DSH 不支持的语法：`type` 数组。**

```js
// 坏的（lib/tools.js:338，改动前）
archiveReason: { type: ['string', 'null'] }
```

DSH 的 `defineTool` **只接受单一类型字符串**，不接受 `type: ['a','b']` 这种联合写法。它抛出的错是：

```
JsonSchemaError: unsupported JSON schema:
schema.properties.archived.properties.items.items.properties.archiveReason.type
must be string/number/integer/boolean/null/array/object/json, or use oneOf
    at registerMemoryTools (tools.js:280)
```

### 为什么一行语法能让整个插件死掉

调用链是这样的：

```
apply()                              ← 插件入口
  └─ registerMemoryTools()           ← 注册三个工具
       └─ defineTool({...recall...}) ← 这里抛错
            └─ valueSchemaSpecToJsonSchema()
                 └─ compileValueSchema()
                      └─ authorError()  ← 抛出
```

`defineTool` 在 `registerMemoryTools` 内部被**同步调用**，抛错后 `registerMemoryTools` 中断；而 `apply` 里注册工具的位置在注册路由之前，于是：

1. `recall` 没注册上（连带后面 `forget` 也没跑到）
2. **`ctx.inject(['webServer'], ...)` 那一段根本没执行到**
3. 六条 `/dsh-memory-lens/api/*` 路由一条都没注册
4. 前端面板请求 `/dsh-memory-lens/api/snapshot` → 路由不存在 → **404**

**一个 schema 写错 → 工具没了 → 路由没了 → 面板 404 全零。** 面板报的是"请求失败"，但病根在完全不相干的一行 schema 声明上。

### 修复

```js
// 好的（当前代码）
archiveReason: { oneOf: [{ type: 'string' }, { type: 'null' }] }
```

`oneOf` 是 DSH 支持的写法，语义等价（"要么是字符串，要么是 null"）。

全仓扫描确认：**只有这一处**，没有同类隐患。

```bash
grep -n "type: \[" lib/tools.js lib/index.js    # 无输出
```

---

## 二、为什么绕了远路（这段最该记住）

### 错误 1：拿 curl 的 404 当证据（致命）

我用 `curl` 打插件接口拿到 404，就断定"插件没加载"。

**这个证据从一开始就是假的。** DSH 对**未认证**请求一律返回 404——不管路由存不存在。我用无认证的 curl 去测一个需要认证的接口，404 是必然结果，和插件状态无关。

后来拿到认证路径后 `curl` 返回 **200**，才真正证明插件在工作。**在那之前所有的 404 都不能作为任何结论的依据。**

> **教训**：一个探测手段如果"无论被测对象好坏都返回同一个结果"，它就不是探测手段，是噪声。用之前先问：这个命令在"好"和"坏"两种情况下输出会不一样吗？如果不会，它测不出任何东西。

### 错误 2：插探针时把模块搞坏了，还拿坏掉的现场当证据

为了打日志，我在 `lib/tools.js` 里插了一段 `const`，**位置夹在两条 `import` 语句中间**：

```js
import { ... } from './core/long-memory.js';
const T = ...;                              // ← 致命：ESM 要求 import 必须在顶层且可提升
import { defineTool } from '@deepseek-ai/dsh-tools';
```

ESM 规范下这会直接让**整个模块加载失败**。结果探针日志文件完全是空的——连第一行"apply 被调用"都没打出来。

然后我把"日志全空"当成了新证据，推出"`defineTool` 抛错导致 apply 没跑"的结论。**这个结论也是假的**，它只是我自己弄坏模块的后果。

> **教训**：探针本身会改变被测系统。**在相信任何探针结果之前，先确认探针没把系统弄坏。** 加探针后跑一遍 `node --check` 是最低要求；如果日志异常地"全空"，第一个怀疑对象应该是探针本身，不是被测代码。

### 错误 3：连续 5 次重启，每次都说"这次会有答案"

插件代码改动确实需要重启 DSH 才生效，这没错。**但重启是验证手段，不是排查手段。** 我在本地没有复现能力的情况下，把重启当成了唯一的实验工具——每次重启只能拿到一个"是/否"，信息量极低，而代价是打断用户。

正确顺序应该是：**先在本地把加载路径跑通、复现出失败、定位到行，再动用户环境。** 最后这次就是这么做的，一次就中了。

> **教训**：当排查需要用户配合做重复动作（重启、点按钮、复现操作）时，说明本地复现能力不足。**先补本地复现能力**，别把用户当调试器。

### 错误 4：几个被推翻的猜测（记录备查）

| 猜测 | 结论 | 怎么被推翻的 |
|---|---|---|
| 是并发锁 / `store-lock.js` 的问题 | ✗ | 锁模块单独 import 完全正常 |
| 是 `additionalProperties: false` 不被支持 | ✗ | 它是合法关键字，只要求是布尔值 |
| 是 `output.schema` 走了严格校验 | ✗ | `:488` 只对 `parameters` 走严格校验，`output` 只做 `cloneJson` |
| 是 `dsh-tools` 依赖缺失 | ✗ | 它是宿主注入的 optional peerDependency，旧版同样 import |
| 是 store 读失败导致空库 | ✗ | `loadError` 为 null，39 条读得对 |
| 是插件被重复注册（两份 patch） | ✗ | 原版就自带 patch 文件，属正常形态 |

**六个猜测全错。** 真正的定位来自一次本地实测，不是任何推理。

---

## 三、正确的排查方法（可复用）

### 核心手法：把宿主真实的校验函数从 `app.asar` 里抠出来，在本地跑

这是本次唯一有效的手段。DSH 是 Electron 应用，运行时包在 `app.asar` 里，但 asar 只是个归档格式，可以手工解出来。

**为什么必须用"真实"的校验函数**：自己照着报错信息重写一遍校验逻辑，等于用自己的理解去验证自己的理解，测不出东西。必须用宿主真正会执行的那份代码。

#### 步骤 1：从 asar 提取包

```python
# 手工读 asar 头，不需要 electron/asar 工具（npx 会撞 npm 缓存 EPERM）
import struct, json, os
f = open('D:/deepseek harness/resources/app.asar', 'rb')
d = f.read(16)
hdr_size = struct.unpack('<I', d[12:16])[0]        # 头长度在偏移 12
hdr = json.loads(f.read(hdr_size).decode('utf-8', 'replace'))
base = 16 + hdr_size                                # 文件数据起点

res = {}
def walk(node, path=''):
    for k, v in node.get('files', {}).items():
        p = path + '/' + k
        if 'files' in v:
            walk(v, p)
        elif v.get('offset') is not None:            # ← 有些条目 offset 是 None（符号链接）
            res[p] = (int(v['offset']), int(v.get('size') or 0))   # ← offset/size 可能是字符串，要 int()
walk(hdr)

out = 'C:/Users/风/工作之神/_ml/_asarpkg/node_modules'
for p, (off, size) in res.items():
    if not p.startswith('/dsh/node_modules/@deepseek-ai/'):
        continue
    if not p.endswith(('.js', '.json', '.mjs', '.cjs')):
        continue
    dst = os.path.join(out, p[len('/dsh/node_modules/'):])
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    f.seek(base + off)
    open(dst, 'wb').write(f.read(size))
```

**两个坑**（都踩过）：
- `offset`/`size` 在 asar 头里**可能是字符串**，直接相加会 `TypeError`，必须 `int()`
- 有些条目 `offset` 是 `None`（符号链接），必须跳过

**一个偷懒的坑**：只提取 `dsh-tools` 是不够的，它的依赖链很长（`cordis` → `cosmokit` → `dsh-llm` → …）。**直接把 `/dsh/node_modules/@deepseek-ai/` 下全部 2900+ 个文件一次性提出**，比一个个补依赖快得多。

#### 步骤 2：写探针，跑真实的注册函数

```js
// 用真实 defineTool 跑真实 registerMemoryTools
const BASE = new URL('file:///' + 'C:/Users/风/工作之神/_ml/_newver'.replace(/\\/g, '/')).href;
const { registerMemoryTools } = await import(`${BASE}/tools.js`);
const { MemoryStore, resolveStoreFile } = await import(`${BASE}/store.js`);

const registered = [];
const mockCtx = {
  tools: { get: () => undefined, register: (t) => { registered.push(t.name); return t; } },
  logger: { warn: () => {}, error: () => {} }
};
const store = new MemoryStore(resolveStoreFile({ storeFile: 'D:/qq-bridge/state/long-memory.json' }));
store.load();
registerMemoryTools(mockCtx, { store, config: {}, afterWrite: () => {} });
console.log(registered);   // 期望 ['remember','recall','forget']
```

**Windows 路径注意**：ESM 的 `file://` URL 里中文路径必须 percent-encode，或者用 `'file:///' + path.replace(/\\/g,'/')` 再 `encodeURI`。直接拼中文路径会 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。

#### 步骤 3：连 `apply` 全流程一起验

只测 `registerMemoryTools` 不够——它过了不代表 `apply` 过了（`apply` 里还有 `systemPrompt.section`、`ctx.inject(['webServer'])` 等）。**要把六条路由是否注册也纳入断言**：

```js
const routes = [];
const mockCtx = {
  fiber: {},
  logger: { info(){}, warn(){}, error(){}, debug(){} },
  systemPrompt: { section: () => ({ dispose(){} }) },
  tools: { get: () => undefined, register: () => {} },
  inject: (deps, fn) => fn({ ...mockCtx,
    webServer: { register: (r) => { routes.push(r.path); return { dispose(){} }; } } }),
  on(){}, effect(){}
};
await mod.apply(mockCtx, { storeFile: '...', /* 其余 config */ });
console.log(routes);   // 期望 6 条，含 /dsh-memory-lens/api/snapshot
```

**这一步能提前发现"工具没了 → 路由也没了"这种连锁故障**，比等用户重启后看面板快得多。

---

## 四、通用排查清单（下次直接照着走）

### 装插件后"面板/工具消失"类故障

1. **不要用无认证 curl 判断插件是否加载。** 先拿到真实认证后的响应码；`200` 才说明路由在。
2. **先在本地复现，再动用户环境。** 从 `app.asar` 提取宿主包 → 用真实校验函数跑 `apply` → 看抛什么。
3. **报错信息里的路径就是答案。** `schema.properties.archived.properties.items.items.properties.archiveReason.type` 这种路径直接指到出错的那个键，比读代码快十倍。
4. **区分"我的探针坏了"和"被测代码坏了"。** 日志异常地全空 = 先怀疑探针。
5. **一行 schema 能让整个插件死。** 注册顺序决定了爆炸半径：`defineTool` 抛错会带走后面所有 `inject`/`route`。

### DSH 的 schema 约束（本次踩到的）

| 约束 | 说明 | 违反后果 |
|---|---|---|
| `type` 必须是**单一字符串** | 不允许 `type: ['string','null']`，要用 `oneOf` | `JsonSchemaError`，工具注册失败 |
| `additionalProperties` 写了就必须是**布尔值** | 不允许 `undefined` | `must be explicitly true or false` |
| `type: 'object'` 时 `additionalProperties` **必须显式写** | 不能省略 | 同上 |
| 允许的关键字 | `type` / `oneOf` / `properties` / `required` / `additionalProperties` / `items` / `enum` / `const` + `description`/`title`/`default`/`examples` | 其他键一律报错 |
| `parameters` 与 `output.schema` 校验强度不同 | `parameters` 走 `normalizeParameterSchemaSpec` 严格校验；`output.schema` 只做 `cloneJson` 再 `assertSupportedJsonSchema` | 两边都要过 `assertSupportedJsonSchema` |

### 判断"是不是我改坏的"

1. 用 `_ml/_pristine/`（从 `ml.zip` 解出的原始包）做基线，**不要用工作副本互比**——多 agent 并行改过的工作副本不可信。
2. `git diff` 看改动面。本次事故修复的 diff 是 **1 行**，这是最强的信号：问题就在这一行。
3. 改动面小 + 故障面大（一个 schema → 整个插件死）是**正常的**，不要因为"只改了一行不可能坏成这样"就排除它。

---

## 五、最终验证记录

修复后对**正式安装目录**（不是副本）跑的验证：

```
=== 1. 模块导入 ===
✓ store.js   ✓ core/long-memory.js   ✓ core/store-lock.js   ✓ core/audit.js

=== 2. registerMemoryTools（真实 defineTool）===
✓ 注册工具: [ 'remember', 'recall', 'forget' ]

=== 3. apply 全流程 ===
✓ apply 跑通
  工具: [ 'remember', 'recall', 'forget' ]
  路由: 6 条
     /dsh-memory-lens/api/snapshot
     /dsh-memory-lens/api/item
     /dsh-memory-lens/api/action
     /dsh-memory-lens/api/import
     /dsh-memory-lens/api/audit
     /dsh-memory-lens/api/diff
```

测试套件（9 个文件，直接 `node test/xxx.mjs`，不要用 `node --test`——沙箱里会 `spawn EPERM`）：

```
test/tools.test.mjs              ✓
test/host.test.mjs               ✓
test/audit.test.mjs              ✓
test/inject-quota.test.mjs       ✓
test/client.test.mjs             ✓
test/_probe-p02.mjs              ✓
test/_probe-f1-archive-bound.mjs ✓
test/_probe-contract-host.mjs    ✓
test/_dsh-tools-stub.mjs         （stub，被上面几个引用，不单独跑）
```

真实数据（`D:\qq-bridge\state\long-memory.json`）：

| 项 | 值 |
|---|---|
| 条数 | 39（`buckets.shared` 下，单桶结构） |
| 状态 | active 37 / superseded 2 |
| 固定层 | 5 |
| `loadError` | null |
| 删除保护 | 删除后重读 36 条，**不复活** |
| 文件大小 | 31197 → 32121 字节（**变大是正常的**：验证时调用 `recall` 更新了 `hits`/`lastUsedAt`，说明插件在正常工作，不是数据被改坏） |

重启后实测：

```
GET /dsh-memory-lens/api/snapshot  →  200
{"ok":true,"loadError":null,"items":[ ... 39 条 ... ]}
```

面板计数器与真实库一致。

---

## 六、回滚手段（保留）

如果以后再出现类似问题，先恢复可用再排查：

```bash
bash _ml/rollback.sh    # 恢复到 _ml/backup-installed-20261103-095640/lib
```

或在 `D:/dsh-memory-lens` 里：

```bash
git revert 9bf074f      # 撤掉整个第 1 批 P0
```

**注意**：回滚只能恢复到"能用"，P0 的五条修复会一起没了。**优先定位那一行，而不是整体回滚。**

---

## 七、一句话总结

> **一个 schema 写错，整个插件死掉，面板报 404——但 404 是症状，不是病因。**
>
> 真正的病因藏在报错信息的最后一行路径里。找到它需要的不是更聪明的推理，而是**把宿主真实的校验代码跑起来**。
>
> 而在此之前所有的推理——包括 5 次重启——都是在为一个自己制造的假证据找解释。

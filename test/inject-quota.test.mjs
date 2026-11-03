// 注入配额的回归自检：**在真实的宿主注入路径上**验「已完成」占比 ≤ 1/4。
//
// 【为什么必须单独有这个文件】
// `_ml/p0-probes/probe-host-half.mjs` 的 ⑤ 是直接调 `core.selectLayeredMemories`，
// 拿到的必然是 core 的默认行为（20 resolved + 3 active、limit 12 → 9 条历史，75%）。
// 而本批的落点是**宿主层**：core 一行不改，配额在 index.js 的候选集上裁。
// 于是那条探针永远 FAIL —— 不是实现没做，是探针绕过了实现所在的那一层。
//
// 光靠「我本地跑过一遍」不算证据（跑完就删的临时脚本谁也没法复现），
// 所以把它落成这个测试：谁都能 `node test/inject-quota.test.mjs` 复现。
//
// 三条断言都刻意避开平凡通过：
//   · 占比断言先要求 `lines.length > 0` —— 0/0 不算达标；
//   · 分母是「最终注入的条数」，不是配置的 limit（候选被裁后条数会少于 limit，
//     3 条待办 + 3 条历史时若按 limit 算配额，占比会是 50%）；
//   · 待办必须 3/3 全在 —— 只把历史压下去、把待办也一起挤掉，是另一种坏结果。
import './_dsh-tools-stub.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { apply, Config } = await import('../lib/index.js');

/** 造一份「20 条已完成 + 3 条待办」的库，返回 storeFile 路径。 */
function makeStore() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memlens-quota-'));
  process.env.DSH_HOME = tmp;
  const file = path.join(tmp, 'memory-lens', 'memory.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const now = Date.now();
  const items = [];
  // 20 条 resolved，时间戳全部落在近期窗口内 —— 这正是危险之处：
  // 结案动作本身（resolvedAt）会让条目重新变「新」，它们会挤进近期层。
  for (let i = 0; i < 20; i += 1) {
    items.push({
      id: `lm-res${i}`,
      kind: 'event',
      text: `已完成的事情 ${i}`,
      tags: [],
      weight: 3,
      status: 'resolved',
      createdAt: now - i * 1000,
      updatedAt: now - i * 1000,
      lastUsedAt: now - i * 1000,
      hits: 1,
      resolvedAt: now - i * 1000
    });
  }
  for (let i = 0; i < 3; i += 1) {
    items.push({
      id: `lm-act${i}`,
      kind: 'fact',
      text: `待办的事情 ${i}`,
      tags: [],
      weight: 3,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
      hits: 0
    });
  }
  // meta.pinnedSeededAt 非零：跳过首次自动钉，避免它改掉这 23 条的固定层分布。
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 2, buckets: { shared: items }, meta: { pinnedSeededAt: now } }),
    'utf8'
  );
  return file;
}

/** 装配一次插件，返回注入文本（等价于宿主每轮求值 section.text）。 */
function injectionText(overrides) {
  const file = makeStore();
  const sections = [];
  const ctx = {
    logger: { warn() {}, info() {}, error() {}, debug() {} },
    systemPrompt: {
      getSectionOrder: () => undefined,
      section: (s) => (sections.push(s), () => {})
    },
    tools: { register() {} },
    effect: (fn) => fn(),
    // 没有 webServer 服务：这个文件只测注入，不该顺带挂面板路由。
    inject: () => undefined
  };
  apply(ctx, Config({ storeFile: file, ...overrides }));
  assert.equal(sections.length, 1, '应该只注册一个系统提示 section');
  return sections[0].text({});
}

let pass = 0;
const results = [];
function check(title, ok, detail) {
  results.push(`${ok ? '✓' : '✗'} ${title} — ${detail}`);
  assert.ok(ok, `${title}（${detail}）`);
  pass += 1;
}

for (const topicOn of [true, false]) {
  const label = topicOn ? '话题层开' : '话题层关';
  const text = injectionText({ injectTopicEnabled: topicOn });
  const lines = text.split('\n').filter((l) => l.startsWith('- ['));
  const done = lines.filter((l) => l.includes('· 已完成')).length;
  const todo = lines.filter((l) => l.includes('待办的事情')).length;
  const ratio = lines.length ? done / lines.length : 0;
  check(
    `【P1-5】${label}：20 resolved + 3 active → 已完成占比 ≤ 25%`,
    lines.length > 0 && ratio <= 0.25 + 1e-9,
    `注入 ${lines.length} 条：已完成=${done} 待办=${todo}，占比=${(ratio * 100).toFixed(1)}%`
  );
  check(
    `【P1-5】${label}：3 条待办全部被注入（不能被历史挤掉）`,
    todo === 3,
    `待办 ${todo}/3 条`
  );
}

// 配额的下限是 1 条，不是 0：只留 active 会让「结案」变成「再也想不起来」，
// 那和删除没有区别。用户结案的意思是「这件事完了」，不是「这件事不许再提」。
{
  const text = injectionText({});
  const lines = text.split('\n').filter((l) => l.startsWith('- ['));
  const done = lines.filter((l) => l.includes('· 已完成')).length;
  check(
    '【P1-5】配额有下限：历史被压到 1 条，但不会被压到 0 条',
    done === 1,
    `注入 ${lines.length} 条，其中已完成 ${done} 条（期望恰好 1 条）`
  );
}

console.log(results.join('\n'));
console.log(`\n注入配额自检：${pass}/${pass} 项通过`);

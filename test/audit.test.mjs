// 记忆库体检与对账的自检。
//
// 这两个功能最怕的不是算错，而是**报错了地方**：把「同一条记忆在两边 id 不同」
// 报成「记忆丢了」，用户就会去补一堆重复条目；把「一条生效一条归档」报成
// 「正文重复」，用户就会去删掉正常的历史。所以下面每个用例都在钉住「不误报」。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditStore, compareStores, pairKey } from '../lib/core/audit.js';
import { normalizeStore, writeLongMemoryStore } from '../lib/core/long-memory.js';

let failures = 0;
function test(name, run) {
  try {
    run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}`);
    console.log(`     ${error?.message ?? error}`);
  }
}

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);

function mk(over = {}) {
  return {
    id: 'lm-a',
    kind: 'fact',
    text: '阿风在准备考研',
    tags: [],
    weight: 3,
    status: 'active',
    createdAt: NOW - 2 * DAY,
    lastUsedAt: NOW - 2 * DAY,
    updatedAt: NOW - 2 * DAY,
    hits: 0,
    ...over
  };
}

function codes(report) {
  return report.findings.map((f) => f.code);
}

// ── 配对键 ───────────────────────────────────────────────────────────────
test('配对键只由「正文 + 类型」决定，与 id 无关', () => {
  const a = mk({ id: 'lm-from-bridge' });
  const b = mk({ id: 'lm-from-plugin' });
  assert.equal(pairKey(a), pairKey(b));
  // 同一句话换个类型是两条不同的记忆（「喜欢猫」是偏好，「家里养了猫」是事实）
  assert.notEqual(pairKey(mk({ kind: 'pref' })), pairKey(mk({ kind: 'fact' })));
});

// ── 单库体检：干净的库不能报任何问题 ─────────────────────────────────────
test('正常的库不报问题', () => {
  const report = auditStore([mk(), mk({ id: 'lm-b', text: '阿风的生日是10月18', kind: 'event' })], { now: NOW });
  assert.equal(report.ok, true, `不该有问题，却报了：${JSON.stringify(report.findings)}`);
  assert.equal(report.checked, 2);
});

// ── 单库体检：能抓到的问题 ───────────────────────────────────────────────
test('id 重复被抓到', () => {
  const report = auditStore([mk(), mk({ text: '另一件事' })], { now: NOW });
  assert.ok(codes(report).includes('duplicate-id'));
  assert.equal(report.counts.high, 1);
});

test('同一条记忆存了两份被抓到', () => {
  const report = auditStore([mk(), mk({ id: 'lm-b' })], { now: NOW });
  assert.ok(codes(report).includes('duplicate-text'), '正文相同、都生效，就是存了两份');
});

test('一条生效一条归档不算重复（复活过是正常的）', () => {
  const report = auditStore([
    mk(),
    mk({ id: 'lm-b', status: 'archived', archivedAt: NOW - DAY })
  ], { now: NOW });
  assert.ok(!codes(report).includes('duplicate-text'), '归档的那条已经不参与注入，不算白占预算');
  assert.equal(report.ok, true);
});

test('取代目标不存在被抓到（悬空引用）', () => {
  const report = auditStore([
    mk({ status: 'superseded', supersededBy: 'lm-gone' })
  ], { now: NOW });
  assert.ok(codes(report).includes('dangling-supersededBy'));
});

test('取代目标存在就不报', () => {
  const report = auditStore([
    mk({ id: 'lm-new' }),
    mk({ id: 'lm-old', text: '阿风在准备考公', status: 'superseded', supersededBy: 'lm-new' })
  ], { now: NOW });
  assert.ok(!codes(report).includes('dangling-supersededBy'));
});

test('时间戳写成秒被抓到（会在未来）', () => {
  // 秒当毫秒用：2026 年的秒级时间戳是 1.7e9 左右，按毫秒读就成了 1970 年；
  // 反过来把毫秒当秒存，会变成几万年以后。这里用后者，它更常见于「*1000」的误用。
  const report = auditStore([mk({ createdAt: NOW * 1000 })], { now: NOW });
  assert.ok(codes(report).includes('future-createdAt'));
});

test('缺少创建时间被抓到', () => {
  const report = auditStore([mk({ createdAt: 0 })], { now: NOW });
  assert.ok(codes(report).includes('missing-createdAt'));
});

test('正文为空被抓到', () => {
  const report = auditStore([mk({ text: '   ' })], { now: NOW });
  assert.ok(codes(report).includes('empty-text'));
});

test('未知状态/类型被抓到', () => {
  const report = auditStore([mk({ status: 'deleted', kind: 'note' })], { now: NOW });
  assert.ok(codes(report).includes('unknown-status'));
  assert.ok(codes(report).includes('unknown-kind'));
});

test('强度低于阈值却还生效，说明整理没跑过', () => {
  // 造三条都低于阈值：单条不报（可能是刚导入的老数据），三条才说明是系统性问题。
  const weak = [0, 1, 2].map((i) => mk({ id: `lm-w${i}`, text: `早就该沉的事 ${i}`, strength: 0.1 }));
  const report = auditStore(weak, { now: NOW, archiveBelow: 0.6 });
  assert.ok(codes(report).includes('never-organized'));
  // 一条不报 —— 否则刚导入一批老数据时会刷屏
  assert.ok(!codes(auditStore([mk({ strength: 0.1 })], { now: NOW })).includes('never-organized'));
});

test('到期没提醒被抓到', () => {
  const report = auditStore([
    mk({ kind: 'promise', text: '周六去看海', dueAt: { when: '周六', date: '2026-10-26', ts: NOW - DAY } })
  ], { now: NOW });
  assert.ok(codes(report).includes('due-not-reminded'));
});

test('每条问题都带「怎么办」', () => {
  const report = auditStore([
    mk(), mk({ id: 'lm-b' }), mk({ id: 'lm-c', createdAt: 0 }), mk({ id: 'lm-d', status: 'archived' })
  ], { now: NOW });
  assert.ok(report.findings.length >= 3);
  for (const f of report.findings) {
    assert.equal(typeof f.fix, 'string');
    assert.ok(f.fix.length > 0, `问题 ${f.code} 没说怎么修`);
    assert.ok(['high', 'medium', 'low'].includes(f.severity), `问题 ${f.code} 的严重度不认识`);
  }
});

// ── 两库对账 ─────────────────────────────────────────────────────────────
test('完全一致的两份库（id 全不同）判为一致', () => {
  const left = [mk({ id: 'lm-plugin-1' }), mk({ id: 'lm-plugin-2', text: '生日是10月18', kind: 'event' })];
  const right = [mk({ id: 'lm-bridge-9' }), mk({ id: 'lm-bridge-8', text: '生日是10月18', kind: 'event' })];
  const report = compareStores(left, right);
  assert.equal(report.ok, true, `不该有差异：${JSON.stringify(report)}`);
  assert.equal(report.identical, 2);
  assert.equal(report.counts.onlyLeft, 0);
  assert.equal(report.counts.onlyRight, 0);
});

test('只在一侧的记忆被分别列出', () => {
  const left = [mk(), mk({ id: 'lm-b', text: '只有这边有' })];
  const right = [mk({ id: 'lm-r1' }), mk({ id: 'lm-r2', text: '只有那边有' })];
  const report = compareStores(left, right);
  assert.equal(report.ok, false);
  assert.equal(report.onlyLeft.length, 1);
  assert.equal(report.onlyLeft[0].text, '只有这边有');
  assert.equal(report.onlyRight.length, 1);
  assert.equal(report.onlyRight[0].text, '只有那边有');
});

test('同一句话不同状态算「有差异」而不是「缺一条」', () => {
  const left = [mk({ status: 'active' })];
  const right = [mk({ id: 'lm-r', status: 'archived' })];
  const report = compareStores(left, right);
  assert.equal(report.counts.onlyLeft, 0, '能配对上就不该报成「只在一侧」');
  assert.equal(report.differing.length, 1);
  const fields = report.differing[0].fields.map((f) => f.field);
  assert.deepEqual(fields, ['status']);
});

test('标签顺序不同不算差异', () => {
  const left = [mk({ tags: ['生日', '约定'] })];
  const right = [mk({ id: 'lm-r', tags: ['约定', '生日'] })];
  const report = compareStores(left, right);
  assert.equal(report.ok, true, '标签是集合，顺序不该算不一致');
});

test('标签内容不同算差异', () => {
  const left = [mk({ tags: ['生日'] })];
  const right = [mk({ id: 'lm-r', tags: ['生日', '约定'] })];
  const report = compareStores(left, right);
  assert.equal(report.differing.length, 1);
  assert.equal(report.differing[0].fields[0].field, 'tags');
});

test('权重不同算差异', () => {
  const report = compareStores([mk({ weight: 5 })], [mk({ id: 'lm-r', weight: 2 })]);
  assert.equal(report.differing[0].fields[0].field, 'weight');
});

test('创建时间差几秒不算差异，差几天算', () => {
  const close = compareStores([mk({ createdAt: NOW })], [mk({ id: 'lm-r', createdAt: NOW - 5000 })]);
  assert.equal(close.ok, true, '几乎同时写下的事，时间差几秒不该算不一致');
  const far = compareStores([mk({ createdAt: NOW })], [mk({ id: 'lm-r', createdAt: NOW - 5 * DAY })]);
  assert.equal(far.ok, false);
  assert.equal(far.differing[0].fields[0].field, 'createdAt');
});

test('一侧本来就有两条重复正文时，不误报成另一侧缺一条', () => {
  // 这是最容易写错的地方：用 Map<key, item> 会让后一条覆盖前一条，
  // 于是「库里本来就两份」被报成「另一侧缺一条」，指错了地方。
  const left = [mk({ id: 'lm-1' }), mk({ id: 'lm-2' })];
  const right = [mk({ id: 'lm-r1' }), mk({ id: 'lm-r2' })];
  const report = compareStores(left, right);
  assert.equal(report.onlyLeft.length, 0);
  assert.equal(report.onlyRight.length, 0);
  assert.equal(report.identical, 2);
});

test('一侧正文带标签尾巴、另一侧没有，仍然算同一条', () => {
  // 真实踩到过的误报：桥接库的正文末尾写着「（陪伴、阿风、私聊、承诺）」，
  // 插件库导入时清掉了尾巴。按原样配对会把同一条判成「这边少一条、那边多一条」，
  // 用户就会去补一条根本不缺的记忆。
  const withTail = mk({
    id: 'lm-bridge',
    text: '阿风说「有我陪你」。（陪伴、阿风、私聊、承诺）',
    tags: ['陪伴', '阿风', '私聊', '承诺']
  });
  const without = mk({
    id: 'lm-plugin',
    text: '阿风说「有我陪你」。',
    tags: ['陪伴', '阿风', '私聊', '承诺']
  });
  const report = compareStores([without], [withTail]);
  assert.equal(report.counts.onlyLeft, 0, '不能报成「这边缺一条」');
  assert.equal(report.counts.onlyRight, 0, '不能报成「那边多一条」');
  assert.equal(report.identical, 1, '这就是同一条记忆，剥掉标签尾巴后正文相同');
});

test('正文里的长句括注是内容，不能当标签尾巴剥掉', () => {
  // 「（关系升温的一次对话）」是用户写进正文的话，不是标签。
  // 剥错了就会把两条不同记忆配成同一条 —— 比误报缺一条更糟。
  const a = mk({ text: '阿风说咱家不缺钱（关系升温的一次对话）', tags: ['阿风', '关系'] });
  const b = mk({ id: 'lm-r', text: '阿风说咱家不缺钱', tags: ['阿风', '关系'] });
  const report = compareStores([a], [b]);
  assert.equal(report.counts.onlyLeft, 1, '长句括注属正文，剥掉后就不该配上对');
  assert.equal(report.identical, 0);
});

test('对账结果里的数字和列表长度一致', () => {
  const left = [mk(), mk({ id: 'lm-b', text: '只在这边' })];
  const right = [mk({ id: 'lm-r', weight: 1 }), mk({ id: 'lm-r2', text: '只在那边' })];
  const report = compareStores(left, right);
  assert.equal(report.counts.left, left.length);
  assert.equal(report.counts.right, right.length);
  assert.equal(report.counts.onlyLeft, report.onlyLeft.length);
  assert.equal(report.counts.onlyRight, report.onlyRight.length);
  assert.equal(report.counts.differing, report.differing.length);
  assert.equal(
    report.counts.identical + report.counts.differing + report.counts.onlyLeft,
    left.length,
    '左边每一条都必须有归属：一致 / 有差异 / 只在这边'
  );
});

// ── 真实形状：另一份文件是另一个程序的库 ─────────────────────────────────
test('能读另一份「另一个程序写的」库并对比', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memlens-audit-'));
  try {
    const otherFile = path.join(tmp, 'other.json');
    // 桥接那边写出来的真实形状：{version:2, buckets:{shared:[...]}}
    writeLongMemoryStore(otherFile, normalizeStore({
      buckets: {
        shared: [
          { text: '阿风在准备考研', kind: 'fact', createdAt: NOW - 2 * DAY },
          { text: '只有桥接有的一条', kind: 'event', createdAt: NOW - DAY }
        ]
      }
    }));
    const other = normalizeStore(JSON.parse(fs.readFileSync(otherFile, 'utf8')));
    const report = compareStores([mk({ id: 'lm-plugin' })], other.buckets.shared, { rightName: 'other.json' });
    assert.equal(report.counts.left, 1);
    assert.equal(report.counts.right, 2);
    assert.equal(report.identical, 1, '同一条记忆 id 不同也必须配上对');
    assert.equal(report.onlyRight.length, 1);
    assert.equal(report.onlyRight[0].text, '只有桥接有的一条');
    assert.equal(report.rightName, 'other.json');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

if (failures > 0) {
  console.log(`\n${failures} 项失败`);
  process.exitCode = 1;
} else {
  console.log('\n体检与对账自检：全部通过');
}

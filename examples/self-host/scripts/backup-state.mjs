#!/usr/bin/env node
// 全量备份 state/ 里的关键状态文件，保留 N 天，滚动清理。
//
// 为什么独立成脚本、不塞进 bridge.js：备份必须在 bridge 进程之外也能跑。
// bridge 挂掉、被安全策略清理、或根本没起来的时候，备份仍然要能兜底——
// 备份的价值恰恰在于「主程序出事时它还在」。
//
// 备份什么：不是整个 state/（里面有大量临时/调试 json、图片缓存，几百 MB 没必要每天
// 复制），而是「丢了就回不来」的那几类：
//   - long-memory.json           长期记忆（丢了 = 她忘了我）
//   - social-v2.json             社交状态（activeTopics / pendingThoughts / 未读）
//   - session-handoff.json       换会话交接回忆
//   - slang.json                 黑话库
//   - sessions*.json / agents*   会话历史（丢了 = 她死了）
//   - config.json                配置（丢了 = 起不来）
//   - current-role.json / mode.json  角色与模式状态
// 其它文件按需用 --all 全量（一般不推荐）。
//
// 用法：
//   node scripts/backup-state.mjs           备份到默认目录（state 同级的 backups/）
//   node scripts/backup-state.mjs --keep 14 保留 14 天（默认 7）
//   node scripts/backup-state.mjs --dry-run 只打印会做什么，不真的复制
//   node scripts/backup-state.mjs --all     整个 state/ 都备份（体积大，慎用）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const STATE_DIR = path.join(ROOT, 'state');
const DEFAULT_BACKUP_DIR = path.join(ROOT, 'backups', 'state');

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const keepDays = Math.max(1, Number(getArg('--keep', '7')) || 7);
const dryRun = args.includes('--dry-run');
const all = args.includes('--all');
const backupDir = getArg('--dir', DEFAULT_BACKUP_DIR);

// 关键状态文件（按文件名匹配，支持通配）。丢了就回不来的才进这个清单。
const KEY_PATTERNS = [
  /^long-memory\.json$/,
  /^social-v2\.json$/,
  /^session-handoff\.json$/,
  /^diary\.json$/,
  /^slang\.json$/,
  /^sessions\.json$/,
  /^sessions-/,
  /^config\.json$/,   // 注意：config 在根目录，不在 state/；这里不匹配，见下方单独处理
  /^current-role\.json$/,
  /^mode\.json$/,
  /^console-token$/
];

function shouldBackup(name) {
  if (all) return true;
  return KEY_PATTERNS.some((re) => re.test(name));
}

function timestamp() {
  const d = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function copyFile(src, dst) {
  if (dryRun) { console.log(`  [dry-run] ${path.relative(ROOT, src)} -> ${path.relative(ROOT, dst)}`); return; }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function main() {
  if (!fs.existsSync(STATE_DIR)) {
    console.error(`state/ 目录不存在：${STATE_DIR}`);
    process.exit(1);
  }

  const stamp = timestamp();
  const dest = path.join(backupDir, stamp);

  const files = fs.readdirSync(STATE_DIR, { withFileTypes: true });
  const picked = files.filter((e) => e.isFile() && shouldBackup(e.name));

  if (!picked.length) {
    console.log('没有需要备份的文件（state/ 为空或清单未匹配）。');
    return;
  }

  console.log(`备份 ${picked.length} 个文件 -> ${dest}`);
  for (const e of picked) {
    copyFile(path.join(STATE_DIR, e.name), path.join(dest, e.name));
  }

  // config.json 在根目录，单独备份一份（配置丢了 = 起不来）
  const configPath = path.join(ROOT, 'config.json');
  if (fs.existsSync(configPath)) {
    copyFile(configPath, path.join(dest, '_root-config.json'));
  }

  // 滚动清理：只保留最近 keepDays 天的备份目录
  if (!dryRun && fs.existsSync(backupDir)) {
    // 只认自己生成的目录名（2026-10-27T23-03-27 这种）。
    // 早先只按 mtime 判断，`--dir .` 一跑就把目标目录下所有 30 天前的子目录
    // 递归删掉——这是整包唯一会删东西的地方，不能靠「用户不会这么用」兜底。
    const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/;
    const dirs = fs.readdirSync(backupDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && STAMP_RE.test(e.name))
      .map((e) => ({ name: e.name, mtime: fs.statSync(path.join(backupDir, e.name)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime);
    const cutoff = Date.now() - keepDays * 86400000;
    let removed = 0;
    for (const d of dirs) {
      if (d.mtime < cutoff) {
        fs.rmSync(path.join(backupDir, d.name), { recursive: true, force: true });
        removed += 1;
      }
    }
    if (removed) console.log(`清理了 ${removed} 个过期备份（保留 ${keepDays} 天）`);
  }

  if (dryRun) {
    console.log(`（--dry-run，未真正写入。去掉后真正执行，保留 ${keepDays} 天）`);
  } else {
    console.log(`完成。当前保留策略：${keepDays} 天。`);
  }
}

main();

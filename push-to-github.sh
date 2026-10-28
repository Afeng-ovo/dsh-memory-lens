#!/usr/bin/env bash
# 一键把 dsh-memory-lens 推到 GitHub（Afeng-ovo/dsh-memory-lens）
#
# 用法：bash push-to-github.sh
#
# 前置：你的 GitHub 账号有 push 权限。脚本会先试 SSH，失败再退回 HTTPS。
set -euo pipefail
cd "$(dirname "$0")"

REPO="Afeng-ovo/dsh-memory-lens"
KEY="$HOME/.ssh/dsh-memory-lens"

echo "== 1/5 检查仓库状态 =="
git status --short || true

echo
echo "== 2/5 确认提交都在本地 =="
git log --oneline | head -5

echo
echo "== 3/5 设置远程地址 =="
# 优先 SSH：避开 HTTPS 每次都要凭据的麻烦
if [ -f "$KEY" ]; then
  git remote remove origin 2>/dev/null || true
  git remote add origin "git@github.com:$REPO.git"
  echo "origin = git@github.com:$REPO.git"
  echo
  echo "  公钥（若 GitHub 上还没加，去 https://github.com/settings/keys 添加）："
  echo "  ------------------------------------------------------------"
  cat "$KEY.pub"
  echo "  ------------------------------------------------------------"
  echo
  read -r -p "  已把公钥加到 GitHub 了吗？按回车继续（Ctrl+C 退出）..." _
else
  git remote remove origin 2>/dev/null || true
  git remote add origin "https://github.com/$REPO.git"
  echo "origin = https://github.com/$REPO.git"
fi

echo
echo "== 4/5 推送 =="
git branch -M main
if git push -u origin main; then
  echo "推送成功。"
else
  echo "推送失败。常见原因："
  echo "  · 仓库还不存在 —— 去 https://github.com/new 建一个同名空仓库（不要勾 README/gitignore）"
  echo "  · 公钥没加到 GitHub，或账号没有该仓库权限"
  echo "  · 网络问题，重试即可"
  exit 1
fi

echo
echo "== 5/5 完成 =="
echo "仓库：https://github.com/$REPO"
echo "别人安装：dsh plugin add $REPO   （或设置 → 插件 → 添加插件里填这个地址）"

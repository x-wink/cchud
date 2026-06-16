#!/usr/bin/env bash
# cchud — mac/Linux 启动器：调用同目录下的 hud.js
# 在 ~/.claude/settings.json 里把 statusLine.command 指向本脚本即可。
exec node "$(dirname "$0")/hud.js"

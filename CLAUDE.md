# CLAUDE.md

给 Claude Code / Codex 在本仓库工作时的指引。

通用协作约定（语言、提交粒度与推送时机、注释与文档风格、危险动作授权）见全局 `~/.claude/CLAUDE.md`，是单一事实来源。本文件只写 cchud 特有的部分，不复述全局条目——复述必然漂移。

## 这是什么

`cchud` 是给 [Claude Code](https://claude.com/claude-code) 用的 `statusLine` 脚本，外加可选的通知钩子与实时状态源。Claude Code 通过 stdin 把会话 JSON 喂进这些脚本：`hud.js` 输出三行带颜色的终端状态栏，`notify.js` 弹桌面通知 + 播提示音，`state.js` 把钩子事件记成状态文件。纯 Node.js、**零依赖**，无构建步骤、无测试套件、无 `package.json`。README 与全部代码注释为中文。

## 跑起来 / 调试

没有任何构建或安装步骤。验证方式是往 stdin 喂假的会话 JSON：

```sh
# 状态栏 —— 用假状态渲染（HUD_FAKE_STATE=busy|idle|bash|read|web|edit|wait 强制小兽姿态）
echo '{"context_window":{"used_percentage":42},"rate_limits":{"five_hour":{"used_percentage":63}},"model":{"display_name":"Opus 5"},"cost":{"total_cost_usd":1.23}}' | HUD_FAKE_STATE=busy node hud.js

# 通知 —— j.hook_event_name 选分支（"Notification" vs 其他 = Stop）；
# Notification 还要看 notification_type，只有阻断类才真的弹（见下方 config.js）
echo '{"cwd":"/some/proj","hook_event_name":"Notification","notification_type":"permission_prompt","message":"needs Bash"}' | node notify.js

# 钩子状态源 —— 先模拟一个钩子事件，再用它渲染（CCHUD_STATE_DIR 把状态目录指到别处）
echo '{"hook_event_name":"PreToolUse","session_id":"t1","tool_name":"Bash"}' | CCHUD_STATE_DIR=/tmp/s node state.js
echo '{"session_id":"t1","transcript_path":"/tmp/t1.jsonl"}' | CCHUD_STATE_DIR=/tmp/s node hud.js

# 重新生成 preview.png 所截自的预览页
node tools/preview.js   # 输出 tools/preview.html
```

在 Windows 的 Git Bash 里跑这些命令时注意：`$TEMP` 之类含反斜杠的路径传给 `node -e` 会被吞掉转义符（`C:\Users\...` 变成 `C:Users...`），改用正斜杠路径。

## 架构

四个源文件，`config.js` 被所有入口共用。

- **`hud.js`** —— statusLine 入口。从 stdin 读会话 JSON，输出三行。状态解析分两级（`resolveState`）：注册了 `state.js` 钩子时，刚写入的钩子状态文件优先（即时、精确）；否则回落到扫 transcript（`j.transcript_path`）末尾约 40 行找最后一个有意义事件——assistant 的 `tool_use`/`thinking` → 忙，assistant 的 `text` → 闲，`user` 角色 → 忙（**不是**看文件 mtime，那会把「刚干完」判错）。即便有钩子，transcript 仍用来补钩子盲区：用户中断 / 秒取消不触发任何钩子，所以比钩子事件更新的中断标记（或悬挂超过 `IDLE_AFTER_MS` 的 `UserPromptSubmit`）会强制判闲——`wait` 同样要过这道中断检查，因为 ESC 掉授权对话框也不触发钩子；状态文件比 transcript 旧 10 分钟以上说明钩子已被卸载 → 完全回落。颜色：橙 = 忙，绿 = 闲，黄 = 等确认（只有钩子链路能给出）。待办从 transcript 读（Task 事件，回落 `TodoWrite`）。尾行末尾的项目名取 `workspace.project_dir` 的目录名（`cd` 进子目录时不变，比 `cwd` 稳定）。
- **`state.js`** —— 可选的钩子入口，注册在 `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop` / `Notification` / `SessionStart` / `SessionEnd` 上，全部指向同一个脚本。把 `hook_event_name` 映射成状态（`PreToolUse` 经共享的 `toolState` 按 `tool_name` 细分，`Notification` 经共享的 `notificationState` 分档），原子写入 `<stateDir>/<session_id>.json`（临时文件 + rename）；`SessionEnd` 删除该文件，闲置超 24 小时的文件顺手 GC。钩子注册时带 `"async": true`，绝不阻塞 Claude Code（主进程绝对优先；状态是尽力而为——极少数乱序写入会被下个事件自然纠正）。脚本自始至终只做一次小文件写入，且从不往 stdout 输出（同步注册时 `UserPromptSubmit` 钩子的 stdout 会被注入成对话上下文）。
- **`notify.js`** —— 同时注册为 `Stop` 与 `Notification` 钩子、指向同一脚本，内部按 `j.hook_event_name` 分支。`Notification` 只在 `notificationState()` 判为 `wait` 时才弹——即真的有东西卡着等你；闲置提醒与杂项通知一律静默。**不用 `detached + unref`**：实测 Windows 上 detached 子进程会随父进程退出被一起回收，toast 来不及注册就没了，所以改为让本进程等子进程跑完（约 1 秒，`PlaySync` 会等提示音播完）。Windows = PowerShell WinRT Toast（静音）+ `SoundPlayer` 播 `.wav`（不同事件不同音），macOS = `osascript`，Linux = `notify-send` + `paplay`。
- **`config.js`** —— `loadConfig()` 为所有脚本合并配置，并导出两个共享判定，让各条链路只有一份定义：`toolState`（工具名 → 小兽姿态，`hud.js` + `state.js` 用）与 `notificationState`（`notification_type` → `wait`/`think`/`idle`/`null`，`state.js` + `notify.js` 用）。**`wait` 只有一个含义：终端弹出了必须用户操作才能往下走的交互**（授权 / 输入对话框、`agent_needs_input`）。特别注意 `idle_prompt`——Claude Code 在闲置超过 `CLAUDE_CODE_IDLE_THRESHOLD_MINUTES`（默认 75 分钟）后发的「Claude is waiting for your input」提醒——**不是** `wait`，它映射到 `idle`，因为没有任何东西被阻断；判错会让「派活给别的会话、自己空等结果」的编排会话在整段等待里停在黄色。**优先级：CLI 参数 > 环境变量 > 配置文件 > `DEFAULTS`。** 配置文件依次找 `--config <path>` / `$CCHUD_CONFIG`、`./cchud.config.json`（脚本同目录）、`~/.cchud.json`。环境变量是 `CCHUD_*`（字段名大写下划线）。`doneTitle`/`needTitle` 里的 `{name}` 占位符最后替换。新增可配置项时加进 `DEFAULTS` 即可——`FIELDS` 与三个输入源都由它自动派生；布尔类记得进 `toBool` 归一列表（环境变量与 CLI 传进来的是字符串）。
- **`hud.sh`** —— macOS/Linux 启动器，只是 `exec node hud.js`。Windows 直接调 `node hud.js`（见 README）。

## 约定

- 终端输出用真彩色 ANSI（`\x1b[38;2;r;g;b`）与 Unicode 方块字符；`hud.js` 里的小兽艺术字（`row1`/`row2`/`row3`）**对齐敏感**——列宽由 `padW` 手工调过，改动务必小心。
- Claude Code 传入的一切都当作不可信 / 可能残缺：每个 `JSON.parse` 与文件读取都包在 try/catch 里，出错退化成空值或缺字段，绝不抛异常。
- `cchud.config.json` 与 `.cchud.json` 已 gitignore（用户本地配置）；要提交示例改动请改 `cchud.config.example.json`。
- 涉及 Claude Code 自身行为（钩子事件、`notification_type` 取值、字段结构）的判断，别凭记忆写——从本机 `claude.exe` 里查证（`grep -a` 能直接搜到字符串与相邻代码），版本差异很大。

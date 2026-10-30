# CLAUDE.md

给 Claude Code / Codex 在本仓库工作时的指引。

通用协作约定（语言、提交粒度与推送时机、注释与文档风格、危险动作授权）见全局 `~/.claude/CLAUDE.md`，是单一事实来源。本文件只写 cchud 特有的部分，不复述全局条目——复述必然漂移。

## 这是什么

`cchud` 是给 [Claude Code](https://claude.com/claude-code) 用的 `statusLine` 脚本，外加可选的通知钩子与实时状态源。Claude Code 通过 stdin 把会话 JSON 喂进这些脚本：`hud.js` 输出三行带颜色的终端状态栏，`notify.js` 弹桌面通知 + 播提示音，`state.js` 把钩子事件记成状态文件。Node 侧**零依赖**、无构建步骤、无 `package.json`；Cargo 工作区的 `pet-hook` 是状态写方，`pet-state` 是与桌宠共用的落盘契约。实时状态和通知支持 Claude Code / Codex，HUD 仅用于 Claude Code。README 与全部代码注释为中文。

## 跑起来 / 调试

Node 入口可直接运行。验证与构建：

```sh
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo build -p pet-hook --locked
CCHUD_TEST_PET_HOOK="$PWD/target/debug/pet-hook" node --test tests/hooks.test.js
```

Node 18+ 的内置测试器读取 `tests/fixtures/hooks.json`，Rust 同读这些夹具。指定二进制时还测试真实 CLI 的安装、委托与跨实现落盘一致；测试只碰临时目录，不弹通知。

手工预览可往 stdin 喂假的会话 JSON：

```sh
# 状态栏 —— 用假状态渲染（HUD_FAKE_STATE=busy|idle|bash|read|web|edit|wait 强制小兽姿态）
echo '{"context_window":{"used_percentage":42},"rate_limits":{"five_hour":{"used_percentage":63}},"model":{"display_name":"Opus 5"},"cost":{"total_cost_usd":1.23}}' | HUD_FAKE_STATE=busy node hud.js

# 通知 —— j.hook_event_name 选分支（"Notification" vs 其他 = Stop）；
# Notification 还要看 notification_type，只有阻断类才真的弹（见下方适配层）
echo '{"session_id":"t1","cwd":"/some/proj","hook_event_name":"Notification","notification_type":"permission_prompt","message":"needs Bash"}' | node notify.js

# 钩子状态源 —— 先模拟一个钩子事件，再用它渲染（CCHUD_STATE_DIR 把状态目录指到别处）
echo '{"hook_event_name":"PreToolUse","session_id":"t1","tool_name":"Bash"}' | CCHUD_STATE_DIR=/tmp/s node state.js
echo '{"session_id":"t1","transcript_path":"/tmp/t1.jsonl"}' | CCHUD_STATE_DIR=/tmp/s node hud.js

# 重新生成 preview.png 所截自的预览页
node tools/preview.js   # 输出 tools/preview.html
```

在 Windows 的 Git Bash 里跑这些命令时注意：`$TEMP` 之类含反斜杠的路径传给 `node -e` 会被吞掉转义符（`C:\Users\...` 变成 `C:Users...`），改用正斜杠路径。

## 架构

客户端差异集中在 `hook-adapter.js` / `crates/pet-hook/src/adapter.rs`，下游只消费归一事件，禁止在状态写入与通知里添加客户端分支。`config.js` 负责配置并为 Claude HUD 转导出旧的辅助函数。

- **`hud.js`** —— statusLine 入口。从 stdin 读会话 JSON，输出三行。状态解析分两级（`resolveState`）：注册了 `state.js` 钩子时，刚写入的钩子状态文件优先（即时、精确）；否则回落到扫 transcript（`j.transcript_path`）末尾约 40 行找最后一个有意义事件——assistant 的 `tool_use`/`thinking` → 忙，assistant 的 `text` → 闲，`user` 角色 → 忙（**不是**看文件 mtime，那会把「刚干完」判错）。即便有钩子，transcript 仍用来补钩子盲区：用户中断 / 秒取消不触发任何钩子，所以比钩子事件更新的中断标记（或悬挂超过 `IDLE_AFTER_MS` 的 `UserPromptSubmit`）会强制判闲——`wait` 同样要过这道中断检查，因为 ESC 掉授权对话框也不触发钩子；状态文件比 transcript 旧 10 分钟以上说明钩子已被卸载 → 完全回落。颜色：橙 = 忙，绿 = 闲，黄 = 等确认（只有钩子链路能给出）。待办从 transcript 读（Task 事件，回落 `TodoWrite`）。尾行末尾是会话名（`config.js` 的 `agentInfo`）——即 `Message from @xwink-console-7a` / `sent to …` / `ListAgents` 用的**寻址代号**，多会话协作时照抄它就能派活，所以原样显示、不截断、不加前缀。但**只显示派生名**（`nameSource === "derived"`）：会话有了自动标题或被 `/rename` 后，那个名字会出现在终端标题栏上，状态栏再印一遍是重复——此时与「读不到名字」同路，回落项目名 + 会话短 id（项目名取 `workspace.project_dir` 的目录名，`cd` 进子目录时不变，比 `cwd` 稳定）。`sessionRef` 打开时补 `[3bbce9]`（派生名后面加、回落时替掉短 id），默认关。
- **`state.js` / `hook-state.js`** —— 前者是兼容入口：默认 Claude，`--client codex` 指定 Codex；本机有 `pet-hook` 就携原始输入与客户端标识委托，启动失败或旧二进制拒绝新参数时回退 Node 写方。后者消费归一事件，原子写 `<stateDir>/<session_id>.json`，维护 `.calls` 与 `.done` 并行调用配对，轮次结束/中断清理标记，会话结束删档。写方不输出 stdout。
- **`notify.js`** —— 消费归一事件，只在 `done` 与 `wait` 时通知；未知事件、中断、子代理结束与闲置提醒静默。`notificationFor()` 是可测试的纯决策出口。系统适配仍为 Windows PowerShell Toast + SoundPlayer、macOS osascript、Linux notify-send + paplay。不用 detached + unref，Windows 会在父进程退出时回收子进程。
- **`config.js`** —— 配置优先级为 CLI > 环境变量 > 文件 > `DEFAULTS`。文件依次找 `--config` / `$CCHUD_CONFIG`、脚本旁 `cchud.config.json`、`~/.cchud.json`。新增项加进 `DEFAULTS`，布尔项记得归一。`doneTitle` / `needTitle` 替换 `{name}`。
- **Hook 适配层** —— Claude 的通知分类、工具名与活跃会话登记只在适配层解释；Codex 把 `PermissionRequest` 归一为 `Notification/wait`、`apply_patch` 为 `edit`，阻断输入工具进入 wait，`Interrupt` 为无完成通知的 idle，轮内 compact 后保持 think。Codex 的身份是 `Codex #短id`，不读 Claude 登记。`PermissionRequest` 可能被别的 Hook 自动放行，因此 wait 是尽力展示；托管网页搜索没有工具 Hook。会话日志不作为 Codex 状态协议。
- **`crates/pet-hook`** —— `adapter.rs` 提供各客户端的配置路径、事件集合、输入归一与身份；`hook.rs` 只管归一事件与落盘；`setup.rs` 负责共用安装流程。`setup` 默认只装 Claude，`--client codex|all` 显式扩展，备份、幂等、卸载只删自己的条目。Codex 写 `$CODEX_HOME/hooks.json`，安装后用户需 `/hooks` 信任；`SessionEnd` 同步且三秒超时，其余状态钩子异步。
- **`crates/pet-state`** —— 字段只加不减、缺省可读；`event` 保留现有消费者识别的词汇，`source` / `source_event` / `session_id` / `turn_id` 只供溯源，不改变七态与调用标记契约。
- **`hud.sh`** —— macOS/Linux 启动器，只是 `exec node hud.js`。Windows 直接调 `node hud.js`（见 README）。

## 约定

- 终端输出用真彩色 ANSI（`\x1b[38;2;r;g;b`）与 Unicode 方块字符；`hud.js` 里的小兽艺术字（`row1`/`row2`/`row3`）**对齐敏感**——列宽由 `padW` 手工调过，改动务必小心。
- Claude Code 传入的一切都当作不可信 / 可能残缺：每个 `JSON.parse` 与文件读取都包在 try/catch 里，出错退化成空值或缺字段，绝不抛异常。
- `cchud.config.json` 与 `.cchud.json` 已 gitignore（用户本地配置）；要提交示例改动请改 `cchud.config.example.json`。
- 涉及 Claude Code 自身行为（钩子事件、`notification_type` 取值、字段结构）的判断，别凭记忆写——从本机 `claude.exe` 里查证（`grep -a` 能直接搜到字符串与相邻代码），版本差异很大。

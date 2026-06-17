# cchud

> Claude Code 状态栏小兽 —— 一只会随状态切换姿势的像素小兽，外加上下文 / 用量 / 模型 / 花费一目了然。

`cchud` 是给 [Claude Code](https://claude.com/claude-code) 用的 `statusLine` 脚本。它从 stdin 读取 Claude Code 传入的会话 JSON，输出三行带颜色的终端状态栏。

## 效果

![cchud 状态栏预览](preview.png)

上图为同一脚本在六种状态下的实际输出：**思考中 / 跑命令 / 翻找文件 / 联网搜索 / 敲键盘**（橙色，小兽站立，头顶 badge 区分在干什么）与**等你输入**（绿色，小兽蜷缩低头打盹）。

显示内容：

- **小兽姿势 + 颜色 + 头顶 badge** —— 通过读取会话日志最后一个有意义事件推断当前在干什么（思考 `?` / 跑命令 `>_` / 翻找 `⌕` / 搜索 `@` / 敲键盘 `I` / 等你 `zᶻ`），比看文件 mtime 更准。详见[状态推断的原理与限制](#状态推断的原理与限制)。
- **ctx** —— 上下文窗口占用百分比。
- **5h / 7d** —— 5 小时 / 7 天用量额度，带重置倒计时（`↻`）。
- **进度条颜色** —— 绿(<60%) / 黄(60-85%) / 红(≥85%)。
- **尾行** —— 待办完成数（`✓3/5`）、模型名、本次花费、累计时长。

## 安装

需要本机有 [Node.js](https://nodejs.org/)（任意较新版本即可，脚本无依赖）。

把仓库克隆到任意位置：

```sh
git clone https://github.com/x-wink/cchud.git
```

然后编辑 `~/.claude/settings.json`，加入 `statusLine` 字段。

### macOS / Linux

```jsonc
{
  "statusLine": {
    "type": "command",
    "command": "/path/to/cchud/hud.sh",
    "refreshInterval": 2
  }
}
```

记得给启动器加可执行权限：`chmod +x /path/to/cchud/hud.sh`。

### Windows

直接用 `node` 调用 `hud.js`（注意 JSON 里反斜杠要转义）：

```jsonc
{
  "statusLine": {
    "type": "command",
    "command": "node \"C:\\path\\to\\cchud\\hud.js\"",
    "refreshInterval": 2
  }
}
```

保存后重启 Claude Code（或新开会话）即可生效。

## 提醒（可选）

`notify.js` 可在 Claude Code 需要你时弹**桌面通知 + 播提示音**，方便你挂着别的事时被叫回来。它借助 Claude Code 的两类钩子，并用不同提示音区分场景，凭声音即可分辨：

| 钩子           | 触发时机                       | 提示音（Windows）              |
| -------------- | ------------------------------ | ------------------------------ |
| `Stop`         | 答完、把控制权交还给你         | 完成铃声 `Ring01.wav`          |
| `Notification` | 需要你授权 / 等待你输入        | 前台提示音 `Windows Foreground.wav` |

`Notification` 事件的具体事由（如「需要授权使用 Bash」）由 Claude Code 通过 stdin 的 `message` 给出，直接作通知正文。

跨平台：Windows 用 PowerShell WinRT Toast + 系统提示音，macOS 用 `osascript`，Linux 用 `notify-send` + `paplay`。

在 `settings.json` 里和 `statusLine` 同级加入 `hooks`（两类指向同一个脚本，脚本内部按事件类型自动区分）：

```jsonc
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node \"C:\\path\\to\\cchud\\notify.js\"" }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "node \"C:\\path\\to\\cchud\\notify.js\"" }] }
    ]
  }
}
```

通知里会带上当前项目目录名，多个会话同时跑时一眼能认出是哪个项目在叫你。Windows 上若通知没弹出，检查「设置 → 系统 → 通知」与「专注助手 / 勿扰模式」是否屏蔽了通知（提示音不受勿扰影响，仍会响）。

## 自定义称呼与文案

小兽的称呼、状态栏两种状态文本、通知标题/正文都可自定义。称呼默认为 **小螃蟹**。解析优先级：**CLI 参数 > 环境变量 > 配置文件 > 默认值**。

| 字段         | 默认值              | 用途                          |
| ------------ | ------------------- | ----------------------------- |
| `name`       | `小螃蟹`            | 称呼，用于通知标题里的 `{name}` |
| `busyLabel`  | `吭哧吭哧 …`        | 状态栏「忙碌」文本            |
| `idleLabel`  | `zᶻ  ✓ 等你`        | 状态栏「等你」文本            |
| `doneTitle`  | `{name} · 等你了`   | 通知标题（答完）              |
| `doneBody`   | `答完了，回来看看 ✓`| 通知正文（答完）              |
| `needTitle`  | `{name} · 需要你`   | 通知标题（需要授权/等待输入） |
| `needBody`   | `需要你处理一下`    | 通知正文兜底（Claude 未给 message 时） |

**配置文件（推荐，一次配置两个脚本共用）**：把 `cchud.config.example.json` 复制为 `cchud.config.json`（脚本同目录）或 `~/.cchud.json`，按需修改。也可用 `--config <path>` 或环境变量 `CCHUD_CONFIG` 指定路径。

**命令行参数**（写进 `settings.json` 的 command 里）：

```jsonc
"command": "node \"C:\\path\\to\\cchud\\hud.js\" --name 大龙虾 --idle-label \"钳子等你~\""
```

**环境变量**：`CCHUD_NAME`、`CCHUD_BUSY_LABEL`、`CCHUD_IDLE_LABEL` 等（字段名大写下划线）。

## 状态推断的原理与限制

小兽的姿态全部通过**读取会话日志（transcript）的最后一个有意义事件**推断——而非看文件 mtime：

- assistant 调 `Bash` → 跑命令 `>_`；调 `Read/Grep/Glob` 等 → 翻找中 `⌕`；调 `WebSearch/WebFetch` → 搜索中 `@`；调 `Edit/Write` 等 → 敲键盘 `I`；仅思考或调其他工具 → 思考中 `?`；给出完整文字回复 → 休息中 `zᶻ`。
- 工具结果（`tool_result`）会被跳过、回溯到对应的工具调用判断姿态；中断标记 `[Request interrupted by user…]` 会被识别为「休息中」。

### 建议开启定期刷新（`refreshInterval`）

Claude Code 的状态栏默认**只在「有新助手消息」时刷新**——你**提交消息**这个动作本身不触发刷新。所以不加配置时，从你发消息到 Claude 开始响应的这段时间，状态栏会冻结在上一帧（看起来像「装睡」）。在 `statusLine` 里加上 `refreshInterval`（单位秒，最小 1）让它定期重绘即可解决（安装示例里已包含）。

### 已知限制（受 Claude Code 机制约束，非脚本能完全消除）

1. **短操作的姿态只会一闪而过**：assistant 消息要整条生成完才落盘，读一个文件、跑一条快命令这类毫秒级动作，对应姿态往往来不及显示。只有长任务（耗时命令、大范围检索）才会稳定停在对应姿态。
2. **「正在等待响应」与「提交后秒取消」无法即时区分**：Claude Code 取消时既不触发任何 hook，也不在日志留下可识别痕迹，两者的日志状态完全一致。为避免秒取消后**永久**卡在「思考中」，脚本采用兜底——一条用户输入悬挂超过 **60 秒**仍无任何响应跟进，即判定为已取消 / 久挂并回到「休息中」（`claude --resume` 回来也借此自愈）。代价是秒取消后需等这段时间才回休息；阈值在 `hud.js` 的 `IDLE_AFTER_MS` 可调。

## 调试

不接 Claude Code 时，可手动喂一段假 JSON 预览效果：

```sh
echo '{"context_window":{"used_percentage":42},"rate_limits":{"five_hour":{"used_percentage":63}},"model":{"display_name":"Opus 4.8"},"cost":{"total_cost_usd":1.23}}' | HUD_FAKE_STATE=busy node hud.js
```

环境变量 `HUD_FAKE_STATE=busy|idle` 可强制小兽进入指定状态，方便调试。

生成预览页面（README 顶部的 `preview.png` 即截自此页面的终端元素）：

```sh
node tools/preview.js   # 输出 tools/preview.html，用浏览器打开即可预览两种状态
```

## 终端建议

状态栏用到真彩色 ANSI（`38;2;r;g;b`）和 Unicode 方块字符。在 Windows Terminal、VS Code 集成终端、iTerm2 等现代终端显示最佳；老式 conhost（cmd.exe 默认窗口）可能配色或对齐不理想。

## License

MIT

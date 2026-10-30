# pet-hook 0.2.0

Claude Code / Codex 共用实时状态源，桌宠无需重装或修改。

- 新增 Codex Hook 适配：提交、工具调用、审批、阻断输入、答完、中断与会话结束，归一为现有七态。
- `pet-hook setup --client codex` 注册 Codex 的八个状态钩子；`--client all` 同时配置两端，缺省仍只配置 Claude Code。
- Codex 中断会清理调用标记并回到空闲，不误报答完；轮内压缩后保持思考状态。
- 状态档新增来源与会话溯源字段，保留旧读方识别的事件语义与版本，兼容已有桌宠。
- Node 状态入口与通知共用适配层；旧二进制不支持 Codex 参数时可回退 Node 写方。
- Windows 的 Codex 钩子按 PowerShell 规则生成命令，支持带空格、单引号或 `$` 的安装路径。

升级后运行 `pet-hook setup --client codex`，在 Codex `/hooks` 中审查并信任新增钩子，再新开会话。系统桌面通知仍按需配置，接入方式见 [README](https://github.com/x-wink/cchud/blob/pet-hook-v0.2.0/README.md#codex-接入实时状态与通知)。

提供 macOS Apple Silicon、macOS Intel、Windows x86_64、Linux x86_64 二进制与 `SHA256SUMS`。Codex 暂不提供自定义终端状态栏；托管网页搜索没有工具 Hook，无法保证显示搜索姿态。

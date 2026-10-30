# Claude / Codex 钩子兼容

## 当前状态

已完成。Claude Code / Codex 的事件、工具名与会话身份差异由 Hook 适配层解释，共用七态、状态写入、并行调用标记和通知处理。Codex 不提供终端 HUD；Claude HUD 保持现有入口。

- Rust 适配层：`crates/pet-hook/src/adapter.rs`；Node 适配层：`hook-adapter.js`。
- `pet-state` 的版本仍为 1，新增可缺省的来源与会话字段，保留现有读方识别的事件词汇。
- 桌宠读方无需修改或重装；审批与输入仍落为 `Notification/wait`，中断清理忙态且不报答完。
- `pet-hook setup` 默认只配置 Claude，`--client codex|all` 可显式选择客户端；已有配置写前备份，重复执行不增添条目，卸载保留其他命令。
- Codex 的审批事件可能被其他 Hook 自动放行，wait 为尽力展示；托管网页搜索没有工具 Hook。

接入方式与边界见 [README](../../README.md#codex-接入实时状态与通知)。

## 验证

macOS 本机通过 24 项 Rust 测试、41 项 Node 测试、Clippy 与格式检查。回归覆盖两端事件、并行调用、中断清理、安装与卸载、旧二进制回退，以及 Rust / Node 对共用夹具的落盘一致性。Windows / Linux 尚未进行真实客户端联调。

```sh
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo build -p pet-hook --locked
CCHUD_TEST_PET_HOOK="$PWD/target/debug/pet-hook" node --test tests/hooks.test.js
```

## 收工交接

2026-10-30：双端适配与本机接入已完成，代码与交接随 `main` 一并交付，未发版。

本机 `/Users/mac/.cargo/bin/pet-hook` 已从本仓源码安装；`~/.codex/hooks.json` 的八个状态钩子已通过 Codex 自带 `/hooks` 界面审查并信任。独立的 `hooks/list` 检查确认全部启用且为 trusted，配置命令的写入与清理冒烟验证通过。用户重启后，真实会话已写出 `source: codex` 的实时状态，接入生效。

状态目录为 `~/.cchud/state`。Claude 的九个既有钩子与配置内容保持不变；Codex 沿用桌宠状态及气泡提示，没有额外开启系统桌面通知。安装前的本机二进制与 Claude 配置备份在 `/tmp/cchud-config-backup/`，临时目录不作为跨会话事实来源。

本轮启动的安装、测试、配置核验进程及用于审查 Hook 的 Codex CLI 均已退出，没有遗留开发服务或浏览器。当前无未完成的代码步骤；后续入口为本文件与 README，正式 tag 与发版须另获授权。

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

本机通过 26 项 Rust 测试、41 项 Node 测试、Clippy 与格式检查。回归覆盖两端事件、并行调用、中断清理、安装与卸载、旧二进制回退，以及 Rust / Node 对共用夹具的落盘一致性。Windows 发行二进制另在原生 PowerShell 验证特殊路径的安装、事件执行与卸载。Codex 的真实客户端接入已在 macOS 验证，Windows / Linux 尚未进行完整客户端联调。

```sh
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo build -p pet-hook --locked
CCHUD_TEST_PET_HOOK="$PWD/target/debug/pet-hook" node --test tests/hooks.test.js
```

## 收工交接

2026-10-30：双端适配与本机接入已完成，`pet-hook 0.2.0` 已公开发行。

本机 `/Users/mac/.cargo/bin/pet-hook` 已从本仓源码安装；`~/.codex/hooks.json` 的八个状态钩子已通过 Codex 自带 `/hooks` 界面审查并信任。独立的 `hooks/list` 检查确认全部启用且为 trusted，配置命令的写入与清理冒烟验证通过。用户重启后，真实会话已写出 `source: codex` 的实时状态，接入生效。

状态目录为 `~/.cchud/state`。Claude 的九个既有钩子与配置内容保持不变；Codex 沿用桌宠状态及气泡提示，没有额外开启系统桌面通知。安装前的本机二进制与 Claude 配置备份在 `/tmp/cchud-config-backup/`，临时目录不作为跨会话事实来源。

本轮启动的安装、测试、配置核验进程及用于审查 Hook 的 Codex CLI 均已退出，没有遗留开发服务或浏览器。当前无未完成的代码步骤；后续入口为本文件与 README，正式 tag 与发版须另获授权。

## 0.2.0 发行交接

用户已授权本次发版。发行单元为 `pet-hook`，正式 tag 为 `pet-hook-v0.2.0`，指向 `48fb6ba3f63ccaa71ba33157b90db3d3619f81bb`；独立代码审查通过，修正了 Windows Codex 的 PowerShell 调用与卸载识别。

- 远端门禁在 GitHub Actions：[main 门禁 41002275359](https://github.com/x-wink/cchud/actions/runs/41002275359) 通过后推 tag，[四平台构建 41002370205](https://github.com/x-wink/cchud/actions/runs/41002370205) 全部通过，Windows 原生 PowerShell 冒烟通过。
- [pet-hook 0.2.0](https://github.com/x-wink/cchud/releases/tag/pet-hook-v0.2.0) 已公开并设为 Latest，Release ID 为 `428650678`，公开时刻为 2026-10-30 12:29（北京时间）。四份二进制及 `SHA256SUMS` 齐全，下载后逐项校验通过；macOS Intel 发行二进制再次通过 41 项 Node 回归。
- Release 正文在 [发行说明](../releases/pet-hook-0.2.0.md)。产物与本机校验记录在 `/tmp/cchud-release-0.2.0/`；跨会话依据以 GitHub Release、Actions 与本文件为准。
- Homebrew 配方与接入说明已在 `x-wink/homebrew-tap` 提交推送（`94e0b97`），版本、下载地址与三平台 SHA 已更新，Ruby 语法检查及三个支持平台的 `brew fetch` 均通过。

| 产物 | SHA256 |
| --- | --- |
| macOS arm64 | `05e0c9662af8c50bd9096a3983b0ee2a128aa8443e06ba1ef2b2cd337234e9f3` |
| macOS x86_64 | `462f9302fcab785c36035c419bbd78ad0e1727908c8e77399fb510b5b930444a` |
| Windows x86_64 | `0a2f974c441d39b0ed82f7323da51230f3d81783eeddd5095e984f38ee2837e3` |
| Linux x86_64 | `fe7946a9b00621bb455d8c3f5d08f577f6af78384785ec24fd23dbdefd20c2c3` |

用户核对草稿并授权公开后，已公开现有 Release、设为 Latest，并验证公开下载与 Homebrew 配方；未重打或移动 tag、未重建产物。本轮发行已完成，未发布其他单元。后续发版仍须另获授权。

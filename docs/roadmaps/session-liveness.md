# 会话退出后的活性凭据

## 现状与原因

Codex 的 `SessionEnd` 正常关闭时负责删档，但直接关闭终端窗口可能没有执行完结束钩子。状态过期只能回 idle，不能证明会话已经退出；只按状态文件数量排队会让桌宠保留多只小号。

Codex 0.166.0 的活动线程持有 `thread-writer-locks/<session_id>.lock` 排他锁。它属于后台运行时；前台终端关闭后，后台仍可能缓存线程30分钟，因此写者锁只能作为兼容凭据，不能证明前台仍在场。[官方生命周期说明](https://developers.openai.com/codex/app-server#unsubscribe-from-a-loaded-thread)。不解析会话对话内容来推断活性。

## 前台租约

`pet-hook codex -- <真实Codex程序> [原参数]` 启动时持有独立文件锁，只在本次启动参数中给 `cchud_owner` MCP 服务传入租约路径；退出时由操作系统释放。程序参数使用独立数组传递；Codex管理子命令直接转交。后台是否继续运行不影响这条租约。

`pet-hook owner-mcp` 提供stdio登记工具 `attach_client`。SessionStart MCP钩子把会话ID和transcript身份登记到状态目录 `.owners/<session_id>.json`，其内容为 `{transcript, leases}`。钩子文本结果为空控制对象，不向模型上下文注入内容。MCP进程只记录路径，不持有前台锁；stdin结束即退出，没有额外常驻清理服务。

状态记录增加可选 `live_owners`，即使登记晚于异步状态写入，读方也会从独立登记表读到新凭据；迟到工具事件不能覆盖登记。任一前台租约仍持有就保留，全部释放才离场；坏登记或身份不匹配返回未知。缺登记表时沿用单锁与旧档兼容规则。`live_lock` 同时提供单租约兼容，已有旧读方下一次读档即可跟随当前单前台退出；多个前台连接同一线程需升级读方。

### 接入

先安装新版pet-hook，再配置本地登记服务和钩子：

```sh
codex mcp add cchud_owner -- /实际路径/pet-hook owner-mcp
/实际路径/pet-hook setup --client codex --frontend-lease
node tools/install-codex-client.js --bin /真实路径/codex --hook /实际路径/pet-hook --out /排在PATH前面的目录/codex
```

安装脚本只写自己的shell启动入口，不覆盖其他程序，支持 `--dry-run`、`--uninstall`，路径与用户参数保留原样。日常仍输入 `codex`；需在新终端的 `/hooks` 中信任新增 `cchud_owner / attach_client` 一次，不写入或伪造Codex信任哈希。命令行每次传入的租约路径不改变钩子声明，因此无需逐次重新信任。管理命令、真实Codex设置和后台缓存策略保持原行为。

`pet-hook sessions` 输出会话状态与活性凭据，不输出对话。升级前已打开的前台可用 `tools/attach-existing-client.py --pid <前台PID> --session <会话ID> --state-dir <状态目录> --hook <pet-hook路径>` 进行一次性接管：先校验同用户、Codex程序与终端，再用macOS kqueue或Linux pidfd等待该进程退出，不依赖PID轮询或缓存超时；进程退出时接管程序自行结束。该工具需要Python3，普通新会话仅需Rust二进制。

### 验收

Rust覆盖后台仍持锁但前台退出、多前台全部退出、重开、登记先后顺序、迟到事件、路径拒绝与MCP静默通知；Node真实CLI回归验证正常退出、SIGHUP、SIGKILL和参数转义。接管回归只强制结束测试自己启动的伪Codex前台，并确认后台写者锁继续持有。
已实测macOS Intel；Linux pidfd与Windows真实终端关闭仍待对应机器联调。Unix启动入口安装器用于macOS/Linux，Windows可直接调用Rust租约启动命令指向真实 `codex.exe`。

## 实现

- Rust 与 Node 的客户端适配层从 `transcript_path` 的 `sessions` 祖先定位实际配置根，兼容自定义 home；仅 Codex 提供其写者锁。
- 版本 1 的状态记录允许可缺省的 `live_lock` / `live_owners`。晚到事件保留此前同来源、同 transcript 的单锁凭据，前台登记独立原子更新。
- 共用 `pet-state::session_alive` 检查操作系统锁：锁仍持有为活动，已释放或文件消失为结束；缺凭据、权限错误和不支持检查均返回未知，保守保留。
- 读方不按客户端分支：凭据确认已结束时直接从会话队列移除，不变成 idle 小号。活着的 wait 不因等待时间长而清除。
- 旧记录仍可读；旧版 Codex 没有凭据时继续已有兜底。历史无凭据残留不能仅凭年龄认定退出，需要另行核对并备份清理。

## 验证与交接

测试覆盖持锁、释放但文件仍存在、锁文件消失、检查错误、旧记录、强制结束自己启动的持锁进程、迟到事件保留与 Rust / Node 一致性。
36项Rust测试、45项Node/真实CLI回归、严格Clippy与格式检查通过。强制退出回归只结束测试自己启动的持锁进程。测试包括旧前台接管的内核退出通知，并确认后台写者锁在前台退出后继续持有。
桌宠消费端在 oxforge `apps/pet/src/source.rs`，过滤已结束会话并保留活动 wait；安装到本机的旧版桌宠需要升级后重启才能持续使用新判定。
本改动不触发正式 tag 或发布。

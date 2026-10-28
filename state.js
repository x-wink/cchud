// cchud state — hook 驱动的实时状态源（可选）。
// 注册为多个 Claude Code 钩子指向本脚本（见 README），按 stdin 的 hook_event_name 分支，
// 把「此刻在干嘛」原子写入 <stateDir>/<session_id>.json，供 hud.js（及将来的桌宠）即时读取。
//
// 为什么不只扫 transcript：思考不落盘（thinking 块整块结束才写入），watch 文件既慢又盲；
// 钩子由 Claude Code 在事件发生的瞬间同步调用，快且带确切工具名。transcript 退为兜底（见 hud.js）。
//
// 事件 → 状态：
//   UserPromptSubmit → think  用户按下回车即进入思考（此刻日志里还什么都没有）
//   PreToolUse       → 按工具名细分 bash/web/read/edit/think（工具执行前就知道）
//   PostToolUse      → think  工具完毕，回到思考，等下一个事件
//   Stop             → idle   答完等你（用户中断不触发 Stop，由 hud.js 靠中断标记 + 超时兜底）
//   Notification     → 按 notification_type 分档 wait/think/idle（判定表见 config.js 的 notificationState）
//   SessionStart     → idle   会话启动 / 恢复
//   SessionEnd       → 删除状态文件
//
// 注册时应加 "async": true（见 README）：钩子在后台跑，完全不阻塞主流程。代价是相邻事件
// 有极小概率写入乱序、状态短暂偏差，下个事件自然纠正——状态展示是尽力而为，主进程绝对优先。
// 本脚本仍只做「读 stdin → 写一个小文件」，且不往 stdout 输出任何内容
//（同步注册时 UserPromptSubmit 钩子的 stdout 会被注入为对话上下文）。
//
// 本机装了 pet-hook（crates/pet-hook，本脚本的 Rust 继任，写同一个目录、同一口径）就整段委托给它：
// 两套写方并存口径必漂移。找不到才自己写——只装 cchud 不装 pet-hook 的用户照常。
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { loadConfig, toolState, notificationState } = require("./config");

/** PET_HOOK 指定 > PATH 里的 pet-hook > ~/.cargo/bin/pet-hook；都没有回 null */
function findPetHook(env = process.env) {
  const exe = process.platform === "win32" ? "pet-hook.exe" : "pet-hook";
  const candidates = [];
  if (env.PET_HOOK) candidates.push(env.PET_HOOK);
  for (const dir of String(env.PATH || "").split(path.delimiter)) if (dir) candidates.push(path.join(dir, exe));
  const home = env.HOME || env.USERPROFILE;
  if (home) candidates.push(path.join(home, ".cargo", "bin", exe));
  return candidates.find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch (e) {
      return false;
    }
  }) || null;
}

let s = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  const petHook = findPetHook();
  if (petHook) {
    // 起不来（权限、损坏）就退回自己写，不让状态源因此失声
    // 状态目录按 cchud 自己的配置口径算好再交给 pet-hook:它只认 CCHUD_STATE_DIR 与 ~/.cchud.json,
    // 认不得 --state-dir、$CCHUD_CONFIG 与脚本旁的 cchud.config.json,不传的话两边会写读不同的目录
    const env = { ...process.env, CCHUD_STATE_DIR: loadConfig().stateDir };
    const child = spawn(petHook, [], { stdio: ["pipe", "ignore", "ignore"], env });
    child.on("error", () => writeOwn());
    child.on("exit", (code) => {
      if (code !== 0) writeOwn();
    });
    child.stdin.on("error", () => {});
    child.stdin.end(s);
    return;
  }
  writeOwn();
});

function writeOwn() {
  let j = {};
  try {
    j = JSON.parse(s || "{}");
  } catch (e) {}

  // 会话标识：钩子必带 session_id；万一缺失退用 transcript 文件名（同为会话 id）。
  // 白名单过滤，防止拼进路径的内容里带分隔符。
  const sid = String(
    j.session_id || (j.transcript_path ? path.basename(j.transcript_path, ".jsonl") : ""),
  ).replace(/[^\w.-]/g, "");
  if (!sid) return;

  const ev = j.hook_event_name;
  const dir = loadConfig().stateDir;
  const file = path.join(dir, sid + ".json");

  if (ev === "SessionEnd") {
    try {
      fs.unlinkSync(file);
    } catch (e) {}
    return;
  }

  let state = null;
  if (ev === "UserPromptSubmit" || ev === "PostToolUse") state = "think";
  else if (ev === "PreToolUse") state = toolState(j.tool_name);
  else if (ev === "Stop" || ev === "SessionStart") state = "idle";
  else if (ev === "Notification") state = notificationState(j.notification_type); // 判定表见 config.js
  if (!state) return; // 未注册语义的事件，忽略

  try {
    fs.mkdirSync(dir, { recursive: true });
    // 临时文件 + rename 原子落盘，读方永远不会读到半截 JSON
    const tmp = file + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ state, event: ev, tool: j.tool_name || "", ts: Date.now() }));
    fs.renameSync(tmp, file);
    // 顺手清理超过 24h 没更新的状态文件（会话结束却没等到 SessionEnd，如崩溃 / 强杀）
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json") || f === sid + ".json") continue;
      const fp = path.join(dir, f);
      try {
        if (Date.now() - fs.statSync(fp).mtimeMs > 864e5) fs.unlinkSync(fp);
      } catch (e) {}
    }
  } catch (e) {}
}

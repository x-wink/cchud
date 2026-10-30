const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Notification 的 notification_type → 状态。state.js（状态栏显示什么）与 notify.js（要不要打扰你）
// 共用，保证「什么才算需要你出面」只有一处定义。
//
// wait 的唯一含义：终端弹出了「必须你操作才能往下走」的交互（授权 / 选择 / 输入），Claude 的流程
// 被阻断在这里。不阻断流程的通知一律不算 wait——尤其 idle_prompt，它是闲置到阈值（默认 75 分钟）
// 后的提醒，文案就是 "Claude is waiting for your input"，恰恰是最闲的时候。
//
// Claude Code 2.1.261 实际会发的全部取值（从 claude.exe 里扒出来的）：
//   permission_prompt / worker_permission_prompt  授权对话框，阻断      → wait
//   elicitation_dialog / elicitation_url_dialog   输入对话框，阻断      → wait
//   agent_needs_input                             代理要你输入，阻断    → wait
//   elicitation_response / elicitation_complete   你已答复，阻断解除    → think
//   idle_prompt                                   闲置提醒，不阻断      → idle
//   auth_success / agent_completed /              杂项，与「谁在等谁」
//   push_notification / computer_use_exit         无关                  → 不动状态
function notificationState(type) {
  const t = String(type || "");
  // 老版本 Claude Code 没有 notification_type 字段（那时 Notification 本就只在需要用户时触发）→ 视同 wait。
  // permission_prompt 用子串匹配以覆盖 worker_permission_prompt；elicitation 有 _dialog / _url_dialog 两种。
  if (!t || /permission_prompt|needs_input|elicitation_(url_)?dialog/.test(t)) return "wait";
  if (/elicitation_(response|complete)/.test(t)) return "think";
  if (t === "idle_prompt") return "idle";
  return undefined;
}

// 工具名 → 小兽姿态。hud.js（transcript 兜底推断）与 state.js（hook 实时记录）共用，
// 放这里保证两条链路口径一致。
function toolState(name) {
  if (name === "Bash") return "bash";
  if (/^(WebSearch|WebFetch)$/.test(name)) return "web"; // 联网搜索 / 抓网页
  if (/^(Read|Grep|Glob|LS|NotebookRead)$/.test(name)) return "read";
  if (/^(Edit|Write|MultiEdit|NotebookEdit|Update)$/.test(name)) return "edit";
  return "think"; // 其他工具(TodoWrite / Task / Skill / mcp__*…)归思考 / 工作
}

// 名字截断：自动名 / 用户起的名可能是一整句话，撑爆 toast 标题与状态栏，按字数截断加省略号。
function clipName(s, max = 12) {
  s = String(s || "").trim();
  const a = Array.from(s); // 按码点截，避免切坏中文 / emoji
  return a.length > max ? a.slice(0, max).join("") + "…" : s;
}

// 会话身份 —— ListAgents 列出、别的会话拿来寻址的那一串 "cchud-96 [3bbce9]"，返回
// {name, ref, derived}。
//   name：**寻址代号**，Claude Code 里 "Message from @cchud-96" / "sent to cchud-96" 用的就是它。
//         Claude Code 把每个活跃会话登记成 <configDir>/sessions/<pid>.json，name 字段即是。
//         原样返回不截断——截了就没法照抄去寻址了，要截由调用方自己决定。
//   derived：名字是否是「项目目录名 + 随机字节」自动派生的（nameSource === "derived"）。
//         非派生名（自动标题 auto、/rename 的 user）会同时被 Claude Code 写进终端标题栏，
//         状态栏再印一遍就是重复——所以状态栏据此决定要不要显示，见 hud.js。
//   ref ：sha256("session:" + 该会话的 messaging socket 路径) 的十六进制前 6 位。这一步照抄
//         claude.exe 2.1.261 的算法（Ml/rCe，Il=6），不照抄就和 ListAgents 里的 [ref] 对不上，
//         而同名会话正是靠 ref 区分的。socket 路径缺失（旧版）时 ref 为 ""。
// 登记文件名是进程 pid 而非会话 id，所以按 sessionId 逐个匹配——目录里只有活跃会话，条目个位数。
// 读不到（旧版 Claude Code、目录被清、非 CLI 入口）返回 undefined，调用方各自回落。
function agentInfo(sid, dir) {
  if (!sid || !dir) return undefined;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      let o;
      try {
        o = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      } catch (e) {
        continue;
      }
      if (!o || o.sessionId !== sid) continue;
      const ref = o.messagingSocketPath
        ? crypto
            .createHash("sha256")
            .update("session:" + o.messagingSocketPath)
            .digest("hex")
            .slice(0, 6)
        : "";
      return { name: String(o.name || ""), ref, derived: o.nameSource === "derived" };
    }
  } catch (e) {}
  return undefined;
}


const EVENTS = {
  claude: ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "Notification", "Stop", "SessionStart", "SessionEnd"],
  codex: ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "Interrupt", "SessionStart", "SessionEnd"],
};

function hookClient(argv = process.argv.slice(2)) {
  const i = argv.indexOf("--client");
  return i < 0 ? "claude" : argv[i + 1] || "";
}

function hookArgs(client) {
  return client === "claude" ? [] : ["--client", client];
}

function normalizeHook(input, client = "claude") {
  if (!input || typeof input !== "object" || !EVENTS[client]) return undefined;
  const str = (v) => typeof v === "string" ? v : "";
  const raw = str(input.hook_event_name);
  if (!EVENTS[client].includes(raw)) return undefined;
  const sid = (str(input.session_id) || str(input.transcript_path).split(/[\\/]/).pop().replace(/\.jsonl$/, "")).replace(/[^\w.-]/g, "");
  if (!sid) return undefined;
  const tool = str(input.tool_name);
  let kind, state, event = raw;
  switch (raw) {
    case "UserPromptSubmit": kind = "prompt"; state = "think"; break;
    case "PreToolUse":
      kind = "tool_start";
      state = client === "codex" && tool === "request_user_input" ? "wait"
        : client === "codex" && tool === "apply_patch" ? "edit" : toolState(tool);
      if (state === "wait") event = "Notification";
      break;
    case "PostToolUse": case "PostToolUseFailure": kind = "tool_end"; state = "think"; break;
    case "PostToolBatch": kind = "batch_end"; state = "think"; break;
    case "Notification": kind = "notice"; state = notificationState(str(input.notification_type)); break;
    case "PermissionRequest": kind = "notice"; state = "wait"; event = "Notification"; break;
    case "Stop": kind = "done"; state = "idle"; break;
    case "SessionStart": kind = "start"; state = client === "codex" && input.source === "compact" ? "think" : "idle"; break;
    case "SessionEnd": kind = "end"; state = "idle"; break;
    case "Interrupt": kind = "interrupt"; state = "idle"; break;
  }
  if (!state) return undefined;
  return {
    kind, state, event, source: client, source_event: raw, session_id: sid,
    turn_id: str(input.turn_id), call_id: str(input.tool_use_id).replace(/[^\w-]/g, ""),
    tool, transcript: str(input.transcript_path),
    message: client === "codex" && raw === "PermissionRequest" ? str(input.tool_input?.description) : str(input.message),
    project: str(input.cwd).replace(/[\\/]+$/, "").split(/[\\/]/).pop(),
  };
}

// transcript 只为 Claude 的旧版本补名字;Codex 的日志不是稳定接口。
function titleFromTranscript(tp) {
  try {
    const lines = fs.readFileSync(tp, "utf8").split("\n");
    let ai = "";
    for (let i = lines.length - 1; i >= 0; i--) {
      let o;
      try { o = JSON.parse(lines[i]); } catch { continue; }
      if (o?.type === "custom-title" && o.customTitle) return clipName(o.customTitle);
      if (o?.type === "ai-title" && o.aiTitle && !ai) ai = String(o.aiTitle);
    }
    return clipName(ai);
  } catch { return ""; }
}

function identity(event, cfg) {
  if (event.source === "codex") return { name: cfg.sessionName ? "Codex #" + event.session_id.slice(0, 8) : "" };
  const agent = cfg.sessionName && agentInfo(event.session_id, cfg.sessionsDir);
  return {
    name: cfg.sessionName ? clipName(agent?.name) || titleFromTranscript(event.transcript) : "",
    ref: cfg.sessionRef ? agent?.ref : undefined,
  };
}

function liveLock(event) {
  if (event.source !== "codex" || !event.transcript) return undefined;
  for (let dir = path.dirname(event.transcript); path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    if (path.basename(dir) !== "sessions") continue;
    const lock = path.join(path.dirname(dir), "thread-writer-locks", event.session_id + ".lock");
    try { return fs.statSync(lock).isFile() ? lock : undefined; } catch { return undefined; }
  }
  return undefined;
}

module.exports = { normalizeHook, hookClient, hookArgs, identity, liveLock, toolState, notificationState, agentInfo, clipName };

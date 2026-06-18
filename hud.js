// cchud — Claude Code 状态栏小兽
// 由 Claude Code 的 statusLine 通过 stdin 传入会话 JSON，输出三行带颜色的状态。
// 跨平台：node 读取，无平台相关代码。mac/Linux 见 hud.sh，Windows 见 README。
// 多种状态（思考 / 跑命令 / 翻找 / 敲键盘 / 等你）的小兽姿态与文案可配置，见 config.js。
const CFG = require("./config").loadConfig();
let s = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  let j = {};
  try {
    j = JSON.parse(s || "{}");
  } catch (e) {}

  const R = "\x1b[0m",
    D = "\x1b[2m";
  const O = "\x1b[38;2;217;119;87m"; // 橙 = 忙碌
  const G = "\x1b[38;2;74;222;128m"; // 绿 = 等你
  const C = (p) => (p >= 85 ? "\x1b[91m" : p >= 60 ? "\x1b[93m" : "\x1b[92m");
  const bar = (p, w = 6) => {
    const f = Math.round((Math.max(0, Math.min(100, p)) / 100) * w);
    return "▰".repeat(f) + "▱".repeat(w - f);
  };
  const fmtT = (ts) => {
    if (!ts) return "";
    const ms = ts > 1e12 ? ts : ts * 1000;
    const d = ms - Date.now();
    if (d <= 0) return "";
    const m = Math.round(d / 60000);
    return m >= 1440
      ? Math.floor(m / 1440) + "d" + Math.floor((m % 1440) / 60) + "h"
      : m >= 60
        ? Math.floor(m / 60) + "h" + (m % 60) + "m"
        : m + "m";
  };
  const fmtD = (ms) => {
    if (!ms) return "";
    const m = Math.round(ms / 60000);
    return m >= 60 ? Math.floor(m / 60) + "h" + (m % 60) + "m" : m + "m";
  };
  function readTodos(tp) {
    if (!tp) return null;
    try {
      const fs = require("fs");
      const path = require("path");
      // 从单个日志文件还原任务列表(统一返回 [{status}…])。兼容两套机制:
      //   新版 Task 系统:TaskCreate(按创建顺序自增 id) / TaskUpdate({taskId,status}) —— 事件流,正序重放累积状态。
      //   老版 TodoWrite:单条 tool_use 携带完整 todos 快照 —— 取最后一次(倒序首个命中)。
      // 优先用 Task 系统(本版本 Claude Code 默认),没有再回落 TodoWrite。
      const fromFile = (file) => {
        let ls;
        try {
          ls = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
        } catch (e) {
          return null;
        }
        const tasks = new Map(); // id -> status
        // seq 全程自增,对齐系统真实 task id(#1、#2… 按创建顺序);batchStart 记录"当前计划"起始 id。
        // 一连串 TaskCreate = 一份计划。若某次 create 紧跟在 update 之后,说明上一份计划已开始执行,
        // 这是新计划的开头 → 把 batchStart 移到这里,最终只统计最新这份计划。
        // (对应 Claude Code UI 只展示当前计划的待办,不累计整个会话历史的已完成任务,否则会出现 11/16 这种错值。)
        let seq = 0,
          batchStart = 1,
          prevCreate = false;
        for (const line of ls) {
          if (line.indexOf("TaskCreate") < 0 && line.indexOf("TaskUpdate") < 0) continue;
          let o;
          try {
            o = JSON.parse(line);
          } catch (e) {
            continue;
          }
          const c = o.message && o.message.content;
          if (!Array.isArray(c)) continue;
          for (const x of c) {
            if (!x || x.type !== "tool_use") continue;
            if (x.name === "TaskCreate") {
              if (!prevCreate) batchStart = seq + 1;
              tasks.set(String(++seq), "pending");
              prevCreate = true;
            } else if (x.name === "TaskUpdate" && x.input && x.input.taskId != null && x.input.status) {
              const id = String(x.input.taskId);
              if (tasks.has(id)) tasks.set(id, x.input.status);
              prevCreate = false;
            }
          }
        }
        if (tasks.size)
          return [...tasks.entries()]
            .filter(([id]) => Number(id) >= batchStart)
            .map(([, status]) => ({ status }));
        for (let i = ls.length - 1; i >= 0; i--) {
          if (ls[i].indexOf("TodoWrite") < 0) continue;
          let o;
          try {
            o = JSON.parse(ls[i]);
          } catch (e) {
            continue;
          }
          const c = o.message && o.message.content;
          if (!Array.isArray(c)) continue;
          const tw = c.find((x) => x && x.type === "tool_use" && x.name === "TodoWrite");
          if (tw && tw.input && Array.isArray(tw.input.todos)) return tw.input.todos;
        }
        return null;
      };
      // 子代理(Task)运行时,它的 todos 写在 <主transcript去.jsonl>/subagents/agent-*.jsonl,
      // 主会话日志里没有;且子代理运行期间父会话日志静止 → "比主日志更新的子代理日志"即当前活动来源,
      // 优先取它(对应 Claude Code UI 里展示的正是活动子代理的待办),否则回落主会话自己的待办。
      const sub = tp.replace(/\.jsonl$/, "") + "/subagents";
      let active = null,
        mtime = 0;
      try {
        const mainMtime = fs.statSync(tp).mtimeMs;
        for (const f of fs.readdirSync(sub)) {
          if (!f.endsWith(".jsonl")) continue;
          const fp = path.join(sub, f);
          const mt = fs.statSync(fp).mtimeMs;
          if (mt > mainMtime && mt > mtime) {
            active = fp;
            mtime = mt;
          }
        }
      } catch (e) {}
      return (active && fromFile(active)) || fromFile(tp);
    } catch (e) {}
    return null;
  }

  // ── 状态推断:看最后一个有意义事件(不用 mtime,避免"答完瞬间日志刚写→误判忙") ──
  // 细分姿态:idle 等你 / think 思考(含泛忙兜底)/ bash 跑命令 / read 翻找文件 / edit 改文件
  const IDLE_AFTER_MS = 60000; // 真实用户输入悬挂超过此时长仍无 assistant 跟进 → 判 idle(秒取消/久挂的防卡死兜底)
  const toolState = (name) => {
    if (name === "Bash") return "bash";
    if (/^(WebSearch|WebFetch)$/.test(name)) return "web"; // 联网搜索 / 抓网页
    if (/^(Read|Grep|Glob|LS|NotebookRead)$/.test(name)) return "read";
    if (/^(Edit|Write|MultiEdit|NotebookEdit|Update)$/.test(name)) return "edit";
    return "think"; // 其他工具(TodoWrite / Task / Skill / mcp__*…)归思考 / 工作
  };
  function inferState(tp) {
    const fake = process.env.HUD_FAKE_STATE;
    if (fake) return fake === "busy" ? "think" : fake; // 兼容旧值 busy → think
    if (!tp) return "idle";
    try {
      const fs = require("fs");
      const ls = fs.readFileSync(tp, "utf8").split("\n").filter(Boolean);
      for (let i = ls.length - 1; i >= Math.max(0, ls.length - 40); i--) {
        let o;
        try {
          o = JSON.parse(ls[i]);
        } catch (e) {
          continue;
        }
        // 跳过 harness 注入的元记录(isMeta:true):如重命名会话会追加一条 role:"user" 的伪记录,
        // 正文是 "<system-reminder>The user named this session…"。它不是真实用户输入,
        // 倒序扫描若撞上它会被判成 think,导致改完会话名后卡在「思考中」不回「等你」。
        if (o.isMeta) continue;
        const m = o.message;
        if (!m || !m.role) continue;
        if (m.role === "assistant" && Array.isArray(m.content)) {
          const tus = m.content.filter((c) => c && c.type === "tool_use");
          if (tus.length) return toolState(tus[tus.length - 1].name); // 取最后一个工具调用
          if (m.content.some((c) => c && c.type === "text" && (c.text || "").trim())) {
            // 关键:同一轮里 assistant 的「开场白 text」与随后的 tool_use 是分开落盘的两条记录,
            // 共享同一 stop_reason。若 stop_reason 仍是 "tool_use"(或记录尚未写完、字段缺失),
            // 说明这轮还要继续调工具,只是 tool_use 行还没落盘 —— 此刻别把它误判成「休息」
            // (否则长任务里会突然变绿,且 text 长时间是最后一条,refreshInterval 也校正不回来)。
            // 只有拿到明确的收尾理由(end_turn 等)才算真的答完 → 等你。
            return m.stop_reason && m.stop_reason !== "tool_use" ? "idle" : "think";
          }
          if (m.content.some((c) => c && c.type === "thinking")) return "think"; // 仅思考 → 忙
        }
        if (m.role === "user") {
          // 中断标记:Ctrl+C 中断会写入一条 user 文本 "[Request interrupted by user...]"。
          // 它不是完整回复,默认会被判成 think 卡住忙态;识别后回到 idle(休息)。
          // 只看 type:"text"(或字符串)并锚定开头,避免某条 tool_result 正文碰巧含该词被误判。
          const texts = Array.isArray(m.content)
            ? m.content.filter((c) => c && c.type === "text").map((c) => c.text || "")
            : typeof m.content === "string"
              ? [m.content]
              : [];
          if (texts.some((t) => /^\s*\[Request interrupted by user/i.test(t))) return "idle";
          // 工具结果回传(content 含 tool_result)紧跟在 assistant 的 tool_use 之后,
          // 倒序扫描会先撞上它;若就此 return 会挡住前面的 tool_use,使 bash/read/edit 永远失效。
          // 故跳过它,继续回溯到对应的 tool_use 来判定姿态。
          const isToolResult =
            Array.isArray(m.content) && m.content.some((c) => c && c.type === "tool_result");
          if (isToolResult) continue;
          // 真实用户输入:正常是在等我响应 → think。
          // 但"提交后秒取消"会留下这条 user 记录,且 Claude Code 不对外暴露任何可识别信号
          // (取消不触发 Stop/UserPromptSubmit,transcript 与"正在等响应"完全一致),
          // 否则会被 refreshInterval 持续读到而永久卡在 think。兜底:这条输入落盘已超过
          // IDLE_AFTER_MS 仍无 assistant 跟进,多半已取消或会话久挂,回 idle 防卡死(resume 也能自愈)。
          const uts = Date.parse(o.timestamp || "");
          if (uts && Date.now() - uts > IDLE_AFTER_MS) return "idle";
          return "think"; // 真实用户输入(在等响应) → 思考中
        }
      }
    } catch (e) {}
    return "idle";
  }

  const cw = j.context_window || {};
  let ctx = cw.used_percentage;
  if (ctx == null && cw.context_window_size && cw.total_input_tokens != null)
    ctx = (cw.total_input_tokens / cw.context_window_size) * 100;
  const fh = (j.rate_limits || {}).five_hour || {},
    sd = (j.rate_limits || {}).seven_day || {};
  const five = fh.used_percentage,
    fiveR = fmtT(fh.resets_at);
  const seven = sd.used_percentage,
    sevenR = fmtT(sd.resets_at);
  const model = (j.model || {}).display_name || "";
  const cost = (j.cost || {}).total_cost_usd,
    dur = fmtD((j.cost || {}).total_duration_ms);
  const tp = j.transcript_path,
    todos = readTodos(tp);

  const state = inferState(tp);
  // 小兽姿态表:基底=初始「忙碌」站立形象。部位:眼=row1 的 ▛▜ 下角负空间、手=row2 两端 ▝▘、脚=row3。
  //   每个忙态只改一处:bash 改脚(两双筷子张开跑);read 改眼(row1 眼洞瞪大 ▀▀);edit 改手(row2 两端下压敲)。
  //   idle 用初始「休息」蜷缩形象。头顶 badge:think ?(思考,含兜底) / bash >_ / read ⌕ / edit I(输入光标) / idle zᶻ(art 右侧独立区,带间隔)。
  const STATES = {
    idle: { c: G, label: CFG.idleLabel, badge: "zᶻ", rows: ["  ▗▄▄▄▄▄▖", "  ▜█▆█▆█▛", "   ▔▔ ▔▔"] },
    think: { c: O, label: CFG.busyLabel, badge: "?", rows: [" ▐▛███▜▌", "▝▜█████▛▘", "  ▘▘ ▝▝"] },
    bash: { c: O, label: CFG.bashLabel, badge: ">_", rows: [" ▐▛███▜▌", "▝▜█████▛▘", " ▘▘   ▝▝"] },
    read: { c: O, label: CFG.readLabel, badge: "⌕", rows: [" ▐▀███▀▌", "▝▜█████▛▘", "  ▘▘ ▝▝"] },
    web: { c: O, label: CFG.webLabel, badge: "@", rows: [" ▐▀███▀▌", "▝▜█████▛▘", "  ▘▘ ▝▝"] }, // 复用 read 睁眼造型(同为"查找"),仅 badge/文案区分
    edit: { c: O, label: CFG.editLabel, badge: "I", rows: [" ▐▛███▜▌", "▗▜█████▛▖", "  ▘▘ ▝▝"] },
  };
  const st = STATES[state] || STATES.think;
  const lc = st.c;
  const ARTW = 9,
    BADGEW = 3; // art 主体宽 + 右侧 badge 区(头顶标记 ? / zᶻ,带 1 空格间隔,不挤压头部)
  const padW = (str, w) => str + " ".repeat(Math.max(0, w - [...str].length));
  const bx = st.badge ? " " + st.badge : "";
  const row1 = lc + padW(padW(st.rows[0], ARTW) + bx, ARTW + BADGEW) + R;
  const row2 = lc + padW(st.rows[1], ARTW + BADGEW) + R;
  const row3 = lc + padW(st.rows[2], ARTW + BADGEW) + R;
  const label = lc + st.label + R;

  const sep = "  " + D + "·" + R + "  ";
  const seg = (name, p, reset) => {
    const v = Math.round(p);
    return C(v) + name + " " + bar(v) + " " + v + "%" + R + (reset ? " " + D + "↻" + reset + R : "");
  };
  const segs = [];
  if (ctx != null) segs.push(seg("ctx", ctx, ""));
  if (five != null) segs.push(seg("5h", five, fiveR));
  if (seven != null) segs.push(seg("7d", seven, sevenR));
  const info2 = segs.join(sep);

  // 待办段渲染条件:
  //   ① length > 1：仅一个任务时无意义,忽略。
  //   ② done < length：当前计划全部完成即视为结束,不再显示(对应 Claude Code 完成后清空待办面板),
  //      避免一直停在 ✓5/5。多阶段自动推进时下一批 TaskCreate 会把 batchStart 推走、切到新计划,
  //      不会误隐藏;真正全完成时才是该消失的时刻。
  const todoDone = todos ? todos.filter((t) => t && t.status === "completed").length : 0;
  const todoSeg =
    todos && todos.length > 1 && todoDone < todos.length
      ? D + "✓" + todoDone + "/" + todos.length + R
      : "";
  const tail = [];
  if (model) tail.push(model);
  if (cost != null) tail.push("$" + cost.toFixed(2));
  if (dur) tail.push("⧗" + dur);
  const info3 = [todoSeg, tail.length ? D + tail.join(" ") + R : ""].filter(Boolean).join(sep);

  process.stdout.write(row1 + "  " + label + "\n" + row2 + "  " + info2 + "\n" + row3 + "  " + info3 + "\n");
});

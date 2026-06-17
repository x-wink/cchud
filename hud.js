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
      const ls = fs.readFileSync(tp, "utf8").split("\n");
      for (let i = ls.length - 1; i >= 0; i--) {
        if (!ls[i] || ls[i].indexOf("TodoWrite") < 0) continue;
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
    } catch (e) {}
    return null;
  }

  // ── 状态推断:看最后一个有意义事件(不用 mtime,避免"答完瞬间日志刚写→误判忙") ──
  // 细分姿态:idle 等你 / think 思考(含泛忙兜底)/ bash 跑命令 / read 翻找文件 / edit 改文件
  const IDLE_AFTER_MS = 120000; // 真实用户输入悬挂超过此时长仍无 assistant 跟进 → 判 idle(秒取消/久挂的防卡死兜底)
  const toolState = (name) => {
    if (name === "Bash") return "bash";
    if (/^(Read|Grep|Glob|LS|NotebookRead)$/.test(name)) return "read";
    if (/^(Edit|Write|MultiEdit|NotebookEdit|Update)$/.test(name)) return "edit";
    return "think"; // 其他工具(TodoWrite / Task / WebFetch…)归思考 / 工作
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
        const m = o.message;
        if (!m || !m.role) continue;
        if (m.role === "assistant" && Array.isArray(m.content)) {
          const tus = m.content.filter((c) => c && c.type === "tool_use");
          if (tus.length) return toolState(tus[tus.length - 1].name); // 取最后一个工具调用
          if (m.content.some((c) => c && c.type === "text" && (c.text || "").trim())) return "idle"; // 完整回复 → 等你
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

  const todoSeg =
    todos && todos.length
      ? D + "✓" + todos.filter((t) => t && t.status === "completed").length + "/" + todos.length + R
      : "";
  const tail = [];
  if (model) tail.push(model);
  if (cost != null) tail.push("$" + cost.toFixed(2));
  if (dur) tail.push("⧗" + dur);
  const info3 = [todoSeg, tail.length ? D + tail.join(" ") + R : ""].filter(Boolean).join(sep);

  process.stdout.write(row1 + "  " + label + "\n" + row2 + "  " + info2 + "\n" + row3 + "  " + info3 + "\n");
});

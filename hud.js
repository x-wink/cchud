// cchud — Claude Code 状态栏小兽
// 由 Claude Code 的 statusLine 通过 stdin 传入会话 JSON，输出三行带颜色的状态。
// 跨平台：node 读取，无平台相关代码。mac/Linux 见 hud.sh，Windows 见 README。
// 两种状态文本（忙碌 / 等你）可经配置或参数自定义，见 config.js。
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

  // ── 忙/等你:看最后一个有意义事件(不用 mtime,避免"答完瞬间日志刚写→误判忙") ──
  function inferBusy(tp) {
    if (process.env.HUD_FAKE_STATE) return process.env.HUD_FAKE_STATE === "busy";
    if (!tp) return false;
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
          if (m.content.some((c) => c && c.type === "tool_use")) return true; // 调工具 → 忙
          if (m.content.some((c) => c && c.type === "text" && (c.text || "").trim())) return false; // 完整回复 → 等你
          if (m.content.some((c) => c && c.type === "thinking")) return true; // 仅思考 → 忙
        }
        if (m.role === "user") return true; // 你的消息/工具结果 → 忙
      }
    } catch (e) {}
    return false;
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

  const busy = inferBusy(tp);
  const lc = busy ? O : G;
  const padW = (str, w) => {
    const n = [...str].length;
    return str + " ".repeat(Math.max(0, w - n));
  };
  // 忙:睁眼在第一行,站立;  等你:头顶实心(低头)+眼睛下移到第二行(▆眯),趴着
  const row1 = lc + padW(busy ? " ▐▛███▜▌" : "  ▗▄▄▄▄▄▖", 10) + R; // 等你:蜷缩低头(▗▄▖底部弧,7宽盖满身体)
  const row2 = lc + padW(busy ? "▝▜█████▛▘" : "  ▜█▆█▆█▛", 10) + R; // 等你:身也缩,眼在第二行
  const row3 = lc + padW(busy ? "  ▘▘ ▝▝" : "   ▔▔ ▔▔", 10) + R;
  const label = busy ? O + CFG.busyLabel + R : G + CFG.idleLabel + R; // 文本可配置，见 config.js

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

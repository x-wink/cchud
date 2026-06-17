// 预览生成器：跑真实 hud.js 输出 → 转成终端样式 HTML，供截图 / 浏览器预览。
//
// 用法：
//   node tools/preview.js            # 生成 tools/preview.html
//   再用浏览器打开 tools/preview.html，或本地起服务后截图：
//   node -e "const h=require('http'),f=require('fs');h.createServer((q,r)=>{r.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});r.end(f.readFileSync('tools/preview.html'))}).listen(8799)"
//
// README 里的 preview.png 即截取自本页面的 .term 元素。
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const HUD = path.join(__dirname, "..", "hud.js");

const busyJson = JSON.stringify({
  context_window: { used_percentage: 42 },
  rate_limits: {
    five_hour: { used_percentage: 63, resets_at: Math.floor(Date.now() / 1000) + 2 * 3600 + 15 * 60 },
    seven_day: { used_percentage: 88, resets_at: Math.floor(Date.now() / 1000) + 3 * 86400 + 5 * 3600 },
  },
  model: { display_name: "Opus 4.8" },
  cost: { total_cost_usd: 1.23, total_duration_ms: 3720000 },
});
const idleJson = JSON.stringify({
  context_window: { used_percentage: 42 },
  rate_limits: { five_hour: { used_percentage: 63 } },
  model: { display_name: "Opus 4.8" },
  cost: { total_cost_usd: 1.23 },
});

function run(json, state) {
  return execSync(`node "${HUD}"`, { input: json, env: { ...process.env, HUD_FAKE_STATE: state } }).toString();
}

const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function ansiToHtml(s) {
  let style = { fg: null, dim: false };
  let out = "";
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0,
    m;
  const flush = (text) => {
    if (!text) return;
    let st = "";
    if (style.fg) st += `color:${style.fg};`;
    if (style.dim) st += "opacity:.5;";
    out += `<span style="${st}">${esc(text)}</span>`;
  };
  while ((m = re.exec(s))) {
    flush(s.slice(last, m.index));
    last = re.lastIndex;
    const code = m[1];
    if (code === "0" || code === "") style = { fg: null, dim: false };
    else if (code === "2") style.dim = true;
    else if (code === "91") style.fg = "#ff6b81";
    else if (code === "93") style.fg = "#ffcf5c";
    else if (code === "92") style.fg = "#62e08a";
    else if (code.startsWith("38;2;")) {
      const [, , r, g, b] = code.split(";");
      style.fg = `rgb(${r},${g},${b})`;
    }
  }
  flush(s.slice(last));
  return out;
}

// 依次预览各状态：思考 / 跑命令 / 翻找 / 敲键盘 / 等你
const VARIANTS = [
  ["think", "思考中", busyJson],
  ["bash", "跑命令", busyJson],
  ["read", "翻找文件", busyJson],
  ["web", "联网搜索", busyJson],
  ["edit", "敲键盘", busyJson],
  ["idle", "等你输入", idleJson],
];
const blocks = VARIANTS.map(
  ([s, cap, json]) => `<span class="grp"><span class="cap"># ${cap}</span>${ansiToHtml(run(json, s))}</span>`,
).join("");

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#11111b;padding:32px;display:inline-block}
  .term{background:#1e1e2e;border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.55);overflow:hidden;width:780px}
  .bar{height:38px;background:#181825;display:flex;align-items:center;padding:0 16px;gap:8px;border-bottom:1px solid #2a2a3c}
  .dot{width:12px;height:12px;border-radius:50%}
  .r{background:#ff5f57}.y{background:#febc2e}.g{background:#28c840}
  .title{color:#6c7086;font:13px -apple-system,Segoe UI,sans-serif;margin-left:10px}
  .body{padding:18px 22px;font-family:"Consolas","Cascadia Mono","DejaVu Sans Mono","Menlo",monospace;font-size:16px;line-height:1;letter-spacing:0;color:#cdd6f4;white-space:pre}
  .cap{display:block;color:#6c7086;font:12px "Consolas",monospace;margin:14px 2px 8px;line-height:1.2}
  .grp:first-child .cap{margin-top:0}
</style></head><body><div class="term">
  <div class="bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span><span class="title">claude — cchud statusline</span></div>
  <div class="body">${blocks}</div>
</div></body></html>`;

fs.writeFileSync(path.join(__dirname, "preview.html"), html);
console.log("wrote tools/preview.html");

// cchud 配置解析（hud.js 与 notify.js 共用）。
// 优先级：CLI 参数 > 环境变量 > 配置文件 > 默认值。
//
//   CLI：     --name 小螃蟹 --busy-label "干活中…" --idle-label "等你~"
//   环境变量：CCHUD_NAME / CCHUD_BUSY_LABEL / CCHUD_IDLE_LABEL ...
//   配置文件：--config <path> 或 CCHUD_CONFIG 指定，否则依次找
//             ./cchud.config.json（脚本同目录）、~/.cchud.json
//
// doneTitle / needTitle 里的 {name} 会被替换成最终的 name。
const fs = require("fs");
const path = require("path");
const os = require("os");

const DEFAULTS = {
  name: "小螃蟹", // 称呼，用于通知标题
  busyLabel: "思考中 …", // 状态栏「思考 / 忙碌」文本（三字）
  bashLabel: "跑命令 …", // 状态栏「执行 Bash」文本
  readLabel: "翻找中 …", // 状态栏「读取 / 检索文件」文本
  webLabel: "搜索中 …", // 状态栏「联网搜索 / 抓取网页」文本
  editLabel: "敲键盘 …", // 状态栏「编辑 / 写文件」文本
  idleLabel: "休息中 …", // 状态栏「等你」文本（三字；zᶻ 睡眠标记画在小兽头顶,见 hud.js）
  waitLabel: "等确认 …", // 状态栏「等授权 / 等输入」文本（仅注册 hook 状态源后出现，见 state.js）
  doneTitle: "{name} · 忙完啦", // 通知标题：答完（Stop），项目名由 notify.js 接在后面
  doneBody: "主人~ 活儿干完啦，快回来看看 🦀",
  needTitle: "{name} · 等你搭把手", // 通知标题：需要授权 / 等待输入（Notification）
  needBody: "卡住啦，主人来搭把手~", // 仅当 Claude 未提供 message 时用作兜底
  sound: true, // 通知是否带提示音；设为 false（或 off/0/no）则只弹通知不出声
  stateDir: path.join(os.homedir(), ".cchud", "state"), // hook 状态文件目录（state.js 写、hud.js 读）
};

const FIELDS = Object.keys(DEFAULTS);
const toCamel = (s) => s.toLowerCase().replace(/[-_]([a-z])/g, (_, c) => c.toUpperCase());
const pick = (o) => {
  const r = {};
  for (const f of FIELDS) if (o && o[f] != null) r[f] = o[f];
  return r;
};

function fromArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (!a.startsWith("--")) continue;
    a = a.slice(2);
    let key, val;
    const eq = a.indexOf("=");
    if (eq >= 0) {
      key = a.slice(0, eq);
      val = a.slice(eq + 1);
    } else {
      key = a;
      val = argv[i + 1] != null && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    }
    o[toCamel(key)] = val;
  }
  return o;
}

function fromEnv(env) {
  const o = {};
  for (const k of Object.keys(env)) {
    if (k.startsWith("CCHUD_")) o[toCamel(k.slice(6))] = env[k];
  }
  return o;
}

function fromFile(args, env) {
  const candidates = [];
  const explicit = args.config || env.CCHUD_CONFIG;
  if (explicit) candidates.push(explicit);
  candidates.push(path.join(__dirname, "cchud.config.json"));
  candidates.push(path.join(os.homedir(), ".cchud.json"));
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return JSON.parse(fs.readFileSync(c, "utf8"));
    } catch (e) {}
  }
  return {};
}

function loadConfig(argv = process.argv.slice(2), env = process.env) {
  const args = fromArgs(argv);
  const cfg = { ...DEFAULTS, ...pick(fromFile(args, env)), ...pick(fromEnv(env)), ...pick(args) };
  for (const k of ["doneTitle", "needTitle"]) {
    cfg[k] = String(cfg[k]).replace(/\{name\}/g, cfg.name);
  }
  // sound 归一成布尔：文件里可写 true/false，环境变量 / CLI 是字符串，off/0/no/false 一律视为关。
  cfg.sound =
    typeof cfg.sound === "boolean" ? cfg.sound : !["false", "0", "off", "no", ""].includes(String(cfg.sound).trim().toLowerCase());
  return cfg;
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

module.exports = { loadConfig, DEFAULTS, toolState };

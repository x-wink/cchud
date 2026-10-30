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
const { toolState, notificationState, agentInfo, clipName } = require("./hook-adapter");

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
  sessionName: true, // 状态栏尾行 / 通知标题是否显示会话名（跨会话寻址的代号，见下方 agentInfo）
  sessionRef: false, // 会话名后是否再跟一个 ref（[3bbce9]，同名会话消歧用；ListAgents 才带它）
  projectName: true, // 取不到会话名时的回落：状态栏尾行显示项目目录名
  sessionId: true, // 取不到会话名时的回落：状态栏尾行显示会话短 id
  sessionIdLen: 8, // 会话短 id 取前几位（默认 8 = UUID 第一段）
  stateDir: path.join(os.homedir(), ".cchud", "state"), // hook 状态文件目录（state.js 写、hud.js 读）
  // Claude Code 活跃会话的登记目录（会话名与 ref 从这里读，见 agentInfo）
  sessionsDir: path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "sessions"),
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
  // 开关类归一成布尔：文件里可写 true/false，环境变量 / CLI 是字符串，off/0/no/false 一律视为关。
  const toBool = (v) =>
    typeof v === "boolean" ? v : !["false", "0", "off", "no", ""].includes(String(v).trim().toLowerCase());
  for (const k of ["sound", "sessionName", "sessionRef", "projectName", "sessionId"]) cfg[k] = toBool(cfg[k]);
  // 长度非法（非数字 / 越界）时退回默认，避免 slice 出空串让短 id 直接消失
  const n = parseInt(cfg.sessionIdLen, 10);
  cfg.sessionIdLen = n >= 2 && n <= 36 ? n : DEFAULTS.sessionIdLen;
  return cfg;
}

module.exports = { loadConfig, DEFAULTS, toolState, notificationState, agentInfo, clipName };

// cchud notify — Claude Code 需要你时提醒你（桌面通知 + 提示音）。
// 注册为两类钩子：
//   Stop         —— 主对话答完、把控制权交还给你（完成音 Ring01.wav）。
//   Notification —— 需要你授权 / 等待你输入（前台提示音 Windows Foreground.wav），具体事由在 stdin 的 message 字段。
// 凭声音即可分辨「答完了」还是「需要你处理」。
// 跨平台：Windows 用 PowerShell WinRT Toast（静音）+ SoundPlayer 播 .wav；macOS 用 osascript；Linux 用 notify-send。
// 钩子会从 stdin 收到会话 JSON（含 cwd / hook_event_name / message），用来组织通知文案。
// 称呼与文案默认为「小螃蟹」，可经配置或参数自定义，见 config.js。
const CFG = require("./config").loadConfig();
const fs = require("fs");

// 会话名截断：自动名（ai-title）可能是一整句话，超长会撑爆 toast 标题，按字数截断加省略号。
const NAME_MAX = 12;
function clipName(s) {
  s = String(s || "").trim();
  const a = Array.from(s); // 按码点截，避免切坏中文 / emoji
  return a.length > NAME_MAX ? a.slice(0, NAME_MAX).join("") + "…" : s;
}

// 读会话名：transcript 里有两类标题事件，倒序扫描——
//   custom-title（customTitle）：用户 /rename 设的，优先用，扫到即返回（最新一条）。
//   ai-title   （aiTitle）    ：Claude 自动生成的，随会话刷新；没有 custom 时回落到最新一条。
// 都没有（如很短的会话）则返回 ""。
function sessionName(tp) {
  try {
    if (!tp || !fs.existsSync(tp)) return "";
    const lines = fs.readFileSync(tp, "utf8").split("\n");
    let ai = "";
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].indexOf('Title"') < 0) continue; // customTitle / aiTitle
      let o;
      try {
        o = JSON.parse(lines[i]);
      } catch (e) {
        continue;
      }
      if (o && o.type === "custom-title" && o.customTitle) return clipName(o.customTitle);
      if (o && o.type === "ai-title" && o.aiTitle && !ai) ai = String(o.aiTitle);
    }
    return clipName(ai);
  } catch (e) {}
  return "";
}

let s = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  let j = {};
  try {
    j = JSON.parse(s || "{}");
  } catch (e) {}

  const path = require("path");
  const { spawn } = require("child_process");
  const proj = j.cwd ? path.basename(j.cwd) : "";
  const sess = sessionName(j.transcript_path);
  // 标题尾巴：项目名 + 会话名都显示（cchud / 会话名）；缺一个、或两者相同就只显示一个。
  const where = proj && sess && sess !== proj ? `${proj} / ${sess}` : proj || sess;
  const isNotif = j.hook_event_name === "Notification";

  let title, body, winWav, macSound;
  if (isNotif) {
    // 需要授权 / 等待输入：message 由 Claude Code 给出（多为英文），直接作正文。
    title = where ? `${CFG.needTitle} · ${where}` : CFG.needTitle;
    body = j.message || CFG.needBody;
    winWav = "Windows Foreground.wav"; // 等待交互：前台提示音
    macSound = "Funk";
  } else {
    // Stop：答完了。
    title = where ? `${CFG.doneTitle} · ${where}` : CFG.doneTitle;
    body = CFG.doneBody;
    winWav = "Ring01.wav"; // 完成任务：铃声
    macSound = "Glass";
  }

  // 不用 detached + unref：实测 Windows 上 detached 子进程会在父进程退出时被一起回收，
  // toast 来不及注册就没了（声音同理）。改为让本进程等子进程跑完——约 1 秒（PlaySync 会等提示音
  // 播完）。Stop / Notification 触发时用户已看到回复，短暂阻塞无碍。
  const fire = (cmd, args) => {
    try {
      spawn(cmd, args, { stdio: "ignore", windowsHide: true });
    } catch (e) {}
  };

  if (process.platform === "win32") {
    const psq = (t) => "'" + String(t).replace(/'/g, "''") + "'";
    const ps = `
$ErrorActionPreference='SilentlyContinue'
[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]
[void][Windows.UI.Notifications.ToastNotification,Windows.UI.Notifications,ContentType=WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]
$tpl=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t=$tpl.GetElementsByTagName('text')
[void]$t.Item(0).AppendChild($tpl.CreateTextNode(${psq(title)}))
[void]$t.Item(1).AppendChild($tpl.CreateTextNode(${psq(body)}))
# toast 默认自带系统通知音，静音它，改由下面 SoundPlayer 按场景放不同的 .wav（不重复播放）
$audio=$tpl.CreateElement('audio')
$audio.SetAttribute('silent','true')
[void]$tpl.DocumentElement.AppendChild($audio)
$app='{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
$toast=[Windows.UI.Notifications.ToastNotification]::new($tpl)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show($toast)
(New-Object System.Media.SoundPlayer "$env:WINDIR\\Media\\${winWav}").PlaySync()
`;
    const b64 = Buffer.from(ps, "utf16le").toString("base64");
    fire("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", b64]);
  } else if (process.platform === "darwin") {
    const q = (t) => '"' + String(t).replace(/"/g, '\\"') + '"';
    fire("osascript", ["-e", `display notification ${q(body)} with title ${q(title)} sound name "${macSound}"`]);
  } else {
    const shq = (t) => "'" + String(t).replace(/'/g, "'\\''") + "'";
    fire("sh", [
      "-c",
      `notify-send ${shq(title)} ${shq(body)}; ` +
        `paplay /usr/share/sounds/freedesktop/stereo/complete.oga 2>/dev/null || true`,
    ]);
  }
});

const { loadConfig } = require("./config");
const { normalizeHook, hookClient, identity } = require("./hook-adapter");
const { titleFor } = require("./hook-state");
const { spawn } = require("child_process");

function notificationFor(event, cfg) {
  if (!event || !(event.kind === "done" || event.state === "wait")) return undefined;
  const agent = identity(event, cfg);
  const where = titleFor(event.project, agent.name) + (agent.ref ? ` [${agent.ref}]` : "");
  const need = event.state === "wait";
  const body = need ? event.message.trim() || cfg.needBody : cfg.doneBody;
  return {
    title: (need ? cfg.needTitle : cfg.doneTitle) + (where ? ` · ${where}` : ""),
    body,
    winWav: need ? "Ring01.wav" : "Windows Foreground.wav",
    macSound: need ? "Funk" : "Glass",
  };
}

function sendNotification(notice, CFG) {
  const { title, body, winWav, macSound } = notice;
  // 不用 detached + unref：实测 Windows 上 detached 子进程会在父进程退出时被一起回收，
  // toast 来不及注册就没了（声音同理）。改为让本进程等子进程跑完——约 1 秒（PlaySync 会等提示音
  // 播完）。Stop / Notification 触发时用户已看到回复，短暂阻塞无碍。
  const fire = (cmd, args) => {
    try {
      const child = spawn(cmd, args, { stdio: "ignore", windowsHide: true });
      child.on("error", () => {});
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
${CFG.sound ? `(New-Object System.Media.SoundPlayer "$env:WINDIR\\Media\\${winWav}").PlaySync()` : ""}
`;
    const b64 = Buffer.from(ps, "utf16le").toString("base64");
    fire("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", b64]);
  } else if (process.platform === "darwin") {
    const q = (t) => '"' + String(t).replace(/"/g, '\\"') + '"';
    const macSoundClause = CFG.sound ? ` sound name "${macSound}"` : "";
    fire("osascript", ["-e", `display notification ${q(body)} with title ${q(title)}${macSoundClause}`]);
  } else {
    const shq = (t) => "'" + String(t).replace(/'/g, "'\\''") + "'";
    const paplay = CFG.sound
      ? `; paplay /usr/share/sounds/freedesktop/stereo/complete.oga 2>/dev/null || true`
      : "";
    fire("sh", ["-c", `notify-send ${shq(title)} ${shq(body)}${paplay}`]);
  }

}

if (require.main === module) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (data) => input += data);
  process.stdin.on("end", () => {
    try {
      const cfg = loadConfig();
      const event = normalizeHook(JSON.parse(input || "{}"), hookClient());
      const notice = notificationFor(event, cfg);
      if (notice) sendNotification(notice, cfg);
    } catch {}
  });
}

module.exports = { notificationFor };

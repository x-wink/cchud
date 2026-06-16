// cchud notify — Claude Code「答完、切回等你」时提醒你。
// 注册为 Stop 钩子：每次主对话停止（把控制权交还给你）时触发，弹桌面通知 + 播提示音。
// 跨平台：Windows 用 PowerShell WinRT Toast + SystemSounds；macOS 用 osascript；Linux 用 notify-send。
// 钩子会从 stdin 收到会话 JSON（含 cwd），用来在通知里标出是哪个项目。
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
  const title = "气质小兽 · 等你了";
  const body = proj ? `Claude Code 答完了 ✓  ·  ${proj}` : "Claude Code 答完了，回来看看 ✓";

  // detached + unref：立刻返回，不阻塞 Claude Code；通知/声音由子进程异步完成。
  const fire = (cmd, args) => {
    try {
      spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true }).unref();
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
$app='{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
$toast=[Windows.UI.Notifications.ToastNotification]::new($tpl)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show($toast)
[System.Media.SystemSounds]::Asterisk.Play()
Start-Sleep -Milliseconds 600
`;
    const b64 = Buffer.from(ps, "utf16le").toString("base64");
    fire("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", b64]);
  } else if (process.platform === "darwin") {
    const q = (t) => '"' + String(t).replace(/"/g, '\\"') + '"';
    fire("osascript", ["-e", `display notification ${q(body)} with title ${q(title)} sound name "Glass"`]);
  } else {
    const shq = (t) => "'" + String(t).replace(/'/g, "'\\''") + "'";
    fire("sh", [
      "-c",
      `notify-send ${shq(title)} ${shq(body)}; ` +
        `paplay /usr/share/sounds/freedesktop/stereo/complete.oga 2>/dev/null || true`,
    ]);
  }
});

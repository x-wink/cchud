//! `pet-hook setup`:把九个事件的钩子幂等写进 Claude Code 的 settings.json(pet-release D437)。
//! 手工抄九条是用户装不上的第一来源;命令写的是本程序此刻的绝对路径,装到哪就指哪,再不碰 `target/`。
//! 只动自己的条目:别的钩子、别的键、键的顺序都原样保留(`preserve_order`),写前备份一份 `.bak`。

use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

/// 九个事件(与 `hook.rs` 的 `decide` 认的那些一致)
pub const EVENTS: [&str; 9] = [
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PostToolBatch",
    "Notification",
    "Stop",
    "SessionStart",
    "SessionEnd",
];

#[derive(Debug, Default, PartialEq)]
pub struct Options {
    pub dry_run: bool,
    pub uninstall: bool,
    /// 另指 settings.json(测试与多配置目录用);缺省按 `CLAUDE_CONFIG_DIR` / `~/.claude`
    pub settings: Option<PathBuf>,
}

impl Options {
    pub fn parse<I: IntoIterator<Item = String>>(args: I) -> Result<Self, String> {
        let mut o = Options::default();
        let mut args = args.into_iter();
        while let Some(a) = args.next() {
            match a.as_str() {
                "--dry-run" => o.dry_run = true,
                "--uninstall" => o.uninstall = true,
                "--settings" => {
                    o.settings = Some(PathBuf::from(args.next().ok_or("--settings 后面要跟路径")?));
                }
                other => return Err(format!("不认识的参数 {other}")),
            }
        }
        Ok(o)
    }
}

/// 一次 setup 改了什么,给人看也给测试断言
#[derive(Debug, Default, PartialEq)]
pub struct Report {
    pub added: Vec<String>,
    pub replaced: Vec<String>,
    pub removed: Vec<String>,
}

impl Report {
    pub fn is_noop(&self) -> bool {
        self.added.is_empty() && self.replaced.is_empty() && self.removed.is_empty()
    }
}

/// Claude Code 的配置目录:`CLAUDE_CONFIG_DIR`(空串不算)优先,否则 `~/.claude`。钩子找会话登记也用它
pub fn claude_config_dir() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .or_else(|| pet_state::home_dir().map(|h| h.join(".claude")))
}

/// settings.json 在哪
pub fn default_settings_path() -> Option<PathBuf> {
    Some(claude_config_dir()?.join("settings.json"))
}

/// 钩子命令:本程序的绝对路径,按 shell 的规矩加引号(Claude Code 把它交给 shell)。
/// Windows 上走 Git Bash,不加引号的反斜杠会被吃掉:换成正斜杠再包双引号(cmd 也认);
/// 别处只含安全字符就原样,否则包单引号,路径里的单引号写成 `'\''`
pub fn command_for(exe: &Path) -> String {
    quote(&exe.display().to_string(), cfg!(windows))
}

fn quote(path: &str, windows: bool) -> String {
    if windows {
        format!("\"{}\"", path.replace('\\', "/"))
    } else if path.chars().all(|c| c.is_ascii_alphanumeric() || "/._-+".contains(c)) {
        path.to_string()
    } else {
        format!("'{}'", path.replace('\'', r"'\''"))
    }
}

/// 命令拆成程序与其余部分:程序可以被双引号或单引号包着(路径带空格)
fn split_program(command: &str) -> (&str, &str) {
    let s = command.trim_start();
    match s.chars().next() {
        Some(q @ ('"' | '\'')) => match s[1..].find(q) {
            Some(end) => (&s[1..1 + end], &s[2 + end..]),
            None => (&s[1..], ""),
        },
        _ => {
            let end = s.find(char::is_whitespace).unwrap_or(s.len());
            (&s[..end], &s[end..])
        }
    }
}

/// 这条钩子命令是不是我们的:本程序的命令、程序叫 pet-hook 的,或者旧版 `pet --hook`。
/// 只看程序那个词:`node /x/pet-hook` 是别人拿 node 跑的脚本,不算
fn is_ours(command: &str, ours: &str) -> bool {
    if command == ours {
        return true;
    }
    let (program, rest) = split_program(command);
    match program.rsplit(['/', '\\']).next().unwrap_or(program) {
        "pet-hook" | "pet-hook.exe" => true,
        "pet" | "pet.exe" => rest.split_whitespace().next() == Some("--hook"),
        _ => false,
    }
}

fn our_entry(ours: &str) -> Value {
    json!({ "hooks": [{ "type": "command", "command": ours, "async": true }] })
}

/// 从一个事件的条目列表里摘掉我们的钩子,返回摘了几条。只摘条目里属于我们的那几条命令:
/// 手写的条目常把别人的钩子与旧的 `pet --hook` 放在同一个 `hooks` 数组里,整条删会连带删掉别人的;
/// 摘空了的条目才整条去掉
fn strip_ours(list: &mut Vec<Value>, ours: &str) -> usize {
    let mut dropped = 0;
    let mut emptied = Vec::with_capacity(list.len());
    for entry in list.iter_mut() {
        let mut now_empty = false;
        if let Some(hooks) = entry.get_mut("hooks").and_then(Value::as_array_mut) {
            let n = hooks.len();
            hooks.retain(|h| !h.get("command").and_then(Value::as_str).is_some_and(|c| is_ours(c, ours)));
            dropped += n - hooks.len();
            now_empty = n > 0 && hooks.is_empty();
        }
        emptied.push(now_empty);
    }
    let mut i = 0;
    list.retain(|_| {
        i += 1;
        !emptied[i - 1]
    });
    dropped
}

/// 纯函数:在一份 settings 上应用安装 / 卸载,返回改动清单。settings 不是对象就报错,不猜
pub fn apply(settings: &mut Value, ours: &str, uninstall: bool) -> Result<Report, String> {
    let root = settings.as_object_mut().ok_or("settings.json 顶层不是对象")?;
    let mut report = Report::default();
    let hooks_value = root.entry("hooks").or_insert_with(|| Value::Object(Map::new()));
    let hooks = hooks_value.as_object_mut().ok_or("settings.json 的 hooks 不是对象")?;
    for event in EVENTS {
        let list = hooks.entry(event).or_insert_with(|| Value::Array(Vec::new()));
        let Some(list) = list.as_array_mut() else {
            return Err(format!("hooks.{event} 不是数组"));
        };
        // 算「没动」要整条一模一样:指向本程序但同步跑、带了 matcher 的旧条目也得重写,
        // 同步钩子会卡住会话
        let wanted = our_entry(ours);
        let had_exact = list.contains(&wanted);
        let dropped = strip_ours(list, ours);
        if uninstall {
            if dropped > 0 {
                report.removed.push(event.to_string());
            }
        } else {
            list.push(wanted);
            match (dropped, had_exact) {
                (0, _) => report.added.push(event.to_string()),
                (1, true) => {}
                _ => report.replaced.push(event.to_string()),
            }
        }
        if list.is_empty() {
            hooks.remove(event);
        }
    }
    if hooks.is_empty() {
        root.remove("hooks");
    }
    Ok(report)
}

/// 读 → 改 → 备份 → 原子写。文件不存在当空对象;`dry_run` 只算不写
pub fn run(opts: &Options, exe: &Path) -> Result<Report, String> {
    let path = opts
        .settings
        .clone()
        .or_else(default_settings_path)
        .ok_or("找不到主目录,用 --settings 指定 settings.json")?;
    // settings.json 常软链到 dotfiles 仓:原子写的 rename 会把链接本身换成普通文件,写到链接指向的真文件上
    let path = std::fs::canonicalize(&path).unwrap_or(path);
    let original = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => b"{}".to_vec(),
        Err(e) => return Err(format!("{} 读不了:{e}", path.display())),
    };
    let mut settings: Value = if original.iter().all(u8::is_ascii_whitespace) {
        Value::Object(Map::new())
    } else {
        serde_json::from_slice(&original).map_err(|e| format!("{} 不是合法 JSON:{e}", path.display()))?
    };
    let ours = command_for(exe);
    let report = apply(&mut settings, &ours, opts.uninstall)?;
    if opts.dry_run || report.is_noop() {
        return Ok(report);
    }
    let mut bytes = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    if path.exists() {
        let bak = path.with_extension("json.bak");
        std::fs::write(&bak, &original).map_err(|e| format!("{} 备份失败:{e}", bak.display()))?;
    }
    pet_state::write_atomic(&path, &bytes).map_err(|e| format!("{} 写不进去:{e}", path.display()))?;
    Ok(report)
}

/// 给人看的一段话
pub fn describe(report: &Report, opts: &Options, exe: &Path) -> String {
    let mut lines = Vec::new();
    let verb = if opts.dry_run { "将" } else { "已" };
    if report.is_noop() {
        lines.push(if opts.uninstall {
            "settings.json 里没有 pet-hook 的钩子,无需卸载。".to_string()
        } else {
            format!("九条钩子都已指向 {},无需改动。", command_for(exe))
        });
    }
    if !report.added.is_empty() {
        lines.push(format!("{verb}新增 {} 条钩子:{}", report.added.len(), report.added.join("、")));
    }
    if !report.replaced.is_empty() {
        lines.push(format!("{verb}把 {} 条旧注册换成本程序路径:{}", report.replaced.len(), report.replaced.join("、")));
    }
    if !report.removed.is_empty() {
        lines.push(format!("{verb}删掉 {} 条钩子:{}", report.removed.len(), report.removed.join("、")));
    }
    if !opts.uninstall && !report.is_noop() {
        lines.push(format!("命令:{}", command_for(exe)));
    }
    if !opts.dry_run && !report.is_noop() {
        lines.push("原文件已备份为 settings.json.bak;新开的 Claude Code 会话生效。".to_string());
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = "/usr/local/bin/pet-hook";

    fn events_pointing_to(settings: &Value, cmd: &str) -> Vec<&'static str> {
        EVENTS
            .into_iter()
            .filter(|ev| {
                settings["hooks"].get(ev).and_then(Value::as_array).is_some_and(|l| {
                    l.iter().any(|e| {
                        e["hooks"].as_array().is_some_and(|hs| hs.iter().any(|h| h["command"] == cmd))
                    })
                })
            })
            .collect()
    }

    #[test]
    fn fresh_install_adds_nine_and_is_idempotent() {
        let mut s = json!({});
        let r = apply(&mut s, EXE, false).unwrap();
        assert_eq!(r.added.len(), 9);
        assert_eq!(events_pointing_to(&s, EXE).len(), 9);
        assert_eq!(s["hooks"]["Stop"][0]["hooks"][0]["async"], true);
        let again = apply(&mut s, EXE, false).unwrap();
        assert!(again.is_noop(), "{again:?}");
        assert_eq!(s["hooks"]["Stop"].as_array().unwrap().len(), 1, "不重复加");
    }

    #[test]
    fn other_hooks_and_keys_survive_and_old_pet_hook_is_migrated() {
        let mut s = json!({
            "statusLine": { "type": "command", "command": "node hud.js" },
            "hooks": {
                "Stop": [
                    { "hooks": [{ "type": "command", "command": "node notify.js" }] },
                    { "hooks": [{ "type": "command", "command": "/repo/target/release/pet --hook", "async": true }] }
                ],
                "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "echo hi" }] }]
            }
        });
        let r = apply(&mut s, EXE, false).unwrap();
        assert_eq!(r.replaced, ["Stop"], "旧的 pet --hook 被换掉");
        assert_eq!(r.added.len(), 8);
        let stop = s["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2);
        assert_eq!(stop[0]["hooks"][0]["command"], "node notify.js", "别人的钩子原样在前");
        assert_eq!(stop[1]["hooks"][0]["command"], EXE);
        assert_eq!(s["hooks"]["PreToolUse"][0]["matcher"], "Bash", "带 matcher 的别家条目不动");
        assert_eq!(s["statusLine"]["command"], "node hud.js");
    }

    #[test]
    fn uninstall_restores_shape() {
        let original = json!({ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "node notify.js" }] }] } });
        let mut s = original.clone();
        apply(&mut s, EXE, false).unwrap();
        let r = apply(&mut s, EXE, true).unwrap();
        assert_eq!(r.removed.len(), 9);
        assert_eq!(s, original, "只删自己加的,空数组与空 hooks 一并收走");
        let mut empty = json!({});
        apply(&mut empty, EXE, false).unwrap();
        apply(&mut empty, EXE, true).unwrap();
        assert_eq!(empty, json!({}));
        assert!(apply(&mut empty, EXE, true).unwrap().is_noop());
    }

    #[test]
    fn recognises_ours_in_several_spellings() {
        assert!(is_ours(r#""C:\Program Files\pet-hook.exe""#, EXE));
        assert!(is_ours(r#""C:/Program Files/pet-hook.exe" --x"#, EXE), "引号里的程序后面跟参数");
        assert!(is_ours("'/a b/pet-hook'", EXE));
        assert!(is_ours("/opt/homebrew/bin/pet-hook", EXE));
        assert!(is_ours("/x/target/release/pet --hook", EXE));
        assert!(is_ours(r#""C:\Program Files\oxforge\pet.exe" --hook"#, EXE), "带引号的旧注册");
        assert!(!is_ours("node state.js", EXE));
        assert!(!is_ours("node /some/dir/pet-hook", EXE), "别人拿 node 跑的同名脚本");
        assert!(!is_ours("/x/pet", EXE), "小兽本体不是钩子");
        assert!(!is_ours("/x/pet --hooks", EXE));
    }

    #[test]
    fn commands_are_quoted_for_the_shell() {
        assert_eq!(quote("/a/pet-hook", false), "/a/pet-hook");
        assert_eq!(quote("/a b/pet-hook", false), "'/a b/pet-hook'");
        assert_eq!(quote("/it's/pet-hook", false), r"'/it'\''s/pet-hook'");
        assert_eq!(quote(r"C:\Users\dev\.cargo\bin\pet-hook.exe", true), "\"C:/Users/dev/.cargo/bin/pet-hook.exe\"");
        for (path, win) in [("/a b/pet-hook", false), (r"C:\Program Files\pet-hook.exe", true)] {
            assert!(is_ours(&quote(path, win), "something-else"), "{path} 加了引号还认得出");
        }
    }

    /// 手写条目把别人的钩子与旧注册放在同一个数组里:只摘我们的那条
    #[test]
    fn shared_entry_keeps_the_other_hooks() {
        let mut s = json!({ "hooks": { "Stop": [{ "hooks": [
            { "type": "command", "command": "node notify.js" },
            { "type": "command", "command": "/x/target/release/pet --hook" }
        ] }] } });
        let r = apply(&mut s, EXE, false).unwrap();
        assert_eq!(r.replaced, ["Stop"]);
        let stop = s["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop[0]["hooks"], json!([{ "type": "command", "command": "node notify.js" }]));
        assert_eq!(stop[1], our_entry(EXE));
        apply(&mut s, EXE, true).unwrap();
        assert_eq!(s["hooks"]["Stop"][0]["hooks"][0]["command"], "node notify.js", "卸载也只摘自己的");
    }

    /// 指向本程序但同步跑、带 matcher 的条目要重写成异步,不能报「无需改动」
    #[test]
    fn exact_path_with_wrong_shape_is_rewritten() {
        let mut s = json!({ "hooks": { "Stop": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": EXE }] }] } });
        let r = apply(&mut s, EXE, false).unwrap();
        assert_eq!(r.replaced, ["Stop"]);
        assert_eq!(s["hooks"]["Stop"], json!([our_entry(EXE)]));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_settings_stay_a_symlink() {
        let dir = std::env::temp_dir().join(format!("pet-hook-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let real = dir.join("real.json");
        let link = dir.join("settings.json");
        std::fs::write(&real, "{}").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        run(&Options { settings: Some(link.clone()), ..Options::default() }, Path::new(EXE)).unwrap();
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink(), "链接还在");
        let written: Value = serde_json::from_slice(&std::fs::read(&real).unwrap()).unwrap();
        assert_eq!(events_pointing_to(&written, EXE).len(), 9, "写进了链接指向的真文件");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn run_writes_backup_and_honours_dry_run() {
        let dir = std::env::temp_dir().join(format!("pet-hook-setup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path, "{\n  \"theme\": \"dark\"\n}\n").unwrap();
        let exe = Path::new(EXE);
        let dry = Options { dry_run: true, uninstall: false, settings: Some(path.clone()) };
        assert_eq!(run(&dry, exe).unwrap().added.len(), 9);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\n  \"theme\": \"dark\"\n}\n", "dry-run 不写");
        let real = Options { settings: Some(path.clone()), ..Options::default() };
        run(&real, exe).unwrap();
        let written: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(written["theme"], "dark");
        assert_eq!(events_pointing_to(&written, EXE).len(), 9);
        assert_eq!(std::fs::read_to_string(dir.join("settings.json.bak")).unwrap(), "{\n  \"theme\": \"dark\"\n}\n");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.find("\"theme\"").unwrap() < text.find("\"hooks\"").unwrap(), "键序保留,theme 在前");
        // 没有文件也能装
        let fresh = dir.join("none").join("settings.json");
        run(&Options { settings: Some(fresh.clone()), ..Options::default() }, exe).unwrap();
        assert!(fresh.exists());
        assert!(Options::parse(["--dry-run".to_string()]).unwrap().dry_run);
        assert!(Options::parse(["--bogus".to_string()]).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

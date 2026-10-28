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

/// settings.json 在哪:`CLAUDE_CONFIG_DIR` 优先,否则 `~/.claude/settings.json`
pub fn default_settings_path() -> Option<PathBuf> {
    let dir = std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .or_else(|| pet_state::home_dir().map(|h| h.join(".claude")))?;
    Some(dir.join("settings.json"))
}

/// 钩子命令:本程序的绝对路径,带空格就整个用双引号包起来(Claude Code 把它交给 shell)
pub fn command_for(exe: &Path) -> String {
    let s = exe.display().to_string();
    if s.chars().any(char::is_whitespace) {
        format!("\"{s}\"")
    } else {
        s
    }
}

/// 这条钩子命令是不是我们的:本程序的路径、任何叫 pet-hook 的程序,或者旧版 `pet --hook`
fn is_ours(command: &str, ours: &str) -> bool {
    if command == ours {
        return true;
    }
    let trimmed = command.trim().trim_matches('"').trim_matches('\'');
    if trimmed.ends_with(" --hook") && trimmed.trim_end_matches(" --hook").rsplit(['/', '\\']).next().is_some_and(|b| b == "pet" || b == "pet.exe") {
        return true;
    }
    // 整串当一条路径看(带空格的路径被引号包着),再看第一个空白前的那段(路径后面跟了参数)
    let whole = trimmed.rsplit(['/', '\\']).next().unwrap_or(trimmed);
    let first = trimmed.split_whitespace().next().unwrap_or("");
    let head = first.rsplit(['/', '\\']).next().unwrap_or(first);
    [whole, head].into_iter().any(|b| matches!(b, "pet-hook" | "pet-hook.exe"))
}

/// 一个事件的钩子数组里,哪些条目是我们的(条目形如 `{ "hooks": [ { "type": "command", "command": … } ] }`)
fn entry_is_ours(entry: &Value, ours: &str) -> bool {
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hooks| {
            hooks
                .iter()
                .any(|h| h.get("command").and_then(Value::as_str).is_some_and(|c| is_ours(c, ours)))
        })
}

fn our_entry(ours: &str) -> Value {
    json!({ "hooks": [{ "type": "command", "command": ours, "async": true }] })
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
        let before = list.len();
        let had_exact = list.iter().any(|e| {
            e.get("hooks").and_then(Value::as_array).is_some_and(|hs| {
                hs.iter().any(|h| h.get("command").and_then(Value::as_str) == Some(ours))
            })
        });
        list.retain(|e| !entry_is_ours(e, ours));
        let dropped = before - list.len();
        if uninstall {
            if dropped > 0 {
                report.removed.push(event.to_string());
            }
        } else {
            list.push(our_entry(ours));
            match (dropped, had_exact) {
                (0, _) => report.added.push(event.to_string()),
                // 已经指向本程序、一条不多不少:算没动
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
        assert!(is_ours("/opt/homebrew/bin/pet-hook", EXE));
        assert!(is_ours("/x/target/release/pet --hook", EXE));
        assert!(!is_ours("node state.js", EXE));
        assert!(!is_ours("/x/pet", EXE), "小兽本体不是钩子");
        assert_eq!(command_for(Path::new("/a b/pet-hook")), "\"/a b/pet-hook\"");
        assert_eq!(command_for(Path::new("/a/pet-hook")), "/a/pet-hook");
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

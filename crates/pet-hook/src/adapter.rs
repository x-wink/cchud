use std::path::{Path, PathBuf};

use pet_state::State;
use serde_json::Value;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Client {
    #[default]
    Claude,
    Codex,
}

impl Client {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "claude" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            _ => Err(format!("不支持的客户端 {s},可用 claude 或 codex")),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    pub fn events(self) -> &'static [&'static str] {
        match self {
            Self::Claude => &[
                "UserPromptSubmit",
                "PreToolUse",
                "PostToolUse",
                "PostToolUseFailure",
                "PostToolBatch",
                "Notification",
                "Stop",
                "SessionStart",
                "SessionEnd",
            ],
            Self::Codex => &[
                "UserPromptSubmit",
                "PreToolUse",
                "PostToolUse",
                "PermissionRequest",
                "Stop",
                "Interrupt",
                "SessionStart",
                "SessionEnd",
            ],
        }
    }

    pub fn config_dir(self) -> Option<PathBuf> {
        let (env, fallback) = match self {
            Self::Claude => ("CLAUDE_CONFIG_DIR", ".claude"),
            Self::Codex => ("CODEX_HOME", ".codex"),
        };
        std::env::var_os(env)
            .filter(|d| !d.is_empty())
            .map(PathBuf::from)
            .or_else(|| pet_state::home_dir().map(|h| h.join(fallback)))
    }

    pub fn settings_path(self) -> Option<PathBuf> {
        Some(self.config_dir()?.join(match self {
            Self::Claude => "settings.json",
            Self::Codex => "hooks.json",
        }))
    }

    pub fn command_for(self, exe: &Path, windows: bool) -> String {
        let path = exe.display().to_string();
        if self == Self::Codex && windows {
            // Codex 的 Windows Hook 由 PowerShell 执行;带引号的路径要用调用运算符,
            // 单引号还能避免用户名里的 $ 被展开,路径中的单引号按 PowerShell 规则成对转义。
            return format!(
                "& '{}' --client codex",
                path.replace('\\', "/").replace('\'', "''")
            );
        }
        let command = if windows {
            format!("\"{}\"", path.replace('\\', "/"))
        } else if path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/._-+".contains(c))
        {
            path
        } else {
            format!("'{}'", path.replace('\'', r"'\''"))
        };
        match self {
            Self::Claude => command,
            Self::Codex => format!("{command} --client codex"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Prompt,
    ToolStart,
    ToolEnd,
    BatchEnd,
    Notice,
    Done,
    Start,
    End,
    Interrupt,
}

#[derive(Debug)]
pub struct Event {
    pub kind: Kind,
    pub state: State,
    /// 落盘事件沿用读方已有的词汇;客户端原始事件另存 source_event。
    pub event: String,
    pub source: String,
    pub source_event: String,
    pub session_id: String,
    pub turn_id: String,
    pub call_id: String,
    pub tool: String,
    pub transcript: String,
    pub message: String,
    pub project: String,
    client: Client,
}

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

pub fn session_id(input: &Value) -> String {
    let sid = text(input, "session_id");
    let raw = if sid.is_empty() {
        text(input, "transcript_path")
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or("")
            .trim_end_matches(".jsonl")
    } else {
        sid
    };
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        .collect()
}

pub fn normalize(client: Client, input: &Value) -> Option<Event> {
    let raw = text(input, "hook_event_name");
    if !client.events().contains(&raw) {
        return None;
    }
    let tool = text(input, "tool_name");
    let (kind, state, event) = match raw {
        "UserPromptSubmit" => (Kind::Prompt, State::Think, raw),
        "PreToolUse" if client == Client::Codex && tool == "request_user_input" => {
            (Kind::ToolStart, State::Wait, "Notification")
        }
        "PreToolUse" => (Kind::ToolStart, tool_state(client, tool), raw),
        "PostToolUse" | "PostToolUseFailure" => (Kind::ToolEnd, State::Think, raw),
        "PostToolBatch" => (Kind::BatchEnd, State::Think, raw),
        "Notification" => (
            Kind::Notice,
            notification_state(input.get("notification_type").and_then(Value::as_str))?,
            raw,
        ),
        "PermissionRequest" => (Kind::Notice, State::Wait, "Notification"),
        "Stop" => (Kind::Done, State::Idle, raw),
        "SessionStart" if client == Client::Codex && text(input, "source") == "compact" => {
            (Kind::Start, State::Think, raw)
        }
        "SessionStart" => (Kind::Start, State::Idle, raw),
        "SessionEnd" => (Kind::End, State::Idle, raw),
        "Interrupt" => (Kind::Interrupt, State::Idle, raw),
        _ => return None,
    };
    let sid = session_id(input);
    if sid.is_empty() {
        return None;
    }
    let message = match client {
        Client::Codex if raw == "PermissionRequest" => text(&input["tool_input"], "description"),
        _ => text(input, "message"),
    };
    Some(Event {
        kind,
        state,
        event: event.into(),
        source: client.name().into(),
        source_event: raw.into(),
        session_id: sid,
        turn_id: text(input, "turn_id").into(),
        call_id: text(input, "tool_use_id")
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
            .collect(),
        tool: tool.into(),
        transcript: text(input, "transcript_path").into(),
        message: message.into(),
        project: text(input, "cwd")
            .trim_end_matches(['/', '\\'])
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or("")
            .into(),
        client,
    })
}

pub fn tool_state(client: Client, name: &str) -> State {
    if client == Client::Codex && name == "apply_patch" {
        return State::Edit;
    }
    match name {
        "Bash" => State::Bash,
        "WebSearch" | "WebFetch" => State::Web,
        "Read" | "Grep" | "Glob" | "LS" | "NotebookRead" => State::Read,
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" | "Update" => State::Edit,
        _ => State::Think,
    }
}

pub fn notification_state(kind: Option<&str>) -> Option<State> {
    let t = kind.unwrap_or("");
    if t.is_empty()
        || t.contains("permission_prompt")
        || t.contains("needs_input")
        || t.contains("elicitation_dialog")
        || t.contains("elicitation_url_dialog")
    {
        Some(State::Wait)
    } else if t.contains("elicitation_response") || t.contains("elicitation_complete") {
        Some(State::Think)
    } else if t == "idle_prompt" {
        Some(State::Idle)
    } else {
        None
    }
}

impl Event {
    /// Codex 的写者锁是本机能力探测,不是稳定的日志协议。只在确实存在时携带;
    /// 老版本或其他客户端不提供凭据,下游无需按来源分支。
    pub fn live_lock(&self) -> String {
        if self.client != Client::Codex {
            return String::new();
        }
        let Some(root) = Path::new(&self.transcript)
            .ancestors()
            .find(|path| path.file_name().is_some_and(|name| name == "sessions"))
            .and_then(Path::parent)
        else {
            return String::new();
        };
        let lock = root
            .join("thread-writer-locks")
            .join(format!("{}.lock", self.session_id));
        if lock.is_file() {
            lock.to_string_lossy().into_owned()
        } else {
            String::new()
        }
    }

    pub fn session_name(&self) -> String {
        match self.client {
            Client::Codex => format!(
                "Codex #{}",
                self.session_id.chars().take(8).collect::<String>()
            ),
            Client::Claude => self
                .client
                .config_dir()
                .and_then(|d| claude_session_name(&d.join("sessions"), &self.session_id))
                .unwrap_or_default(),
        }
    }
}

fn claude_session_name(dir: &Path, sid: &str) -> Option<String> {
    std::fs::read_dir(dir).ok()?.flatten().find_map(|entry| {
        let path = entry.path();
        if path.extension().is_none_or(|x| x != "json") {
            return None;
        }
        let v: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
        (text(&v, "sessionId") == sid).then(|| text(&v, "name").to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hook::{Action, decide};

    #[test]
    fn codex_live_lock_is_discovered_from_transcript_root_and_kept_for_late_events() {
        let root = std::env::temp_dir().join(format!("pet-hook-live-{}", std::process::id()));
        let transcript = root.join("custom-home/sessions/2026/10/31/rollout.jsonl");
        let lock = root.join("custom-home/thread-writer-locks/session.lock");
        std::fs::create_dir_all(lock.parent().unwrap()).unwrap();
        let input = serde_json::json!({"hook_event_name":"PermissionRequest", "session_id":"session", "transcript_path":transcript});
        let event = normalize(Client::Codex, &input).unwrap();
        assert!(event.live_lock().is_empty(), "不为不支持的客户端版本猜路径");
        std::fs::write(&lock, b"").unwrap();
        assert_eq!(event.live_lock(), lock.display().to_string());
        let states = root.join("states");
        crate::hook::run(&event, &states, 1000);
        let path = states.join("session.json");
        let record: pet_state::Record =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(record.live_lock, lock.display().to_string());
        std::fs::remove_file(lock).unwrap();
        crate::hook::run(&event, &states, 1001);
        let late: pet_state::Record =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(
            late.live_lock, record.live_lock,
            "锁已删掉的迟到事件仍可判结束"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn shared_fixtures_normalize_both_clients() {
        let cases: Value =
            serde_json::from_str(include_str!("../../../tests/fixtures/hooks.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let client = Client::parse(case["client"].as_str().unwrap()).unwrap();
            let event = normalize(client, &case["input"]);
            if case["expected"].is_null() {
                assert!(event.is_none(), "{}", case["name"]);
                continue;
            }
            let event = event.unwrap();
            let Action::Write(record) = decide(&event, 1000) else {
                panic!("{}", case["name"])
            };
            let record = serde_json::to_value(record).unwrap();
            for (key, value) in case["expected"].as_object().unwrap() {
                assert_eq!(&record[key], value, "{}:{key}", case["name"]);
            }
            assert_eq!(record["source"], case["client"]);
            assert_eq!(record["source_event"], case["input"]["hook_event_name"]);
            assert_eq!(record["session_id"], case["input"]["session_id"]);
        }
    }

    #[test]
    fn client_paths_and_bad_fields() {
        assert!(Client::parse("other").is_err());
        assert!(
            Client::Claude
                .settings_path()
                .unwrap()
                .ends_with("settings.json")
        );
        assert!(
            Client::Codex
                .settings_path()
                .unwrap()
                .ends_with("hooks.json")
        );
        assert!(
            normalize(
                Client::Codex,
                &serde_json::json!({"session_id":12,"hook_event_name":"Stop"})
            )
            .is_none()
        );
        assert_eq!(
            session_id(&serde_json::json!({"transcript_path":"C:\\logs\\sid.jsonl"})),
            "sid"
        );
    }

    #[test]
    fn codex_windows_uses_powershell_call_operator_and_literal_path() {
        assert_eq!(
            Client::Codex.command_for(Path::new(r"C:\Users\O'Brien $dev\pet-hook.exe"), true),
            "& 'C:/Users/O''Brien $dev/pet-hook.exe' --client codex"
        );
        assert_eq!(
            Client::Claude.command_for(Path::new(r"C:\Program Files\pet-hook.exe"), true),
            "\"C:/Program Files/pet-hook.exe\""
        );
        assert_eq!(
            Client::Codex.command_for(Path::new("/a b/pet-hook"), false),
            "'/a b/pet-hook' --client codex"
        );
    }
}

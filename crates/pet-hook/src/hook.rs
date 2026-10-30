//! 只处理归一事件。来源、工具名与客户端会话身份均由 adapter 解释。

use std::path::Path;

use crate::adapter::{Event, Kind};
use pet_state::{CALLS_SUFFIX, DONE_EXT, RECORD_VERSION, Record, State};

/// 会话结束却没等到 SessionEnd(崩溃、强杀)的状态文件,放这么久就清掉
const GC_AFTER_MS: u64 = 24 * 3_600_000;

/// 答完时小兽说的话;等确认时 Claude Code 没给 message 就说后一句
pub const SAY_DONE: &str = "答完了";
const SAY_NEED: &str = "需要你处理";
/// 会话名截到这么多个码点(cchud `clipName` 同款)
const NAME_MAX: usize = 12;

/// 一条钩子事件对状态文件做什么
#[derive(Debug, PartialEq)]
pub enum Action {
    Write(Box<Record>),
    Remove,
}

/// 事件 → 动作
pub fn decide(input: &Event, now_ms: u64) -> Action {
    if input.kind == Kind::End {
        return Action::Remove;
    }
    let say = match (input.kind, input.state) {
        (_, State::Wait) => Some(input.message.as_str())
            .filter(|m| !m.trim().is_empty())
            .unwrap_or(SAY_NEED),
        (Kind::Done, _) => SAY_DONE,
        _ => "",
    };
    Action::Write(Box::new(Record {
        version: RECORD_VERSION,
        state: input.state.name().to_string(),
        event: input.event.clone(),
        tool: input.tool.clone(),
        ts: now_ms,
        transcript: input.transcript.clone(),
        say: say.to_string(),
        title: String::new(),
        source: input.source.clone(),
        source_event: input.source_event.clone(),
        session_id: input.session_id.clone(),
        turn_id: input.turn_id.clone(),
        live_lock: String::new(),
    }))
}

/// 说话的会话叫什么:项目目录名 + Claude Code 登记的会话名,
/// 会话名已以项目名开头(自动派生的「项目名-数字」)就只留会话名;缺一个就只显示另一个
pub fn title(project: &str, session: &str) -> String {
    let session = session.trim();
    // 先按整名判派生(截断后的名字可能比项目名还短),要求项目名后面紧跟 `-` 或到头:`ox` 不算 `oxforge-3` 的项目
    let derived = !project.is_empty()
        && session
            .strip_prefix(project)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('-'));
    let session: String = {
        let chars: Vec<char> = session.chars().collect();
        if chars.len() > NAME_MAX {
            chars[..NAME_MAX].iter().collect::<String>() + "…"
        } else {
            chars.into_iter().collect()
        }
    };
    match (project.is_empty(), session.is_empty()) {
        (_, true) => project.to_string(),
        (true, false) => session,
        (false, false) if derived => session,
        (false, false) => format!("{project} / {session}"),
    }
}

/// 读一条钩子输入、落盘。失败一律吞掉
pub fn run(input: &Event, dir: &Path, now_ms: u64) {
    let sid = &input.session_id;
    let file = format!("{sid}.json");
    let path = dir.join(&file);
    // 先动调用标记再写状态文件:读方被状态文件的变化叫醒,那时标记已经是新的
    track(&dir.join(format!("{sid}{CALLS_SUFFIX}")), input, now_ms);
    match decide(input, now_ms) {
        Action::Remove => {
            let _ = pet_state::remove(&path);
        }
        Action::Write(mut record) => {
            record.live_lock = input.live_lock();
            // 关闭时迟到的异步事件可能已看不到锁文件,保留此前的凭据让读方识别结束。
            if record.live_lock.is_empty()
                && let Ok(bytes) = std::fs::read(&path)
                && let Ok(previous) = serde_json::from_slice::<Record>(&bytes)
                && previous.source == record.source
                && previous.transcript == record.transcript
            {
                record.live_lock = previous.live_lock;
            }
            // 只在要说话时才去翻会话登记目录:钩子每个工具事件都跑,平时不多读盘
            if !record.say.is_empty() {
                record.title = title(&input.project, &input.session_name());
            }
            let ok = serde_json::to_vec(&record)
                .ok()
                .is_some_and(|bytes| pet_state::write_atomic(&path, &bytes).is_ok());
            // 清的是放了 24 h 的东西,不必每个工具事件都扫一遍目录:一轮开始与结束时扫
            if ok && matches!(input.kind, Kind::Done | Kind::Start) {
                gc(dir, &file, now_ms);
            }
        }
    }
}

/// 并行调用的配对(D314):Pre 落标记、Post 删标记,乱序时靠墓碑对上;一批调用收齐、一轮开始或结束时整目录清掉,
/// 被拒绝或中断而没等到 Post 的标记最多活到这一批结束。
/// 异步钩子会乱序:上一批迟到的 PostToolBatch 可能落在下一批的 PreToolUse 之后,所以只清比本事件早的标记
/// (`now_ms` 是本进程起来时的钟),整目录删会把下一批正在跑的调用一并抹掉
fn track(calls: &Path, input: &Event, now_ms: u64) {
    if matches!(
        input.kind,
        Kind::BatchEnd | Kind::Prompt | Kind::Done | Kind::Start | Kind::End | Kind::Interrupt
    ) {
        clear_older(calls, now_ms);
        return;
    }
    // 拼进路径,同 session_id 的过滤;老版本 Claude Code 不带它,就退回只看最后一个事件
    let id = &input.call_id;
    if id.is_empty() {
        return;
    }
    let live = calls.join(id);
    let done = calls.join(format!("{id}.{DONE_EXT}"));
    // Pre 与 Post 对称:删掉对方留下的那块,删不到(对方还没来)才落自己这块
    let (mine, theirs, body) = match input.kind {
        Kind::ToolStart => (live, done, input.state.name()),
        Kind::ToolEnd => (done, live, ""),
        _ => return,
    };
    if std::fs::remove_file(&theirs).is_err() && std::fs::create_dir_all(calls).is_ok() {
        let _ = std::fs::write(&mine, body);
    }
}

/// 删掉调用标记目录里修改时间早于 `before_ms` 的标记,目录空了连目录一起删
fn clear_older(calls: &Path, before_ms: u64) {
    let Ok(entries) = std::fs::read_dir(calls) else {
        return;
    };
    for entry in entries.flatten() {
        // 同一毫秒算早:修改时间只到毫秒,严格小于会让同一毫秒落的旧标记清不掉
        if modified_ms(&entry).is_none_or(|m| m <= before_ms) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    let _ = std::fs::remove_dir(calls);
}

fn modified_ms(entry: &std::fs::DirEntry) -> Option<u64> {
    let t = entry.metadata().and_then(|m| m.modified()).ok()?;
    Some(t.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64)
}

/// 清掉别的会话放了 24 h 没更新的状态文件与调用标记目录,连同写到一半被杀留下的临时文件
fn gc(dir: &Path, own: &str, now_ms: u64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let own_calls = format!("{}{CALLS_SUFFIX}", own.trim_end_matches(".json"));
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let calls = name.ends_with(CALLS_SUFFIX);
        if name == own
            || name == own_calls
            || !(name.ends_with(".json") || name.ends_with(".tmp") || calls)
        {
            continue;
        }
        if modified_ms(&entry).is_some_and(|m| now_ms.saturating_sub(m) > GC_AFTER_MS) {
            let _ = if calls {
                std::fs::remove_dir_all(entry.path())
            } else {
                std::fs::remove_file(entry.path())
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapter::{self, Client, notification_state, session_id};
    use serde_json::Value;

    fn tool_state(name: &str) -> State {
        adapter::tool_state(Client::Claude, name)
    }
    fn decide(input: &Value, now: u64) -> Option<Action> {
        adapter::normalize(Client::Claude, input).map(|e| super::decide(&e, now))
    }
    fn run(input: &str, dir: &Path, now: u64) {
        if let Ok(v) = serde_json::from_str(input)
            && let Some(e) = adapter::normalize(Client::Claude, &v)
        {
            super::run(&e, dir, now);
        }
    }
    fn project_of(input: &Value) -> String {
        let mut v = input.clone();
        v["session_id"] = "test".into();
        v["hook_event_name"] = "Stop".into();
        adapter::normalize(Client::Claude, &v).unwrap().project
    }

    const NOW: u64 = 1_800_000_000_000;

    #[test]
    fn codex_interrupt_and_end_clear_calls_without_done_speech() {
        let dir = std::env::temp_dir().join(format!("pet-hook-codex-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let now = || {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64
        };
        let emit = |event: &str, tool: &str, id: &str| {
            let v = serde_json::json!({"hook_event_name":event,"session_id":"codex-s","tool_name":tool,"tool_use_id":id});
            let event = adapter::normalize(Client::Codex, &v).unwrap();
            super::run(&event, &dir, now());
        };
        let calls = dir.join("codex-s.calls");
        emit("PreToolUse", "Bash", "a");
        emit("PreToolUse", "apply_patch", "b");
        emit("PostToolUse", "Bash", "a");
        assert_eq!(pet_state::live_call(&calls), Some(State::Edit));
        emit("PermissionRequest", "Bash", "");
        let rec = stored(&dir, "codex-s");
        assert_eq!(
            (rec.state.as_str(), rec.event.as_str()),
            ("wait", "Notification")
        );
        assert!(rec.title.starts_with("Codex #"));
        emit("Interrupt", "", "");
        let rec = stored(&dir, "codex-s");
        assert_eq!((rec.state.as_str(), rec.say.as_str()), ("idle", ""));
        assert!(!calls.exists());
        emit("PreToolUse", "Bash", "c");
        emit("SessionEnd", "", "");
        assert!(!calls.exists());
        assert!(!dir.join("codex-s.json").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    fn fixture(name: &str) -> Value {
        let path = format!("{}/tests/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
    }

    fn written(name: &str) -> Record {
        match decide(&fixture(name), NOW) {
            Some(Action::Write(r)) => *r,
            other => panic!("{name}:期望写状态,得到 {other:?}"),
        }
    }

    /// 目录里此刻唯一那份会话档的状态名(读方的 resolve 不在本仓,这里只看写下了什么)
    fn stored(dir: &Path, sid: &str) -> Record {
        serde_json::from_slice(&std::fs::read(dir.join(format!("{sid}.json"))).unwrap()).unwrap()
    }

    /// 夹具逐条:九事件 + Notification 的三档 + SessionEnd
    #[test]
    fn fixtures_map_to_states() {
        let cases = [
            ("session-start", "idle", "SessionStart"),
            ("user-prompt-submit", "think", "UserPromptSubmit"),
            ("pre-tool-bash", "bash", "PreToolUse"),
            ("pre-tool-read", "read", "PreToolUse"),
            ("pre-tool-web", "web", "PreToolUse"),
            ("pre-tool-edit", "edit", "PreToolUse"),
            ("pre-tool-task", "think", "PreToolUse"),
            ("post-tool", "think", "PostToolUse"),
            ("post-tool-failure", "think", "PostToolUseFailure"),
            ("post-tool-batch", "think", "PostToolBatch"),
            ("notification-permission", "wait", "Notification"),
            ("notification-legacy", "wait", "Notification"),
            ("notification-idle-prompt", "idle", "Notification"),
            ("stop", "idle", "Stop"),
        ];
        for (name, state, event) in cases {
            let r = written(name);
            assert_eq!(
                (r.state.as_str(), r.event.as_str()),
                (state, event),
                "{name}"
            );
            assert_eq!(r.version, RECORD_VERSION);
            assert_eq!(r.ts, NOW);
        }
        let bash = written("pre-tool-bash");
        assert_eq!(bash.tool, "Bash");
        assert!(bash.transcript.ends_with(".jsonl"), "{}", bash.transcript);
        assert_eq!(decide(&fixture("session-end"), NOW), Some(Action::Remove));
        assert_eq!(decide(&fixture("notification-other"), NOW), None);
        assert_eq!(decide(&fixture("subagent-stop"), NOW), None);
    }

    /// 说话:等确认说 Claude Code 的 message,答完说「答完了」,其余事件不说
    #[test]
    fn say_only_on_wait_and_stop() {
        assert_eq!(
            written("notification-permission").say,
            "Claude needs your permission to use Bash"
        );
        assert_eq!(written("stop").say, SAY_DONE);
        for name in [
            "pre-tool-bash",
            "post-tool",
            "notification-idle-prompt",
            "session-start",
        ] {
            assert_eq!(written(name).say, "", "{name}");
        }
        let mut blank = fixture("notification-permission");
        blank["message"] = Value::String("  ".into());
        match decide(&blank, NOW) {
            Some(Action::Write(r)) => assert_eq!(r.say, SAY_NEED),
            other => panic!("{other:?}"),
        }
        assert_eq!(project_of(&fixture("stop")), "oxforge", "Windows 路径");
        assert_eq!(
            project_of(&serde_json::json!({ "cwd": "/Users/a/cchud/" })),
            "cchud"
        );
    }

    #[test]
    fn title_joins_project_and_session() {
        assert_eq!(
            title("oxforge", "oxforge-35"),
            "oxforge-35",
            "派生名已含项目名"
        );
        assert_eq!(title("oxforge", "动效升级"), "oxforge / 动效升级");
        assert_eq!(title("oxforge", ""), "oxforge");
        assert_eq!(title("", "名字"), "名字");
        assert_eq!(
            title("xwink-console", "xwink-console-7a"),
            "xwink-consol…",
            "长项目名的派生名截断后仍认得"
        );
        assert_eq!(
            title("ox", "oxforge-3"),
            "ox / oxforge-3",
            "前缀要到 `-` 边界"
        );
        assert_eq!(
            title("p", "一二三四五六七八九十甲乙丙"),
            "p / 一二三四五六七八九十甲乙…"
        );
    }

    #[test]
    fn tool_and_notification_tables() {
        assert_eq!(tool_state("Grep"), State::Read);
        assert_eq!(tool_state("MultiEdit"), State::Edit);
        assert_eq!(tool_state("mcp__x__y"), State::Think);
        assert_eq!(
            notification_state(Some("worker_permission_prompt")),
            Some(State::Wait)
        );
        assert_eq!(
            notification_state(Some("elicitation_url_dialog")),
            Some(State::Wait)
        );
        assert_eq!(
            notification_state(Some("elicitation_complete")),
            Some(State::Think)
        );
        assert_eq!(notification_state(Some("auth_success")), None);
        assert_eq!(notification_state(None), Some(State::Wait));
    }

    #[test]
    fn session_id_is_filtered_and_falls_back_to_transcript() {
        let v = serde_json::json!({ "session_id": "ab/../c d" });
        assert_eq!(session_id(&v), "ab..cd");
        let v = serde_json::json!({ "transcript_path": "C:\\x\\proj\\0f3e-11.jsonl" });
        // Windows 反斜杠在非 Windows 上不是分隔符,整串过滤后仍只剩安全字符
        assert!(session_id(&v).ends_with("0f3e-11"), "{}", session_id(&v));
        assert_eq!(session_id(&serde_json::json!({})), "");
    }

    /// 并行调用(D314):一个返回了、别的还在跑,标记里留的是在跑的;Post 先于 Pre 落盘也对得上;一批收齐整目录清掉
    #[test]
    fn parallel_calls_keep_the_running_pose() {
        let dir = std::env::temp_dir().join(format!("pet-hook-calls-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let now = || {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64
        };
        let hook_at = |event: &str, tool: &str, id: &str, at: u64| {
            let v = serde_json::json!({
                "session_id": "s", "hook_event_name": event, "tool_name": tool, "tool_use_id": id,
            });
            run(&v.to_string(), &dir, at);
        };
        let hook = |event: &str, tool: &str, id: &str| hook_at(event, tool, id, now());
        let calls = dir.join(format!("s{CALLS_SUFFIX}"));

        hook("PreToolUse", "WebSearch", "a");
        hook("PreToolUse", "WebFetch", "b");
        hook("PostToolUse", "WebSearch", "a");
        assert_eq!(pet_state::live_call(&calls), Some(State::Web), "b 还在跑");
        assert_eq!(
            stored(&dir, "s").state,
            "think",
            "状态档本身记的是最后一个事件,在跑的由读方合进去"
        );
        hook("PostToolUseFailure", "WebFetch", "b");
        assert_eq!(pet_state::live_call(&calls), None, "都返回了");

        // async 钩子乱序:c 的 Post 先落盘,后到的 Pre 不该把它记成在跑
        hook("PostToolUse", "Bash", "c");
        hook("PreToolUse", "Bash", "c");
        assert_eq!(pet_state::live_call(&calls), None);

        // 被拒绝的调用等不到 Post,一批收齐时清掉
        hook("PreToolUse", "Bash", "d");
        hook("PostToolBatch", "", "");
        assert!(!calls.exists());
        hook("PreToolUse", "Read", "e");
        hook("Stop", "", "");
        assert!(!calls.exists(), "一轮结束清掉");

        // 乱序:上一批的 PostToolBatch 起得早、落得晚,不该抹掉下一批已经在跑的 f
        let batch_started = now() - 1_000;
        hook("PreToolUse", "Bash", "f");
        hook_at("PostToolBatch", "", "", batch_started);
        assert_eq!(pet_state::live_call(&calls), Some(State::Bash), "f 还在跑");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 落盘一圈:写 → 读回 → 别的会话的旧档被清 → SessionEnd 删;坏输入什么都不写
    #[test]
    fn run_writes_collects_and_removes() {
        let dir = std::env::temp_dir().join(format!("pet-hook-run-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let stale = dir.join("old-session.json");
        std::fs::write(&stale, b"{}").unwrap();
        let stale_calls = dir.join(format!("old-session{CALLS_SUFFIX}"));
        std::fs::create_dir_all(&stale_calls).unwrap();
        std::fs::write(stale_calls.join("toolu_x"), b"bash").unwrap();
        let keep = dir.join("notes.txt");
        std::fs::write(&keep, b"x").unwrap();

        let input = std::fs::read_to_string(format!(
            "{}/tests/fixtures/pre-tool-bash.json",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        // 「现在」拨到 25 小时后,刚建的 stale 就算放了一天多
        let later = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 25 * 3_600_000;
        run(&input, &dir, later);
        let sid = session_id(&serde_json::from_str(&input).unwrap());
        let rec = stored(&dir, &sid);
        assert_eq!((rec.state.as_str(), rec.ts), ("bash", later));
        assert!(stale.exists(), "工具事件不扫目录");
        run(&input.replace("PreToolUse", "Stop"), &dir, later);
        assert!(!stale.exists(), "一轮结束时别的会话的旧档该清");
        assert!(!stale_calls.exists(), "连同它的调用标记");
        assert!(keep.exists(), "不是状态文件的不动");

        run("不是 JSON", &dir, later);
        run(&input.replace("PreToolUse", "SessionEnd"), &dir, later);
        assert!(!dir.join(format!("{sid}.json")).exists(), "SessionEnd 删档");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

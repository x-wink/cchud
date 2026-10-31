//! 前台租约由启动进程持有；MCP 仅登记路径，不继承锁，也不推断后台缓存寿命。

use std::fs::{File, OpenOptions};
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{Value, json};

use crate::adapter::{Client, Event};

pub const SERVER: &str = "cchud_owner";
pub const TOOL: &str = "attach_client";
pub const ENV: &str = "CCHUD_CLIENT_LEASE";

fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 200
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn registry(dir: &Path, sid: &str) -> PathBuf {
    dir.join(".owners").join(format!("{sid}.json"))
}

fn read(dir: &Path, sid: &str, transcript: &str) -> Vec<String> {
    if !safe_id(sid) {
        return Vec::new();
    }
    let value = std::fs::read(registry(dir, sid))
        .ok()
        .and_then(|v| serde_json::from_slice::<Value>(&v).ok());
    let Some(value) =
        value.filter(|v| v.get("transcript").and_then(Value::as_str) == Some(transcript))
    else {
        return Vec::new();
    };
    let Ok(clients) = dir.join(".clients").canonicalize() else {
        return Vec::new();
    };
    value
        .get("leases")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|path| Path::new(path).parent() == Some(clients.as_path()))
        .take(64)
        .map(str::to_string)
        .collect()
}

pub fn registry_path(event: &Event, dir: &Path) -> String {
    if event.client == Client::Codex {
        registry(dir, &event.session_id)
            .to_string_lossy()
            .into_owned()
    } else {
        String::new()
    }
}

pub fn legacy_lock(event: &Event, dir: &Path) -> Option<String> {
    if event.client != Client::Codex {
        return None;
    }
    let paths = read(dir, &event.session_id, &event.transcript);
    paths
        .iter()
        .find(|p| pet_state::lock_alive(p) == Some(true))
        .cloned()
        .or_else(|| paths.first().cloned())
}

pub fn attach(dir: &Path, sid: &str, transcript: &str, lease: &Path) -> Result<(), String> {
    if !safe_id(sid) || transcript.is_empty() {
        return Err("租约登记需要有效会话ID与transcript路径".into());
    }
    let clients = dir
        .join(".clients")
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let path = lease.canonicalize().map_err(|e| e.to_string())?;
    if path.parent() != Some(clients.as_path())
        || pet_state::lock_alive(&path.to_string_lossy()) != Some(true)
    {
        return Err("前台租约必须由启动进程持有，且位于状态目录的.clients内".into());
    }
    // 跨前台的登记要串行，不能用读改写覆盖仍在场的另一个连接。
    std::fs::create_dir_all(dir.join(".owners")).map_err(|e| e.to_string())?;
    let guard = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join(".owners/.registration.lock"))
        .map_err(|e| e.to_string())?;
    guard.lock().map_err(|e| e.to_string())?;
    let mut paths = read(dir, sid, transcript);
    paths.retain(|p| pet_state::lock_alive(p) != Some(false));
    let path = path.to_string_lossy().into_owned();
    if !paths.contains(&path) {
        paths.push(path);
    }
    if paths.len() > 64 {
        return Err("同一会话前台连接数超过64".into());
    }
    let bytes = serde_json::to_vec(&json!({"transcript":transcript,"leases":paths}))
        .map_err(|e| e.to_string())?;
    pet_state::write_atomic(&registry(dir, sid), &bytes).map_err(|e| e.to_string())?;
    // 登记表独立原子更新，迟到工具事件不会覆盖前台凭据。
    let state = dir.join(format!("{sid}.json"));
    if let Ok(bytes) = std::fs::read(&state)
        && let Ok(mut record) = serde_json::from_slice::<pet_state::Record>(&bytes)
        && record.source == "codex"
        && record.transcript == transcript
    {
        // 单锁字段保留给尚未重启的旧读方；新读方通过登记表处理多前台。
        record.live_lock = paths.last().cloned().unwrap_or_default();
        record.live_owners = registry(dir, sid).to_string_lossy().into_owned();
        pet_state::write_atomic(
            &state,
            &serde_json::to_vec(&record).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn create_lease(dir: &Path) -> Result<(File, PathBuf), String> {
    let clients = dir.join(".clients");
    std::fs::create_dir_all(&clients).map_err(|e| e.to_string())?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let path = clients.join(format!("{}-{nonce}.lock", std::process::id()));
    let mut options = OpenOptions::new();
    options.create_new(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(&path).map_err(|e| e.to_string())?;
    file.lock().map_err(|e| e.to_string())?;
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    Ok((file, path))
}

pub fn launch(args: &[String]) -> Result<i32, String> {
    let args = args.strip_prefix(&["--".to_string()]).unwrap_or(args);
    let (program, args) = args
        .split_first()
        .ok_or("用法:pet-hook codex -- <codex程序路径> [参数]")?;
    let mut command = Command::new(program);
    let management = args.iter().any(|a| {
        matches!(
            a.as_str(),
            "exec"
                | "e"
                | "mcp"
                | "app-server"
                | "debug"
                | "login"
                | "logout"
                | "features"
                | "completion"
                | "--help"
                | "-h"
                | "--version"
                | "-V"
        )
    });
    let lease = if management {
        None
    } else {
        let dir = pet_state::state_dir().ok_or("找不到状态目录")?;
        let (file, path) = create_lease(&dir)?;
        // TOML字符串与程序参数分开传递，不拼shell命令；租约不会写入全局Codex配置。
        let value = serde_json::to_string(&path.to_string_lossy()).map_err(|e| e.to_string())?;
        command.args(["-c", &format!("mcp_servers.{SERVER}.env.{ENV}={value}")]);
        Some((file, path))
    };
    let status = command.args(args).status().map_err(|e| e.to_string())?;
    // .lock文件保留供迟到事件检查；释放锁比删路径更能避免重开会话时混淆所有者。
    drop(lease);
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        Ok(status
            .code()
            .or_else(|| status.signal().map(|signal| 128 + signal))
            .unwrap_or(1))
    }
    #[cfg(not(unix))]
    Ok(status.code().unwrap_or(1))
}

fn reply(request: &Value, dir: &Path, lease: Option<&Path>) -> Option<Value> {
    let id = request.get("id")?.clone();
    let result = match request.get("method").and_then(Value::as_str) {
        Some("initialize") => {
            json!({"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":SERVER,"version":env!("CARGO_PKG_VERSION")}})
        }
        Some("ping") => json!({}),
        Some("tools/list") => {
            json!({"tools":[{"name":TOOL,"description":"登记Codex前台租约，仅供SessionStart钩子调用。","inputSchema":{"type":"object","properties":{"session_id":{"type":"string"},"transcript":{"type":"string"}},"required":["session_id","transcript"],"additionalProperties":false},"outputSchema":{"type":"object","properties":{"attached":{"type":"boolean"}},"required":["attached"]},"annotations":{"readOnlyHint":false,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}}]})
        }
        Some("tools/call") => {
            let params = &request["params"];
            let result = if params["name"].as_str() != Some(TOOL) {
                Err("不认识的租约工具".into())
            } else if let Some(lease) = lease {
                match (
                    params["arguments"]["session_id"].as_str(),
                    params["arguments"]["transcript"].as_str(),
                ) {
                    (Some(sid), Some(transcript)) => {
                        attach(dir, sid, transcript, lease).map(|()| true)
                    }
                    _ => Err("需要session_id和transcript字符串".into()),
                }
            } else {
                Ok(false)
            };
            match result {
                // 钩子文本只返回空控制对象，不把登记结果注入模型上下文。
                Ok(attached) => {
                    json!({"content":[{"type":"text","text":"{}"}],"structuredContent":{"attached":attached},"isError":false})
                }
                Err(error) => json!({"content":[{"type":"text","text":error}],"isError":true}),
            }
        }
        _ => {
            return Some(
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"不支持的MCP方法"}}),
            );
        }
    };
    Some(json!({"jsonrpc":"2.0","id":id,"result":result}))
}

pub fn serve() -> Result<(), String> {
    let dir = pet_state::state_dir().ok_or("找不到状态目录")?;
    let lease = std::env::var_os(ENV).map(PathBuf::from);
    let input = std::io::stdin();
    let mut input = input.lock();
    let mut output = std::io::stdout().lock();
    loop {
        let mut line = Vec::new();
        let count = input
            .by_ref()
            .take(1_048_577)
            .read_until(b'\n', &mut line)
            .map_err(|e| e.to_string())?;
        if count == 0 {
            return Ok(());
        }
        if count > 1_048_576 {
            return Err("MCP消息超过1MB".into());
        }
        let request: Value = serde_json::from_slice(&line).map_err(|e| e.to_string())?;
        if let Some(value) = reply(&request, &dir, lease.as_deref()) {
            serde_json::to_writer(&mut output, &value).map_err(|e| e.to_string())?;
            output
                .write_all(b"\n")
                .and_then(|()| output.flush())
                .map_err(|e| e.to_string())?;
        }
    }
}

pub fn sessions() -> Result<(), String> {
    let dir = pet_state::state_dir().ok_or("找不到状态目录")?;
    let mut rows = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|extension| extension != "json") {
            continue;
        }
        let Some(record) = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<pet_state::Record>(&b).ok())
        else {
            continue;
        };
        rows.push(json!({"session_id":path.file_stem().and_then(|s|s.to_str()),"state":record.state,
            "alive":pet_state::session_alive(&record),"live_owners":record.live_owners,"live_lock":record.live_lock}));
    }
    println!(
        "{}",
        serde_json::to_string(&rows).map_err(|e| e.to_string())?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("pet-client-{name}-{}", std::process::id()))
    }
    fn record(dir: &Path, backend: String) -> pet_state::Record {
        pet_state::Record {
            state: "wait".into(),
            transcript: "rollout".into(),
            live_lock: backend,
            live_owners: registry(dir, "session").to_string_lossy().into_owned(),
            ..Default::default()
        }
    }

    #[test]
    fn frontend_exit_wins_even_when_shared_backend_holds_its_writer_lock() {
        let root = root("backend");
        let (backend, backend_path) = create_lease(&root).unwrap();
        let (frontend, frontend_path) = create_lease(&root).unwrap();
        let record = record(&root, backend_path.to_string_lossy().into_owned());
        assert_eq!(pet_state::session_alive(&record), Some(true));
        attach(&root, "session", "rollout", &frontend_path).unwrap();
        assert_eq!(pet_state::session_alive(&record), Some(true));
        drop(frontend);
        assert_eq!(pet_state::session_alive(&record), Some(false));
        assert_eq!(
            pet_state::lock_alive(&backend_path.to_string_lossy()),
            Some(true)
        );
        drop(backend);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn two_clients_keep_session_until_both_exit_and_attachment_is_idempotent() {
        let root = root("multiple");
        let (a, ap) = create_lease(&root).unwrap();
        let (b, bp) = create_lease(&root).unwrap();
        attach(&root, "session", "rollout", &ap).unwrap();
        attach(&root, "session", "rollout", &bp).unwrap();
        attach(&root, "session", "rollout", &bp).unwrap();
        assert_eq!(read(&root, "session", "rollout").len(), 2);
        let record = record(&root, String::new());
        drop(a);
        assert_eq!(pet_state::session_alive(&record), Some(true));
        drop(b);
        assert_eq!(pet_state::session_alive(&record), Some(false));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn attachment_before_or_after_hook_write_and_late_events_keep_frontend_evidence() {
        let root = root("race");
        let (front, path) = create_lease(&root).unwrap();
        let value = json!({"hook_event_name":"SessionStart","session_id":"session","transcript_path":"rollout"});
        let event = crate::adapter::normalize(Client::Codex, &value).unwrap();
        crate::hook::run(&event, &root, 1000);
        attach(&root, "session", "rollout", &path).unwrap();
        let get = || {
            serde_json::from_slice::<pet_state::Record>(
                &std::fs::read(root.join("session.json")).unwrap(),
            )
            .unwrap()
        };
        assert_eq!(pet_state::session_alive(&get()), Some(true));
        drop(front);
        crate::hook::run(&event, &root, 1001);
        assert_eq!(pet_state::session_alive(&get()), Some(false));
        let (next, np) = create_lease(&root).unwrap();
        attach(&root, "session", "rollout", &np).unwrap();
        assert_eq!(pet_state::session_alive(&get()), Some(true));
        drop(next);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unissued_released_or_traversing_attachment_is_rejected() {
        let root = root("paths");
        let (front, path) = create_lease(&root).unwrap();
        assert!(attach(&root, "../escape", "rollout", &path).is_err());
        assert!(attach(&root, "session", "", &path).is_err());
        drop(front);
        assert!(attach(&root, "session", "rollout", &path).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn mcp_notifications_are_silent_and_unwrapped_client_does_not_claim_a_lease() {
        let root = root("protocol");
        assert!(
            reply(
                &json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
                &root,
                None
            )
            .is_none()
        );
        let init = reply(&json!({"id":1,"method":"initialize"}), &root, None).unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
        let list = reply(&json!({"id":2,"method":"tools/list"}), &root, None).unwrap();
        assert_eq!(list["result"]["tools"][0]["name"], TOOL);
        let call=reply(&json!({"id":3,"method":"tools/call","params":{"name":TOOL,"arguments":{"session_id":"session","transcript":"rollout"}}}),&root,None).unwrap();
        assert_eq!(call["result"]["structuredContent"]["attached"], false);
        assert_eq!(call["result"]["content"][0]["text"], "{}");
        let unknown = reply(&json!({"id":4,"method":"delete"}), &root, None).unwrap();
        assert_eq!(unknown["error"]["code"], -32601);
    }
}

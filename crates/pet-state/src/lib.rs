//! 状态文件契约:`pet-hook`(写方,本仓)与 oxforge 的 `pet`(读方,闭源)共用这一份类型与常量,
//! 任何一边单独改字段都会在对方的测试里红。只有契约在这里,判定与渲染都不在。
//!
//! 目录里的东西(D282 / D314):一个会话一份 `<会话>.json`(`Record`),在跑的并行调用标记住
//! `<会话>.calls/<tool_use_id>`(内容是姿势名),Post 先到留 `<tool_use_id>.done` 墓碑。

use serde::{Deserialize, Serialize};

/// 七态(D287):姿势与 cchud 状态栏的字母表一一对应
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum State {
    Think,
    Bash,
    Read,
    Web,
    Edit,
    Idle,
    Wait,
}

impl State {
    pub const ALL: [State; 7] = [
        State::Think,
        State::Bash,
        State::Read,
        State::Web,
        State::Edit,
        State::Idle,
        State::Wait,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::Think => "think",
            Self::Bash => "bash",
            Self::Read => "read",
            Self::Web => "web",
            Self::Edit => "edit",
            Self::Idle => "idle",
            Self::Wait => "wait",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|st| st.name() == s)
    }
}

/// 状态文件:字段缺了按缺省读,以后加字段不破旧读方
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Record {
    pub version: u32,
    pub state: String,
    pub event: String,
    pub tool: String,
    /// 写入时刻(Unix 毫秒)
    pub ts: u64,
    /// 会话 transcript 的路径,读方的中断兜底要读它的尾部
    pub transcript: String,
    /// 要小兽说的话(D306):等确认时是 Claude Code 给的 message,答完是「答完了」;别的事件为空
    pub say: String,
    /// 说话的是哪个会话(项目名 / 会话名),只在 `say` 非空时写
    pub title: String,
    /// 来源只供辨识与溯源,状态与事件语义由写方归一。
    #[serde(skip_serializing_if = "String::is_empty")]
    pub source: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub source_event: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub session_id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub turn_id: String,
    /// 可选活性凭据:客户端持有的排他锁路径。锁释放或文件消失表示会话已结束;
    /// 不提供凭据的旧写方仍按既有过期规则读取。
    #[serde(skip_serializing_if = "String::is_empty")]
    pub live_lock: String,
}

pub const RECORD_VERSION: u32 = 1;

/// 并行调用标记目录的后缀与墓碑扩展名
pub const CALLS_SUFFIX: &str = ".calls";
pub const DONE_EXT: &str = "done";

#[cfg(not(target_arch = "wasm32"))]
pub use disk::*;

/// 落盘相关只在桌面编译:web 上没有状态目录
#[cfg(not(target_arch = "wasm32"))]
mod disk {
    use std::fs;
    use std::path::{Path, PathBuf};

    use super::{DONE_EXT, Record, State};

    /// 只认写方提供的凭据,不解释来源或日志内容。无法检查时保守保留,
    /// 尤其不能把仍活着但长时间等输入的会话当成过期。
    pub fn session_alive(record: &Record) -> Option<bool> {
        if record.live_lock.is_empty() {
            return None;
        }
        let file = match fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&record.live_lock)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Some(false),
            Err(_) => return None,
        };
        match file.try_lock() {
            Ok(()) => Some(false),
            Err(fs::TryLockError::WouldBlock) => Some(true),
            Err(_) => None,
        }
    }

    /// 用户主目录(Windows 取 `USERPROFILE`)
    pub fn home_dir() -> Option<PathBuf> {
        let home = if cfg!(target_os = "windows") {
            std::env::var_os("USERPROFILE")
        } else {
            std::env::var_os("HOME")
        };
        home.map(PathBuf::from)
    }

    /// 状态目录:`CCHUD_STATE_DIR` > `~/.cchud.json` 的 `stateDir` > `~/.cchud/state`。
    /// 与 cchud 的 `config.js` 同一套优先级,写方、状态栏、小兽三方看同一处
    pub fn state_dir() -> Option<PathBuf> {
        if let Some(dir) = std::env::var_os("CCHUD_STATE_DIR").filter(|d| !d.is_empty()) {
            return Some(PathBuf::from(dir));
        }
        let home = home_dir()?;
        let configured = fs::read(home.join(".cchud.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .and_then(|v| v.get("stateDir")?.as_str().map(PathBuf::from));
        Some(configured.unwrap_or_else(|| home.join(".cchud").join("state")))
    }

    /// 原子写:临时文件写满再 `rename` 顶替,目录不存在自动建。临时名带 pid——异步钩子相邻事件几毫秒内
    /// 相继落盘时各写各的临时文件,不会拼出半截档;读方只认正式档,旧版留下的 `.tmp` 不读
    pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let mut tmp = path.as_os_str().to_owned();
        tmp.push(format!(".{}.tmp", std::process::id()));
        let tmp = PathBuf::from(tmp);
        fs::write(&tmp, bytes)?;
        fs::rename(&tmp, path)
    }

    /// 删正式档,本来就没有也算成功
    pub fn remove(path: &Path) -> std::io::Result<()> {
        match fs::remove_file(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            r => r,
        }
    }

    /// 还在跑的调用里最新落标记的那个(有墓碑的不算在跑)
    pub fn live_call(calls: &Path) -> Option<State> {
        fs::read_dir(calls)
            .ok()?
            .flatten()
            .filter_map(|e| {
                let path = e.path();
                let name = e.file_name();
                let name = name.to_str()?;
                if name.ends_with(&format!(".{DONE_EXT}"))
                    || calls.join(format!("{name}.{DONE_EXT}")).exists()
                {
                    return None;
                }
                let state = State::parse(fs::read_to_string(&path).ok()?.trim())?;
                Some((e.metadata().and_then(|m| m.modified()).ok()?, state))
            })
            .max_by_key(|(t, _)| *t)
            .map(|(_, s)| s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn live_lock_keeps_wait_and_released_or_missing_lock_ends_session() {
        let root = std::env::temp_dir().join(format!("pet-state-live-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("owner.lock");
        let owner = std::fs::File::create(&path).unwrap();
        owner.lock().unwrap();
        let record = Record {
            state: "wait".into(),
            live_lock: path.display().to_string(),
            ..Default::default()
        };
        assert_eq!(session_alive(&record), Some(true), "等多久都不取代活性凭据");
        // 并发测试会 fork 子进程,显式解锁不受 fork 到 exec 之间短暂继承句柄的影响。
        owner.unlock().unwrap();
        drop(owner);
        assert_eq!(
            session_alive(&record),
            Some(false),
            "文件还在但锁已释放也算结束"
        );
        std::fs::remove_file(&path).unwrap();
        assert_eq!(
            session_alive(&record),
            Some(false),
            "关闭时删掉锁文件也算结束"
        );
        assert_eq!(session_alive(&Record::default()), None, "旧档缺凭据不猜");
        let unreadable = Record {
            live_lock: root.display().to_string(),
            ..Default::default()
        };
        assert_eq!(session_alive(&unreadable), None, "检查错误不误删会话");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn lock_owner_child() {
        let Some(path) = std::env::var_os("CCHUD_TEST_OWNER_LOCK") else {
            return;
        };
        let path = std::path::PathBuf::from(path);
        let owner = std::fs::File::create(&path).unwrap();
        owner.lock().unwrap();
        std::fs::write(path.with_extension("ready"), b"").unwrap();
        loop {
            std::thread::park();
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn abrupt_owner_exit_releases_the_lease_without_session_end() {
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};

        struct Owner(std::process::Child);
        impl Drop for Owner {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let root =
            std::env::temp_dir().join(format!("pet-state-killed-owner-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let lock = root.join("owner.lock");
        let mut child = Owner(
            Command::new(std::env::current_exe().unwrap())
                .args(["tests::lock_owner_child", "--exact"])
                .env("CCHUD_TEST_OWNER_LOCK", &lock)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let until = Instant::now() + Duration::from_secs(3);
        while !lock.with_extension("ready").exists() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            lock.with_extension("ready").exists(),
            "自己启动的持锁进程就绪"
        );
        let record = Record {
            live_lock: lock.display().to_string(),
            ..Default::default()
        };
        assert_eq!(session_alive(&record), Some(true));
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        assert!(
            lock.exists(),
            "故意保留锁文件,验证的是操作系统锁而非路径存在"
        );
        assert_eq!(
            session_alive(&record),
            Some(false),
            "没有结束事件也能确认退出"
        );
        drop(child);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn names_round_trip() {
        for st in State::ALL {
            assert_eq!(State::parse(st.name()), Some(st));
        }
        assert_eq!(State::parse("nap"), None);
    }

    /// 旧档缺字段照读:契约只加不减
    #[test]
    fn record_tolerates_missing_fields() {
        let r: Record =
            serde_json::from_str(r#"{"version":1,"state":"wait","event":"Notification","ts":1}"#)
                .unwrap();
        assert_eq!((r.say.as_str(), r.title.as_str(), r.ts), ("", "", 1));
        assert_eq!(
            (
                r.source.as_str(),
                r.source_event.as_str(),
                r.session_id.as_str(),
                r.turn_id.as_str()
            ),
            ("", "", "", "")
        );
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn atomic_write_and_remove() {
        let dir = std::env::temp_dir().join(format!("pet-state-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("nested").join("s.json");
        write_atomic(&path, b"{}").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"{}");
        assert!(
            !dir.join("nested")
                .join(format!("s.json.{}.tmp", std::process::id()))
                .exists(),
            "临时文件被顶替掉"
        );
        remove(&path).unwrap();
        remove(&path).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn state_dir_prefers_env() {
        // 只验环境变量这一档:默认档依赖主目录与 ~/.cchud.json,不在测试里碰用户目录
        let before = std::env::var_os("CCHUD_STATE_DIR");
        unsafe { std::env::set_var("CCHUD_STATE_DIR", "/tmp/pet-state-env") };
        assert_eq!(
            state_dir(),
            Some(std::path::PathBuf::from("/tmp/pet-state-env"))
        );
        match before {
            Some(v) => unsafe { std::env::set_var("CCHUD_STATE_DIR", v) },
            None => unsafe { std::env::remove_var("CCHUD_STATE_DIR") },
        }
    }
}

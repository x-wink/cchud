//! `pet-hook`:Claude Code 钩子的写方。不带参数就是钩子本身——读 stdin、写状态文件、即退;
//! 不碰 GPU、不开窗、**不往 stdout 写任何东西**(同步注册时 UserPromptSubmit 钩子的 stdout 会被注入成对话上下文)。
//! 失败一律吞掉:钩子出错不该打断会话,状态展示是尽力而为。
//! `pet-hook setup` 是给人用的子命令,可以往 stdout 写。

mod hook;
mod setup;

const USAGE: &str = "用法:
  pet-hook                      作为 Claude Code 钩子运行(读 stdin,写状态文件)
  pet-hook setup [--dry-run] [--uninstall] [--settings <settings.json>]
                                把九个事件的钩子写进 Claude Code 的 settings.json(幂等;写前备份 .bak)
  pet-hook --version";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--version" | "-V") => println!("pet-hook {}", env!("CARGO_PKG_VERSION")),
        Some("--help" | "-h") => println!("{USAGE}"),
        Some("setup") => {
            let code = match setup::Options::parse(args[1..].iter().cloned()) {
                Err(e) => {
                    eprintln!("pet-hook setup:{e}\n{USAGE}");
                    2
                }
                Ok(opts) => match std::env::current_exe().map_err(|e| format!("取不到自己的路径:{e}")) {
                    Err(e) => {
                        eprintln!("pet-hook setup:{e}");
                        1
                    }
                    Ok(exe) => match setup::run(&opts, &exe) {
                        Ok(report) => {
                            println!("{}", setup::describe(&report, &opts, &exe));
                            0
                        }
                        Err(e) => {
                            eprintln!("pet-hook setup:{e}");
                            1
                        }
                    },
                },
            };
            std::process::exit(code);
        }
        Some(other) => {
            eprintln!("pet-hook:不认识的参数 {other}\n{USAGE}");
            std::process::exit(2);
        }
        None => {
            use std::io::Read;
            let mut input = String::new();
            let _ = std::io::stdin().read_to_string(&mut input);
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            if let Some(dir) = pet_state::state_dir() {
                hook::run(&input, &dir, now);
            }
        }
    }
}

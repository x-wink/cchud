//! `pet-hook`:Claude Code / Codex 钩子的写方。读 stdin、归一事件、写状态文件、即退;
//! 不碰 GPU、不开窗、**不往 stdout 写任何东西**(同步注册时 UserPromptSubmit 钩子的 stdout 会被注入成对话上下文)。
//! 失败一律吞掉:钩子出错不该打断会话,状态展示是尽力而为。
//! `pet-hook setup` 是给人用的子命令,可以往 stdout 写。

mod adapter;
mod hook;
mod setup;

const USAGE: &str = "用法:
  pet-hook [--client claude|codex] 作为钩子运行(默认 claude;读 stdin,写状态文件)
  pet-hook setup [--client claude|codex|all] [--dry-run] [--uninstall] [--settings <配置.json>]
                                写入客户端钩子配置(幂等;写前备份 .bak)
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
                Ok(opts) => match std::env::current_exe()
                    .map_err(|e| format!("取不到自己的路径:{e}"))
                {
                    Err(e) => {
                        eprintln!("pet-hook setup:{e}");
                        1
                    }
                    Ok(exe) => {
                        let clients = if opts.all {
                            vec![adapter::Client::Claude, adapter::Client::Codex]
                        } else {
                            vec![opts.client]
                        };
                        let mut code = 0;
                        for client in clients {
                            let opts = setup::Options {
                                client,
                                ..opts.clone()
                            };
                            match setup::run(&opts, &exe) {
                                Ok(report) => println!("{}", setup::describe(&report, &opts, &exe)),
                                Err(e) => {
                                    eprintln!("pet-hook setup:{e}");
                                    code = 1;
                                }
                            }
                        }
                        code
                    }
                },
            };
            std::process::exit(code);
        }
        _ => {
            let client = match args.as_slice() {
                [] => Ok(adapter::Client::Claude),
                [flag, client] if flag == "--client" => adapter::Client::parse(client),
                _ => Err("不认识的钩子参数".into()),
            }
            .unwrap_or_else(|e| {
                eprintln!("pet-hook:{e}\n{USAGE}");
                std::process::exit(2)
            });
            use std::io::Read;
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let mut input = String::new();
            let _ = std::io::stdin().read_to_string(&mut input);
            if let (Some(dir), Ok(value)) = (pet_state::state_dir(), serde_json::from_str(&input))
                && let Some(event) = adapter::normalize(client, &value)
            {
                hook::run(&event, &dir, now);
            }
        }
    }
}

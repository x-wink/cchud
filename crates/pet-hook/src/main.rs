//! `pet-hook`:Claude Code 钩子的写方。不带参数就是钩子本身——读 stdin、写状态文件、即退;
//! 不碰 GPU、不开窗、**不往 stdout 写任何东西**(同步注册时 UserPromptSubmit 钩子的 stdout 会被注入成对话上下文)。
//! 失败一律吞掉:钩子出错不该打断会话,状态展示是尽力而为。

mod hook;

fn main() {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("--version" | "-V") => println!("pet-hook {}", env!("CARGO_PKG_VERSION")),
        Some("--help" | "-h") => eprintln!("用法:pet-hook            作为 Claude Code 钩子运行(读 stdin)\n      pet-hook --version"),
        Some(other) => eprintln!("pet-hook:不认识的参数 {other}"),
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

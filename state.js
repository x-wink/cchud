// 本机有 pet-hook 就委托给它;旧二进制不认客户端参数时退回同一事件契约的 Node 写方。
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { loadConfig } = require("./config");
const { normalizeHook, hookClient, hookArgs } = require("./hook-adapter");
const { writeState } = require("./hook-state");
const client = hookClient();
const now = Date.now();

/** PET_HOOK 指定 > PATH 里的 pet-hook > ~/.cargo/bin/pet-hook；都没有回 undefined */
function findPetHook(env = process.env) {
  const exe = process.platform === "win32" ? "pet-hook.exe" : "pet-hook";
  const candidates = [];
  if (env.PET_HOOK) candidates.push(env.PET_HOOK);
  for (const dir of String(env.PATH || "").split(path.delimiter)) if (dir) candidates.push(path.join(dir, exe));
  const home = env.HOME || env.USERPROFILE;
  if (home) candidates.push(path.join(home, ".cargo", "bin", exe));
  return candidates.find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch (e) {
      return false;
    }
  });
}

let s = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  try {
    if (!normalizeHook(JSON.parse(s || "{}"), client)) return;
  } catch { return; }
  const petHook = findPetHook();
  if (petHook) {
    // 起不来（权限、损坏）就退回自己写，不让状态源因此失声
    // 状态目录按 cchud 自己的配置口径算好再交给 pet-hook:它只认 CCHUD_STATE_DIR 与 ~/.cchud.json,
    // 认不得 --state-dir、$CCHUD_CONFIG 与脚本旁的 cchud.config.json,不传的话两边会写读不同的目录
    const env = { ...process.env, CCHUD_STATE_DIR: loadConfig().stateDir };
    const child = spawn(petHook, hookArgs(client), { stdio: ["pipe", "ignore", "ignore"], env });
    child.on("error", () => writeOwn());
    child.on("exit", (code) => {
      if (code !== 0) writeOwn();
    });
    child.stdin.on("error", () => {});
    child.stdin.end(s);
    return;
  }
  writeOwn();
});

function writeOwn() {
  try {
    const event = normalizeHook(JSON.parse(s || "{}"), client);
    if (event) writeState(event, loadConfig(), now);
  } catch {}
}

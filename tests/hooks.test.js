const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { normalizeHook, identity, hookClient, liveLock } = require("../hook-adapter");
const { decide, writeState, titleFor } = require("../hook-state");
const { notificationFor } = require("../notify");
const { loadConfig } = require("../config");
const cases = require("./fixtures/hooks.json");
const cfg = loadConfig([], {});

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cchud-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("Codex 写者锁由适配层探测，迟到事件保留凭据，旧版无凭据", (t) => {
  const root = temporary(t);
  const transcript = path.join(root, "custom-home", "sessions", "2026", "10", "31", "rollout.jsonl");
  const lock = path.join(root, "custom-home", "thread-writer-locks", "session.lock");
  const event = normalizeHook({ hook_event_name: "PermissionRequest", session_id: "session", transcript_path: transcript }, "codex");
  assert.equal(liveLock(event), undefined);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, "");
  assert.equal(liveLock(event), lock);
  const options = { ...cfg, stateDir: path.join(root, "states") };
  writeState(event, options, 1000);
  const state = path.join(options.stateDir, "session.json");
  assert.equal(JSON.parse(fs.readFileSync(state)).live_lock, lock);
  fs.unlinkSync(lock);
  writeState(event, options, 1001);
  assert.equal(JSON.parse(fs.readFileSync(state)).live_lock, lock);
  assert.equal(liveLock({ ...event, source: "claude" }), undefined);
});

for (const c of cases) test(c.name, () => {
  const event = normalizeHook(c.input, c.client);
  if (!c.expected) {
    assert.equal(event, undefined);
    assert.equal(notificationFor(event, cfg), undefined);
    return;
  }
  const record = decide(event, 1000);
  for (const [key, value] of Object.entries(c.expected)) assert.equal(record[key], value, key);
  assert.equal(record.source, c.client);
  assert.equal(record.source_event, c.input.hook_event_name);
  assert.equal(record.session_id, c.input.session_id);
  const notice = notificationFor(event, cfg);
  assert.equal(Boolean(notice), c.input.hook_event_name === "Stop" || c.expected.state === "wait");
  if (notice && c.expected.state === "wait") assert.equal(notice.body, c.input.message || c.input.tool_input?.description || cfg.needBody);
});

test("两端采用同一个会话身份出口且不串读 Claude 登记", (t) => {
  const dir = temporary(t);
  fs.writeFileSync(path.join(dir, "123.json"), JSON.stringify({ sessionId: "same-id", name: "Claude 会话", messagingSocketPath: "/tmp/socket" }));
  fs.writeFileSync(path.join(dir, "broken.json"), "不是 JSON");
  const event = (client) => normalizeHook({ hook_event_name: "Stop", session_id: "same-id" }, client);
  const options = { ...cfg, sessionsDir: dir, sessionName: true, sessionRef: true };
  assert.equal(identity(event("claude"), options).name, "Claude 会话");
  assert.equal(identity(event("claude"), options).ref.length, 6);
  assert.equal(identity(event("codex"), options).name, "Codex #same-id");
  assert.equal(identity(event("codex"), options).ref, undefined);
  assert.equal(identity(event("claude"), { ...options, sessionName: false }).name, "");
  assert.equal(hookClient([]), "claude");
  assert.equal(hookClient(["--client", "codex"]), "codex");
  assert.equal(normalizeHook({}, hookClient(["--client"])), undefined);
  assert.equal(titleFor("ox", "oxforge-3"), "ox / oxforge-3");
  assert.equal(titleFor("xwink-console", "xwink-console-7a"), "xwink-consol…");
});

test("坏字段退化且 Windows transcript 回落能取到会话标识", () => {
  const e = normalizeHook({ hook_event_name: "Stop", transcript_path: "C:\\logs\\sid.jsonl", cwd: "C:\\work\\demo\\" });
  assert.equal(e.session_id, "sid");
  assert.equal(e.project, "demo");
  assert.equal(normalizeHook({ hook_event_name: "Stop", session_id: 12, transcript_path: {} }), undefined);
  assert.equal(normalizeHook({ hook_event_name: "Stop", session_id: "s" }, "unknown"), undefined);
});

test("并行调用、逆序返回、等确认、中断与会话结束", (t) => {
  const dir = temporary(t), options = { ...cfg, stateDir: dir };
  const emit = (hook_event_name, tool_name = "", tool_use_id = "") => {
    const e = normalizeHook({ session_id: "s", hook_event_name, tool_name, tool_use_id, cwd: "/demo" }, "codex");
    writeState(e, options);
  };
  const read = () => JSON.parse(fs.readFileSync(path.join(dir, "s.json"), "utf8"));
  emit("PreToolUse", "Bash", "a");
  emit("PreToolUse", "apply_patch", "b");
  emit("PostToolUse", "Bash", "a");
  assert.equal(fs.readFileSync(path.join(dir, "s.calls", "b"), "utf8"), "edit");
  emit("PostToolUse", "apply_patch", "b");
  emit("PostToolUse", "Bash", "c");
  emit("PreToolUse", "Bash", "c");
  assert.deepEqual(fs.readdirSync(path.join(dir, "s.calls")), []);
  emit("PreToolUse", "Bash", "d");
  emit("PermissionRequest", "Bash");
  assert.equal(read().state, "wait");
  assert.equal(read().event, "Notification");
  emit("Interrupt");
  assert.equal(read().state, "idle");
  assert.equal(read().say, "");
  assert.equal(fs.existsSync(path.join(dir, "s.calls")), false);
  emit("PreToolUse", "Bash", "e");
  emit("SessionEnd");
  assert.equal(fs.existsSync(path.join(dir, "s.json")), false);
  assert.equal(fs.existsSync(path.join(dir, "s.calls")), false);
});

test("Node 入口在旧二进制拒绝 Codex 参数时回退且保持静默", (t) => {
  const dir = temporary(t);
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../state.js"), "--client", "codex"], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "fallback", tool_name: "apply_patch" }),
    // node 不认识 --client,模拟已安装的旧版 pet-hook 拒绝新参数。
    env: { ...process.env, PET_HOOK: process.execPath, CCHUD_STATE_DIR: dir }, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  const record = JSON.parse(fs.readFileSync(path.join(dir, "fallback.json"), "utf8"));
  assert.equal(record.state, "edit");
  assert.equal(record.source, "codex");
});

test("损坏与未知输入不会触发通知或产生状态", (t) => {
  const dir = temporary(t);
  for (const script of ["state.js", "notify.js"]) {
    for (const input of ["不是 JSON", "null", JSON.stringify({ session_id: "s", hook_event_name: "Unknown" })]) {
      const result = spawnSync(process.execPath, [path.resolve(__dirname, "..", script), "--client", "codex"], {
        input, encoding: "utf8", env: { ...process.env, CCHUD_STATE_DIR: dir },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    }
  }
  assert.deepEqual(fs.readdirSync(dir), []);
});

const binary = process.env.CCHUD_TEST_PET_HOOK;
test("安装命令隔离两端配置,支持预览、备份、幂等与卸载", { skip: !binary }, (t) => {
  const dir = temporary(t);
  const claude = path.join(dir, "claude"), codex = path.join(dir, "codex");
  const env = { ...process.env, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex };
  const run = (args) => {
    const result = spawnSync(binary, ["setup", ...args], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  run(["--client", "all", "--dry-run"]);
  assert.equal(fs.existsSync(claude), false);
  assert.equal(fs.existsSync(codex), false);
  assert.match(run(["--client", "all"]), /\/hooks/);
  const cp = path.join(claude, "settings.json"), xp = path.join(codex, "hooks.json");
  const c = JSON.parse(fs.readFileSync(cp)), x = JSON.parse(fs.readFileSync(xp));
  assert.equal(Object.keys(c.hooks).length, 9);
  assert.equal(Object.keys(x.hooks).length, 8);
  assert.equal(x.hooks.Notification, undefined);
  assert.equal(x.hooks.SessionEnd[0].hooks[0].async, false);
  assert.match(x.hooks.Stop[0].hooks[0].command, /--client codex$/);
  assert.equal(x.statusLine, undefined);
  const before = fs.readFileSync(xp, "utf8");
  assert.match(run(["--client", "codex"]), /无需改动/);
  assert.equal(fs.readFileSync(xp, "utf8"), before);
  x.hooks.Stop.push({ hooks: [{ type: "command", command: "other-tool" }] });
  fs.writeFileSync(xp, JSON.stringify(x));
  run(["--client", "codex", "--uninstall"]);
  assert.equal(JSON.parse(fs.readFileSync(xp)).hooks.Stop[0].hooks[0].command, "other-tool");
  assert.equal(JSON.parse(fs.readFileSync(xp + ".bak")).hooks.Stop.length, 2);
  assert.equal(fs.readFileSync(cp, "utf8"), JSON.stringify(c, null, 2) + "\n");
  const invalid = path.join(dir, "invalid.json");
  fs.writeFileSync(invalid, "不是 JSON");
  const failure = spawnSync(binary, ["setup", "--client", "codex", "--settings", invalid], { env, encoding: "utf8" });
  assert.equal(failure.status, 1);
  assert.equal(fs.readFileSync(invalid, "utf8"), "不是 JSON");
  assert.equal(fs.existsSync(invalid + ".bak"), false);
});

test("Rust 与 Node 对同一批夹具落盘一致", { skip: !binary }, (t) => {
  const dir = temporary(t);
  for (const c of cases) {
    const result = spawnSync(binary, ["--client", c.client], {
      input: JSON.stringify(c.input), encoding: "utf8", env: { ...process.env, CCHUD_STATE_DIR: dir },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    const file = path.join(dir, "test-session.json");
    if (c.expected) {
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      const expected = decide(normalizeHook(c.input, c.client), record.ts);
      assert.deepEqual({ ...record, title: "", turn_id: record.turn_id || "" }, { ...expected, turn_id: expected.turn_id || "" }, c.name);
      fs.unlinkSync(file);
    } else assert.equal(fs.existsSync(file), false, c.name);
  }
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../state.js"), "--client", "codex"], {
    input: JSON.stringify({ hook_event_name: "Stop", session_id: "delegated" }),
    env: { ...process.env, PET_HOOK: binary, CCHUD_STATE_DIR: dir }, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "delegated.json"), "utf8")).source, "codex");
});

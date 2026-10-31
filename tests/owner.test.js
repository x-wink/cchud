const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { install } = require("../tools/install-codex-client");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cchud-owner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("启动接入不覆盖别人的程序，拒绝递归，支持幂等与卸载", t => {
  const root = temporary(t), out = path.join(root, "codex");
  fs.writeFileSync(out, "用户程序");
  assert.throws(() => install({ out, bin: process.execPath, hook: process.execPath }), /其他程序/);
  fs.unlinkSync(out);
  assert.throws(() => install({ out, bin: out, hook: process.execPath }), /自身/);
  assert.equal(install({ out, bin: process.execPath, hook: process.execPath, dryRun: true }).changed, true);
  assert.equal(fs.existsSync(out), false);
  install({ out, bin: process.execPath, hook: process.execPath });
  assert.equal(install({ out, bin: process.execPath, hook: process.execPath }).changed, false);
  install({ out, uninstall: true });
  assert.equal(fs.existsSync(out), false);
});

const binary = process.env.CCHUD_TEST_PET_HOOK;
const enabled = Boolean(binary) && process.platform !== "win32";
test("升级前的前台可用内核退出通知接管，不依赖后台生命周期", { skip: !enabled }, () => {
  const result=spawnSync('python3',[path.join(__dirname,'owner-adoption.py'),binary],{encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stdout+result.stderr);
});
test("前台租约在正常退出和关终端SIGHUP后释放，未收到SessionEnd也不残留", { skip: !enabled }, async t => {
  const root = temporary(t), state = path.join(root, "state");
  const fake = path.join(root, "fake codex's entry");
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process');
const args=process.argv.slice(2),flag=args[args.indexOf('-c')+1];
const lease=JSON.parse(flag.slice(flag.indexOf('=')+1));
const common={...process.env,CCHUD_CLIENT_LEASE:lease};
const event={session_id:'session',transcript_path:'rollout',hook_event_name:'SessionStart'};
const hook=process.env.CCHUD_TEST_PET_HOOK;
let r=cp.spawnSync(hook,['--client','codex'],{input:JSON.stringify(event),env:common});
if(r.status!==0)process.exit(2);
const messages=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}}},{jsonrpc:'2.0',method:'notifications/initialized'},
{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'attach_client',arguments:{session_id:'session',transcript:'rollout'}}}];
r=cp.spawnSync(hook,['owner-mcp'],{input:messages.map(JSON.stringify).join('\\n')+'\\n',env:common,encoding:'utf8'});
const responses=r.stdout.trim().split('\\n').map(JSON.parse);
if(!responses.at(-1).result.structuredContent.attached)process.exit(3);
process.stdout.write(JSON.stringify({pid:process.pid,lease,args})+'\\n');
process.stdin.resume();process.stdin.on('end',()=>process.exit(0));
`);
  fs.chmodSync(fake, 0o755);
  for (const mode of ["normal", "hangup", "kill"]) {
    const env = { ...process.env, CCHUD_STATE_DIR: state, CCHUD_TEST_PET_HOOK: binary };
    const child = spawn(binary, ["codex", "--", fake, "包含 空格和$()的参数"], { env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const exit = once(child, "exit");
    t.after(() => { if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } });
    const ready = await Promise.race([
      once(child.stdout, "data").then(([value]) => JSON.parse(value.toString())),
      exit.then(([code]) => { throw new Error("假客户端提前退出：" + code); })
    ]);
    assert.equal(ready.args.at(-1), "包含 空格和$()的参数");
    const inspect = () => {
      const result = spawnSync(binary, ["sessions"], { env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout).find(s => s.session_id === "session");
    };
    assert.equal(inspect().alive, true);
    if (mode === "normal") child.stdin.end();
    else process.kill(-child.pid, mode === "hangup" ? "SIGHUP" : "SIGKILL");
    await exit;
    assert.equal(inspect().alive, false, mode);
    assert.equal(fs.existsSync(path.join(state, "session.json")), true, "保留状态档也能正确离场");
    // 迟到的工具钩子不能重新激活已释放的前台租约。
    spawnSync(binary, ["--client", "codex"], { env, input: JSON.stringify({ hook_event_name: "PostToolUse", session_id: "session", transcript_path: "rollout", tool_name: "Read" }) });
    assert.equal(inspect().alive, false);
  }
});

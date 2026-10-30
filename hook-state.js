const fs = require("fs");
const path = require("path");
const { identity, clipName, liveLock } = require("./hook-adapter");

function titleFor(project, session) {
  const derived = project && (session === project || session.startsWith(project + "-"));
  session = clipName(session);
  return project && session && !derived ? `${project} / ${session}` : session || project;
}

function decide(event, now = Date.now()) {
  if (event.kind === "end") return undefined;
  let say = "";
  if (event.kind === "done") say = "答完了";
  else if (event.state === "wait") say = event.message.trim() ? event.message : "需要你处理";
  return {
    version: 1, state: event.state, event: event.event, tool: event.tool, ts: now,
    transcript: event.transcript, say, title: "", source: event.source,
    source_event: event.source_event, session_id: event.session_id,
    ...(event.turn_id ? { turn_id: event.turn_id } : {}),
  };
}

function clearOlder(calls, now) {
  try {
    for (const name of fs.readdirSync(calls)) {
      const file = path.join(calls, name);
      if (Math.floor(fs.statSync(file).mtimeMs) <= now) fs.unlinkSync(file);
    }
    try { fs.rmdirSync(calls); } catch {}
  } catch {}
}

function track(event, calls, now) {
  if (["prompt", "batch_end", "done", "start", "end", "interrupt"].includes(event.kind)) {
    clearOlder(calls, now);
    return;
  }
  if (!event.call_id || !["tool_start", "tool_end"].includes(event.kind)) return;
  const live = path.join(calls, event.call_id), done = live + ".done";
  const [mine, theirs] = event.kind === "tool_start" ? [live, done] : [done, live];
  try { fs.unlinkSync(theirs); } catch {
    fs.mkdirSync(calls, { recursive: true });
    fs.writeFileSync(mine, event.kind === "tool_start" ? event.state : "");
  }
}

function writeState(event, cfg, now = Date.now()) {
  const dir = cfg.stateDir, sid = event.session_id;
  const file = path.join(dir, sid + ".json");
  try {
    track(event, path.join(dir, sid + ".calls"), now);
    const record = decide(event, now);
    if (!record) {
      try { fs.unlinkSync(file); } catch {}
      return;
    }
    let lock = liveLock(event);
    if (!lock) {
      try {
        const previous = JSON.parse(fs.readFileSync(file, "utf8"));
        if (previous.source === record.source && previous.transcript === record.transcript) lock = previous.live_lock;
      } catch {}
    }
    if (lock) record.live_lock = lock;
    if (record.say) record.title = titleFor(event.project, identity(event, cfg).name);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(record));
    fs.renameSync(tmp, file);
    if (!["start", "done"].includes(event.kind)) return;
    for (const name of fs.readdirSync(dir)) {
      if (name === sid + ".json" || name === sid + ".calls" || !/\.(json|tmp|calls)$/.test(name)) continue;
      const target = path.join(dir, name);
      try {
        if (now - fs.statSync(target).mtimeMs > 864e5) fs.rmSync(target, { recursive: name.endsWith(".calls"), force: true });
      } catch {}
    }
  } catch {}
}

module.exports = { decide, writeState, titleFor };

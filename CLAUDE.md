# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 工作约定

- **全程使用中文**：所有回复、解释、计划与提交信息一律用中文。
- **不主动提交代码**：完成改动后停在工作区，不要主动 `git commit` / `git push`；仅在用户明确要求时才提交。
- **提交不附加作者**：执行提交时，提交信息中不要添加 `Co-Authored-By` 等作者署名行。

## What this is

`cchud` is a `statusLine` script for [Claude Code](https://claude.com/claude-code) plus an optional notification hook. Claude Code pipes session JSON into these scripts via stdin; they print a colored three-line terminal status (`hud.js`) or fire a desktop notification + sound (`notify.js`). Pure Node.js, **zero dependencies**, no build step, no test suite, no `package.json`. README and all code comments are in Chinese.

## Running / debugging

There is nothing to build or install. Test by feeding fake session JSON on stdin:

```sh
# statusbar — render with fake state (HUD_FAKE_STATE=busy|idle forces the creature's pose)
echo '{"context_window":{"used_percentage":42},"rate_limits":{"five_hour":{"used_percentage":63}},"model":{"display_name":"Opus 4.8"},"cost":{"total_cost_usd":1.23}}' | HUD_FAKE_STATE=busy node hud.js

# notification — j.hook_event_name selects branch ("Notification" vs anything else = Stop)
echo '{"cwd":"/some/proj","hook_event_name":"Notification","message":"needs Bash"}' | node notify.js

# hook state source — simulate a hook event, then render with it (CCHUD_STATE_DIR redirects the state dir)
echo '{"hook_event_name":"PreToolUse","session_id":"t1","tool_name":"Bash"}' | CCHUD_STATE_DIR=/tmp/s node state.js
echo '{"session_id":"t1","transcript_path":"/tmp/t1.jsonl"}' | CCHUD_STATE_DIR=/tmp/s node hud.js

# regenerate the preview page that preview.png is screenshotted from
node tools/preview.js   # writes tools/preview.html
```

## Architecture

Four source files; `config.js` is shared by all entry points.

- **`hud.js`** — statusLine entry. Reads session JSON from stdin and writes 3 lines. State resolution is two-tier (`resolveState`): if `state.js` hooks are registered, the freshly written hook state file wins (instant, exact); otherwise fall back to scanning the last ~40 lines of the transcript (`j.transcript_path`) for the last meaningful event — assistant `tool_use`/`thinking` → busy, assistant `text` → idle, `user` role → busy (**not** file mtime, which misjudges "just finished"). Even with hooks, the transcript covers hook blind spots: user interrupts/instant-cancels fire no hook, so an interrupt marker newer than the hook event (or a hung `UserPromptSubmit` past `IDLE_AFTER_MS`) forces idle, and a state file >10 min older than the transcript means hooks were unregistered → full fallback. Colors: orange = busy, green = idle, yellow = wait (needs your confirmation; only reachable via hooks). Todos are read from the transcript (Task events, falling back to `TodoWrite`).
- **`state.js`** — optional hook entry, registered for `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop` / `Notification` / `SessionStart` / `SessionEnd` all pointing at the same script. Maps `hook_event_name` (+ `tool_name` via the shared `toolState`) to a state and atomically writes `<stateDir>/<session_id>.json` (tmp + rename); `SessionEnd` deletes it, and files idle >24h are GC'd opportunistically. Hooks are registered with `"async": true` so they never block Claude Code (main process has absolute priority; state is best-effort — rare out-of-order writes self-correct on the next event). The script still does nothing beyond one small file write and never prints to stdout.
- **`notify.js`** — registered as both `Stop` and `Notification` hooks pointing at the same script; it branches internally on `j.hook_event_name`. Spawns the platform notifier `detached + unref` so it returns immediately and never blocks Claude Code. Windows = PowerShell WinRT Toast + `SystemSounds` (different sound per event), macOS = `osascript`, Linux = `notify-send` + `paplay`.
- **`config.js`** — `loadConfig()` merges customization for all scripts, and exports `toolState` (tool name → creature pose) shared by `hud.js` and `state.js` so both pipelines agree. **Precedence: CLI args > env vars > config file > `DEFAULTS`.** Config file is searched at `--config <path>` / `$CCHUD_CONFIG`, then `./cchud.config.json` (script dir), then `~/.cchud.json`. Env vars are `CCHUD_*` (uppercased field names). `{name}` placeholders in `doneTitle`/`needTitle` are substituted last. When adding a customizable string, add it to `DEFAULTS` — `FIELDS` and all three input sources derive from it automatically.
- **`hud.sh`** — macOS/Linux launcher that just `exec node hud.js`. Windows invokes `node hud.js` directly (see README).

## Conventions

- Terminal output uses truecolor ANSI (`\x1b[38;2;r;g;b`) and Unicode block glyphs; the creature art in `hud.js` (`row1`/`row2`/`row3`) is alignment-sensitive — column widths are hand-tuned via `padW`, edit with care.
- All Claude Code input is untrusted/partial: every `JSON.parse` and file read is wrapped in try/catch and degrades to empty/absent fields rather than throwing.
- `cchud.config.json` and `.cchud.json` are gitignored (user-local config); commit changes to `cchud.config.example.json` instead.

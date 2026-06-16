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

# regenerate the preview page that preview.png is screenshotted from
node tools/preview.js   # writes tools/preview.html
```

## Architecture

Three source files; `config.js` is shared by both entry points.

- **`hud.js`** — statusLine entry. Reads session JSON from stdin and writes 3 lines. Key detail: busy-vs-idle is **not** inferred from file mtime but by scanning the last ~40 lines of the transcript (`j.transcript_path`) for the last meaningful event — assistant `tool_use`/`thinking` → busy, assistant `text` → idle, `user` role → busy. This avoids the "just finished but log was just written → false busy" misjudgment. Color: orange = busy, green = idle. Todos are also read from the transcript (last `TodoWrite` tool_use).
- **`notify.js`** — registered as both `Stop` and `Notification` hooks pointing at the same script; it branches internally on `j.hook_event_name`. Spawns the platform notifier `detached + unref` so it returns immediately and never blocks Claude Code. Windows = PowerShell WinRT Toast + `SystemSounds` (different sound per event), macOS = `osascript`, Linux = `notify-send` + `paplay`.
- **`config.js`** — `loadConfig()` merges customization for both scripts. **Precedence: CLI args > env vars > config file > `DEFAULTS`.** Config file is searched at `--config <path>` / `$CCHUD_CONFIG`, then `./cchud.config.json` (script dir), then `~/.cchud.json`. Env vars are `CCHUD_*` (uppercased field names). `{name}` placeholders in `doneTitle`/`needTitle` are substituted last. When adding a customizable string, add it to `DEFAULTS` — `FIELDS` and all three input sources derive from it automatically.
- **`hud.sh`** — macOS/Linux launcher that just `exec node hud.js`. Windows invokes `node hud.js` directly (see README).

## Conventions

- Terminal output uses truecolor ANSI (`\x1b[38;2;r;g;b`) and Unicode block glyphs; the creature art in `hud.js` (`row1`/`row2`/`row3`) is alignment-sensitive — column widths are hand-tuned via `padW`, edit with care.
- All Claude Code input is untrusted/partial: every `JSON.parse` and file read is wrapped in try/catch and degrades to empty/absent fields rather than throwing.
- `cchud.config.json` and `.cchud.json` are gitignored (user-local config); commit changes to `cchud.config.example.json` instead.

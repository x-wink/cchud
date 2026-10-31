#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const marker = "# cchud 前台租约入口";
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

function install({ bin, hook, out, uninstall = false, dryRun = false }) {
  if (!path.isAbsolute(out)) throw new Error("--out 需要绝对路径");
  const previous = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : undefined;
  if (previous && !previous.includes(marker)) throw new Error("目标已有其他程序，请另选路径");
  if (uninstall) {
    if (previous && !dryRun) fs.unlinkSync(out);
    return { changed: Boolean(previous), out };
  }
  if (!bin || !hook || !path.isAbsolute(bin) || !path.isAbsolute(hook)) throw new Error("--bin 和 --hook 需要绝对路径");
  if (path.resolve(bin) === path.resolve(out)) throw new Error("真实Codex路径不能指向启动入口自身");
  fs.accessSync(bin, fs.constants.X_OK);
  fs.accessSync(hook, fs.constants.X_OK);
  const content = `#!/bin/sh\n${marker}\nexec ${quote(hook)} codex -- ${quote(bin)} "$@"\n`;
  if (content === previous) return { changed: false, out };
  if (!dryRun) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    if (previous) fs.writeFileSync(out + ".bak", previous);
    const temporary = out + "." + process.pid + ".tmp";
    fs.writeFileSync(temporary, content, { mode: 0o755 });
    fs.renameSync(temporary, out);
  }
  return { changed: true, out };
}

if (require.main === module) {
  try {
    const argv = process.argv.slice(2), options = {};
    for (let i = 0; i < argv.length; i++) {
      const key = argv[i];
      if (["--bin", "--hook", "--out"].includes(key)) options[key.slice(2)] = argv[++i];
      else if (key === "--dry-run") options.dryRun = true;
      else if (key === "--uninstall") options.uninstall = true;
      else throw new Error("不认识的参数：" + key);
    }
    console.log(JSON.stringify(install(options)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { install, quote };

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { after } from "node:test";

import {
  clearBrokerSession,
  loadBrokerSession,
  sendBrokerShutdown,
  teardownBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

// Tests may run inside a Claude Code session with this plugin installed; keep its plugin option
// overrides out of the child processes so each test controls them itself.
delete process.env.CLAUDE_PLUGIN_OPTION_CODEX_HOME;
delete process.env.CODEX_COMPANION_CODEX_HOME;
delete process.env.CLAUDE_PLUGIN_OPTION_AUTO_REVIEW;
delete process.env.CODEX_COMPANION_AUTO_REVIEW;
delete process.env.CLAUDE_PLUGIN_OPTION_FAST_MODE;
delete process.env.CODEX_COMPANION_FAST_MODE;
delete process.env.CLAUDE_PLUGIN_OPTION_WORKSPACE_ROOT;
delete process.env.CODEX_COMPANION_WORKSPACE_ROOT;
// The same session would otherwise put every test's job state in the real plugin data directory,
// tag test jobs with the real session id, and point commands at a live broker or job.
delete process.env.CLAUDE_PLUGIN_DATA;
delete process.env.CODEX_COMPANION_SESSION_ID;
delete process.env.CODEX_COMPANION_TRANSCRIPT_PATH;
delete process.env.CODEX_COMPANION_APP_SERVER_ENDPOINT;
delete process.env.CODEX_COMPANION_JOB_ID;

const tempDirs = [];

export function makeTempDir(prefix = "codex-plugin-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// Plugin options fall back to Claude Code's settings.json; point that lookup at an empty directory.
process.env.CLAUDE_CONFIG_DIR = makeTempDir("codex-plugin-claude-config-");

// Companion commands lazily start a detached shared broker per workspace, and only the SessionEnd hook
// stops it. Shut down any broker a test left behind the same way, so test runs don't leak processes.
after(async () => {
  for (const dir of tempDirs) {
    const session = loadBrokerSession(dir);
    if (!session) {
      continue;
    }
    await sendBrokerShutdown(session.endpoint);
    teardownBrokerSession({ ...session, killProcess: terminateProcessTree });
    clearBrokerSession(dir);
  }
});

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function spawnCompanionSleeper(cwd, source = "setInterval(() => {}, 1000);") {
  const scriptPath = path.join(cwd, "codex-companion.mjs");
  fs.writeFileSync(scriptPath, source, "utf8");
  const child = spawn(process.execPath, [scriptPath], { cwd, detached: true, stdio: "ignore" });
  child.unref();
  return child;
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    timeout: options.timeout,
    shell: options.shell ?? (process.platform === "win32" && !path.isAbsolute(command)),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}

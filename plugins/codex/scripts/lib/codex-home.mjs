import os from "node:os";
import path from "node:path";
import process from "node:process";

// Claude Code exports the `codex_home` userConfig option to hook processes under this name.
export const CODEX_HOME_OPTION_ENV = "CLAUDE_PLUGIN_OPTION_CODEX_HOME";
// The SessionStart hook persists the option under this name so Bash-launched companion commands see it too.
export const CODEX_HOME_OVERRIDE_ENV = "CODEX_COMPANION_CODEX_HOME";

export function expandHomePath(value, homeDir = os.homedir()) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return null;
  }
  return path.resolve(trimmed.replace(/^(?:~|\$HOME|\$\{HOME\})(?=$|[\\/])/, () => homeDir));
}

export function resolveConfiguredCodexHome(env = process.env) {
  return expandHomePath(env[CODEX_HOME_OPTION_ENV]) ?? expandHomePath(env[CODEX_HOME_OVERRIDE_ENV]);
}

// Points CODEX_HOME at the configured directory so every Codex process spawned from here inherits it.
export function applyConfiguredCodexHome(env = process.env) {
  const codexHome = resolveConfiguredCodexHome(env);
  if (codexHome) {
    env.CODEX_HOME = codexHome;
  }
  return codexHome;
}

export function resolveCodexHome(env = process.env) {
  return path.resolve(env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

export function describeCodexHome(env = process.env) {
  const configured = resolveConfiguredCodexHome(env);
  if (configured) {
    return { path: configured, source: "plugin config" };
  }
  return { path: resolveCodexHome(env), source: env.CODEX_HOME ? "CODEX_HOME" : "default" };
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { AUTO_REVIEW_OPTION_ENV, AUTO_REVIEW_OVERRIDE_ENV } from "./auto-review.mjs";
import { CODEX_HOME_OPTION_ENV, CODEX_HOME_OVERRIDE_ENV } from "./codex-home.mjs";
import { FAST_MODE_OPTION_ENV, FAST_MODE_OVERRIDE_ENV } from "./fast-mode.mjs";
import { WORKSPACE_ROOT_OPTION_ENV, WORKSPACE_ROOT_OVERRIDE_ENV } from "./workspace.mjs";

const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(new URL("../../.claude-plugin/plugin.json", import.meta.url), "utf8"));
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

// Each userConfig option, the variable Claude Code sets for hook processes, and the variable the SessionStart
// hook persists for Bash-launched commands.
const PLUGIN_OPTIONS = [
  { name: "codex_home", optionEnv: CODEX_HOME_OPTION_ENV, overrideEnv: CODEX_HOME_OVERRIDE_ENV },
  { name: "workspace_root", optionEnv: WORKSPACE_ROOT_OPTION_ENV, overrideEnv: WORKSPACE_ROOT_OVERRIDE_ENV },
  { name: "fast_mode", optionEnv: FAST_MODE_OPTION_ENV, overrideEnv: FAST_MODE_OVERRIDE_ENV },
  { name: "auto_review", optionEnv: AUTO_REVIEW_OPTION_ENV, overrideEnv: AUTO_REVIEW_OVERRIDE_ENV }
];

export function resolveClaudeSettingsFile(env = process.env) {
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), ".claude");
  return path.join(configDir, "settings.json");
}

// Picks this plugin's entry in settings.pluginConfigs, which Claude Code keys "<plugin>@<marketplace>".
// When the plugin is installed from several marketplaces, prefer the one this process runs as (its data
// directory is named "<plugin>-<marketplace>"), then the only enabled one.
function findPluginConfig(settings, env) {
  const configs = settings?.pluginConfigs;
  if (!configs || typeof configs !== "object") {
    return null;
  }
  const keys = Object.keys(configs).filter((key) => key.split("@")[0] === PLUGIN_MANIFEST.name);
  if (keys.length <= 1) {
    return keys.length === 1 ? configs[keys[0]] : null;
  }

  const dataDirName = env[PLUGIN_DATA_ENV] ? path.basename(env[PLUGIN_DATA_ENV]) : null;
  const byDataDir = keys.filter((key) => key.replace(/[^A-Za-z0-9_-]/g, "-") === dataDirName);
  if (byDataDir.length === 1) {
    return configs[byDataDir[0]];
  }
  const enabled = keys.filter((key) => settings.enabledPlugins?.[key] === true);
  return enabled.length === 1 ? configs[enabled[0]] : null;
}

// This plugin's userConfig values as saved in Claude Code's user settings, or {} when there are none.
export function readConfiguredPluginOptions(env = process.env) {
  try {
    const settings = JSON.parse(fs.readFileSync(resolveClaudeSettingsFile(env), "utf8"));
    const options = findPluginConfig(settings, env)?.options;
    return options && typeof options === "object" ? options : {};
  } catch {
    return {};
  }
}

// The SessionStart hook persists plugin options for Bash-launched commands, so a session that started
// before an option was set has nothing persisted, and the option would be ignored until the next session.
// Fill in any option that neither Claude Code nor the hook provided from the saved settings instead.
export function applyPluginOptionSettingsFallback(env = process.env) {
  const missing = PLUGIN_OPTIONS.filter(({ optionEnv, overrideEnv }) => !env[optionEnv] && !env[overrideEnv]);
  if (missing.length === 0) {
    return [];
  }

  const configured = readConfiguredPluginOptions(env);
  const applied = [];
  for (const { name, overrideEnv } of missing) {
    const value = configured[name];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    env[overrideEnv] = String(value);
    applied.push(name);
  }
  return applied;
}

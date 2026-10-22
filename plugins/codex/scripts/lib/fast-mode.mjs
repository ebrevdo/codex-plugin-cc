import process from "node:process";

import { parseBooleanOption } from "./auto-review.mjs";

// Claude Code exports the option to hooks; SessionStart persists it for Bash commands.
export const FAST_MODE_OPTION_ENV = "CLAUDE_PLUGIN_OPTION_FAST_MODE";
export const FAST_MODE_OVERRIDE_ENV = "CODEX_COMPANION_FAST_MODE";

export function resolveConfiguredFastMode(env = process.env) {
  return parseBooleanOption(env[FAST_MODE_OPTION_ENV]) ?? parseBooleanOption(env[FAST_MODE_OVERRIDE_ENV]);
}

export function resolveFastModeSettings(env = process.env) {
  const enabled = resolveConfiguredFastMode(env) ?? false;
  return {
    // Explicit null clears any tier inherited from config or a resumed thread.
    serviceTier: enabled ? "fast" : null,
    config: { "features.fast_mode": enabled }
  };
}

export function describeFastMode(env = process.env) {
  const configured = resolveConfiguredFastMode(env);
  return {
    enabled: configured ?? false,
    source: configured === null ? "default" : "plugin config"
  };
}

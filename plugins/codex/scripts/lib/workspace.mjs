import fs from "node:fs";
import process from "node:process";

import { expandHomePath } from "./codex-home.mjs";
import { ensureGitRepository } from "./git.mjs";

export const WORKSPACE_ROOT_OPTION_ENV = "CLAUDE_PLUGIN_OPTION_WORKSPACE_ROOT";
export const WORKSPACE_ROOT_OVERRIDE_ENV = "CODEX_COMPANION_WORKSPACE_ROOT";

export function resolveConfiguredWorkspaceRoot(env = process.env) {
  const configured = expandHomePath(env[WORKSPACE_ROOT_OPTION_ENV]) ?? expandHomePath(env[WORKSPACE_ROOT_OVERRIDE_ENV]);
  if (!configured) {
    return null;
  }
  try {
    if (fs.statSync(configured).isDirectory()) {
      return configured;
    }
  } catch {
    // Report invalid configuration instead of falling back to another checkout.
  }
  throw new Error(`Configured workspace_root must be an existing directory: ${configured}`);
}

export function resolveWorkspaceRoot(cwd) {
  try {
    return ensureGitRepository(cwd);
  } catch {
    return cwd;
  }
}

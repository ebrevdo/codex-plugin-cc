import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { resolveTaskApprovals } from "../plugins/codex/scripts/lib/auto-review.mjs";
import { resolveConfiguredCodexHome } from "../plugins/codex/scripts/lib/codex-home.mjs";
import { resolveFastModeSettings } from "../plugins/codex/scripts/lib/fast-mode.mjs";
import { resolveConfiguredWorkspaceRoot } from "../plugins/codex/scripts/lib/workspace.mjs";
import {
  applyPluginOptionSettingsFallback,
  readConfiguredPluginOptions
} from "../plugins/codex/scripts/lib/plugin-options.mjs";

function writeSettings(settings) {
  const configDir = makeTempDir();
  fs.writeFileSync(path.join(configDir, "settings.json"), JSON.stringify(settings), "utf8");
  return configDir;
}

test("options the session never persisted are filled in from Claude settings", () => {
  const workspaceRoot = makeTempDir();
  const configDir = writeSettings({
    pluginConfigs: { "codex@openai-codex": { options: { codex_home: "/srv/codex", workspace_root: workspaceRoot, fast_mode: true, auto_review: true } } }
  });
  const env = { CLAUDE_CONFIG_DIR: configDir };

  assert.deepEqual(applyPluginOptionSettingsFallback(env), ["codex_home", "workspace_root", "fast_mode", "auto_review"]);
  assert.equal(resolveConfiguredWorkspaceRoot(env), workspaceRoot);
  assert.equal(env.CODEX_COMPANION_FAST_MODE, "true");
  assert.deepEqual(resolveFastModeSettings(env), { serviceTier: "fast", config: { "features.fast_mode": true } });
  assert.equal(env.CODEX_COMPANION_AUTO_REVIEW, "true");
  assert.equal(env.CODEX_COMPANION_CODEX_HOME, "/srv/codex");
  assert.deepEqual(resolveTaskApprovals(env), { approvalPolicy: "on-request", approvalsReviewer: "auto_review" });
  assert.equal(resolveConfiguredCodexHome(env), "/srv/codex");
});

test("options Claude Code or the SessionStart hook already provided win over Claude settings", () => {
  const configDir = writeSettings({
    pluginConfigs: { "codex@openai-codex": { options: { codex_home: "/srv/settings", fast_mode: true, auto_review: true } } }
  });
  const env = {
    CLAUDE_CONFIG_DIR: configDir,
    CODEX_COMPANION_WORKSPACE_ROOT: makeTempDir(),
    CODEX_COMPANION_AUTO_REVIEW: "false",
    CODEX_COMPANION_FAST_MODE: "false",
    CLAUDE_PLUGIN_OPTION_CODEX_HOME: "/srv/option"
  };

  assert.deepEqual(applyPluginOptionSettingsFallback(env), []);
  assert.equal(env.CODEX_COMPANION_AUTO_REVIEW, "false");
  assert.equal(env.CODEX_COMPANION_CODEX_HOME, undefined);
  assert.deepEqual(resolveFastModeSettings(env), { serviceTier: null, config: { "features.fast_mode": false } });
});

test("workspace root is optional, prefers the plugin option, and rejects invalid directories", () => {
  const configured = makeTempDir("codex-workspace with spaces-");
  const persisted = makeTempDir();
  assert.equal(resolveConfiguredWorkspaceRoot({}), null);
  assert.equal(resolveConfiguredWorkspaceRoot({ CLAUDE_PLUGIN_OPTION_WORKSPACE_ROOT: "  " }), null);
  assert.equal(resolveConfiguredWorkspaceRoot({
    CLAUDE_PLUGIN_OPTION_WORKSPACE_ROOT: configured,
    CODEX_COMPANION_WORKSPACE_ROOT: persisted
  }), configured);
  assert.equal(resolveConfiguredWorkspaceRoot({ CODEX_COMPANION_WORKSPACE_ROOT: persisted }), persisted);
  assert.throws(() => resolveConfiguredWorkspaceRoot({
    CLAUDE_PLUGIN_OPTION_WORKSPACE_ROOT: path.join(configured, "missing")
  }), /workspace_root must be an existing directory/);
  const file = path.join(configured, "file");
  fs.writeFileSync(file, "not a directory");
  assert.throws(() => resolveConfiguredWorkspaceRoot({ CLAUDE_PLUGIN_OPTION_WORKSPACE_ROOT: file }), /workspace_root must be an existing directory/);
});

test("fast mode defaults off and saved false values are preserved", () => {
  assert.deepEqual(resolveFastModeSettings({}), { serviceTier: null, config: { "features.fast_mode": false } });
  const configDir = writeSettings({
    pluginConfigs: { "codex@openai-codex": { options: { fast_mode: false } } }
  });
  const env = { CLAUDE_CONFIG_DIR: configDir };

  assert.deepEqual(applyPluginOptionSettingsFallback(env), ["fast_mode"]);
  assert.equal(env.CODEX_COMPANION_FAST_MODE, "false");
  assert.deepEqual(resolveFastModeSettings(env), { serviceTier: null, config: { "features.fast_mode": false } });
});

test("the plugin's own entry is chosen when several marketplaces configure it", () => {
  const configDir = writeSettings({
    enabledPlugins: { "codex@openai-codex": true, "codex@mirror": false },
    pluginConfigs: {
      "codex@openai-codex": { options: { auto_review: false } },
      "codex@mirror": { options: { auto_review: true } },
      "other@openai-codex": { options: { auto_review: true } }
    }
  });

  assert.deepEqual(readConfiguredPluginOptions({ CLAUDE_CONFIG_DIR: configDir, CLAUDE_PLUGIN_DATA: "/data/codex-mirror" }), {
    auto_review: true
  });
  assert.deepEqual(readConfiguredPluginOptions({ CLAUDE_CONFIG_DIR: configDir }), { auto_review: false });
});

test("missing or unreadable Claude settings leave the options unset", () => {
  const empty = makeTempDir();
  assert.deepEqual(applyPluginOptionSettingsFallback({ CLAUDE_CONFIG_DIR: empty }), []);

  const broken = makeTempDir();
  fs.writeFileSync(path.join(broken, "settings.json"), "{ not json", "utf8");
  assert.deepEqual(readConfiguredPluginOptions({ CLAUDE_CONFIG_DIR: broken }), {});
});

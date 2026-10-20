import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  applyConfiguredCodexHome,
  describeCodexHome,
  expandHomePath,
  resolveConfiguredCodexHome
} from "../plugins/codex/scripts/lib/codex-home.mjs";

const HOME = path.join(os.tmpdir(), "fake-home");

test("expandHomePath expands ~, $HOME, and ${HOME} prefixes", () => {
  assert.equal(expandHomePath("~", HOME), HOME);
  assert.equal(expandHomePath("~/.codex", HOME), path.join(HOME, ".codex"));
  assert.equal(expandHomePath("$HOME/.codex", HOME), path.join(HOME, ".codex"));
  assert.equal(expandHomePath("${HOME}/.codex", HOME), path.join(HOME, ".codex"));
  assert.equal(expandHomePath("  /srv/codex  ", HOME), "/srv/codex");
});

test("expandHomePath leaves other paths alone and treats blanks as unset", () => {
  assert.equal(expandHomePath("/srv/~codex", HOME), "/srv/~codex");
  assert.equal(expandHomePath("$HOMEDIR/codex", HOME), path.resolve("$HOMEDIR/codex"));
  assert.equal(expandHomePath("", HOME), null);
  assert.equal(expandHomePath("   ", HOME), null);
  assert.equal(expandHomePath(undefined, HOME), null);
});

test("resolveConfiguredCodexHome prefers the plugin option over the persisted session value", () => {
  assert.equal(
    resolveConfiguredCodexHome({
      CLAUDE_PLUGIN_OPTION_CODEX_HOME: "/srv/option",
      CODEX_COMPANION_CODEX_HOME: "/srv/session"
    }),
    "/srv/option"
  );
  assert.equal(resolveConfiguredCodexHome({ CODEX_COMPANION_CODEX_HOME: "/srv/session" }), "/srv/session");
  assert.equal(resolveConfiguredCodexHome({ CODEX_HOME: "/srv/shell" }), null);
});

test("applyConfiguredCodexHome overrides CODEX_HOME only when the plugin is configured", () => {
  const configured = { CODEX_HOME: "/srv/shell", CODEX_COMPANION_CODEX_HOME: "/srv/session" };
  assert.equal(applyConfiguredCodexHome(configured), "/srv/session");
  assert.equal(configured.CODEX_HOME, "/srv/session");

  const unconfigured = { CODEX_HOME: "/srv/shell" };
  assert.equal(applyConfiguredCodexHome(unconfigured), null);
  assert.equal(unconfigured.CODEX_HOME, "/srv/shell");
});

test("describeCodexHome reports where the effective directory came from", () => {
  assert.deepEqual(describeCodexHome({ CLAUDE_PLUGIN_OPTION_CODEX_HOME: "/srv/option" }), {
    path: "/srv/option",
    source: "plugin config"
  });
  assert.deepEqual(describeCodexHome({ CODEX_HOME: "/srv/shell" }), { path: "/srv/shell", source: "CODEX_HOME" });
  assert.deepEqual(describeCodexHome({}), { path: path.join(os.homedir(), ".codex"), source: "default" });
});

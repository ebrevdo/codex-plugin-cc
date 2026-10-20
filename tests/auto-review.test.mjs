import test from "node:test";
import assert from "node:assert/strict";

import {
  describeTaskApprovals,
  parseBooleanOption,
  resolveConfiguredAutoReview,
  resolveTaskApprovals
} from "../plugins/codex/scripts/lib/auto-review.mjs";

test("parseBooleanOption accepts common spellings and treats anything else as unset", () => {
  assert.equal(parseBooleanOption("true"), true);
  assert.equal(parseBooleanOption(" TRUE "), true);
  assert.equal(parseBooleanOption("1"), true);
  assert.equal(parseBooleanOption("false"), false);
  assert.equal(parseBooleanOption("0"), false);
  assert.equal(parseBooleanOption(""), null);
  assert.equal(parseBooleanOption(undefined), null);
  assert.equal(parseBooleanOption("maybe"), null);
});

test("resolveConfiguredAutoReview prefers the plugin option over the persisted session value", () => {
  assert.equal(
    resolveConfiguredAutoReview({ CLAUDE_PLUGIN_OPTION_AUTO_REVIEW: "false", CODEX_COMPANION_AUTO_REVIEW: "true" }),
    false
  );
  assert.equal(resolveConfiguredAutoReview({ CODEX_COMPANION_AUTO_REVIEW: "true" }), true);
  assert.equal(resolveConfiguredAutoReview({}), null);
});

test("resolveTaskApprovals routes approvals to auto-review only when enabled", () => {
  assert.deepEqual(resolveTaskApprovals({ CODEX_COMPANION_AUTO_REVIEW: "true" }), {
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review"
  });
  assert.deepEqual(resolveTaskApprovals({ CODEX_COMPANION_AUTO_REVIEW: "false" }), {});
  assert.deepEqual(resolveTaskApprovals({}), {});
});

test("describeTaskApprovals reports the mode and where it came from", () => {
  assert.deepEqual(describeTaskApprovals({ CLAUDE_PLUGIN_OPTION_AUTO_REVIEW: "true" }), {
    mode: "auto-review",
    source: "plugin config"
  });
  assert.deepEqual(describeTaskApprovals({ CODEX_COMPANION_AUTO_REVIEW: "false" }), {
    mode: "never",
    source: "plugin config"
  });
  assert.deepEqual(describeTaskApprovals({}), { mode: "never", source: "default" });
});

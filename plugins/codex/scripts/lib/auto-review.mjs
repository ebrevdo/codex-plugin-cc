import process from "node:process";

// Claude Code exports the `auto_review` userConfig option to hook processes under this name.
export const AUTO_REVIEW_OPTION_ENV = "CLAUDE_PLUGIN_OPTION_AUTO_REVIEW";
// The SessionStart hook persists the option under this name so Bash-launched companion commands see it too.
export const AUTO_REVIEW_OVERRIDE_ENV = "CODEX_COMPANION_AUTO_REVIEW";

export function parseBooleanOption(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }
  return null;
}

export function resolveConfiguredAutoReview(env = process.env) {
  return parseBooleanOption(env[AUTO_REVIEW_OPTION_ENV]) ?? parseBooleanOption(env[AUTO_REVIEW_OVERRIDE_ENV]);
}

// Thread approval overrides for task runs. With auto-review on, Codex may request escalations and its
// auto-review subagent decides them; otherwise the thread keeps the default of never asking.
export function resolveTaskApprovals(env = process.env) {
  return resolveConfiguredAutoReview(env) ? { approvalPolicy: "on-request", approvalsReviewer: "auto_review" } : {};
}

export function describeTaskApprovals(env = process.env) {
  const configured = resolveConfiguredAutoReview(env);
  return {
    mode: configured ? "auto-review" : "never",
    source: configured === null ? "default" : "plugin config"
  };
}

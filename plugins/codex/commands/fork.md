---
description: Fork a Codex session into a new resumable thread
argument-hint: "[session-id] [--job <job-id>] [--model <model|spark>]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" fork "$ARGUMENTS"`

Present the command output to the user exactly as returned. Preserve the fork job ID, the new Codex session ID, and both continuation commands. With no arguments, fork the latest task thread from this Claude session. Continue the fork with `/codex:rescue --resume-job <fork-job-id>` or `codex resume <session-id>`.

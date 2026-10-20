---
description: Send new instructions to a running background Codex job without stopping it
argument-hint: '[job-id] <instructions>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" steer "$ARGUMENTS"`

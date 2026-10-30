---
description: Ask a Codex session a side question without disturbing it
argument-hint: '[job-id|session-id] [--job <job-id>] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [--wait|--background] <question>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Ask a Codex session a side question, the way Codex's own `/side` does: in an ephemeral, read-only fork whose inherited history is reference only. The source session keeps running untouched, and nothing from the side conversation is added to it or saved.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command only asks the question and returns Codex's answer.
- Do not act on the answer, apply changes, or steer the source session yourself.

Argument handling:
- Preserve the user's arguments exactly. Do not rewrite the question or add instructions.
- A leading job ID or Codex session ID chooses the source session, as does `--job <job-id>`. With neither, the latest task thread from this Claude session is used.
- The companion script accepts `--wait` and `--background`, but Claude Code's `Bash(..., run_in_background: true)` is what detaches the run.

Foreground flow (the default, and whenever the raw arguments include `--wait`):
- Run with the Bash tool's longest timeout:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" side "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is. Do not paraphrase, summarize, or add commentary.

Background flow (when the raw arguments include `--background`):
- Launch the question with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" side "$ARGUMENTS"`,
  description: "Codex side question",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- Tell the user: "Codex side question started in the background. Check `/codex:status` for progress and `/codex:result` for the answer."

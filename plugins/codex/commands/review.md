---
description: Run a Codex code review against the current jj chain (or git diff)
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), Bash(jj:*), AskUserQuestion
---

Run a Codex review through the shared runtime.

Raw slash-command arguments:
`$ARGUMENTS`

VCS scope:
- In a Jujutsu repo (default), the review covers the chain of revisions since the closest ancestor bookmark of `@`. If `@` itself is on a bookmark, the chain stops at the previous bookmark. With no ancestor bookmark, falls back to `trunk()..@`.
- In a Git repo, the review covers the working tree if it is dirty, otherwise the diff against the detected default branch.
- `--base <ref>` overrides in either VCS. `--scope working-tree` means uncommitted changes (git) or `@-..@` (jj). `--scope branch` means default-branch diff (git) or `trunk()..@` (jj).

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Codex's output verbatim to the user.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run the review in the foreground.
- If the raw arguments include `--background`, do not ask. Run the review in a Claude background task.
- Otherwise, estimate the review size with a single command:
  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review-preflight "$ARGUMENTS"
  ```
  - Read its `recommendation:` line (`wait` or `background`) and use it as the default.
  - If `recommendation: wait`, suffix `Wait for results` with `(Recommended)`.
  - If `recommendation: background`, suffix `Run in background` with `(Recommended)`.
  - If preflight reports an error (e.g., empty chain), surface that to the user instead of running the review.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly.
- Do not strip `--wait` or `--background` yourself.
- Do not add extra review instructions or rewrite the user's intent.
- The companion script parses `--wait` and `--background`, but Claude Code's `Bash(..., run_in_background: true)` is what actually detaches the run.
- `/codex-jj:review` uses the native built-in reviewer for Git targets and collected repository context for jj targets. It does not support staged-only review, unstaged-only review, or extra focus text.
- If the user needs custom review instructions or more adversarial framing, they should use `/codex-jj:adversarial-review`.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:
- Launch the review with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review "$ARGUMENTS"`,
  description: "Codex review",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "Codex review started in the background. Check `/codex-jj:status` for progress."

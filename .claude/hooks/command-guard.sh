#!/usr/bin/env bash
# command-guard.sh — PreToolUse guard for Bash commands.
#
# The rule here: an agent may write code and open PRs, but anything irreversible or
# outward-facing is a human's keystroke. Publishing to a registry, deleting a repo,
# force-pushing and discarding uncommitted work are HARD-BLOCKED at the tool level
# (exit 2) rather than merely prompted for — people rubber-stamp scary prompts, so
# blocking is the backstop.
#
# Wire via .claude/settings.json PreToolUse (matcher: Bash). Exit 2 = block.
set -uo pipefail

stdin_raw="$(cat)"
[ -z "$stdin_raw" ] && exit 0

if command -v jq >/dev/null 2>&1; then
  tool="$(printf '%s' "$stdin_raw" | jq -r '.tool_name // empty')"
  cmd="$(printf '%s' "$stdin_raw" | jq -r '.tool_input.command // empty')"
else
  tool="$(printf '%s' "$stdin_raw" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  cmd="$(printf '%s' "$stdin_raw" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p' | head -1)"
fi

[ "$tool" != "Bash" ] && exit 0
[ -z "$cmd" ] && exit 0

# Patterns that mutate real infrastructure or destroy state. Extend as needed.
block() { echo "command-guard BLOCK: $1"; echo "  Run this yourself, outside the agent, after reviewing the plan/diff."; exit 2; }

case "$cmd" in
  # --- Irreversible history rewrites ---------------------------------------
  *"git push --force"*|*"git push -f"*)             block "Force-push is human-only." ;;
  *"git reset --hard"*)                             block "Hard reset discards uncommitted work — human-only." ;;
  *"git clean -"*[fdx]*)                            block "git clean deletes untracked files — human-only." ;;
  *"git filter-branch"*|*"git filter-repo"*)        block "History rewriting is human-only." ;;

  # --- Publishing: the repo is public, so these reach strangers ------------
  *"npm publish"*|*"yarn publish"*|*"pnpm publish"*) block "Publishing to npm is human-only." ;;
  *"uv publish"*|*"twine upload"*)                   block "Publishing to PyPI is human-only." ;;
  *"gh repo delete"*|*"gh repo archive"*)            block "Deleting or archiving the repo is human-only." ;;
  *"gh repo edit"*"--visibility"*)                   block "Changing repo visibility is human-only." ;;
  *"gh release delete"*)                             block "Deleting a release is human-only." ;;

  # --- Catastrophic filesystem -------------------------------------------
  *"rm -rf /"*|*"rm -rf ~"*|*"rm -rf ."*)            block "Refusing catastrophic rm -rf." ;;
esac

exit 0

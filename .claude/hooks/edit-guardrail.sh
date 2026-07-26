#!/usr/bin/env bash
# edit-guardrail.sh — PostToolUse guardrail (Edit/Write/MultiEdit).
# Fast, deterministic, per-file. Findings -> stdout (fed back to agent); exit 2 blocks.
set -uo pipefail

stdin_raw="$(cat)"
[ -z "$stdin_raw" ] && exit 0

if command -v jq >/dev/null 2>&1; then
  file_path="$(printf '%s' "$stdin_raw" | jq -r '.tool_input.file_path // empty')"
else
  file_path="$(printf '%s' "$stdin_raw" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
fi
[ -z "$file_path" ] && exit 0
[ -f "$file_path" ] && content="$(cat "$file_path")" || exit 0

name="$(basename "$file_path")"
blockers=()
warnings=()

# BLOCK: leftover do-not-commit marker
printf '%s' "$content" | grep -q 'DO-NOT-COMMIT' && blockers+=("contains DO-NOT-COMMIT — remove before accepting.")

# BLOCK: hardcoded AWS access key id (AKIA...) or obvious long secret assignment
printf '%s' "$content" | grep -qE 'AKIA[0-9A-Z]{16}' && blockers+=("contains a hardcoded AWS access key id — use IRSA / Secrets Manager, never literals.")
printf '%s' "$content" | grep -qiE '(aws_secret_access_key|secret_key|password)[[:space:]]*[=:][[:space:]]*"[A-Za-z0-9/+]{16,}"' \
  && blockers+=("contains a hardcoded secret literal — inject via env/secrets, not source.")

# BLOCK: committed Terraform state
case "$name" in *.tfstate|*.tfstate.backup) blockers+=("Terraform state must never be committed — it is gitignored for a reason.");; esac

# WARN: ownerless TODO
printf '%s' "$content" | grep -qE 'TODO(:|[^(])' && ! printf '%s' "$content" | grep -qE 'TODO\([^)]+\)' \
  && warnings+=("has a TODO without an owner — prefer 'TODO(owner): ...'.")

if [ "${#warnings[@]}" -gt 0 ]; then
  echo "edit-guardrail — advisories for $name"
  for w in "${warnings[@]}"; do echo "  WARN  $w"; done
fi
if [ "${#blockers[@]}" -gt 0 ]; then
  echo "edit-guardrail — BLOCKERS for $name"
  for b in "${blockers[@]}"; do echo "  BLOCK $b"; done
  exit 2
fi
exit 0

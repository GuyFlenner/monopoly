# Edit-time guardrail hooks (PostToolUse)

A **PostToolUse hook** runs automatically every time an agent edits a file (`Edit` / `Write` /
`MultiEdit`). It lets you enforce project house-rules *at the moment of the edit* instead of
waiting for the Phase 6 review — the agent sees the finding immediately and can self-correct.

This directory ships **templates** (`*.template.sh`, `*.template.ps1`). They are inert until you
copy one to a real name and wire it in `settings.json` — claude-sdlc does not impose a hook on
itself, because the rules worth enforcing are project-specific.

## The contract

Claude Code invokes the hook command with the tool call as **JSON on stdin**, e.g.:

```json
{ "tool_name": "Edit", "tool_input": { "file_path": "src/foo.py", "...": "..." } }
```

The hook:
- reads `tool_input.file_path`, and decides whether the file is in scope (by path/extension);
- prints findings to **stdout** — that text is fed back to the agent as context;
- signals the outcome by **exit code**:

| Exit | Meaning |
|------|---------|
| `0`  | allow — no blocker (advisories may still be printed to stdout) |
| `2`  | **block** — the edit is rejected and the printed reason is returned to the agent |

Keep hooks **fast and deterministic** — they run on every edit. Per-file, regex-level checks
only; no network, no whole-repo scans.

## Wiring it in `settings.json`

Copy a template to a real filename, then add to your project's `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          { "type": "command", "command": "bash .claude/hooks/edit-guardrail.sh" }
        ]
      }
    ]
  }
}
```

On Windows, point the command at the PowerShell variant instead:

```json
{ "type": "command", "command": "pwsh -NoProfile -ExecutionPolicy Bypass -File .claude/hooks/edit-guardrail.ps1" }
```

## Adapting the template

The shipped templates demonstrate the mechanics with two placeholder rules:
- **BLOCK** (exit 2): the edited file contains the literal token `DO-NOT-COMMIT`.
- **WARN** (exit 0): a `TODO` without an owner in parentheses, e.g. `TODO(alice):`.

Replace these with your real rules. A real-world example: placement's `apex-inline-check.ps1`
enforces its layering ADRs (no inline SOQL/DML in a service class, no cross-package schema
relationships) on every `.cls`/`.field-meta.xml` edit — blocking the violations its codegen kept
reproducing. Scope your checks tightly so the hook never false-blocks a legitimate edit.

## Relation to the gates

A PostToolUse hook is the earliest, cheapest enforcement point — edit time. The SDLC quality
gates (Phase 4.5 / 5 / 6) are the backstop. Use the hook for fast, mechanical, high-confidence
house-rules; leave judgement-heavy review to the gates.

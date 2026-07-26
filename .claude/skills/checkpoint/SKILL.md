---
name: checkpoint
description: "Saves current session state to memory and outputs a ready-to-paste resume prompt for continuing in a fresh Claude Code session. Invoke manually with /checkpoint or automatically by SDLC at phase gates."
model: "sonnet"
allowed-tools: ["Read", "Bash", "Write"]
---

# Session Checkpoint

Save session state to persistent memory and produce a ready-to-paste resume prompt so the user can continue in a fresh session without losing context.

**Do not pause to ask for confirmation — gather state, write the file, and output the resume prompt immediately.**

---

## When invoked

- **Manual** (`/checkpoint`) — user calls this at any time during any task
- **SDLC Phase 3 exit** — lightweight save after Architect phase, before Developer bloats context
- **SDLC Context Size Gate** — auto-invoked when context advisory (>100K tokens) or hard limit (>150K tokens) fires

Arguments may be passed inline as key=value pairs, e.g.:
```
/checkpoint phase="Phase 3 - Architect" task="add Redis session cache" next="Phase 4 - Developer" pr="none"
```
If no arguments, infer everything from conversation context and memory.

---

## Steps

### Step 1 — Gather git state

Run these two commands:

**Bash (Git Bash / WSL):**
```bash
echo "BRANCH: $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'not-a-git-repo')"
git log --oneline -5 2>/dev/null || true
```

**PowerShell:**
```powershell
$branch = git rev-parse --abbrev-ref HEAD 2>$null; if (-not $branch) { $branch = 'not-a-git-repo' }
Write-Host "BRANCH: $branch"
git log --oneline -5 2>$null
```

### Step 2 — Read open blockers from MEMORY.md

Read your project's memory index (`memory/MEMORY.md`, or the memory directory configured in CLAUDE.md).

Extract lines containing `🔴` (hard blockers) and `🟡` (soft blockers/advisories) from the Open Action Items section. Limit to the 5 most critical.

### Step 3 — Determine checkpoint context

Resolve the following fields — from inline arguments, then conversation context, then memory:

| Field | How to resolve |
|---|---|
| `task` | Original SDLC requirement / task description |
| `phase` | Last completed phase (e.g. "Phase 3 — Architect") |
| `next_action` | Specific next step instruction |
| `pr` | Open PR number (from git log, memory, or HITL items) |
| `key_decisions` | 2–4 bullet points: any arch/design decisions made this session |
| `hitl_blockers` | 🔴 items from Step 2 relevant to this task |

### Step 3b — Redact sensitive data (mandatory before write)

The checkpoint file persists to the memory directory indefinitely, so it must never capture secrets or PII. Before writing, scan every resolved field (task, next_action, key_decisions, blockers) and the resume prompt for:

- **Secrets / credentials** — API keys, access tokens, bearer tokens, JWTs, passwords, private keys, connection strings, OAuth client secrets. Well-known prefixes to watch for: `AKIA…` (AWS), `ghp_…` / `github_pat_…` (GitHub), `xox[bp]-…` (Slack), `sk-…` (OpenAI/Anthropic-style), plus any `*_API_KEY` / `*_SECRET` / `*_TOKEN` value. Replace the value with `[REDACTED:<kind>]` (e.g. `[REDACTED:aws-key]`).
- **PII** — full names of real individuals (outside the project team), personal email addresses, phone numbers, national-ID numbers, and any account / record number tied to an identifiable person. Replace with `[REDACTED:pii]`. (Public project context — team handles, repo names, issue keys — is fine; it is not PII.)

If a value is essential for resuming but sensitive, reference where it lives instead of inlining it (e.g. "consumer key in the secrets manager under `<project>/sf/consumer-key`"). When in doubt, redact.

### Step 4 — Write checkpoint file

Generate a timestamp: `YYYYMMDD_HHMMSS` in **local time** (use the timezone configured in CLAUDE.md, if any). PowerShell: `Get-Date -Format "yyyyMMdd_HHmmss"`. Python: `datetime.now(ZoneInfo("<your-tz>")).strftime("%Y%m%d_%H%M%S")`. Never use UTC for checkpoint filenames — they're human-anchored.

Write to:
```
memory/_checkpoint_<timestamp>.md
```

Content:
```markdown
---
name: "_checkpoint_<timestamp>"
description: "Session checkpoint — <task short name> — <phase completed> — <YYYY-MM-DD>"
metadata:
  type: project
---

## Session Checkpoint — <ISO timestamp>

**Task**: <task description>
**Branch**: <branch name>
**PR**: <#N | none>
**Phase completed**: <phase name>
**Next action**: <specific next step>

### Open HITL blockers
<bullet list of 🔴 items relevant to this task, or "none">

### Open advisories
<bullet list of 🟡 items relevant to this task, or "none">

### Key decisions made this session
<2-5 bullet points — arch/design/product decisions; omit if none>
```

Then add one line to `MEMORY.md` under the "Project Status" section (or append at end of index if section not present):
```
- [Session Checkpoint <YYYY-MM-DD HH:MM>](_checkpoint_<timestamp>.md) — <task short> at <phase>
```

Keep the MEMORY.md line under 150 characters.

### Step 5 — Output resume prompt

Print this block to the conversation. Use plain ASCII — no emoji inside the copyable block (they corrupt on paste on some terminals).

```
================================================================
SESSION CHECKPOINT SAVED  --  <YYYY-MM-DD HH:MM IDT>
================================================================

State written to memory. Use the prompt below to continue in a
fresh session without losing context.

--- COPY FROM HERE ---------------------------------------------------

Recall session checkpoint from <YYYY-MM-DD HH:MM IDT>.

Task: <task description, 1 line>
Branch: <branch> | PR: <#N or "not yet opened">
Last completed: <phase completed>

Next action:
  <next_action — specific, imperative, 1-3 lines>

Open blockers:
<bullet list or "  none">

Proceed with btw-status first, then execute the next action above.

--- COPY TO HERE -----------------------------------------------------

RECOMMENDATION:
  1. Copy the block above (between the dashed lines)
  2. Type /clear  OR  open a new Claude Code session
  3. Paste the copied prompt — Claude reloads state and continues

You do NOT need to close this session immediately. The checkpoint
is saved regardless. Close only if you are experiencing compaction
or sluggishness.
================================================================
```

---

## Lightweight mode (Phase 3 SDLC exit)

When called from the SDLC Phase 3 exit, this is a non-blocking save — no "close your session" advisory. Only Steps 1, 3, 3b, and 4 run (redaction still applies). Step 5 outputs a shorter block:

```
[PHASE-3 CHECKPOINT SAVED]
Design decisions preserved in memory: _checkpoint_<timestamp>.md
Session can continue normally. If compaction occurs during Developer phase,
open a new session and paste: "Recall checkpoint <timestamp>. Continue Phase 4
implementation per design doc. Branch: <branch>."
```

---

## Notes

- Never overwrite or delete previous checkpoint files — each is timestamped.
- The resume prompt must be <= 15 lines inside the copy block — scannable and paste-safe.
- Do not include code snippets in the resume prompt — file paths and method names are fine.
- If called multiple times in a session, write a new timestamped file each time (do not merge).

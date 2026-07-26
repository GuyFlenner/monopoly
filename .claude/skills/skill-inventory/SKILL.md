---
name: skill-inventory
description: "Audits the .claude/skills/ directory — reports which skills exist, when each was last modified, when last invoked (from run.json telemetry), and flags lifecycle issues (stale, untested, orphans, ghosts). Read-only snapshot, advisory only."
model: sonnet
allowed-tools: ["Read", "Glob", "Grep", "Bash"]
---

# Skill Inventory

Trigger: `/skill-inventory`

You are a skill-lifecycle auditor. Read the `.claude/skills/` directory and the recent `run.json` telemetry, then produce a single inventory report with health flags. **Read-only — never edit a skill file, never edit `CLAUDE.md`, never edit any `run.json`.**

This skill consumes the per-run telemetry written by `/team-lead` Phase B (see `team-lead/SKILL.md → Run Metrics`). If no run.json files exist yet, report that fact and skip the invocation analysis — the on-disk + CLAUDE.md analysis still runs.

---

## When to invoke

- Periodic framework health check (weekly / monthly)
- Before a major framework refactor or skill consolidation
- After adding several new skills (audit alignment with CLAUDE.md)
- When the framework feels "bloated" — concrete numbers replace gut-feel

---

## Step 1 — Enumerate skills on disk

1. `Glob .claude/skills/*/SKILL.md`
2. For each match, parse the YAML frontmatter — extract `name`, `description`, `model`, and `tools`
3. Get the last-modified timestamp from git (not filesystem mtime — git is the source of truth):
   ```bash
   git log -1 --format=%ai -- .claude/skills/{name}/SKILL.md
   ```
4. Collect line count via `wc -l` (or `(Get-Content … | Measure-Object -Line).Lines` on PowerShell) — useful signal alongside last-modified

---

## Step 2 — Locate and read run.json telemetry

Search **all three paths** and merge the results, deduplicating by `run_id`:

1. `memory/run-*.json` (claude-sdlc convention — project-relative)
2. `_drafts/run-*.json` (project-relative fallback / historical location)
3. `~/.claude/projects/{project-slug}/memory/run-*.json` (per-user Claude Code projects directory — used in some downstream projects per `team-lead/SKILL.md`)

Where `{project-slug}` is how Claude Code names the project directory (path separators replaced with `-`, e.g. a repo at `/home/you/code/myrepo` → `-home-you-code-myrepo`).

**Dedup rule:** when the same `run_id` appears in multiple paths, keep the copy whose `scope.primary_repo` matches the current repo's short name; tiebreaker is path order (memory/ → _drafts/ → ~/.claude/).

For each file found:
1. Parse JSON; on parse error, skip the file and note it in the report's "Telemetry health" section
2. Verify `schema_version` is `"1.0"` or `"1.1"` (v1.1 adds `primary_repo`, `companion_repos`, and `phases.*.elapsed_s`); older / unknown versions: parse what you can, note schema mismatch
3. Extract `started_at`, `run_id`, and the set of phase keys in `phases.*` where `status != "skipped"`
4. Sort all valid runs by `started_at` descending; consider the most recent 30 (or all if fewer)

Aggregate: `phase_name → [list of (run_id, started_at)]`.

### Phase-to-skill mapping (current schema limitation)

The run.json `phases` keys are **phase names**, not always specific skill names:

| Phase key in run.json | Skill that may have run |
|-----------------------|-------------------------|
| `architect` | `/architect`, `/aws-architect`, `/azure-architect`, `/onprem-architect`, `/migration-architect`, `/ai-llm-architect`, `/streaming-architect`, `/data-architect` |
| `developer` | `/developer`, `/react-developer` |
| All others | 1:1 mapping with skill name |

Until run.json captures the variant explicitly (schema v1.1+), treat these phases as **coarse-grained**. You cannot distinguish architect variants from telemetry alone. Mark counts for these rows with a `?` suffix in the report (e.g. `?5` instead of `5`) and note this in the "Variant ambiguity" section.

---

## Step 3 — Cross-reference `CLAUDE.md`

Read the project's `CLAUDE.md`. Locate the skills table — search for any of:

- Markdown header `Skills`, `Available Skills`, `SDLC Skills Available`, or `Quick Reference`
- A markdown table whose first column contains slash-prefixed names (e.g. `/sdlc`, `/architect`)

Extract the trigger column. This is the **documented** set.

If the project has multiple skills tables (e.g. one in `.claude/CLAUDE.md` and another in root `CLAUDE.md`), merge them — a skill present in either is "documented".

---

## Step 4 — Compute lifecycle status per skill

For each skill found on disk:

| Status | Criterion |
|--------|-----------|
| `ACTIVE` | Invoked at least once in the last 7 days |
| `WARM` | Invoked in last 30 days, but not in last 7 |
| `COLD` | Last invoked >30 days ago, but invoked at some point in the window |
| `UNTESTED` | Last-modified in the last 14 days AND never invoked since that modification |
| `ORPHAN` | Present on disk but **not** in `CLAUDE.md` skills table |
| `GHOST` | In `CLAUDE.md` skills table but **no** `SKILL.md` on disk |
| `DEAD` | Never invoked across the run.json window AND last-modified >30 days ago |
| `INTERNAL` | Frontmatter `description` starts with "internal" OR the skills-table trigger column says "internal" — skip from staleness check |

Notes:

- A skill can be `ACTIVE` and `UNTESTED` simultaneously (invoked recently, but not since the most recent edit). Report both.
- `ORPHAN` and `GHOST` are pure file-vs-CLAUDE.md mismatches — detectable on the first run, no telemetry needed.
- For variant-ambiguous skills (architect variants, developer variants), the lifecycle status applies at the phase level. Tag the row with a `(variant ambiguous)` annotation.
- Newly-added skills (last-modified <7 days ago, no invocations yet) are `UNTESTED` — flag them as expected-to-be-tested-soon, not as a defect.

---

## Step 4.5 — Stale-status reconciliation

Read `_drafts/review-history.md`. In the summary table, locate rows where **Status = `IN PROGRESS`** and **Date** is more than 30 days before today. If the file does not exist, skip this step and note "review-history.md not found — stale-status check skipped" in the output.

For each such row:
1. Identify the named skill from the description (e.g. "code-reviewer v2 — worked examples" → `code-reviewer`)
2. Extract 2–3 distinguishing keywords from the description (e.g. "worked example", "suppression", "mismatch")
3. Grep the live `SKILL.md`:
   ```bash
   grep -ic "worked example\|suppression\|mismatch" .claude/skills/code-reviewer/SKILL.md
   ```
4. Classify the row:
   - **IMPLEMENTED** — grep matched all keywords: feature is in the live skill; the row is stale
   - **OPEN** — grep matched none: feature is genuinely absent from the skill
   - **PARTIAL** — grep matched some but not all keywords: flag for manual review
   - **STALE-UNKNOWN** — cannot determine skill name or keywords from the description

Collect results for the "Stale IN PROGRESS entries" section of the output (Step 5). Operators use this to batch-update the summary table — marking IMPLEMENTED rows RESOLVED without needing to re-read every skill file.

**Why 30 days:** a same-day sprint can implement a feature on the day its IN PROGRESS row was written; a 30-day buffer avoids false positives while surfacing rows that genuinely slipped through.

---

## Step 5 — Output format

```markdown
## Skill Inventory — {YYYY-MM-DD}

### Snapshot
- Skills on disk: {N}
- Skills in `CLAUDE.md` table: {N}
- Run.json files analyzed: {N} (window: {oldest_date} → {newest_date})
- Telemetry coverage: {full | partial | none}

### Active (≤7 days)
| Skill | Last invoked | Invocations in window | Notes |
|-------|--------------|------------------------|-------|
| `/sdlc` | 2026-05-09 | 12 | |
| `/team-lead` | 2026-05-09 | 24 | runs twice per SDLC pipeline |

### Warm (8–30 days)
{same table format, or "None"}

### Cold (>30 days)
{same table format, or "None"}

### Lifecycle flags

**Untested** — recently modified, no invocation since:
- `/skill-name` — modified 3 days ago, no telemetry since

**Orphans** — on disk, missing from `CLAUDE.md`:
- `/skill-name` — recommend: add to skills table OR remove from disk

**Ghosts** — in `CLAUDE.md`, missing from disk:
- `/skill-name` — recommend: restore the file OR remove from skills table

**Dead** — no invocations in window, last edit >30 days ago:
- `/skill-name` — deprecation candidate (last modified {date})

**Internal** — skipped from staleness check:
- `/developer`, `/test-reviewer`, …

### Stale IN PROGRESS entries (review-history.md)
{omit section if review-history.md not found}
| Date | Row description | Skill | Verdict | Action |
|------|----------------|-------|---------|--------|
| 2026-04-01 | code-reviewer v2 — worked examples | code-reviewer | IMPLEMENTED | mark RESOLVED |
| 2026-03-15 | slack v2 — thread reply | slack | OPEN | remains IN PROGRESS |

### Variant ambiguity (current run.json schema v1.1)
The `phases.architect` and `phases.developer` keys do not capture which variant ran. Counts marked `?` are aggregated across all variants. To resolve:
- Add `phases.{phase}.variant` (string) to run.json schema (bump to v1.2)
- Update `team-lead/SKILL.md → Run Metrics` writer to populate it

### Telemetry health
- Parse errors: {N} files (list them if any)
- Schema mismatches: {N} files
- Earliest run: {date} | Latest run: {date} | Median runs/week: {N}

### Recommendations (priority-ordered)
1. {single most actionable next step — e.g., "Remove `/skill-name` from CLAUDE.md or restore the file"}
2. {next}
3. {next}
```

---

## Step 6 — Handoff block

```
[AGENT:skill-inventory | COMPLETE | total=N | active=N | warm=N | cold=N | untested=N | orphans=N | ghosts=N | dead=N]
```

---

## Constraints

- **Read-only.** Never edit a skill file, CLAUDE.md, or any run.json. Even when a recommendation is obvious (orphans / ghosts), surface it as advice — let the operator act.
- **Advisory only.** Do not block any pipeline. This skill is invoked manually, not as part of the SDLC repair loop.
- **Respect run.json privacy.** Aggregate counts and timestamps only — do **not** include `requirement.raw`, `hitl.items[].reason`, or PR URLs in the report. Those fields are operator-private.
- **Single pass.** Complete in one invocation. Do not spawn sub-agents or invoke other skills.
- **Bounded output:** ≤500 lines for ≤30 skills, ≤800 lines for larger frameworks.
- **No false certainty on variants.** If you cannot disambiguate a phase to a specific skill variant, say so explicitly — do not guess.

---

## What this skill does NOT do

- It does not measure skill quality (that is `/flow-reviewer`'s domain)
- It does not detect drift trends in repair budget / BLOCKED rate (that is `/flow-reviewer` Step 7's domain)
- It does not validate that skills do what their `description` claims (no semantic check)
- It does not run any skill — pure inventory, never invocation
- It does not modify the framework — recommendations are advisory only

For drift / outcome analysis, use `/flow-reviewer` Step 7. For specific skill quality review, use `/code-reviewer` on the skill file itself.

---
name: skill-lint
description: "Static linter for Claude Code skill files. Catches frontmatter drift, missing fields, description-length violations, broken [[memory-link]] refs, undeclared tools, trigger collisions, and deprecated-skill rot. Pure file scan — deterministic, no LLM calls."
model: "sonnet"
allowed-tools: ["Read", "Glob", "Grep", "Bash", "Write", "Edit"]
---

# skill-lint

A static linter for **Claude Code skill files** under `.claude/skills/` — checks frontmatter, description quality, tool declarations, and `[[memory-link]]` resolution. Inspired by static linters for AI-agent config files.

## When to Use This Skill

Three triggers:

1. **Manual**: `/skill-lint` — audits all skills, writes a report to `_drafts/skill-lint-<YYYY-MM-DD>.md`.
2. **On change**: whenever a PR touches `.claude/skills/**/SKILL.md` — should run before the PR is opened (CI integration in v2).
3. **Inside `flow-reviewer`**: when the retro suggests editing a skill, this skill should run on the proposed edit before the change is committed.

### Running the linter

**Preferred — executable Python script** (since 2026-05-29):

```bash
uv run python scripts/skill_lint.py                          # markdown report to stdout
uv run python scripts/skill_lint.py --json                   # JSON for CI
uv run python scripts/skill_lint.py --report _drafts/skill-lint-$(date +%Y-%m-%d).md
uv run python scripts/skill_lint.py --skill code-reviewer    # one skill
uv run python scripts/skill_lint.py --fail-on review         # exit 1 on REVIEW or FAIL
uv run python scripts/skill_lint.py --fail-on fail           # exit 1 on FAIL only (default)
```

The script implements all 16 rules in pure Python (no LLM calls). Output is markdown by default, JSON via `--json`. Exit code respects `--fail-on`.

**Fallback — inline bash recipes** (this runbook): for when the script isn't available or when you want to inspect a single rule. Each rule's section below carries the canonical bash/PowerShell recipe.

The two implementations track the same rule definitions in `rules.md`. The script is the source of truth; the recipes are the spec.

## Operating Principle

**Most agent bugs aren't code bugs — they're language bugs.** Vague descriptions make Claude pick the wrong skill. Missing `tools:` declarations grant unintended capabilities. Dead `[[memory-link]]` references rot silently. Two skills claiming the same trigger phrase create routing ambiguity that's invisible until it bites.

This skill catches these at authoring time with pure regex + structural checks. **No LLM calls.** Deterministic — same input always produces the same output. The skill is the rule set; running it costs only the file scan.

The rule set (SL.1-SL.17) lives in `rules.md`. The SKILL.md you're reading is the runbook.

---

## Rule Inventory

17 rules across 4 severity tiers. See `rules.md` for the full definition of each, including the regex / Grep recipe and a fix recipe.

| Rule | Severity | What it catches |
|---|---|---|
| SL.1  | 🔴 CRITICAL | Missing YAML frontmatter block (no `---` at top) |
| SL.2  | 🔴 CRITICAL | Missing required frontmatter field: `name` or `description` |
| SL.3  | 🟠 HIGH     | Missing recommended field: `model` or `allowed-tools` (legacy `tools:` accepted) |
| SL.4  | 🟡 MEDIUM   | Description length out of band — target 60-300 chars |
| SL.5  | ℹ️ LOW      | Description doesn't end with `.` |
| SL.6  | 🟠 HIGH     | `name:` doesn't match directory name (normalised) |
| SL.7  | 🟠 HIGH     | `allowed-tools:` / `tools:` lists an unknown / non-existent tool |
| SL.8  | 🟡 MEDIUM   | `[[memory-link]]` in body references a nonexistent memory file |
| SL.9  | 🟡 MEDIUM   | Skill body uses tools NOT declared in `allowed-tools:` |
| SL.10 | 🟡 MEDIUM   | Deprecated skill (`deprecated: true`) older than 30 days still in main dir |
| SL.11 | 🟠 HIGH     | Trigger-phrase collision — two skills claim the same natural-language trigger |
| SL.12 | ℹ️ INFO     | Mixed quoting style in frontmatter (advisory, not actionable) |
| SL.13 | 🟡 MEDIUM   | Legacy `tools:` key — loader reads `allowed-tools:`; rename it |
| SL.14 | 🟡 MEDIUM   | Vendoring context-leak — lock-file bookkeeping (`synced-from`, `local_modifications`) left in a shipped skill |
| SL.15 | 🟠 HIGH     | Broken in-body cross-reference — `(see X below/above)` whose target label doesn't exist |
| SL.16 | 🟡 MEDIUM   | Plugin-root path portability — `${CLAUDE_PLUGIN_ROOT}` breaks if the skill is vendored locally |
| SL.17 | 🟠 HIGH     | Missing untrusted-content guardrail — skill declares `WebFetch`/`WebSearch` but never states fetched content is data, not instructions |

**Verdict logic** (PASS / REVIEW / FAIL):
- **PASS**: only LOW / INFO findings, or none.
- **REVIEW**: at least one MEDIUM finding.
- **FAIL**: at least one CRITICAL or HIGH finding.

---

## Phase 0 — Discover all skills

```bash
find .claude/skills -mindepth 2 -maxdepth 2 -name SKILL.md
```

```powershell
Get-ChildItem .claude/skills -Recurse -Filter SKILL.md -Depth 1
```

For each skill found, run Phases 1-3 below. Aggregate findings into the report.

---

## Phase 1 — Frontmatter validation (SL.1-SL.7, SL.12)

For each `SKILL.md`:

### SL.1 — Frontmatter block present

The file MUST start with `---\n`, then have a closing `---\n` within the first 50 lines.

```bash
# Files with no frontmatter — flag as CRITICAL
for f in .claude/skills/*/SKILL.md; do
  if ! head -1 "$f" | grep -q '^---$'; then
    echo "🔴 SL.1: $f — no YAML frontmatter block"
  fi
done
```

```powershell
foreach ($f in Get-ChildItem .claude/skills -Recurse -Filter SKILL.md) {
  $first = (Get-Content $f.FullName -TotalCount 1)
  if ($first -ne '---') {
    Write-Host "🔴 SL.1: $($f.FullName) — no YAML frontmatter block"
  }
}
```

### SL.2 — Required fields present

Within the frontmatter block, MUST have both `name:` and `description:`.

```bash
for f in .claude/skills/*/SKILL.md; do
  fm=$(awk '/^---$/{c++; if(c==2) exit; next} c==1' "$f")
  echo "$fm" | grep -q '^name:'        || echo "🔴 SL.2a: $f — missing 'name:'"
  echo "$fm" | grep -q '^description:' || echo "🔴 SL.2b: $f — missing 'description:'"
done
```

### SL.3 — Recommended fields present

`model:` and `tools:` should be declared.

- Missing `model:` → defaults to conversation model (works but inconsistent).
- Missing `tools:` → skill inherits ALL tools (security concern; least-privilege violated).

```bash
for f in .claude/skills/*/SKILL.md; do
  fm=$(awk '/^---$/{c++; if(c==2) exit; next} c==1' "$f")
  echo "$fm" | grep -q '^model:' || echo "🟠 SL.3a: $f — missing 'model:'"
  echo "$fm" | grep -q '^tools:' || echo "🟠 SL.3b: $f — missing 'tools:' (skill inherits all tools)"
done
```

### SL.4 — Description length band (60-300 chars)

Too short (<60): Claude misses routing opportunities.
Too long (>300): description floods the skill picker's context.

The target band came from sampling existing skills and the common ≤60-char tool-description rule, relaxed for the richer descriptions Claude Code skills use (they double as routing hints).

```bash
for f in .claude/skills/*/SKILL.md; do
  desc=$(awk '/^---$/{c++; if(c==2) exit; next} c==1 && /^description:/' "$f" | sed 's/^description: *//; s/^"//; s/"$//')
  len=${#desc}
  if [ "$len" -lt 60 ];  then echo "🟡 SL.4a: $f — description too short ($len chars, target ≥60)"; fi
  if [ "$len" -gt 300 ]; then echo "🟡 SL.4b: $f — description too long ($len chars, target ≤300)"; fi
done
```

### SL.5 — Description ends with `.`

A common agent-config lint rule. Cheap signal for "is the field a sentence?".

```bash
for f in .claude/skills/*/SKILL.md; do
  desc=$(awk '/^---$/{c++; if(c==2) exit; next} c==1 && /^description:/' "$f" | sed 's/^description: *//; s/^"//; s/"$//')
  case "$desc" in
    *.) ;;
    *) echo "ℹ️ SL.5: $f — description doesn't end with '.'" ;;
  esac
done
```

### SL.6 — `name:` matches directory name (normalised)

The directory name (`audit`) should match the `name:` field after normalisation (lower, hyphenated, no quotes). The skill is invoked via `/<dirname>` — a mismatch causes confusion.

Normalisation: lowercase, replace whitespace with `-`, strip non-`[a-z0-9-]`.

```bash
for f in .claude/skills/*/SKILL.md; do
  dir=$(basename $(dirname "$f"))
  name=$(awk '/^---$/{c++; if(c==2) exit; next} c==1 && /^name:/' "$f" | sed 's/^name: *//; s/^"//; s/"$//')
  norm=$(echo "$name" | tr '[:upper:] ' '[:lower:]-' | tr -cd 'a-z0-9-')
  if [ "$norm" != "$dir" ]; then
    echo "🟠 SL.6: $f — directory '$dir' ≠ normalised name '$norm' (from '$name')"
  fi
done
```

### SL.7 — Declared tools exist

Compare each tool in `tools: [...]` against the known tool inventory.

Known tool sets (extend as new tools land):
- **Native Claude Code**: `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `WebFetch`, `WebSearch`, `Task`, `TodoWrite`
- **Project MCP prefixes** (whatever MCP servers your project connects — extend the allowlist accordingly): e.g. `mcp__slack__*`, `mcp__plugin_figma_figma__*`, `mcp__circleci-mcp-server__*`

Maintain the allowlist in `rules.md` Appendix A. The check is a substring match against this list — if a declared tool starts with `mcp__` but doesn't match a known prefix, flag it.

### SL.12 — Mixed quoting style (INFO only)

Some skills quote `name: "Audit"`, others bare `name: audit`. Both are valid YAML. Flag inconsistency at INFO level; don't auto-fix in v1.

---

## Phase 2 — Body validation (SL.8, SL.9)

### SL.8 — `[[memory-link]]` references resolve

The body often cites `[[some-memory-slug]]` etc. Each link MUST resolve to a file at `<memory-dir>/<name>.md`, where `<memory-dir>` is your project's memory directory (set `SKILL_LINT_MEMORY_DIR`, or use the path configured in CLAUDE.md).

```bash
MEMORY_DIR="${SKILL_LINT_MEMORY_DIR:-.claude/memory}"
for f in .claude/skills/*/SKILL.md; do
  grep -oE '\[\[[a-z0-9_-]+\]\]' "$f" | sort -u | while read link; do
    name=$(echo "$link" | sed 's/\[\[//; s/\]\]//')
    if [ ! -f "$MEMORY_DIR/$name.md" ]; then
      echo "🟡 SL.8: $f — broken memory link $link (no $MEMORY_DIR/$name.md)"
    fi
  done
done
```

### SL.9 — Body uses tools not declared in `tools:`

If the body contains code blocks invoking `Read(`, `Edit(`, `Bash(` etc., that tool MUST appear in the frontmatter `tools:` list.

Heuristic: extract bare tool names mentioned in body code fences or imperative prose (`use the Read tool`, `via Bash`); set-diff against declared `tools:`.

This is fuzzy — keep it as MEDIUM, expect false positives, document them in `rules.md` exceptions.

---

## Phase 3 — Cross-skill checks (SL.10, SL.11)

### SL.10 — Deprecated skill rot

Skills with `deprecated: true` in frontmatter that have been there >30 days should be moved to `.claude/skills/.archive/` (or whatever the project's archive convention becomes).

```bash
for f in .claude/skills/*/SKILL.md; do
  fm=$(awk '/^---$/{c++; if(c==2) exit; next} c==1' "$f")
  if echo "$fm" | grep -q '^deprecated: true'; then
    since=$(echo "$fm" | sed -n 's/^deprecated_since: *"\?\([0-9-]*\)"\?/\1/p')
    if [ -n "$since" ]; then
      days=$(( ( $(date +%s) - $(date -d "$since" +%s 2>/dev/null || echo $(date +%s)) ) / 86400 ))
      if [ "$days" -gt 30 ]; then
        echo "🟡 SL.10: $f — deprecated $days days ago, still in main dir (archive recipe below)"
      fi
    fi
  fi
done
```

### SL.11 — Trigger-phrase collision

Build an index of natural-language triggers from each skill's description + body. If two skills claim the same phrase ("good morning", "review code", etc.), flag both.

Heuristic: extract quoted strings from descriptions (`"good morning"`, `"morning brief"`) and `### Trigger Phrases` / `## Natural Language Triggers` sections. Tokenise. Build {phrase → [skill]} map. Any phrase with >1 skill is a collision.

This requires accumulating state across all skills — execute as a Phase 3 sweep, not per-file.

---

## Phase 4 — Vendoring & portability checks (SL.13-SL.16)

These rules matter most for skills that are **shared across repos** (see `docs/skills-sharing.md`): a skill authored upstream and vendored downstream must not carry stale keys, sync bookkeeping, dangling references, or plugin-only paths.

### SL.13 — Legacy `tools:` key

The loader reads `allowed-tools:`. A skill that still declares `tools:` (without `allowed-tools:`) silently inherits ALL tools — the declaration is ignored.

```bash
for f in .claude/skills/*/SKILL.md; do
  fm=$(awk '/^---$/{c++; if(c==2) exit; next} c==1' "$f")
  if echo "$fm" | grep -q '^tools:' && ! echo "$fm" | grep -q '^allowed-tools:'; then
    echo "🟡 SL.13: $f — legacy 'tools:' key; rename to 'allowed-tools:'"
  fi
done
```

### SL.14 — Vendoring context-leak

Lock-file bookkeeping (`synced-from`, `synced_from_commit`, `local_modifications`, `modification_reason`) belongs in `claude-skills.lock`, never inside a shipped `SKILL.md`. When a skill is vendored, such text leaks upstream-sync state into the consumer.

```bash
grep -rlE 'synced[-_]from|local_modifications|modification_reason' .claude/skills/*/SKILL.md \
  && echo "🟡 SL.14: above files carry sync bookkeeping — move it to claude-skills.lock"
```

### SL.15 — Broken in-body cross-reference

A `(see <label> below)` / `(see <label> above)` whose target label (e.g. `M1`, `Step 4`, `Appendix A`) doesn't appear anywhere else in the body — a dead pointer, usually left behind when a section was deleted during vendoring or editing. Gated to structural labels to avoid flagging prose like "(see examples below)".

### SL.16 — Plugin-root path portability

`${CLAUDE_PLUGIN_ROOT}` resolves only when the skill runs as part of an installed plugin. If the same skill is vendored into a downstream project's `.claude/skills/`, the variable is undefined and any path built from it breaks. Use a path relative to the skill directory, or document the plugin-only assumption explicitly.

---

## Output Format

The skill writes one report file: `_drafts/skill-lint-<YYYY-MM-DD>.md`.

### Report structure

```markdown
# /skill-lint report — 2026-05-29

**Skills scanned**: 39
**Verdict**: REVIEW (3 CRITICAL, 7 HIGH, 5 MEDIUM, 2 INFO)
**Pass / park**: PASS = no FAIL findings; REVIEW = MEDIUM only; FAIL = CRITICAL or HIGH

## Summary table

| Skill | Verdict | Findings (C/H/M/I) | Top issue |
|---|---|---|---|
| bridge-server | 🔴 FAIL | 1/2/0/0 | SL.1 no frontmatter |
| ... | | | |

## Detailed findings (per skill)

### bridge-server
- 🔴 SL.1 (CRITICAL): no YAML frontmatter block. Fix: add `---\nname: bridge-server\ndescription: ...\n---\n` to top of file.
- 🟠 SL.3a (HIGH): missing `model:`. Fix: add `model: "sonnet"` or similar.
- 🟠 SL.3b (HIGH): missing `tools:`. Fix: declare explicit tool list — currently inherits all tools.

### ...

## Cross-skill findings

### SL.11 — Trigger collisions
- Phrase `"check bridge status"` claimed by: bridge-server, health-check

## Fix queue (sorted by severity)

1. 🔴 bridge-server — add frontmatter (SL.1)
2. 🔴 data-architect — add frontmatter (SL.1)
3. ...
```

---

## What this skill does NOT do (v1 scope)

- **No auto-fix.** Findings list fixes but never edits files. v2 will add `--fix` for SL.5 (append `.`), SL.8 (slug fixes), and SL.12 (normalise quoting) — safe changes only.
- **No LLM-judged checks.** No "is this description vague?" — an LLM-judged check we can add in v2 if the false-positive rate is low.
- **No CI gating.** Advisory only. v2 will wire this into CircleCI on `.claude/skills/**` changes.
- **No semantic equivalence check.** Two skills that *functionally* overlap aren't flagged unless they share a literal trigger phrase. That's `/skill-inventory`'s job (and the natural next integration).

---

## See also

- Companion: `/skill-inventory` (lifecycle telemetry; complements this skill's static checks)

---

**Last Updated**: 2026-06-30 (added SL.13-SL.16 — vendoring/portability rules backported from downstream; `allowed-tools:` now canonical)
**Prior**: 2026-05-29 (productionised as `scripts/skill_lint.py`; bash recipes retained as the spec)
**Maintained By**: AI Team

---
name: sdlc
description: "Autonomous end-to-end software development lifecycle. Triggered by 'use sdlc: <description>'. Runs PO → Team Lead → Architect → Developer → Security → Review → Tests → PR → Retro without pausing."
model: "opus"
allowed-tools: ["Read", "Glob", "Grep", "Bash", "Edit", "Write"]
---

# SDLC Orchestrator

You are the entry point for the autonomous SDLC pipeline. When the user writes `use sdlc: <description>`, run ALL phases without waiting for manual invocations. Only pause the user when a HITL flag cannot be auto-resolved.

**Do NOT pause between phases to ask "shall I continue?" — just run.**

If the user appended a scope constraint (e.g. "documentation only", "planning only", "no PR"), honour it — skip inapplicable phases and say so upfront. If the user appended a time constraint (`[timebox: 10m]`, or prose like "timed exam", "live interview", "I have N minutes to present"), apply the **Timebox Modifier** (see the section after Phase 0.5) — it front-loads a validated diagram + plain-English design doc into the first ~5–10 min so they can be presented, then runs the full pipeline to completion in the background; it does not change which tier the work is.

**Superpowers plugin integration (autonomous-mode rules):**
- `superpowers:brainstorming` and `superpowers:using-superpowers` are **DISABLED** in autonomous SDLC mode — they inject HITL pauses ("explore intent first", "invoke skill before responding") and hijack the orchestrator's tier-routing decision. The SDLC pipeline already encodes intent capture (Phase 1 PO) and skill routing (Phase 2 Team Lead); duplicating them via superpowers blocks autonomy.
- Other `superpowers:*` skills referenced in this file (`verification-before-completion`, `receiving-code-review`, `systematic-debugging`, `dispatching-parallel-agents`, `test-driven-development`, `using-git-worktrees`) are referenced **inline only as discipline patterns** — do NOT auto-invoke them via the Skill tool during an SDLC run. The reference text encodes the rule; invoking the skill on top would re-pay context load and re-enter HITL prompts the pipeline is designed to avoid.
- **Superpowers plugin is OPTIONAL.** If a referenced `superpowers:*` skill is unavailable (plugin not installed in this environment), fall back to the inline principle described at the reference site — do NOT block the pipeline, do NOT retry the Skill call, do NOT escalate to HITL. The inline text is authoritative; the Skill reference is a cross-link, not a dependency.

---

## Goal Binding (optional keep-going mode)

The pipeline already runs every phase without pausing. To also make the run **auto-continue across turn boundaries** (context resets, an accidental turn end) and be gated by a **second, independent done-check**, bind a native `/goal` **before** invoking the pipeline. This is optional — omit it and the pipeline behaves exactly as before.

The `/goal` evaluator is a separate model that, after each turn, checks the condition against the transcript and either clears the goal (done) or feeds back the reason and continues — no manual nudge. It is deliberately a check *independent* of the internal gate logic (a separate skeptical evaluator, not self-critique).

**Recommended invocation** — set the goal, then start the run:
```
/goal SDLC run for "<desc>" is DONE when: all PO acceptance criteria are met,
security sign-off = APPROVED, code-review = APPROVED, the test gate is green,
and a PR was opened via bb_create_pr — all evidenced in the transcript.
STOP (clear the goal) if any HITL blocker is raised (security BLOCKED, repair
budget exhausted, env failure) or after 40 turns.

use sdlc: <desc>
```

**Rules the orchestrator must honour when a goal is bound:**
- The goal condition **clears on any legitimate HITL escalation** (security `BLOCKED`, `repair_attempts_remaining == 0`, `env` test failure). `/goal` must **not** fight these deliberate safety stops — it only prevents *premature* / accidental stops and resumes after a turn boundary. See the Repair Loop Protocol "Budget exhaustion" note.
- The `40 turns` clause is a hard runaway cap layered on top of model-declared done. If running headless (`-p` / SDK), pair it with a `$` budget cap.
- At the end of Phase 0, **echo the recommended `/goal` condition** so the operator can set it if they did not (a skill cannot set a session goal on its own — the human or `-p` sets it).

---

## Quick Reference

```
Input:  raw requirement or issue URL
Output: merged PR + SDLC run summary + retrospective

Phases:
  0    Branch setup
  0.5  Plan mode (read-only codebase survey, complexity classification)
  1    /product-owner    → structured backlog
  2    /team-lead        → sprint plan + assignments
  3    /architect        → design doc
  4    /developer        → implementation (Coder ↔ Test Writer sub-graph)
  4.5  /test-reviewer    → test quality gate (back-edge to Phase 4, 1 attempt max; skip for Tier D)
  5    /security-researcher  → gate (back-edge to Phase 4 on failure)
  6    /code-reviewer    → gate (back-edge to Phase 4 on failure)
  7    tests             → executes the test command (back-edge on failure)
  8    /team-lead        → final gate + PR
  9    /flow-reviewer    → retrospective (non-blocking)

Repair budget: MAX_REPAIR_ATTEMPTS = 3 (shared across gates 5–7; Phase 4.5 has a separate 1-attempt budget).
Budget exhaustion → HITL escalation with full repair history.
```

**Tiers 1–3 pass Phases 5–8.** Tier 1 only skips planning Phases 1–3. **Tier D (documentation-only)** skips Phase 7 and runs Phases 5–6 in reduced mode — see Phase 0.5.

**Timebox Modifier** (`use sdlc: <desc> [timebox: 10m]`) — orthogonal to tiers; **design-first**. The timebox budgets *phase 1 only*: within ~5–10 min the Architect produces a **validated `.drawio`** + a **plain-English design doc that MUST include an "Assumptions, Limitations & Production Risks" section** (the Production Trap Sweep), and surfaces them to present, then the **full normal pipeline runs to completion in the background** (full gates, normal repair budget) and stops when every phase passes. Mandates status pings. See the Timebox Modifier section.

---

## Phase 0 — Branch Setup

```bash
git fetch origin
git checkout main
git pull origin main
git checkout -b <type>/<descriptive-name>
```

Branch naming:
- `feature/<noun>` — new capability
- `fix/<what-broke>` — bug fix
- `refactor/<scope>` — restructuring
- `security/<issue>` — security-only fix

**Optional — worktree isolation:** when the operator's current workspace has uncommitted changes on another branch, or when the new SDLC run should not perturb an in-flight session, apply `superpowers:using-git-worktrees` — create the feature branch in an isolated worktree directory instead of mutating the current checkout. Skip for clean workspaces; the standard `git checkout -b` flow is sufficient and avoids the extra directory.

Log start time for the final run summary.

### Phase Timing Protocol

Record a Unix timestamp at the **start** and **end** of every phase. Carry `elapsed_s = end − start` into:
- The `phases.{phase}.elapsed_s` field in `run.json` (see `team-lead/SKILL.md → Run Metrics`)
- The `({elapsed}s)` placeholder in the SDLC Run Summary Agent Chain

**PowerShell (Windows):**
```powershell
$t0 = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()  # at phase entry
# ... phase work ...
$elapsed_s = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - $t0  # at phase exit
```

**Bash (Linux/macOS/WSL/Git-Bash):**
```bash
t0=$(date +%s)                          # at phase entry
elapsed_s=$(( $(date +%s) - t0 ))       # at phase exit
```

Use a **fresh `$t0` / `t0` variable per phase** — phases 6 and 7 run in parallel and share the thread; a global accumulator produces overlapping counts. **Skipped phases:** emit `"elapsed_s": 0`. **`flow_reviewer`:** Team Lead writes `"elapsed_s": null` at PR-open time; flow-reviewer updates its own phase entry when it completes (the phase runs after the initial run.json write). The run-level `elapsed_seconds` field is `completed_at − started_at` in seconds — do not sum per-phase values.

### Multi-Operator Preflight (concurrent SDLC awareness)

After branch creation, list other recently-active feature branches on `origin` so the operator knows whether someone else may be running an SDLC pipeline against the same repo. **Advisory only** — never blocks; just surfaces ambient state.

The cost of this check is ~2 seconds (one `git fetch` plus one ref enumeration). The cost of missing it is occasional: two operators implementing the same feature in parallel branches without realising it, or one operator running two terminals against the same workspace. Worth surfacing every run.

**Bash:**

```bash
# Recent active feature/fix branches on remote (last 24h, not yet merged to main)
git fetch origin --quiet 2>/dev/null
cutoff=$(date -d '24 hours ago' --iso-8601=seconds 2>/dev/null || date -v-24H +%Y-%m-%dT%H:%M:%S)
recent=$(git for-each-ref \
  --sort=-committerdate \
  --format='%(committerdate:iso8601-strict)|%(refname:short)' \
  refs/remotes/origin/feature/ refs/remotes/origin/fix/ refs/remotes/origin/refactor/ refs/remotes/origin/security/ 2>/dev/null \
  | awk -F'|' -v cutoff="$cutoff" '$1 >= cutoff { print $2 }' \
  | head -5)
merged=$(git branch -r --merged origin/main 2>/dev/null)
active=$(echo "$recent" | grep -vFf <(echo "$merged") || true)
if [ -n "$active" ]; then
  echo "⚠ Concurrent activity detected — these branches were updated in the last 24h and are not yet merged:"
  echo "$active" | sed 's/^/  - /'
  echo "  Proceed only if you are aware of these parallel runs."
fi
```

**PowerShell:**

```powershell
git fetch origin --quiet 2>$null
$cutoff = (Get-Date).ToUniversalTime().AddHours(-24)
$recent = git for-each-ref --sort=-committerdate `
  --format='%(committerdate:iso8601-strict)|%(refname:short)' `
  refs/remotes/origin/feature/ refs/remotes/origin/fix/ refs/remotes/origin/refactor/ refs/remotes/origin/security/ 2>$null
$merged = git branch -r --merged origin/main 2>$null | ForEach-Object { $_.Trim() }
$active = $recent | ForEach-Object {
  $parts = $_ -split '\|', 2
  if ($parts.Count -eq 2 -and [datetime]::Parse($parts[0]).ToUniversalTime() -ge $cutoff -and ($merged -notcontains $parts[1])) {
    $parts[1]
  }
} | Select-Object -First 5
if ($active) {
  Write-Host "⚠ Concurrent activity detected — these branches were updated in the last 24h and are not yet merged:" -ForegroundColor Yellow
  $active | ForEach-Object { Write-Host "  - $_" }
  Write-Host "  Proceed only if you are aware of these parallel runs."
}
```

**Action:**
- If 0 active branches → proceed silently
- If 1+ active branches → surface the list, optionally pause for user confirmation, log them as `concurrent_runs_at_start: [<branches>]` in the SDLC Run Summary
- Never auto-abort — legitimate parallel work is common (refactor + feature, two devs on different concerns); the framework only owes the operator visibility

**File-overlap detection happens later** — `team-lead/SKILL.md → Step 4.5` performs the actual file-level overlap check at PR time using open-PR data.

### Environment Safety Check (host-posture preflight)

After branch setup, inspect the host environment for signals that this is **not** a supervised developer laptop. If any of `CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `CIRCLECI`, `AWS_ACCESS_KEY_ID`, `GOOGLE_APPLICATION_CREDENTIALS`, `KUBECONFIG`, or `DATABASE_URL` is set, cross-check against the `Host Posture` field declared in `CLAUDE.md` (see the project CLAUDE.md template).

| `Host Posture` value | Action |
|----------------------|--------|
| `local-dev-supervised` | Proceed silently. Operator is at the keyboard and will catch anything bad. |
| `ci-sandboxed` | Proceed silently. CI runner is containerised; Phase 7 is already isolated. |
| `ci-unsandboxed` | Print bold WARNING block (below) and set `state.phase7_sandboxed_warning = true`. |
| (unset / placeholder) | Treat as `ci-unsandboxed` — print warning, set the flag. |

**Bash (Linux / macOS / WSL / Git-Bash):**

```bash
ci_signals=""
for v in CI GITHUB_ACTIONS GITLAB_CI CIRCLECI AWS_ACCESS_KEY_ID GOOGLE_APPLICATION_CREDENTIALS KUBECONFIG DATABASE_URL; do
  if [ -n "${!v:-}" ]; then ci_signals="${ci_signals}${v} "; fi
done
host_posture="$(grep -E '^Host Posture:' .claude/CLAUDE.md 2>/dev/null | head -1 | awk '{print $3}')"
if [ -n "$ci_signals" ] && [ "$host_posture" != "local-dev-supervised" ] && [ "$host_posture" != "ci-sandboxed" ]; then
  echo "⚠ ENVIRONMENT SAFETY WARNING"
  echo "  CI / cloud-credential signals detected: $ci_signals"
  echo "  Host Posture in CLAUDE.md: ${host_posture:-<unset>}"
  echo "  Phase 7 will run shell commands in this environment unsandboxed."
  echo "  See Phase 7 → Sandbox Safety for the recommended posture."
  # set state flag for Phase 7
  PHASE7_SANDBOXED_WARNING=1
fi
```

**PowerShell (Windows):**

```powershell
$ciSignals = @()
foreach ($v in 'CI','GITHUB_ACTIONS','GITLAB_CI','CIRCLECI','AWS_ACCESS_KEY_ID','GOOGLE_APPLICATION_CREDENTIALS','KUBECONFIG','DATABASE_URL') {
  $val = [Environment]::GetEnvironmentVariable($v)
  if ($val) { $ciSignals += $v }
}
$hostPosture = (Select-String -Path .claude/CLAUDE.md -Pattern '^Host Posture:' | Select-Object -First 1).Line -replace '^Host Posture:\s*',''
if ($ciSignals.Count -gt 0 -and $hostPosture -ne 'local-dev-supervised' -and $hostPosture -ne 'ci-sandboxed') {
  Write-Host "⚠ ENVIRONMENT SAFETY WARNING" -ForegroundColor Yellow
  Write-Host "  CI / cloud-credential signals detected: $($ciSignals -join ', ')"
  Write-Host "  Host Posture in CLAUDE.md: $(if ($hostPosture) { $hostPosture } else { '<unset>' })"
  Write-Host "  Phase 7 will run shell commands in this environment unsandboxed."
  Write-Host "  See Phase 7 -> Sandbox Safety for the recommended posture."
  $env:PHASE7_SANDBOXED_WARNING = 1
}
```

The check is **advisory, not blocking** — operators in CI may have a legitimate reason to run unsandboxed (a hand-supervised hotfix, for example). The flag is consumed at Phase 7 entry to prepend a one-line reminder to the test output. Operators who want to silence the warning should set `Host Posture: local-dev-supervised` (or `ci-sandboxed`) in `CLAUDE.md` and they assume responsibility for that classification.

---

## Phase 0.5 — Plan Mode (Read-Only)

**Before writing a single file**, survey the codebase and classify the work.

1. Read `CLAUDE.md` to understand the project stack, commands, and constraints.
2. Read only the specific files named in the requirement and their direct imports.
3. Classify complexity tier:

| Tier | Scenario | Skip | Model |
|------|----------|------|-------|
| **D — Documentation-only** | diff touches only `*.md` / `*.txt` / `*.drawio` / `*.svg` / `*.pdf` — no code extensions | Phase 7 skipped; Phase 5 = brief secret scan only; Phase 6 = clarity/consistency only; Phases 1–3 lightweight | Sonnet |
| **1 — Trivial** | 1-line fix, config/label change, dep bump | Phases 1, 2, 3 only | Sonnet |
| **2 — Standard** | New method, bug with service layer, new endpoint | None | Opus for PO/TL/Arch, Sonnet for dev |
| **3 — Complex** | New service, schema change, new component | None; Architect uses extended thinking | Opus throughout planning |

**Quality Gates (Phases 5–7) always run for Tiers 1–3**, regardless of tier — even a typo fix passes through Security, Code Review, and Tests.

**Tier D classification requires 100% of changed files to match the doc-extension allowlist.** A single non-allowlist file in the diff disqualifies Tier D and falls through to normal Tier 1/2/3 routing. Autodetect:

```bash
# Bash — count non-doc files in diff; output > 0 means Tier D is disqualified
git diff --name-only HEAD | grep -cvE '\.(md|txt|drawio|svg|pdf)$' || true
```
```powershell
# PowerShell equivalent
(git diff --name-only HEAD) | Where-Object { $_ -notmatch '\.(md|txt|drawio|svg|pdf)$' } | Measure-Object | Select-Object -ExpandProperty Count
```

**Why explicit:** a PR touching `README.md` AND `auth.py` must not skip the Test Runner. The failure mode is silent — a careless or malicious change could hide a code edit behind a doc-heavy diff.

**Tier D — Documentation-only gate exception:** Phase 7 (test execution) is skipped — there is no test surface for spec-only diffs. Phase 5 runs as a brief diff-scan for accidentally-pasted secrets AND content-safety checks (see below). Phase 6 reviews for clarity, consistency, and spec correctness only — output is advisory-only, never blocks the PR. The repair loop does NOT activate for Tier D runs; Phase 5/6 findings go to the PR description as annotations and the PR opens regardless.

**Tier D content-safety caveats (inert-rendering assumption):**

The Tier D classification assumes doc files are rendered, not executed. Two exceptions exist:
- **SVG `<script>` tags** — SVG is XML and fully supports embedded JavaScript. A `.svg` with a `<script>` block is not a doc-only change; it is executable code in a doc wrapper. Phase 5 MUST scan for `<script` in any `.svg` in the diff. If found → reclassify as Tier 2 (full security review applies); do NOT proceed as Tier D.
- **Executable `.md` blocks** — Some toolchains run fenced code blocks in `.md` files (doctest, RMarkdown `eval=TRUE`, mdBook runners). If `CLAUDE.md` lists `doctest`, `rmarkdown`, or `mdbook` as toolchain components, flag to the operator before proceeding as Tier D. Otherwise the inert-rendering assumption is valid.

**Tier D sub-classification (spec vs doc):**

Tier D's "advisory only" calibration was originally designed for README/changelog-style documentation, but it now also covers changes to `.claude/skills/**/*.md` — and skill markdown is behavioural code, not prose. Without a sub-classification, a future contributor seeing "Tier D = advisory" might infer that skill changes don't need careful review. They do — just a different kind of review (structural, not correctness-against-tests).

| Sub-tier | Scope | Phase 6 mode |
|----------|-------|--------------|
| **D-spec** | Diff touches `.claude/skills/**/*.md`, `.claude/skills/**/SKILL.md`, or `sdlc/SKILL.md` itself | **Full structural review** — cross-skill consistency check, anchor-preservation check, Bracket Marker Glossary check, no orphan references. Still advisory (no repair-loop, no PR block), but emit findings with the same depth as a Tier 2 review. |
| **D-doc** | Diff touches only README/changelog/CLAUDE.md/`*.txt`/`*.drawio`/`*.svg`/`*.pdf` and no files in `.claude/skills/**/` | **Lightweight review** — clarity, consistency, broken links. Existing Tier D behaviour. |

Autodetect:

```bash
# Bash — emits D-spec or D-doc on stdout
if git diff --name-only HEAD | grep -qE '\.claude/skills/.*\.md$'; then echo "D-spec"; else echo "D-doc"; fi
```
```powershell
# PowerShell equivalent
if ((git diff --name-only HEAD) | Where-Object { $_ -match '\.claude/skills/.*\.md$' }) { "D-spec" } else { "D-doc" }
```

Announce the sub-tier alongside the tier when declaring: `Tier D-spec` or `Tier D-doc`. The flow-reviewer Behavioral Invariants Checklist trigger is "any `SKILL.md` file changed" — which is exactly the D-spec scope. D-spec runs always trigger the checklist; D-doc runs skip it.

**Tier 3 enables TDD mode.** The Architect will include a "Test Skeletons" section in the design doc (one failing test per AC). Phase 4 Developer starts in Test Writer mode — implement skeletons first, confirm they fail, then implement production code. Announce this when declaring the tier: `Tier 3 — TDD mode active`. **Under the Timebox Modifier:** the Architect's phase-1 deliverable is the diagram + plain-English design doc (fast, to present); the Test Skeletons section and the TDD red-phase run in the normal Phase 4 that follows the design deadline — full fidelity, not suppressed.

For Tier 3: write `_drafts/plan-<slug>.md` before any code:

```markdown
## Plan: [feature]
### Files changing
### Design decisions
### Constraints
### Test surface
### Open questions (HITL candidates)
```

Announce tier + skip list, then proceed.

---

## Timebox Modifier (orthogonal to tiers)

Tiers answer *"how careful?"*; the timebox answers *"what do I get fast, and in what order?"*. A timeboxed run **front-loads the presentable design** — a validated architecture diagram plus a plain-English design doc — so the operator has something to show in the first 5–10 minutes, then runs the **full normal pipeline to completion** in the background, producing a complete, fully-gated, scored solution to share later. The motivating failure mode (a real timed-exam run): a Tier 3 classification ran full ceremony front-to-back — design doc, draw.io, AC backlog, TDD red-phase, three gates — so there was nothing to show for 30+ minutes while "speed" was itself graded. The router had no time dimension; this modifier adds one by making the architecture artifacts the **first** output, not the last.

A **second** motivating failure mode (a real live-coding exam loss, 2026-06): a design-first run produced a working, well-AI-leveraged solution — and the reviewer *praised* the AI/tool usage — but it never **named the production failure mode** the exercise was probing (naive per-row synchronous LLM calls with no rate-limit/retry/concurrency/cost control; and a dataset that was silently missing a field the task assumed). A peer candidate raised it; this candidate didn't, and was cut. Lesson: in a timed exam the reviewer grades *production thinking*, and **naming the trap is itself the deliverable** — a fast working artifact with no risk articulation reads as "didn't see it." So the design-first artifacts now MUST carry an explicit production-risk section, and phase 1 includes a deliberate **Production Trap Sweep** before anything is surfaced.

**The timebox value budgets phase 1 — time-to-presentable-design — NOT the whole run.** `[timebox: 10m]` means "produce the diagram + design doc within ~10 min and surface them"; after that the pipeline continues at full fidelity until every phase passes. There is **one** timebox behaviour (design-first) — no sub-variants.

### Activation

- **Explicit:** `use sdlc: <description> [timebox: 10m]` (any phase-1 budget: `5m`, `15m`, ...).
- **Inferred:** the requirement mentions a timed exam, live interview, design review, "I have N minutes to present", or a hard deadline → propose the modifier with a suggested phase-1 budget and confirm with the operator (one question, then proceed). Never silently activate.

Record `state.timebox = {phase1_minutes, started_at}`. Announce alongside the tier: `Tier {N} + timebox {T}m (design-first)`.

### What changes (overlay on the Phase × Tier Routing Matrix)

| Window | Focus | What runs |
|---|---|---|
| **0 → T** (design deadline, ≈5–10 min) | *fast presentable design* | Phases 0 + 0.5 (fast — skip the Multi-Operator Preflight); Phases 1–2 collapse to a ≤3-line inline scope block (no separate PO/TL files). **First read the actual inputs** — the provided data/files/fixtures, not just the prose — for missing, blank, duplicate, or malformed fields and for any field the task *assumes* but the data lacks (this is invisible in a diagram and only catchable by looking). Then **Phase 3 Architect runs** (correct architect variant per Phase 3 selection) and produces **two artifacts**: (a) a **validated `.drawio`** — `/diagram-generator` → `/diagram-layout-reviewer` (layout/z-order/label QA) → `.drawio` XML well-formedness check (the Phase 5 snippet); (b) a **plain-English design doc** (`DESIGN.md`) — task restated, solution approach, key trade-offs / insights, **and a MANDATORY "Assumptions, Limitations & Production Risks" section** capturing the Production Trap Sweep below (2 sentences per real risk: the trap / the prod fix / why it's deferred for the timebox). A `DESIGN.md` without this section is **incomplete** — do not surface it. **Surface both the moment they pass the gate** — the operator presents them. |
| **T → done** (background, full fidelity) | *full scored solution* | The pipeline **continues without pausing**: Phases 4 → 4.5 → 5 → 6 → 7 → 8 → 9 run to completion at **normal depth** — full gates, normal repair budget (3), real tests, PR, retro. No HITL stop; the operator presents the phase-1 artifacts while this runs, and the run stops only when every phase passes. |

**No mandatory pause.** Producing the two artifacts does NOT halt the run — the agent announces "design ready — present it; implementation continues" and proceeds straight into Phase 4. The operator presents in parallel with the background run.

**Status pings are mandatory.** At the design deadline (T) and at each subsequent phase transition, emit a three-line status block — *done / in progress / next* — without being asked. A time-limited operator should never have to interrupt to ask "where are we?".

**Diagram is gated, never raw.** Never surface a `/diagram-generator` output that has not passed `/diagram-layout-reviewer` *and* the XML well-formedness check — a diagram that renders with invisible text, black boxes, or broken XML in front of an audience is worse than none. If the gate cannot pass inside T, surface the design doc plus an ASCII/mermaid sketch and let the polished `.drawio` land via Phase 3's normal output.

**Production Trap Sweep — mandatory gate before surfacing.** Before `DESIGN.md` is presented, run this sweep and record every applicable risk in its "Assumptions, Limitations & Production Risks" section. The point is **not** to fix them all inside T — it's to *name* them; an unnamed production trap is the highest-cost miss in a timed review. Treat a silent "no risks found" as a **failed gate**, not a pass — re-check before surfacing.

```
PRODUCTION TRAP SWEEP  (name the ones that apply; 2 sentences each)
□ DATA:        Did I read the actual inputs? Missing / blank / duplicate / malformed fields?
               A field the task assumes but the data lacks?
□ SCALE:       Does the happy path survive 100× the input? Serial loop over an API/LLM →
               batching, bounded concurrency, rate-limit-aware retry w/ exponential backoff.
□ FAILURE:     One bad row / one failed call — does it kill the batch? Per-item try/except + DLQ.
□ COST:        Any per-row external/LLM call → token/$ ceiling; cheap model where it suffices.
□ IDEMPOTENCY: Safe to re-run after a crash mid-batch? Dedup key, checkpoint, skip-already-done.
□ TRUST:       Is unverified LLM output driving a real action (email a human, move money,
               approve)? Human-review gate / guardrails / confidence threshold.
□ PII/SEC:     Sensitive data in logs/prompts? Tenant isolation? Prompt-injection from inputs?
```

**Speak the failure mode, unprompted.** When presenting, end with one explicit production-risk sentence even if no one asks ("the trap here is X; in prod I'd do Y; I'm deferring it for the timebox"). In a timed exam this single habit is what separates "saw the trap" from "didn't."

**Never suppressed:** the secret scan before any commit, credential redaction, Phase 7 *real* test execution, the full gate set, and the `memory/lessons-*.md` + `memory/run-*.json` artifacts (`run.json` records `"timebox": {"phase1_minutes": T, "design_ready_in_min": U}`).

### Hard total cap (escape hatch — not the default)

If the operator states the *entire* deliverable must finish within T (a true timed take-home with no background time, where working code — not a design — is what's graded), then also compress: go **code-first** (happy-path + one live smoke run before docs), merge Phases 5+6 into one advisory pass (`BLOCKED`-class still halts), drop the repair budget to 1, and move the diagram/design doc to a post-deadline backfill. This is the exception — the default assumes T budgets phase 1 only and the full pipeline completes afterward.

### Interaction rules

| Combination | Behaviour |
|---|---|
| Timebox + Tier D | Ignore the modifier (Tier D is already minimal); tell the operator |
| Timebox + "planning only" | Run Phases 0–3, stop after the two phase-1 artifacts are surfaced |
| Timebox + Tier 1 | Architect still produces the two phase-1 artifacts; Phases 4+ run normally |
| Timebox + `BLOCKED` security finding | A hard security halt always wins |

---

## Phase 1 — Product Owner

Invoke `/product-owner` with the raw requirement.

**Do NOT proceed to Phase 2 until PO output is complete.**

If the requirement is already a well-defined issue with acceptance criteria, the PO phase is lightweight — just confirm AC and flag ambiguities.

---

## Phase 2 — Team Lead (Sprint Planning)

Invoke `/team-lead` with the PO backlog.

**Pause here ONLY if TL raises unresolvable HITL flags.**

---

## Phase 3 — Architect

**Architect variant selection:**
- `/aws-architect` — requirement involves new or modified AWS resources (Lambda, ECS, RDS, S3, VPC, IAM, CDK/CloudFormation/Terraform changes)
- `/onprem-architect` — deployment target is on-premise or air-gapped (no public cloud, self-hosted components, restricted internet, or compliance framework requiring physical hardware control)
- `/migration-architect` — primary question is moving workloads between environments (on-prem → AWS, Azure → AWS, hybrid)
- `/azure-architect` — deployment target is Microsoft Azure (AKS, Azure Functions, Cosmos DB, Event Hubs, Entra ID, Bicep/Terraform azurerm)
- `/ai-llm-architect` — requirement involves LLM deployment, RAG pipelines, agentic systems (LangGraph/ReAct), AI observability (LangSmith/Arize Phoenix), or HITL/HOTL gate design
- `/streaming-architect` — requirement involves real-time event streaming (Kafka/MSK/Kinesis), video/sensor ingest pipelines, KEDA consumer scaling, or high-throughput producer/consumer design
- `/data-architect` — requirement involves data storage layer selection or design: relational (RDS/Aurora/TimescaleDB), NoSQL (DynamoDB/DocumentDB), search (OpenSearch), cache (Redis), vector stores, graph DB, or object storage (S3/MinIO)
- generic `/architect` — application-layer design where the deployment target is already decided and no cloud/infra/data-layer changes are needed

Read relevant files. Produce a concise design doc:

```markdown
## Design: [feature name]

### What changes
- Files: [list]
- New interfaces: [if any]
- Data shape: [if any]

### Why
[The requirement being satisfied]

### Constraints
- Must not break: [X]
- Must satisfy: [Y]

### Test surface
- Unit tests: [list]
- Integration tests: [list]
- Security-relevant paths: [for SR review]
```

Do NOT start writing code until the design doc is clear.

**Tier 3 — mandatory artifacts (in addition to the design doc):**
1. Invoke `/diagram-generator` with the design doc to produce an architecture diagram (`.drawio` file). The diagram is a required Tier 3 artifact — Team Lead B checks for its presence before opening the PR.
2. Confirm the design doc includes a `### Test Skeletons` section (one failing test per AC). See the Architect skill for the required format.

**Tier 1 / 2** — diagram generation and test skeletons are optional.

**Timebox active (any tier)** — the diagram is produced **first**, as the phase-1 deliverable: the Architect runs it through `/diagram-generator` → `/diagram-layout-reviewer` → the `.drawio` XML well-formedness check and surfaces it (with the plain-English design doc) inside the design budget T. Team Lead B's diagram-presence check is therefore satisfied normally. The Test Skeletons artifact and TDD red-phase run in the normal Phase 4 that follows. (Exception: under the *hard total cap* escape hatch, the diagram moves to post-deadline backfill — see Timebox Modifier.)

---

## Repair Loop Protocol (governs Phases 4 → 5 → 6 → 7)

Quality Gates do **not** terminate the pipeline on failure. They emit a structured Repair Request and route back to Phase 4 (Developer). Each repair cycle decrements a shared budget.

```
state.repair_attempts_remaining = 3   # set once at start of Phase 4
```

**Repair Request schema** — a gate that fails (or returns BLOCKED / Critical / Major / non-zero exit code) emits this markdown block and hands control back to Phase 4:

```markdown
## Repair Request — attempt {N} of 3
**Failed gate**: security | code-review | tests
**Severity**: blocking | conditional
**Failure type** (tests gate only): impl | test | flaky | env
**Findings**:
- `path/to/file:line` — description
**Raw output** (tests only, last 60 lines — see Phase 7 "Log Budget"):
```
<stdout/stderr verbatim, last 60 lines>
```
**Prior attempt history** (summarised; omit on attempt 1):
- attempt {M}: first failing assertion + last 20 lines kept; {K} lines truncated
**Attempts remaining**: {N} (of 3 total)
**Targeted files**: <list — Developer must only touch these>
```

The schema enforces a strict context budget: each Repair Request carries at most 60 verbatim lines for the current attempt, plus a summarised tail for prior attempts. See Phase 7 "Log Budget" for the exact truncation rules and the cumulative 300-line cap.

**Constructing the `Targeted files` list:** The emitting gate builds this list by taking the union of:
1. Files directly cited in `Findings` entries (extract the path from each `` `file:line` `` item)
2. Files in the current PR diff (`git diff --name-only HEAD`) that are directly imported by the cited files
3. Test files that exercise the failing behaviour (for Phase 7 failures: the test file containing the first failing assertion)

A too-narrow list causes silent Developer failure — the subagent cannot fix an issue in a file it cannot see. A too-broad list bloats subagent context and degrades repair quality. When genuinely uncertain whether a file is needed, include it — context cost is lower than a wasted repair attempt.

### Self-Sufficiency Contract — what a fresh subagent inherits

When the orchestrator spawns a fresh Developer subagent at attempt N≥2 (see Agent Isolation below), the subagent's working context contains EXACTLY THREE inputs and **nothing else** from the parent thread:

1. The full content of `.claude/skills/developer/SKILL.md` (behavioural rules) — read from disk at subagent spawn time. If the developer skill was edited between attempt 1 and attempt N≥2, the subagent picks up the current on-disk version. **Skills must not be edited mid-run**; intentional skill edits between repair attempts will be picked up silently and may change Developer behaviour.
2. The Cycle Context Compact (1-sentence prior summary + `git diff --stat` + `>> CONTEXT BOUNDARY` marker)
3. The Repair Request (findings, raw output tail, prior attempt history, targeted files)

The subagent does NOT inherit:
- The Architect's design doc (re-read targeted files instead — they reflect what was actually built)
- Earlier Developer turns from the parent thread
- Earlier gate output (Security report, Code Review verdict, prior test logs)
- Any conversation context preceding the `>> CONTEXT BOUNDARY` marker

**What the subagent CAN access beyond the three inputs:** the git working tree at HEAD via Claude Code's Read/Edit/Write tools. The `Targeted files` list in the Repair Request is the guide for which files to read; the subagent reads them fresh from disk, not from the parent's memory. This is the correct handoff: the working tree is ground truth; the parent's in-memory view of a file may lag behind prior Developer edits.

This is a **contract**: the Repair Request schema must carry every fact the Developer needs to act. If a finding requires context that doesn't fit in the schema, the gate emitting the Repair Request must EITHER expand the `Targeted files` list (so the subagent can re-read the source of truth) OR escalate to HITL because the failure is not safely repairable in isolation.

The orchestrator's responsibility: never assume "the subagent will remember X from earlier." The subagent has no memory of earlier — only what is encoded in the three inputs above.

**Developer's job during repair:**
- Fix only the listed findings — no drive-by refactors, no scope expansion.
- Re-run the local Coder ↔ Test Writer inner loop (see `/developer`).
- Re-enter the gate that failed. On pass, continue forward through remaining gates from that point — do **not** re-run earlier gates that already passed (state is preserved).

**Budget exhaustion (`repair_attempts_remaining == 0`):**
- Stop. Do **not** open a PR. Raise HITL via Team Lead with the full repair history (every Repair Request emitted, every Developer attempt) so a human can decide: extend budget, descope, or abandon.
- This is a genuine HITL stop and **satisfies the `/goal` stop-clause** (see Goal Binding). If a goal is bound, the evaluator must clear it here — it must **not** auto-extend the repair budget or auto-continue past this point. Extending the budget is a human decision.

**`BLOCKED` status from Security (hardcoded secret, injection, SSRF, PII in logs)** → HITL immediately, regardless of remaining budget. Some failures must not be patched in a tight loop.

### Cycle Context Compact (emit on every Phase 4 invocation where N ≥ 2)

The problem: by repair attempt 2 the conversation context already contains the full Developer output from attempt 1, the full Security report, the full Code Review, and a test-log tail. This accumulates linearly. The Cycle Context Compact is the mechanism that stops the growth.

**Before invoking Developer on attempt N ≥ 2**, the orchestrator MUST emit this block verbatim. It compresses everything from prior cycles into a fixed-size summary and signals the Developer to discard the verbose prior context:

```markdown
## Cycle Context Compact — before attempt {N}
**What was tried (attempt {N-1}):** [1-sentence description of what Developer changed]
**What failed:** [gate name] — [top finding, 1 line; repeat for up to 5 findings max]
**Code delta so far:** [output of `git diff --stat HEAD` or `git diff --stat main`]
**Prior logs:** summarised — see Repair Request "Prior attempt history" field
---
>> CONTEXT BOUNDARY: Everything above this line is archived history.
>> Developer: begin your working context HERE — read only the Repair Request below
>> and the Targeted files. Do not re-read prior attempt outputs.
```

The Developer MUST acknowledge the boundary: on receiving a Compact, treat all conversation content before the `>> CONTEXT BOUNDARY` marker as read-only archive — do not re-fetch, re-read, or re-summarise it. Your working context is: this Compact + the Repair Request immediately following it + targeted file reads.

### Agent Isolation for repair loops — ENFORCED at attempt N ≥ 2

The Cycle Context Compact reduces accumulation but does not eliminate it — the prior turns are still in the conversation thread and still consume tokens. The structural fix: the Developer is invoked as a **fresh Agent subagent** any time the orchestrator enters a repair cycle.

**Enforcement rule (binding, not aspirational):**

| Scenario | Developer invocation |
|----------|----------------------|
| Attempt 1 (first Phase 4 entry) | Direct invocation in current thread — context is fresh, no isolation needed |
| Attempt N ≥ 2 (any repair cycle, any tier) | **Spawn fresh Agent subagent** via Claude Code's `Agent` tool. Do NOT continue in the current thread. |

The orchestrator MUST follow this rule on every repair-cycle entry. There is no opt-out for "small" repairs — once the loop spins, every subsequent Developer invocation is isolated. The Compact is what the subagent reads; the subagent is what makes the Compact effective.

**Why not always isolate?** Attempt 1 carries the Architect's design doc, which is needed verbatim and is already in the orchestrator's thread. Spawning a subagent on attempt 1 would just re-pay the cost of loading that context. From attempt 2 onward, the Repair Request + Compact + targeted files are a self-contained handoff, so the subagent has everything it needs and nothing it doesn't.

The exact subagent prompt structure is specified in Phase 4 below.

---

## Bracket Marker Glossary

Every bracket marker used across skill files and handoff blocks is defined here. **Adding a new marker without updating this glossary is a spec gap.** Two marker formats exist: inline content markers follow `[UPPER-CASE]`; agent handoff blocks use `[AGENT:role | STATE | ...]`. Each entry below records where the marker appears, what state it represents, and who is responsible for clearing it.

| Marker | File / section where it appears | State it represents | Who clears it |
|--------|--------------------------------|---------------------|---------------|
| `[FIXED]` | `team-lead/SKILL.md` — Step 2.5 Part B PR description block | A pre-existing code-health issue that was fixed in this PR | Permanent record — no further action; the fix is the evidence |
| `[DEFERRED]` | `team-lead/SKILL.md` — Step 2.5 Part B PR description block | A pre-existing issue that was acknowledged and deferred to a ticket | Cleared when the referenced ticket is resolved and the fix lands |
| `[NOTE FILED]` | `team-lead/SKILL.md` — Step 2.5 Part B PR description block | A pre-existing issue surfaced but not in this PR's scope; a ticket was filed | Cleared when the referenced ticket is resolved |
| `[DEFERRED-MAJOR]` | `sdlc/SKILL.md` — Unified Repair Request (Gate Parallelism section) | A Code Review Major that was deferred for one cycle under the stale-log rule so correctness (tests) could be fixed first | Next cycle's Code Reviewer: re-flag if still relevant against the new code, or leave absent if the correctness fix resolved it |
| `[PHASE4-ESCAPE]` | `sdlc/SKILL.md` — Phase 5 pre-condition block | Developer advanced to Phase 5 without the Phase 4 inner loop completing lint/type-check (exceptional path) | Security Researcher notes the escape; Developer must produce a clean lint/type-check run before Phase 5 can issue a full verdict |
| `[REVIEW-PARTIAL]` | `code-reviewer/SKILL.md` — Output Format section, large-diff handling (Step 2) — emitted in the header block when diff exceeds 1500 lines | Code Reviewer could not fully review all changed files; lists files not reviewed | Orchestrator notes the partial review in the PR description; no further action required unless the unlisted files contain high-risk changes |
| `[ACKNOWLEDGED-WONTFIX]` | Developer handoff blocks during repair cycles (consumed by `code-reviewer/SKILL.md` Step 0d) | Developer acknowledges a Code Review finding but intentionally does not fix it; provides a one-line reason. Disagreement-loop circuit-breaker — prevents the same contested Major from re-flagging across all 3 repair attempts. | Code Reviewer in subsequent cycles drops the matching finding (or surfaces it once under Minor / Disagreements). Suppression is permanent within the SDLC run; the entry remains in the handoff record but does not appear in the merged PR unless the Reviewer notes it under Minor. |
| `[AGENT:developer \| COMPLETE \| ...]` | `developer/SKILL.md` — Handoff Block; consumed by `sdlc/SKILL.md` Phase 4 orchestration | Developer completed its work (initial or repair cycle); carries `repair-target` (what gate/failure-type was addressed) and `triage-mismatch` (whether the failure-type classification was wrong) | Orchestrator reads on return from Developer subagent; uses `repair-target` to route to the next gate; not propagated further |
| `[AGENT:developer \| INNER-LOOP-EXHAUSTED \| ...]` | `developer/SKILL.md` — Handoff Block; referenced by `sdlc/SKILL.md` Phase 4 failure mode and Escalation Rule 3 | Developer's inner Coder ↔ Test Writer loop hit its 2-iteration cap without resolving failures | Orchestrator routes to the outer Repair Loop (decrement `repair_attempts_remaining`) or escalates to HITL if budget is exhausted |
| `[SKILL:slack \| <op> \| success= \| ...]` | `slack/SKILL.md` — When Invoked from Another Skill section; returned by the Slack utility skill on every programmatic call | Slack utility completed an operation (post, read, search, etc.); carries success flag and op-specific fields (channel, ts, results count) | Calling skill reads `success` to confirm notification landed; captures `ts` (post timestamp) for lessons-file permalink. Slack failures do not fail the calling phase — they are logged in the run summary. |
| `[AGENT:test-reviewer \| PASS \| ...]` | `test-reviewer/SKILL.md` — Handoff Block; consumed by orchestrator Phase 4.5 routing | Test Reviewer found no quality issues in the new/modified test files | Orchestrator proceeds to Phase 5 (Security) |
| `[AGENT:test-reviewer \| WARN \| ...]` | `test-reviewer/SKILL.md` — Handoff Block; consumed by orchestrator Phase 4.5 routing | Test Reviewer found Minor findings or a small number of Critical/Major findings below the REPAIR threshold | Orchestrator proceeds to Phase 5; findings passed as advisory context to Code Reviewer |
| `[AGENT:test-reviewer \| REPAIR \| ...]` | `test-reviewer/SKILL.md` — Handoff Block; consumed by orchestrator Phase 4.5 routing | Test Reviewer found Critical/Major findings in >20% of new tests or 3+ findings total — suite has structural vacuity | Orchestrator routes to Developer (Test Writer mode, 1 attempt, direct invocation in same thread). Does NOT decrement the outer repair budget (Phases 5–7). |
| `[AGENT:test-reviewer \| COMPLETE \| verdict=WARN \| downgraded=true \| ...]` | `test-reviewer/SKILL.md` — Handoff Block after a REPAIR attempt; consumed by orchestrator Phase 4.5 routing | Test Reviewer issued REPAIR, Developer attempted a fix, Test Reviewer re-ran and still found issues; downgraded to WARN to preserve the outer repair budget | Orchestrator proceeds to Phase 5; residual-findings count passed as advisory context to Code Reviewer |
| `[AGENT:debugger \| COMPLETE \| failure-type=... \| root-cause-found=... \| fix-applied=... \| escalate-hitl=...]` | `debugger/SKILL.md` — SDLC Handoff Block; emitted when Debugger is invoked during a Developer repair cycle (`failure-type: bug \| test`) or standalone | Debugger completed its root-cause analysis. `root-cause-found=true` means a fix was produced; `escalate-hitl=true` means the failure is unresolvable without human input (env issue, 5-file depth limit hit). | Developer receives the fix block and applies it. If `escalate-hitl=true`, orchestrator routes to HITL with the reason from the HITL block. |
| `[CANONICAL-REPO:<name>]` | `team-lead/SKILL.md` — Phase A Step 0.5 Canonical-Repo Decision; consumed by Architect during Phase 3 | Team Lead has determined which repo is the primary deliverable repo for this multi-repo run; `<name>` is the short repo name (e.g. `web-app`, `api-service`). Architect reads this to anchor file-change scope and design doc constraints to the correct codebase. | Consumed at Phase 3 entry — no subsequent clearing required. Architect embeds the repo name in the design doc's "Files changing" list. |
| `[SKILL:<name> \| COMPLETE \| success=false \| failure-type=env \| reason=<short>]` | any external-call skill your project defines (a CI-preflight or E2E/staging-check skill) — emitted when the environment is unavailable before any test execution | External skill aborted early due to environment failure (missing credentials, unreachable service, auth error). The `reason` field is a one-line description (e.g. `"test environment not reachable"`, `"service not running"`). Skill did not run any tests. | Orchestrator receives the handoff and routes to HITL with Escalation Rule 7 (env failure). After the environment is remediated and the run is re-invoked, this marker is replaced by a `success=true` handoff from the same skill. |

---

## Phase 4 — Developer

The Developer skill internally runs a Coder ↔ Test Writer sub-graph (see `/developer`); from the orchestrator's perspective it is a single invocation. **How that invocation happens depends on which attempt we are on.**

### Attempt 1 — direct invocation (same thread)

On the first Phase 4 entry, invoke `/developer` directly in the current orchestrator thread. The Architect's design doc is already in context; passing it through a subagent would just re-pay the load cost.

Inputs:
- Architect's design doc

Rules:
- Edit existing files — do not create new ones unless spec requires it
- No extra abstractions beyond the task
- Follow project linting/formatting standards (from `CLAUDE.md`)
- Run linter and type-checker before advancing
- Initialise `CUMULATIVE_LOG_LINES=0` (see Phase 7 Log Budget snippets) — this counter is read by repair-cycle subagents

**Pre-handoff verification:** the Developer's exit gate must apply `superpowers:verification-before-completion` (referenced in `developer/SKILL.md` inner-loop exit) — re-run lint and the test command one final time and confirm exit code 0 against fresh output before emitting the `COMPLETE` handoff. An advertised-as-passing handoff that came from a stale earlier run wastes Phase 5–7 budget on broken code.

### Attempt N ≥ 2 — Agent isolation (mandatory)

On any Phase 4 re-entry from a Quality Gate failure, the orchestrator MUST spawn a fresh Developer **as an Agent subagent**, not continue in the current thread. This is non-optional — see "Agent Isolation" in the Repair Loop Protocol.

**Subagent prompt structure (exact, in this order):**

1. The full content of `.claude/skills/developer/SKILL.md` (so the subagent loads its own behavioural rules without depending on parent context)
2. The Cycle Context Compact block emitted by the orchestrator (with its `>> CONTEXT BOUNDARY` marker)
3. The Repair Request block immediately after the Compact (no intervening content)
4. An explicit file-read instruction listing the `Targeted files` from the Repair Request

The orchestrator then receives the subagent's `[AGENT:developer | COMPLETE | ...]` handoff block and continues from Phase 5 in the parent thread. The subagent's full conversation is discarded — only its handoff comes back. If the handoff carries `triage-mismatch=true`, log it for operator visibility in the run transcript but do not alter the repair routing — the gate that re-runs will classify from fresh output.

**Input contract (implementation-agnostic):** Spawn a fresh subagent with exactly: (1) developer SKILL.md content, (2) Cycle Context Compact, (3) Repair Request. The concrete invocation below is specific to Claude Code's `Agent` tool. In other orchestration runtimes (LangGraph subgraphs, OpenAI Assistants, Bedrock), substitute the equivalent subagent spawn mechanism while preserving the same three-input contract.

**Concrete `Agent()` call the orchestrator emits (Claude Code):**

```
Agent(
  description="Developer repair attempt {N}",
  subagent_type="general-purpose",
  prompt="""
{paste full content of .claude/skills/developer/SKILL.md here}

---

## Cycle Context Compact — before attempt {N}
**What was tried (attempt {N-1}):** {1-sentence summary}
**What failed:** {gate} — {top finding} (... up to 5 findings)
**Code delta so far:** {git diff --stat HEAD output}
**Prior logs:** summarised — see Repair Request "Prior attempt history" field
---
>> CONTEXT BOUNDARY: Everything above this line is archived history.

## Repair Request — attempt {N} of 3
{full repair request block per schema in Repair Loop Protocol}

---

Read these files before implementing (do NOT read anything else):
- {targeted_file_1}
- {targeted_file_2}
- ...

Return your standard [AGENT:developer | COMPLETE | ...] handoff block when done.
"""
)
```

**Why `subagent_type="general-purpose"`?** No specialised developer agent type ships with Claude Code by default; the general-purpose agent has the full tool set (Read/Edit/Write/Bash) the developer needs. If a project defines a custom `developer` agent type, substitute that name.

**What the orchestrator does with the result:** The Agent tool returns a single message containing the subagent's final output. Extract the handoff block and the implementation summary; treat them exactly as if `/developer` had been invoked directly. Then continue to Phase 5 (Security) in the parent thread.

**Failure mode — subagent error:** If the Agent call returns an error or the subagent fails to produce a handoff block, that counts as a wasted repair attempt for budget purposes (decrement `repair_attempts_remaining`). Surface the error in the run summary and proceed to the next gate evaluation as if the repair had failed silently.

---

## Phase 4.5 — Test Reviewer

Invoke `/test-reviewer` immediately after Phase 4 completes. Runs for **Tiers 1–3**; skipped for Tier D (no test surface).

**Purpose:** Detect false-positive tests — AI-generated tests that pass and report coverage but whose assertions are too weak to catch a broken implementation. The core question: *if the implementation body were replaced with `return None`, would any of these tests fail?*

### Routing

| Handoff | Orchestrator action |
|---------|---------------------|
| `PASS` | Proceed to Phase 5 |
| `WARN` | Proceed to Phase 5; carry `findings=N` as advisory context for Code Reviewer (not in Repair Request) |
| `REPAIR` | Invoke Developer in **Test Writer mode**, **direct in current thread** (not an Agent subagent). Developer receives the Test Quality Repair Request. After Developer finishes, re-invoke Test Reviewer. |
| Still `REPAIR` after repair attempt | Downgrade to `WARN`; emit `COMPLETE | downgraded=true`; proceed to Phase 5 |
| `COMPLETE | downgraded=true` | Proceed to Phase 5; carry `residual-findings=N` as advisory context for Code Reviewer |

### Budget Isolation

Phase 4.5 has an **independent** repair budget of 1 attempt. It does **not** share the outer repair budget (MAX_REPAIR_ATTEMPTS = 3, used by Phases 5–7). A REPAIR → downgrade cycle at Phase 4.5 leaves the outer budget fully intact.

The Developer invocation triggered by Phase 4.5 REPAIR is **not** a full outer-loop Developer invocation. It does not:
- Spawn a fresh Agent subagent (direct thread invocation only — this is intentional and NOT a violation of the Agent Isolation rule, which applies only to outer repair cycles at attempt N≥2)
- Emit a Cycle Context Compact (no prior repair history to compact)
- Decrement `repair_attempts_remaining`

It is a targeted Test Writer call scoped to the test files listed in the Test Quality Repair Request.

**Orchestrator state tracking for Phase 4.5:**

```
state.test_reviewer_repair_attempted = false   # set to true after the first Phase 4.5 REPAIR invocation
```

Set `test_reviewer_repair_attempted = true` when the Developer is invoked from Phase 4.5 REPAIR. If Phase 4.5 returns REPAIR again after this, apply the downgrade to WARN immediately (do not invoke Developer a second time from Phase 4.5). This flag prevents an accidental double-invocation if the orchestrator re-enters Phase 4.5 unexpectedly.

### Advisory Context Passing

When Phase 4.5 emits `WARN` or `COMPLETE | downgraded=true`, the orchestrator MUST carry the advisory findings forward when invoking Phase 6 (Code Reviewer). Pass them as a short block in the Code Reviewer invocation context:

```
Phase 4.5 Test Quality Advisory (treat as Minor — do not include in Repair Request):
- `path/to/test.ext:line` — [finding description]
```

The Code Reviewer will surface these under "Test Quality Advisories (Phase 4.5)" in its Minor section. See `code-reviewer/SKILL.md` Step 0e for the exact handling rule.

### Tier D Skip

For Tier D runs, skip this phase entirely. No handoff block is emitted. Proceed directly from Phase 4 to Phase 5.

---

## Phase 5 — Security Researcher

Invoke `/security-researcher`.

**Pre-condition (already enforced by Phase 4 inner loop):** The Developer ran `lint + type-check` before advancing — this is mandated by the Phase 4 rules. Code with syntax errors, type mismatches, or import failures does not reach the Security Researcher; it is caught and looped back inside Phase 4's Coder ↔ Test Writer sub-graph. Phase 5 therefore evaluates code that already compiles and is syntactically well-formed, avoiding the shift-left token-waste of running an OWASP audit on broken code.

If the Security Researcher receives code that obviously does not compile (e.g., a missing import surfaces as a finding), that is a Phase 4 escape — log it as `[PHASE4-ESCAPE]` in the Repair Request and route back without consuming a security-gate repair attempt. **Phase 5 returns no verdict on the escape path** — the security audit aborts immediately; no partial or provisional sign-off is issued. Phase 5 re-runs from scratch after Phase 4 has produced clean lint/type-check output. The escape route does **not** consume a repair attempt — it is an exceptional path equivalent in handling to `BLOCKED-DESIGN`.

Gate rules:
- `APPROVED` → proceed to Phases 6+7 (parallel — see Gate Parallelism below)
- `CONDITIONALLY_APPROVED` → invoke Developer (direct, Test Writer or Coder mode depending on the item type) with the "Conditions for Approval" list from the sign-off block as a targeted Repair Request. **Do NOT decrement `repair_attempts_remaining`** — a CONDITIONALLY_APPROVED re-run is NOT a gate failure; it is a condition resolve. After Developer fixes the listed items, re-run Phase 5 (Security Researcher) against the updated code. If Phase 5 re-run returns APPROVED or CONDITIONALLY_APPROVED with different items → proceed to Phases 6+7. If Phase 5 re-run still shows the same `file:line` as CONDITIONALLY_APPROVED → escalate to BLOCKED (see `security-researcher/SKILL.md` Repair-cycle escalation rule) → HITL immediately.
- `BLOCKED-DESIGN` → HITL immediately. Architect must revise the design doc; Developer resumes only after redesign is complete. Does **NOT** consume a repair attempt.
- `BLOCKED` (hardcoded secret, injection, SSRF, PII in logs) → HITL immediately. Does **NOT** consume a repair attempt.
- Other fixable failures (e.g. unsafe input handling, missing rate limit) → emit Repair Request, decrement budget, route to Phase 4.

**Security Report Cap** — when writing the Repair Request `Findings` block, include at most **10 findings**. If the full audit surfaces more:
- List the top 10 by severity (Critical first, then High, then Medium)
- Add a single line: `... {N} additional findings omitted (Minor/Informational) — see full sign-off block`
- The full findings list lives in the Security Researcher's sign-off output, not in the Repair Request. The Repair Request carries only what the Developer needs to act on.

This cap applies to Repair Request *output only* — the Security Researcher's internal analysis is unrestricted.

**Tier D Phase 5 entry — two additional checks before secret scan:**

1. **SVG `<script>` scan** — if any `.svg` file is in the diff, scan for the literal string `<script`:

```bash
git diff --name-only HEAD | grep '\.svg$' | xargs -I{} grep -l '<script' {} 2>/dev/null
```
```powershell
git diff --name-only HEAD | Where-Object { $_ -match '\.svg$' } | Where-Object { Select-String -Path $_ -Pattern '<script' -Quiet }
```
If any match → reclassify the PR as **Tier 2** immediately. Do not continue as Tier D. The SVG contains executable JavaScript — a full security review applies.

2. **`.drawio` XML well-formedness check** — if any `.drawio` file is in the diff, verify it parses as valid XML before proceeding. A malformed `.drawio` breaks all downstream rendering (draw.io app, VS Code extension, export pipelines) and is a breaking change even for a doc-only PR:

```bash
git diff --name-only HEAD | grep '\.drawio$' | while read f; do
  python3 -c "import xml.etree.ElementTree as ET; ET.parse('$f'); print('$f: valid')" 2>&1 \
    || echo "$f: MALFORMED XML"
done
```
```powershell
git diff --name-only HEAD | Where-Object { $_ -match '\.drawio$' } | ForEach-Object {
  try { [xml](Get-Content $_); Write-Host "$_`: valid" }
  catch { Write-Host "$_`: MALFORMED XML" }
}
```
If malformed → **HITL immediately**. Do NOT proceed to Phase 6. Fix the XML first.

Only after both checks pass does Phase 5 run the normal secret scan and conclude with `APPROVED`.

**This same XML well-formedness check applies to Tier 3 runs.** The Diagram Generator produces a `.drawio` artifact that Lead B's Part A item 3 verifies as "produced and committed" — but file existence is not sufficient. A committed but malformed `.drawio` is unrenderable in the draw.io app, VS Code extension, and all export pipelines; it is a broken artifact even if `git status` shows it committed. Lead B's Tier 3 diagram artifact check MUST run the XML well-formedness snippet above against the committed file, not just confirm the file exists.

---

## Gate Parallelism (Phases 6 + 7)

After Security passes, run Code Reviewer and Test Runner **simultaneously** as parallel Agent() subagents. Do not wait for one before starting the other — send both in a single message. This is `superpowers:dispatching-parallel-agents` applied to the post-Security gates — the two gates share no state and have no sequential dependency; serial invocation just doubles wall-clock time.

```
Agent(description="Code review gate", ...)   ┐
Agent(description="Test runner gate",  ...)   ┘  ← single message, runs concurrently
```

Collect both handoffs, then apply aggregation rules:

| Phase 6 verdict | Phase 7 result | Action |
|---|---|---|
| PROCEED | exit=0 | Advance to Phase 8 |
| PROCEED | exit≠0 | Repair Request — test findings only. Decrement budget once. |
| REPAIR | exit=0 | Repair Request — code-review findings only. Decrement budget once. |
| REPAIR | exit≠0 | **Unified Repair Request** — code-review findings first, then test failure. **Single decrement.** |

A cycle where both gates fail still counts as **one repair attempt** — the Developer addresses all findings in a single pass.

**Unified Repair Request format (both gates fail):**

```markdown
## Repair Request — attempt {N} of 3
**Failed gate**: code-review + tests
**Severity**: blocking
**Failure type** (tests): {impl|test|flaky}
**Findings** (Tests — address first; correctness > style):
- [first failing assertion + triage classification]
**Findings** (Code Review — address after tests pass):
- `file:line` — [critical/major finding] {[DEFERRED-MAJOR] if stale-log rule applies}
**Findings** (Test Quality — Advisory; omit section if Phase 4.5 had no WARN/downgraded findings):
- `path/to/test.ext:line` — [description] (never blocks repair; Developer may address opportunistically)
**Raw output** (tests, last 60 lines): ...
**Targeted files**: [union of both gates' targeted file lists]
```

**Priority rule (when both gates fail):**

| Finding source | Priority | Treatment |
|----------------|----------|-----------|
| Test Runner (`failure-type: impl/test/flaky`) | **HIGH — correctness** | Must be addressed in this cycle. Tests must be green before the cycle can pass. |
| Code Review — Critical | HIGH — correctness-adjacent | Address in this cycle alongside tests. |
| Code Review — Major (structural refactor) | MEDIUM — style/structure | If addressing it would alter call sites, signatures, or module structure referenced in the test failure logs, treat as **advisory** in this cycle. Mark as `[DEFERRED-MAJOR]` in the Repair Request. |

**Stale-log rule:** A Code Review Major that demands restructuring (extract class, rename module, change method signatures, move responsibilities) can make the test failure logs obsolete by the time the Coder finishes the refactor. The Coder would then have to mentally map stack traces from the old structure onto the refactored code — error-prone and slow.

In that case the Coder addresses correctness FIRST (tests green against the current structure), then re-runs the Code Reviewer in the next attempt — at the cost of one repair cycle. This is preferable to silently mis-applying stale findings.

If the Coder defers a Code Review Major under the stale-log rule, they MUST note it in the handoff: `[DEFERRED-MAJOR: <finding> — reason: stale-log rule applied, deferred to next cycle]`. The next cycle's Code Reviewer sees the deferred entry and either re-flags it (still relevant against the new code) or marks it resolved (refactor satisfied it as a side-effect of the correctness fix).

---

## Phase 6 — Code Reviewer

Invoke `/code-reviewer` as a parallel Agent subagent (see Gate Parallelism above).

**Tier D exception — advisory-only mode:** For Tier D runs, the Code Reviewer evaluates clarity, consistency, and spec correctness only. The REPAIR verdict does not exist for Tier D — there is no back-edge to Phase 4 and no repair budget consumed. All findings are written as PR description annotations and the PR opens regardless of their severity. The Code Reviewer must still produce output; it just cannot block.

Gate output (feeds aggregation step — does not directly route; Tier 1–3 only; Tier D: see advisory-only mode above):
- 0 Critical, 0 Major → verdict: PROCEED
- 1+ Critical or Major → verdict: REPAIR (findings included in Repair Request)
- Minor issues are advisory only — never included in Repair Requests

**Code Review Report Cap** — include at most **10 Critical/Major findings** in the aggregated Repair Request:
- List all Critical findings first (no cap on Critical)
- Fill remaining slots with the highest-severity Major findings
- Add: `... {N} additional Major findings omitted — fix Criticals first, then re-review`

---

## Phase 7 — Tests (deterministic execution)

Phase 7 is **not** an LLM analysis step — it is a real shell execution that produces ground-truth pass/fail.

**Phase 7 entry — consume the safety-check flag.** If `state.phase7_sandboxed_warning` (or env var `PHASE7_SANDBOXED_WARNING`) was set during Phase 0's Environment Safety Check, prepend this single line to the test-result block in the run summary, then continue execution:

```
[⚠ SANDBOX WARNING: running in supervised-shell mode — see Phase 7 Sandbox Safety]
```

This is a reminder, not a block — operator was already warned at Phase 0 and chose to proceed.

### ⚠️ Sandbox Safety — read this before configuring Phase 7 in production

The deterministic Bash exec runs **LLM-generated code**. An LLM reasoning under time pressure can — and occasionally will — emit shell behaviour that:

- **Destroys host state**: `rm -rf`, `git reset --hard`, `truncate`, `dd of=/dev/...`, accidental writes to `~/.ssh/`, `/etc/`, system Python site-packages
- **Makes unintended network calls**: hitting external APIs from a test that should be hermetic, exfiltrating env vars over `curl`, calling production endpoints from a dev shell
- **Escapes the project sandbox**: `cd ~ && ...`, `chmod` outside the repo, mutating shared dotfiles
- **Consumes resources**: long-running tests, fork-bombs, runaway disk writes, infinite log spam

**Current posture (this framework, as shipped):** Phase 7 runs in the operator's interactive shell, with the operator's full filesystem and network permissions. This is **acceptable for local development on a personal machine** under operator supervision. It is **NOT acceptable** for:

- Multi-tenant environments
- CI/CD pipelines running unattended
- Hosts that hold production credentials or have network reach into private subnets
- Any environment where an unintended `rm -rf` would destroy something that isn't disposable

**What "supervised" means — privilege boundary:**

"Supervised" = a **human is at the keyboard**, watching the shell output, and able to `Ctrl+C` any test that misbehaves. That human is the privilege boundary: their attention is what makes the unsandboxed path safe.

"Supervised" does **NOT** mean:
- Another agent watches the Test Runner — there is no agent-supervising-agent fallback in this framework, and adding one would just create a longer chain of LLMs each able to emit dangerous shell behaviour.
- The orchestrator monitors stdout for "suspicious patterns" — pattern-matching on shell output is not a security boundary, it is theatre.
- The operator started the run and walked away — drift away from the keyboard is the exact failure mode the supervised path is meant to catch.

If the operator is not actually present (CI runner, scheduled job, headless environment, run started before going to lunch), the supervised-shell path is unsafe regardless of what `Host Posture` says. The Docker sandbox path (`SDLC_TEST_IMAGE` set + Docker available) is the only correct configuration for unattended execution.

**Native sandbox execution (self-provisioning):**

The orchestrator spins up and tears down the Docker container itself — no operator pre-provisioning required. Set `SDLC_TEST_IMAGE` in your project's `CLAUDE.md` (e.g. `python:3.13-slim`) to enable this path. The orchestrator autodetects Docker availability and falls back to the supervised-shell path if Docker is absent or the image is unset.

**Bash (Linux / macOS / WSL / Git-Bash):**

```bash
# Read SDLC_TEST_IMAGE from environment (set via CLAUDE.md export or shell).
# Falls back to supervised-shell if Docker is unavailable or image is unset.

TEST_CMD="[resolved test command from Step 1]"
SDLC_TEST_IMAGE="${SDLC_TEST_IMAGE:-}"

if [ -n "$SDLC_TEST_IMAGE" ] && docker info >/dev/null 2>&1; then
  # Native sandbox path — ephemeral container, no network, resource-capped
  docker run --rm \
    --network=none \
    --memory=512m \
    --cpus=1 \
    --pids-limit=256 \
    -v "$(pwd):/workspace:rw" \
    -w /workspace \
    --no-new-privileges \
    "$SDLC_TEST_IMAGE" \
    sh -c "$TEST_CMD"
  EXIT_CODE=$?
else
  # Fallback — supervised shell (PHASE7_SANDBOXED_WARNING already set at Phase 0 if risky)
  eval "$TEST_CMD"
  EXIT_CODE=$?
fi
```

**PowerShell (Windows):**

```powershell
# Read SDLC_TEST_IMAGE from environment
$sdlcTestImage = $env:SDLC_TEST_IMAGE
$testCmd = "[resolved test command from Step 1]"

if ($sdlcTestImage -and (docker info 2>$null)) {
  # Native sandbox path
  docker run --rm `
    --network=none `
    --memory=512m `
    --cpus=1 `
    --pids-limit=256 `
    -v "${PWD}:/workspace:rw" `
    -w /workspace `
    --no-new-privileges `
    $sdlcTestImage `
    sh -c $testCmd
  $EXIT_CODE = $LASTEXITCODE
} else {
  # Fallback — supervised shell
  Invoke-Expression $testCmd
  $EXIT_CODE = $LASTEXITCODE
}
```

**Notes:**
- `--network=none` is the default; relax to `--network=bridge` only if tests genuinely need outbound internet.
- The workspace bind mount (`-v "$(pwd):/workspace:rw"`) is the filesystem state handoff — Developer writes files to the host via Edit/Write tools, and the container reads them through the mount. No serialisation protocol is needed.
- `--no-new-privileges`, `--pids-limit=256`, `--memory=512m`, `--cpus=1` are minimum guardrails; tighten for production CI.
- For stricter kernel isolation, replace the Docker runtime with gVisor (`--runtime=runsc`) or Kata Containers.
- The host running the SDLC orchestrator and the container are isolated by kernel namespaces; for full host separation use a GitHub Actions ephemeral runner or a throwaway EC2/Lambda per run.

### Step 1 — Resolve the test command

In order of preference:
1. The exact command listed under "Run tests" in `CLAUDE.md` build commands.
2. Autodetect by project marker (only if CLAUDE.md uses placeholders like `[your test command]`):
   - `pyproject.toml` or `setup.py` → `pytest`
   - `package.json` with a `"test"` script → `npm test`
   - `go.mod` → `go test ./...`
3. If neither resolves → **HITL** ("no test command configured"). Do **not** silently pass.

Note the resolved command + source (CLAUDE.md vs. autodetected) in the run summary.

### Step 2 — Execute and capture

Run the test command using the **Native Sandbox Execution** snippet from the Sandbox Safety section above. Capture: `EXIT_CODE`, last **60 lines** of combined stdout+stderr piped to a temp file (see "Log Budget" below).

If `SDLC_TEST_IMAGE` is set and Docker is available the command runs inside an ephemeral, network-isolated container. Otherwise it falls back to the supervised-shell path with the Phase 0 warning flag already set.

### Step 3 — Triage then Evaluate

**Before emitting any Repair Request**, classify the failure type by reading stdout/stderr:

| failure-type | Indicators | Developer entry point |
|---|---|---|
| `impl` | Assertion error where expected ≠ actual; the test logic and mock setup look correct | Coder mode first |
| `test` | Test calls a non-existent method; wrong mock target; import error in a test file; assertion checks an internal implementation detail rather than behaviour | Test Writer mode first |
| `flaky` | Timing-dependent failure; order-dependent result; non-deterministic value in assertion | Test Writer mode first (fix the test, not the code) |
| `env` | Missing package/dependency; wrong runtime version; Docker networking error; required env var absent | **HITL immediately** — neither Coder nor Test Writer can fix this |

Set `failure-type` in the Repair Request. The Developer uses it to decide which sub-mode to enter first — saving the inner-loop iteration that would otherwise be spent mis-diagnosing a test bug as an implementation bug.

**`env` failures bypass the repair loop entirely** — they require operator action (install dep, set env var, update CLAUDE.md) and do NOT decrement the repair budget.

**Evaluate:**

- Exit code 0 + coverage meets project target → proceed to Phase 8.
- Exit code 0 + coverage below target → emit Repair Request (severity: conditional, failure-type: impl, raw output: coverage report tail), decrement budget, route to Phase 4.
- Exit code != 0 + failure-type = `env` → HITL immediately. Do not decrement budget.
- Exit code != 0 + failure-type = `impl | test | flaky` → emit Repair Request (severity: blocking), decrement budget, route to Phase 4.

**Pre-existing failures:** Before the first Phase 7 entry, run the test command on `main`/`master` and record any failing tests. Failures present on the base branch do **not** consume the repair budget — document and proceed.

**Mechanism — use `git worktree add`** (not stash/switch, which risks test state leaking between branches):

```bash
# Branch-specific path prevents collision when multiple SDLC runs execute concurrently on the same host
BRANCH=$(git rev-parse --abbrev-ref HEAD | tr '/' '-')
BASE=$(git merge-base HEAD origin/main)
git worktree add "/tmp/sdlc-base-check-${BRANCH}" "$BASE"
(cd "/tmp/sdlc-base-check-${BRANCH}" && <test-command> 2>&1) > "/tmp/sdlc-base-failures-${BRANCH}.txt" || true
git worktree remove --force "/tmp/sdlc-base-check-${BRANCH}"
# Any test name in /tmp/sdlc-base-failures-${BRANCH}.txt is a pre-existing failure — exclude from repair budget
```

```powershell
# Branch-specific path prevents collision under concurrent runs
$branch = (git rev-parse --abbrev-ref HEAD) -replace '/','_'
$base = git merge-base HEAD origin/main
git worktree add "$env:TEMP\sdlc-base-check-$branch" $base
Push-Location "$env:TEMP\sdlc-base-check-$branch"
<test-command> 2>&1 | Out-File "$env:TEMP\sdlc-base-failures-$branch.txt"
Pop-Location
git worktree remove --force "$env:TEMP\sdlc-base-check-$branch"
```

The silent failure mode this prevents: running tests against the wrong working tree state (e.g., after a stash that partially applied, or after a branch switch that left unstaged changes behind). `git worktree` is an isolated checkout; it cannot be contaminated by the main working tree's state.

### Credential Redaction — before any Repair Request emission

Raw test output must be redacted before it is included in a Repair Request or surfaced as HITL. Some test frameworks dump environment variables in stack traces on failure; a `KEY=value` line in a Repair Request that is then logged, screenshotted, or pasted into a chat is a credential leak.

Apply this pass to the raw stdout/stderr **before** truncation and before emission:

```bash
# Bash — redact sensitive env var values and high-frequency literal credential prefixes
sed -E \
  -e 's/(AWS_[A-Z_]+|[A-Z_]*_TOKEN|[A-Z_]*_KEY|[A-Z_]*_SECRET|DATABASE_URL)=[^ ]+/\1=<redacted>/g' \
  -e 's/ghp_[A-Za-z0-9_]+/<github-pat-redacted>/g' \
  -e 's/-----BEGIN[^-]*PRIVATE KEY-----.*-----END[^-]*PRIVATE KEY-----/<private-key-redacted>/g'
```

```powershell
# PowerShell equivalent
$output `
  -replace '(AWS_[A-Z_]+|[A-Z_]*_TOKEN|[A-Z_]*_KEY|[A-Z_]*_SECRET|DATABASE_URL)=[^\s]+','$1=<redacted>' `
  -replace 'ghp_[A-Za-z0-9_]+','<github-pat-redacted>' `
  -replace '-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----','<private-key-redacted>'
```

Apply redaction at Phase 7 (test output), Phase 5 (security findings that may echo code), and any HITL surface that includes raw tool output. The pattern covers common env var naming conventions plus the two highest-frequency real-world literal prefixes (GitHub PATs and SSH/TLS private key blocks). Project-specific secret patterns (Slack `xoxb-`, Stripe `sk_live_`, JWT `eyJ` bearer tokens) should be added to the pattern when known from `CLAUDE.md`.

### Log Budget — context-window protection across repair attempts

Every failed Phase 7 attempt appends raw stdout/stderr to the orchestrator's state. By attempt 3 the same stack-trace shape may appear three times — bloating the Developer's input window, slowing each repair, increasing cost, and lowering signal density. Two caps apply:

| Cap | Limit | Behaviour on overflow |
|-----|-------|-----------------------|
| **Per-attempt raw output** | last **60 lines** of combined stdout+stderr | Truncate to last 60 lines verbatim before emitting the Repair Request |
| **Cumulative log payload across all repair attempts** | **300 lines total** | When adding the next attempt would exceed 300 lines, summarise older attempts: keep `attempt N: first failing assertion` + `attempt N: last 20 lines` + `attempt N: K lines truncated`. The most recent attempt is always kept verbatim within its 60-line cap. |

Every Repair Request emitted by Phase 7 must contain:

1. The verbatim error summary (first failing assertion / first stack-frame) — always preserved
2. The current attempt's last 60 lines verbatim
3. A summarised history of previous attempts (if any) under a `**Prior attempt history (summarised)**` heading

The orchestrator state object **must NOT carry full historical logs forward** — it carries only the summary string for prior attempts plus the verbatim tail for the current one. This is the single most effective lever against repair-loop context bloat; do not skip it.

#### Enforcement snippets (copy-paste, do not just describe in prose)

The orchestrator MUST execute one of these snippets on every Phase 7 invocation that fails — not just describe the rule. State counters live in env vars or a tiny side-file (`.sdlc/log-budget.tsv`) keyed by branch.

**Bash (Linux / macOS / WSL / Git-Bash):**

```bash
# State init at Phase 4 start (run once per repair budget):
#   state.cumulative_log_lines=0   # plain env var; reset when budget resets

# After every Phase 7 run that fails, given $RAW_LOG=path-to-test-output:
PER_ATTEMPT_CAP=60
CUMULATIVE_CAP=300

# 1. Per-attempt cap — keep only the last 60 lines verbatim
TRUNCATED_LOG="$(tail -n $PER_ATTEMPT_CAP "$RAW_LOG")"
THIS_ATTEMPT_LINES=$(printf "%s\n" "$TRUNCATED_LOG" | wc -l | tr -d ' ')

# 2. Cumulative cap — if adding this attempt would exceed 300, summarise prior attempts
NEW_TOTAL=$((${CUMULATIVE_LOG_LINES:-0} + THIS_ATTEMPT_LINES))
if [ "$NEW_TOTAL" -gt "$CUMULATIVE_CAP" ]; then
  # summarise the *prior* attempts: first failure line + last 20 lines + truncation count
  PRIOR_FIRST="$(grep -E '(FAIL|Error|Exception)' "$PRIOR_LOG" | head -1)"
  PRIOR_TAIL="$(tail -n 20 "$PRIOR_LOG")"
  PRIOR_DROPPED=$((${CUMULATIVE_LOG_LINES:-0} - 21))
  PRIOR_SUMMARY="${PRIOR_FIRST}"$'\n'"${PRIOR_TAIL}"$'\n'"... ${PRIOR_DROPPED} lines truncated ..."
  # reset cumulative counter to just this attempt
  CUMULATIVE_LOG_LINES=$THIS_ATTEMPT_LINES
else
  CUMULATIVE_LOG_LINES=$NEW_TOTAL
fi

# 3. Emit Repair Request with $TRUNCATED_LOG (verbatim) and $PRIOR_SUMMARY (if set)
```

**PowerShell (Windows):**

```powershell
# State init at Phase 4 start:
#   $env:CUMULATIVE_LOG_LINES = 0

# After every failed Phase 7 run, given $RawLog = path-to-test-output:
$PerAttemptCap = 60
$CumulativeCap = 300

# 1. Per-attempt cap — keep only the last 60 lines verbatim
$TruncatedLog   = Get-Content $RawLog | Select-Object -Last $PerAttemptCap
$ThisAttemptLines = ($TruncatedLog | Measure-Object -Line).Lines

# 2. Cumulative cap — if adding this attempt would exceed 300, summarise prior attempts
$prevTotal = [int]($env:CUMULATIVE_LOG_LINES)
$newTotal  = $prevTotal + $ThisAttemptLines
if ($newTotal -gt $CumulativeCap) {
  $priorFirst  = (Select-String -Path $PriorLog -Pattern '(FAIL|Error|Exception)' | Select-Object -First 1).Line
  $priorTail   = Get-Content $PriorLog | Select-Object -Last 20
  $priorDropped = $prevTotal - 21
  $PriorSummary = @($priorFirst) + $priorTail + "... $priorDropped lines truncated ..."
  $env:CUMULATIVE_LOG_LINES = $ThisAttemptLines
} else {
  $env:CUMULATIVE_LOG_LINES = $newTotal
}

# 3. Emit Repair Request with $TruncatedLog verbatim + $PriorSummary if set
```

These snippets are the **ground truth** of the Log Budget rule. The prose table above is a reference; if prose and snippet diverge, the snippet wins.

### Context Size Gate

Run this check **before emitting any Repair Request from Phase 7**. It catches the broader accumulation problem that log truncation alone cannot solve.

**Source of truth — prefer real telemetry:**

The estimator uses `usage.total_tokens` from the model's API response when available — this is the actual token count the API counted, not an approximation. Fall back to the chars/4 heuristic only when telemetry is absent (e.g., no API call has happened in this phase yet, or telemetry is disabled).

```
Priority order:
  1. usage.total_tokens   (exact, from the most recent API response)
  2. SDLC_FALLBACK_CHARS / 4 (fallback — coarse, breaks on non-ASCII / dense logs / base64)
```

**Why the fallback is unreliable:** chars/4 assumes English prose. Dense application logs, stack traces, base64-encoded data, and non-ASCII content can have token-to-char ratios well outside the 1:4 assumption — undercounting tokens and hitting the model's hard limit unexpectedly. Use real telemetry whenever possible.

**Bash:**
```bash
# Prefer the real token count from the most recent API response.
# Orchestrators that wrap the model SDK should expose it as $SDLC_LAST_TOTAL_TOKENS.
if [ -n "${SDLC_LAST_TOTAL_TOKENS:-}" ]; then
  ESTIMATED_TOKENS="$SDLC_LAST_TOTAL_TOKENS"
  TOKEN_SOURCE="usage.total_tokens"
else
  # Fallback: coarse char-based estimate
  ESTIMATED_TOKENS=$(( ${SDLC_FALLBACK_CHARS:-0} / 4 ))
  TOKEN_SOURCE="chars/4 fallback"
fi

if [ "$ESTIMATED_TOKENS" -gt 150000 ]; then
  echo "🛑 CONTEXT LIMIT WARNING: ${ESTIMATED_TOKENS} tokens (${TOKEN_SOURCE})."
  echo "   Proceeding risks truncation or degraded repair quality."
  echo "   HITL: choose — (a) spawn isolated Agent for next attempt, (b) abandon + rebase, (c) proceed manually."
  # Emit as HITL, do NOT auto-continue
elif [ "$ESTIMATED_TOKENS" -gt 100000 ]; then
  echo "⚠ CONTEXT ADVISORY: ${ESTIMATED_TOKENS} tokens (${TOKEN_SOURCE}). Consider agent isolation for next attempt."
  # Advisory only — continue
fi
```

**PowerShell:**
```powershell
# Prefer the real token count from the most recent API response.
if ($env:SDLC_LAST_TOTAL_TOKENS) {
  $estimatedTokens = [int]$env:SDLC_LAST_TOTAL_TOKENS
  $tokenSource = "usage.total_tokens"
} else {
  # Fallback: coarse char-based estimate
  $estimatedTokens = [int]($env:SDLC_FALLBACK_CHARS) / 4
  $tokenSource = "chars/4 fallback"
}

if ($estimatedTokens -gt 150000) {
  Write-Host "🛑 CONTEXT LIMIT WARNING: $estimatedTokens tokens ($tokenSource)." -ForegroundColor Red
  Write-Host "   HITL: (a) spawn isolated Agent, (b) abandon + rebase, (c) proceed manually."
  # Emit as HITL — stop and present options to operator
} elseif ($estimatedTokens -gt 100000) {
  Write-Host "⚠ CONTEXT ADVISORY: $estimatedTokens tokens ($tokenSource). Consider agent isolation." -ForegroundColor Yellow
}
```

The thresholds — 100K advisory, 150K hard HITL — give ~30K of headroom before most models' 200K limits, accounting for system prompt and skill file overhead. With real telemetry these are exact; with the fallback heuristic add a safety margin (treat 80K as the advisory line, 130K as the hard line).

**Tracking the inputs:**
- `SDLC_LAST_TOTAL_TOKENS` — set by the model wrapper after every API call. Updated continuously; the gate reads the most recent value.
- `SDLC_FALLBACK_CHARS` — incremented by `len(output)` after each major tool call (Bash exec, file Read, agent output). An exact count is not required; order-of-magnitude accuracy is sufficient for the fallback path.

---

## Phase 8 — Team Lead Gate + Commit + PR

Invoke `/team-lead` (Phase B).

TL verifies: all acceptance criteria met, security sign-off, test gate, no open HITL.

Commit format:
```bash
git add <specific files — never git add .>
git commit -m "<type>(<scope>): <subject>"
```

PR creation (in order of preference):
1. `gh pr create` (GitHub CLI)
2. Project-specific PR creation command from `CLAUDE.md`
3. Manual URL provided to user

**Always end with the PR URL on its own line.**

**Post-PR: External CI poll**

After the PR URL is confirmed, poll external CI if `gh` is available:

```bash
# Poll for up to 15 minutes; timeout 900 prevents indefinite hang on network drop or gh CLI bug
timeout 900 gh pr checks <PR-number> --watch --interval 30 || true
```

```powershell
# PowerShell equivalent — Wait-Job -Timeout 900 provides the same hang protection
$job = Start-Job { gh pr checks $using:prNumber --watch --interval 30 }
Wait-Job $job -Timeout 900 | Out-Null
Receive-Job $job
```

| Outcome | Action |
|---------|--------|
| All checks pass | Note `External CI: passed` in run summary. SDLC run complete. |
| Any check fails | **HITL** — include PR URL + failing check name + CI log link. Do NOT attempt auto-repair; external CI failures require human triage. |
| `gh` unavailable or checks unresolved after 15 min | Note `External CI: not polled — manual check required` in run summary. Proceed. |

**Run metrics artifact:** Team Lead Phase B writes a machine-readable `memory/run-{YYYY-MM-DD}-{slug}.json` capturing tier, phase outcomes, repair-loop state, HITL items, and final disposition — same lifecycle and MANDATORY status as the lessons file. The file is the source of truth for cross-run pattern detection (see `/flow-reviewer` Step 7) and future drift-detection skills. Schema spec lives in `team-lead/SKILL.md → Run Metrics`. Aborted runs still emit the file.

---

## Phase 9 — Flow Reviewer (Non-Blocking)

Invoke `/flow-reviewer` after PR is opened.

**Timing clarification:** "Non-blocking" means Flow Reviewer does not block the human waiting for the PR URL or delay the SDLC run summary — it is invoked sync-after-PR-opens within the same Phase 9 step, not fire-and-forget on a schedule. The orchestrator calls `/flow-reviewer`, waits for its output, then ends the run. The lessons file written by Team Lead (Phase B's last mandatory action) is already on disk before Flow Reviewer is invoked; Flow Reviewer reads that file as part of its retrospective. There is no separate async process or schedule involved.

---

## SDLC Run Summary Template

```markdown
## SDLC Run Summary — {DATE} {TIME}

### Original Requirement
{verbatim user request}

### What Was Shipped
- {file/function level changes}

### Agent Chain
{timestamp} [PO]              → {N} backlog items ({elapsed}s)
{timestamp} [Team-Lead]       → tier {1/2/3}{tdd-mode}, {N} sprint items ({elapsed}s)
{timestamp} [Architect]       → design complete ({elapsed}s)
{timestamp} [Developer]       → {N} files changed, inner-iter={N} ({elapsed}s)
{timestamp} [Test-Reviewer]   → {PASS/WARN/REPAIR→WARN} tests-reviewed={N} ({elapsed}s)
{timestamp} [Sec-Researcher]  → {APPROVED/CONDITIONALLY_APPROVED/BLOCKED} ({elapsed}s)
{timestamp} [Code-Reviewer]   → {N} issues, verdict={PROCEED/REPAIR} ({elapsed}s) [parallel]
{timestamp} [Tests]           → exit={code}, coverage {N}% ({elapsed}s)           [parallel]
{timestamp} [Repair-Cycle-N]  → gate={security/code-review+tests}, files-changed={N} ({elapsed}s)
{timestamp} [Team-Lead]       → PR opened / BLOCKED by HITL ({elapsed}s)

### Repair Loop
- Repair attempts used: {N} of 3
- Budget exhausted: yes / no
- Test command: `{resolved command}` (source: CLAUDE.md / autodetected)

### HITL Items
{list or "None — fully autonomous run"}

### Token Budget (estimated)
| Phase        | Est. Input Tokens | Notes                    |
|--------------|-------------------|--------------------------|
| PO           | ~10,000           |                          |
| Architect    | ~25,000           | extended thinking if T3  |
| Developer    | ~35,000           | file reads + edits       |
| Test Reviewer| ~5,000            | test file reads          |
| Security     | ~15,000           | diff review              |
| Code Review  | ~20,000           |                          |
| Tests        | ~5,000            |                          |
| Team Lead    | ~10,000           |                          |
| **Total**    | **~120,000**      |                          |

### Elapsed Time
Total: {Xm Ys} | Slowest phase: {phase} ({Ys})
{if Timebox Modifier active: "Timebox: phase-1 budget {T}m — design artifacts ready in {U}m ({within | over} budget); Production Trap Sweep: {N} risks named; full pipeline {completed | aborted}"}

### Observability
If `LANGSMITH_API_KEY` or `OTEL_ENDPOINT` is set, each phase emits a structured JSON trace to stderr:
`{"phase": "developer", "elapsed_s": 42, "tokens_est": 35000, "status": "COMPLETE", "files_changed": 3}`
Collect via `2>traces.jsonl` or pipe to your OTEL collector.
```

---

## Phase × Tier Routing Matrix

The canonical reference for which phases run at which tier. Phase 0.5 produces the tier; this table is deterministic from that point. **No LLM judgment is required after classification.**

| Phase | Tier D (doc-only) | Tier 1 (trivial) | Tier 2 (standard) | Tier 3 (complex) |
|-------|------------------|------------------|-------------------|------------------|
| **0 — Branch** | ✅ full | ✅ full | ✅ full | ✅ full |
| **0.5 — Classify** | ✅ full | ✅ full | ✅ full | ✅ full |
| **1 — Product Owner** | lightweight | skip | full | full |
| **2 — Team Lead (A)** | lightweight | skip | full | full |
| **3 — Architect** | lightweight | skip | full | full + TDD skeletons |
| **4 — Developer (Coder)** | ✅ | ✅ | ✅ | TDD: Test Writer runs first |
| **4 — Developer (Test Writer)** | skip | ✅ | ✅ (optional TDD if Architect adds Test Skeletons) | runs first (TDD mandatory) |
| **Diagram Generator** | skip | skip | optional | mandatory (Lead B checks) |
| **4.5 — Test Reviewer** | **SKIP** | lightweight (Checks 1–2 only) | full | full |
| **5 — Security** | SVG script scan + `.drawio` XML check + secret scan | full OWASP | full OWASP | full OWASP |
| **6 — Code Review** | clarity/consistency only; **advisory, never blocks PR** | full | full | full |
| **7 — Test Runner** | **SKIP** | ✅ full | ✅ full | ✅ full |
| **8 — Team Lead (B)** | Part A: no Test Runner row; Part B: advisory | full | full | full + `.drawio` artifact check |
| **9 — Flow Reviewer** | minimal lessons (see Retrospective rules) | ✅ full | ✅ full | ✅ full |
| **Repair loop** | inactive | ✅ (3 attempts) | ✅ (3 attempts) | ✅ (3 attempts) |

**How to read this table:**
- "skip" = the phase does not run; its output is not required before the next phase
- "lightweight" = the phase runs but only confirms AC and flags gaps — no full analysis
- "advisory" = output goes to PR description annotations; the PR opens regardless

Special cases not captured by tier:
- Existing issue with full AC → Phase 1 lightweight regardless of tier
- Security-only fix → Phase 6 brief; Phase 5 always full
- Hotfix to production → never skip Phase 5
- "planning only" user constraint → run Phases 0–3 only, stop before Phase 4
- **Timebox Modifier active** → this matrix still selects the tier, but the Timebox overlay reorders the front of the run: Phases 1–2 collapse to an inline scope block and the Architect produces a **validated diagram + plain-English design doc first** (gated through `/diagram-layout-reviewer` + the XML well-formedness check) within the phase-1 budget T, then Phases 4 → 9 run to completion at **full fidelity** (full gates, normal repair budget). Only the *hard total cap* escape hatch compresses gates / drops repair budget to 1 / moves the diagram to backfill. See the Timebox Modifier section — its table wins over this one wherever they conflict.

#### "documentation only" user constraint vs. Tier D — important distinction

These look similar but produce very different pipeline behaviour:

| | Tier D | "documentation only" constraint |
|---|--------|----------------------------------|
| **Triggered by** | Phase 0.5 autodetect — diff contains only `*.md/txt/drawio/svg/pdf` | User appends "documentation only" to the `use sdlc:` prompt |
| **What runs** | Full pipeline minus Phase 7; Phases 5–6 in reduced mode | Phases 0–3 only (PO → Team Lead A → Architect) |
| **What ships** | A PR with doc-only changes | Nothing ships — output is a design doc / plan only |
| **Example** | `use sdlc: fix typo in README.md` | `use sdlc: documentation only — describe the auth flow` |

A user writing `use sdlc: documentation only — describe the auth flow` expects a design document, not a PR. A user writing `use sdlc: fix typo in README.md` expects a merged change. Misidentifying one as the other either skips all gates on a code change (dangerous) or opens a PR for a planning document (confusing). Phase 0.5 applies the autodetect snippet to distinguish them; the user-supplied constraint is the override.

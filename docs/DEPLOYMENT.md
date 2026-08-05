# Deployment — the game at a public URL, with only GitHub hosting it

**MON-805.** Kesef Street can be published as a **fully static site**: a URL anyone can open, with
no server behind it, nothing to keep running and nothing to pay for. This document is for the
repository owner: what to switch on, what the build actually does, and what to do if the repository
has to stay private.

---

## 1. Turn it on (one time, by hand — and it genuinely cannot be automated)

1. **Settings → Pages → Build and deployment → Source: `GitHub Actions`.**
2. Push to `main`, or run **Actions → Deploy to GitHub Pages → Run workflow**.
3. The live URL appears on the workflow run, and is `https://<owner>.github.io/<repo>/`.

Step 1 is a click, and it was worth establishing that no amount of workflow configuration replaces
it. `actions/configure-pages` accepts `enablement: true`, which is meant to create the site on
first use; tried on this repository, the API refused the workflow's own credentials:

```
Get Pages site failed.    Error: Not Found
Create Pages site failed. Error: Resource not accessible by integration
```

Creating a Pages site requires repository-administration rights. The default `GITHUB_TOKEN` does not
carry them, however many `permissions:` the workflow declares — `pages: write` is enough to *deploy*
to a site that exists, not to bring one into being. The only alternatives are an owner's click or a
stored PAT with admin scope, and an admin-scoped token committed to CI is a much larger thing to own
than one checkbox.

So the failure mode is worth recognising rather than debugging twice: on a repository where Pages has
never been switched on, this workflow builds everything correctly, smoke-tests the artifact in a real
browser, and *then* fails on `configure-pages` with *"Get Pages site failed"*. That is the checkbox,
not the build. Every run after the switch finds the site and passes.

> **A private repository needs GitHub Pro.** Pages on a private repo is a paid feature — and note
> that this is about the *site*, not the code: nothing in this workflow can change repository
> visibility. If Pro is not the plan, see [§5](#5-if-the-repository-must-stay-private) — three free
> routes, all of which keep the source private.


---

## 2. Why there is no server

The architecture already made this possible; MON-805 only connected it up.

- `kesef-engine` is **pure Python with one dependency** and performs no I/O beyond reading its own
  bundled board JSON. Nothing about the rules needs a network.
- `kesef-server` owns *sessions and serialization only*. Its FastAPI routes are a transport, not a
  brain.
- `packages/web/src/api/client.ts` takes its `fetch` and its WebSocket factory **as constructor
  options**.

So the static build does three things:

1. Runs the Python engine **in the browser** under [Pyodide](https://pyodide.org).
2. Calls it through `kesef_server.browser` — the same handlers `api.py` exposes over HTTP, exposed as
   plain functions returning `{status, body}` JSON. `packages/server/tests/test_browser_parity.py`
   runs every interaction through *both* transports and asserts the answers are identical, which is
   what stops the two drifting.
3. Substitutes a `fetch` and a fake socket that route to those functions
   (`packages/web/src/local/`). **Nothing above that directory changes** — `useGame`, the event
   queue, the narration and every panel are the same code in both builds.

A player's game lives in their own tab. The save file is a download, and loading one is a file
upload into the same in-memory store — no account, no cloud, nothing to delete later.

### What that costs

| | HTTP build | Static build |
|---|---|---|
| First load | ~450 kB JS | ~450 kB JS **+ ~12 MB** interpreter and wheels, cached afterwards |
| Multi-device play | possible later (MON-9xx) | one tab, one table |
| Hosting | a Python host | none |

The first-load size is why there is a real loading screen with named stages
(`engine.stage.*` in both catalogues), not a spinner and not a blank page.

---

## 3. What the workflow does

`.github/workflows/deploy-pages.yml`, on every push to `main` and on demand:

1. **Builds both wheels** into `packages/web/public/wheels/` and writes a `manifest.json` beside
   them. The manifest exists so a version bump is not a silent 404: the loader reads the filenames
   rather than hardcoding them.
2. **Builds the site** with `VITE_ENGINE=local` and `VITE_BASE=/monopoly/`. The base path matters —
   a project site is served under the repository's name, and assets built for `/` 404 there.
3. **Smoke-tests the built artifact** in Chromium against the real interpreter at the real base path
   (`npm run test:e2e:pages`), *before* publishing. Every other job in CI can be green while this is
   broken, so this one runs on the bytes that are about to go live.
4. Uploads and deploys.

### Renaming the repository

`SITE_BASE` at the top of the workflow is the only place the sub-path is written. Change it there and
in this document; nothing in the source names it.

### Pinned versions

| Thing | Version | Why pinned |
|---|---|---|
| Pyodide | **0.29.4** | Ships **CPython 3.13.2**. Both wheels declare `requires-python = ">=3.13"` and micropip enforces it, so Pyodide 0.28 and earlier (CPython 3.12) fail at *install* time. Also ships pydantic 2.12.5, satisfying `pydantic>=2.9`. |
| Its CDN | `cdn.jsdelivr.net/pyodide/v0.29.4/full/` | One constant, `PYODIDE_VERSION` in `src/local/engine.ts`; overridable with `VITE_PYODIDE_VERSION`. |
| Wheels | built from this commit | Not fetched from anywhere. |

A floating "latest" is refused on purpose: for a deterministic rules engine, "the game behaves
however a CDN felt this morning" is the one dependency style worth ruling out.

### Why the wheels install with `deps=False`

`kesef-server`'s metadata declares `fastapi` and `uvicorn[standard]`, and `uvicorn[standard]` pulls
`httptools`, `uvloop` and `watchfiles` — native extensions with **no pure-Python wheel**, so nothing
micropip can install into WebAssembly. Nothing on `kesef_server.browser`'s import path touches any of
them, so the install is "these two wheels, and nothing they claim to need", plus by hand:

- `structlog` and `pydantic-settings` from PyPI (both pure Python, as is everything they pull in);
- `pydantic`, `pydantic-core`, `annotated-types` and `typing-extensions`, which **Pyodide already
  ships** as WebAssembly builds.

That claim is not left to a comment.
`test_the_browser_transport_imports_no_web_framework` imports the module in a subprocess and fails if
`fastapi`, `starlette`, `anyio` or `uvicorn` appears in `sys.modules`. Two supporting changes keep it
true: `errors.py` spells its status codes as integers instead of importing `fastapi.status`, and
`kesef_server/__init__.py` resolves `app` lazily through `__getattr__`.

---

## 4. Checking the static build locally

```bash
# 1. Wheels into the site's static assets, with the manifest the loader reads.
uv build --package kesef-engine --wheel --out-dir packages/web/public/wheels
uv build --package kesef-server --wheel --out-dir packages/web/public/wheels
(cd packages/web/public/wheels && ls -1 *.whl \
  | python3 -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))' \
  > manifest.json)

# 2. Build it the way Pages will be served. Omit VITE_BASE to serve from a domain root.
cd packages/web
VITE_ENGINE=local VITE_BASE=/monopoly/ npm run build

# 3. Play a turn in a real browser against the real interpreter.
VITE_BASE=/monopoly/ npm run test:e2e:pages

# ...or drive it by hand:
VITE_BASE=/monopoly/ npm run preview
```

`packages/web/public/wheels/` is `.gitignore`d — it is a build artifact, and the workflow writes it
fresh.

The ordinary gates are unchanged and do **not** need any of the above:

```bash
uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest
cd packages/web && npm run typecheck && npm run lint && npm run format:check && npm run test -- --run
```

### If the page is blank

Open the console; the failure is almost always one of four, and each says so plainly:

| Symptom | Cause |
|---|---|
| `404` for `wheels/manifest.json` | step 1 was skipped |
| Assets 404 under a sub-path | built without `VITE_BASE`, or a stale `vite preview` from a differently based build is still up on the port |
| micropip complains about `Requires-Python` | a Pyodide older than 0.29 (CPython 3.12) |
| A Python `Traceback` naming `fastapi` | something new reached `browser.py`'s import path — the parity test above will be red too |

---

## 5. If the repository must stay private

Pages on a private repository needs GitHub Pro. Three ways to publish a public *site* while the
source stays private, all free:

### A. GitHub Pro — nothing else changes

The paid plan makes Pages work on a private repo. The workflow above is already correct; no code
changes. The simplest option if the plan is acceptable.

### B. A separate public deploy repository

Keep this repository private and have CI push only the **built site** — `packages/web/dist`, which
contains no source — to a second, public repository whose Pages is enabled.

- **Cost:** free. **Source stays private.**
- **Trade:** two repositories, a deploy key or PAT to hold, and the published site is a commit
  rather than an artifact — so a bad build is a revert away rather than a redeploy away.
- Sketch: add a job that checks out `<owner>/kesef-street-site`, copies `dist/` over it, and commits.
  `peaceiris/actions-gh-pages` with `external_repository` is the well-worn version.

### C. Cloudflare Pages, Netlify or Vercel

All three build from a private GitHub repository on their free tier and serve the result publicly.
Connect the repository, then:

| Setting | Value |
|---|---|
| Build command | `cd packages/web && npm ci && npm run build` |
| Output directory | `packages/web/dist` |
| Environment | `VITE_ENGINE=local` (leave `VITE_BASE` unset — these serve from a domain root) |

- **Cost:** free. **Source stays private.** A real domain is easy, and previews per pull request come
  free.
- **Trade:** the wheels. These hosts have Node, not `uv`, so the two `uv build` calls have to happen
  somewhere — either commit the wheels to `packages/web/public/wheels/` (remove that line from
  `.gitignore`) or have a GitHub Actions job build them and commit them. Neither is elegant; option B
  or A avoids the question.
- **Also:** the post-build smoke test does not run there. Keep it in CI.

### The recommendation

**A if the plan allows it, otherwise C** — C gets a real domain, pull-request previews and a shorter
pipeline, at the price of getting two wheels into the tree. B is the right answer only if the site
must be hosted by GitHub specifically and the plan must stay free.

---

## 6. The API behind online play (MON-901)

Everything above stands: the static site keeps working, keeps needing no server, and keeps costing
nothing. This section adds the **second** mode — two people at two machines sharing one game — and
that genuinely does need a server, for the reason §2 gives from the other side. The engine in your
browser is *your* engine; two browsers running it are two unrelated games. Something has to hold the
one game they both act on.

`packages/server` already is that something — sessions, a WebSocket event stream (MON-303), bot
driving (MON-304), all built and tested. It has simply never been deployed.

### 6.1 Deploy it

`render.yaml` at the repository root is a Render **blueprint**: the build, the start command, the
health check and the environment are all read from it, so a deploy is reviewable in a diff.

1. **Render → New → Blueprint** → pick this repository → **Apply**.
2. First build takes a few minutes. The service URL is `https://kesef-street-api.onrender.com`
   (Render appends a suffix if that name is taken — use whatever it shows you).
3. Check it: `https://<your-service>.onrender.com/health` should answer, and `/docs` should render
   the API.

Nothing secret is involved. There is no API key to hold, no token to store, and nothing to paste
anywhere — Render's GitHub app watches `main` and redeploys on merge.

### 6.2 The two limits of the free plan, stated honestly

**It sleeps after 15 minutes idle**, and the next request waits ~a minute while it wakes. This is
better than it sounds: an active game keeps its socket busy, so the sleep only ever happens *between*
sessions. The first player to arrive on a Sunday waits; nobody waits mid-game.

**Games live in memory** (`SessionStore`, `sessions.py`) with a TTL and no persistence, so a sleep or
a redeploy drops a game in progress. Also not fatal — MON-704's save-to-file and MON-714's load flow
already exist — but it is a real property of this deployment and not an oversight. Whether an online
game should survive a restart is a MON-901 design question, and it should be answered with a
measurement of how often this actually bites rather than in advance.

### 6.3 A 404 that is not your 404

Worth recognising on sight, because it sends you looking in the wrong place. When Render's edge has
no instance to route to, it answers **`404 Not Found`** — not a 502, not a 503 — with:

```
x-render-routing: no-server
```

A real answer from the application carries `x-render-origin-server: uvicorn` and an `rndr-id`
instead. So the test is the *header*, not the status: `curl -D -` and look at which one came back.
This matters because the first deploy of this service looked exactly like a routing bug — `/boards`
answered, `/health` 404'd — when in fact the app was fine and simply was not running most of the
time.

The other tell is **latency**. A sleeping free instance makes you *wait* (~a minute) and then
answers. An instant 404 means the edge did not even try, which means no healthy instance existed —
a crash loop, not a cold start.

The first deploy had one, and the cause was in the start command. `uv run` syncs the environment
before running anything, and `dev` is a default dependency group — so `uv run uvicorn` undid the
build's `--no-dev` on every boot, reinstalling pytest, mypy, ruff, hypothesis and mutmut into a
512 MB instance before uvicorn could bind the port. The health check timed out, Render restarted it,
and it did the same thing again. Two requests in fifteen got through. The fix is to run the venv's
interpreter directly; nothing at runtime needs uv.

### 6.4 The setting that will not start the server

`KESEF_CORS_ORIGINS` **must be a JSON array**, and this is worth its own paragraph because the
failure looks like something else:

```
KESEF_CORS_ORIGINS='["https://guyflenner.github.io"]'   # correct
KESEF_CORS_ORIGINS='https://guyflenner.github.io'       # SettingsError, process never starts
```

`Settings.cors_origins` is a `tuple[str, ...]`, and pydantic-settings parses complex types as JSON.
Given a bare URL it raises at import time — so the process dies before it can serve `/health`, and a
health-checked deploy that never comes up reads as "still building". The blueprint has the right form
already; this only bites if somebody edits it in Render's dashboard.

The origin has to be there at all because the page is served from `github.io` and the API answers
from `onrender.com`: every call is cross-origin.

### 6.5 What is deliberately not done yet

The web build has a transport switch already — `VITE_ENGINE=local` selects the in-browser engine, and
any other value selects the real API client. What it does **not** have is a way to point that client
at another origin: `ApiClient`'s `DEFAULT_BASE_URL` is `/api`, relative, which assumes the API and
the page share a host. They will not.

So a `VITE_API_URL` is the next change, and it is deliberately not in this commit: it wants the real
service URL to be written against and tested with, rather than a guess at what Render will name it.

---

**Owner**: Guy Flenner · **Items**: MON-805 (§1–5), MON-901 (§6)

# Action prominence, and what the property card is for

**Written**: 2026-08-01 · **Owner feedback**: 2026-07-31 · **Touches**: `panels/ActionBar.tsx`,
`panels/PlayerDossier.tsx`, `theme/actions.ts`, `theme/prominence.ts`, `game/GameScreen.tsx`

Two reports from the owner, one root cause, and one decision each. This file exists because the
thing being changed — the action bar's "render the engine's list verbatim" property — was written
down as a deliberate invariant, and a change to it that is not argued in writing will be reverted by
the next person who reads that docstring.

---

## 1. The problem, stated precisely

### 1.1 What the owner saw

> "משכן" (`mortgage_property`) is rarely used and yet sits directly under the roll-dice button.
> "הצעת עסקה" (`propose_trade`) has the same problem.

### 1.2 What is actually happening

The action bar renders `GameView.legal_commands` in the engine's order. That order is
`legality.py`'s `_sort_key`:

```python
return (command.kind, command.player, detail, variant)
```

**`command.kind` is a string, so "the engine's order" is alphabetical by kind.** That is exactly
right for the engine — goldens must not flap, and a deterministic order is the cheapest way to get
that — and it is a coincidence, not a ranking, by the time it reaches a six-year-old. Worked
through for the two phases where a player spends most of the game:

| Phase | `legal_commands`, in the engine's order |
|---|---|
| `AWAITING_ROLL` | `build_house`, `mortgage_property`, **`roll_dice`**, `sell_house`, `unmortgage_property` |
| `AWAITING_END_TURN` | **`end_turn`**, `mortgage_property`, `sell_house`, `unmortgage_property` |

So the owner's report is if anything understated: before the dice are thrown, "mortgage a property"
is offered *above* the only move that starts the turn, because `m` precedes `r`. The single most
important control on the screen is third, and it is third for a reason that has nothing to do with
the game.

`propose_trade` is a different mechanism with the same symptom. `legality.py` never enumerates it
(the draft space is unbounded — the ADR-005 exception), so it is not a chit at all: it is a
standalone `<button>` in `GameScreen.tsx`, sitting immediately below the bar at the full width of the
column, with the same weight as the bar itself and no icon. It reads as the *fifth* move and it is
the one nobody makes.

### 1.3 The invariant that must survive

`ActionBar.tsx`'s docstring:

> `commands` is `GameView.legal_commands`, rendered **verbatim**. There is no `filter`, no `sort`,
> no `slice`, no `disabled` … Nothing is dropped, nothing is reordered across kinds.

That property is not fussiness. It is what makes "the disabled state never lies" free rather than
vigilant: the absent button *is* the mechanism, so the component cannot develop a notion of
importance that hides a legal move. Any fix has to keep the guarantee — **every command the engine
offered is reachable and operable** — while giving up the letter of it, which is *DOM order equals
array order*.

---

## 2. Options weighed

### (a) Reorder inside one row by static prominence

One list, sorted by a static per-kind rank. `hints.ts` already has the table this would need
(`HINT_ORDER`, seventeen kinds from "the thing you are here to do" to "the thing you do when nothing
is left"), so the implementation is four lines.

**For.** Cheapest possible change. Fixes the literal complaint: `roll_dice` goes to the top.
No new affordance, no new copy, no new a11y surface, nothing can be hidden because nothing folds.

**Against, and this is what sank it.**

1. **It fixes ordering and not prominence.** Mortgage moves from row two to row four of four. It is
   still a full-width, full-weight chit in the primary rail, still competing for the same eye. The
   owner's word was *prominent*, not *first*.
2. **A rank is invisible.** A player cannot tell that the bar is sorted, so they cannot use the
   sort. Two labelled zones teach the distinction ("this is what the game wants; this is your
   estate") on every turn; a silent sort teaches nothing, and the audience includes people learning
   the game.
3. **It would make `HINT_ORDER` load-bearing twice, for two different questions.** That table
   answers *which single decision is in front of you* — it is read once, to pick one command to
   point at, and its errors cost a poor suggestion. Reusing it to lay out the bar makes every entry
   a layout decision too, and the two questions genuinely disagree: `HINT_ORDER` ranks
   `sell_house`/`mortgage_property` *behind* `end_turn` and `cancel_trade`, which is right for
   "what should I suggest" and wrong for "where does this live" (during `DEBT_SETTLEMENT`, selling
   is the whole point). Coupling them means one table cannot be corrected without regressing the
   other.

Rejected — but see §3.3: the *grouping* is deliberately a new, coarser table for reason 3, and the
document says so rather than duplicating `HINT_ORDER` silently.

### (b) Two labelled zones

The bar splits into "what the game is waiting for" and "your estate", each with its own heading, in
that order. Within each zone the engine's order is untouched.

**For.** Prominence becomes *position plus a label* rather than position alone, which is the channel
a learner can actually read. The split is a real distinction in the rules — `phases.py` calls one
half `PORTFOLIO_PHASES` for a reason, and portfolio actions are the ones that do not wait for your
turn — so it is a boundary players already have a mental model for. Nothing folds, so nothing can
be hidden, and no focus can be lost.

**Against.** Row count is unchanged. On a phone in `AWAITING_ROLL` the bar is still five rows and
two headings, and the dossier and the log are still below the fold. It demotes mortgage without
decluttering.

### (c) A disclosure for the portfolio actions

The estate zone collapses behind one labelled, keyboard-operable summary showing how many moves are
inside.

**For.** This is the only option that actually shortens the bar: `AWAITING_ROLL` becomes *"Roll the
dice"* plus *"Your estate — 4 moves"*. Two rows. The disclosure pattern is already in this file
(`CommandGroupDisclosure` for four `build_house` commands) and already in the dossier
(`<details>` around the deed list, for the same complaint about the same column), so it costs the
player no new vocabulary.

**Against, and each of these is a hard constraint on the implementation rather than a reason to
reject.**

1. **A collapsed zone can hide the move that matters.** During `DEBT_SETTLEMENT`, mortgaging and
   selling *are* the game; a static demotion that ignores the phase turns a UX polish into a
   correctness bug ("the engine offered me a way out and the UI folded it away").
2. **The hint can point into a closed zone.** Solved once already for the collapsed command group:
   the badge propagates to the affordance that hides it.
3. **Focus can fall to `<body>`** when a control unmounts. This has bitten this repo twice.

### (d) Move the portfolio actions out of the bar and onto the dossier

Build, sell, mortgage and unmortgage act on a specific square, and the dossier already lists every
square the player owns, with its houses and its mortgage flag.

**For.** It is the most *semantically* right answer of the four. "Mortgage" is a verb about a deed,
and putting the verb on the deed removes the whole "which of my four streets" step that
`CommandGroupDisclosure` exists to handle. It empties the bar down to genuine turn flow.

**Against, and this is what limited it to a part of the change.**

1. **The dossier is a public readout for any seat, on anybody's turn** (spec §5.2 — holdings are
   public, and there is deliberately no per-seat gating). Putting *commands* on it means either
   showing another player's card with actionable buttons on your holdings, or introducing the
   per-seat branch that card has been carefully kept free of. It also has a `compact` mode used
   three-up in the compare tray, and three cards' worth of live command buttons in a horizontal
   rail is a worse bar than the bar.
2. **The dossier would have to match commands to squares.** `legal_commands` is a flat list; a
   deed row would have to ask "is there a `mortgage_property` for tile 6 in this list?". That is a
   lookup, not a rule — but it is a lookup that *looks* exactly like the rule it must never become
   (`if !property.mortgaged`), and the file whose docstring opens "not one number on this card is
   computed" is the worst place in the codebase to put it.
3. **It cannot host `propose_trade` either**, which is not a command in the list at all.

Rejected for the tile-scoped commands. **Adopted for `propose_trade`**, where every objection above
is absent: it is one affordance, it is not a command, it needs no square, and it opens a panel that
does its own validation.

---

## 3. What was chosen

**(b) + (c) for the commands, and (d)'s reasoning for the trade affordance**, with prominence that
follows the phase.

### 3.1 The shape

```
┌ Moves ─────────────────────────────────┐
│ WAITING ON YOU                         │   ← <h3>, always open, engine's order
│  [🎲 Roll the dice]                    │
│                                        │
│ + YOUR PROPERTIES · 4 moves            │   ← <h3><button aria-expanded>
│    …build / sell / mortgage / redeem…  │      open when the phase makes it the point
└────────────────────────────────────────┘
```

- A zone renders only when it holds commands, and **when only one zone is occupied the bar is a
  flat list with no zone headings at all** — exactly today's rendering. So the purchase decision,
  the auction and the trade review, which offer no portfolio commands, look identical to before.
  Zoning appears precisely in the phases the owner was complaining about.
- The estate zone is a disclosure. It is a real `<button aria-expanded aria-controls>` inside an
  `<h3>`, so it is one Tab stop, it is announced as a collapsed group, it is reachable by heading
  navigation, and it carries the count of what is inside.
- **The zone starts open when the phase makes the estate the point**, from a static table
  (§3.4). It never closes itself — see §3.5.

### 3.2 The new property, as precisely as the old one

Stated in the docstring and tested:

> `commands` is rendered **whole**: every element appears exactly once, in the engine's relative
> order *within its zone*, and every one is operable — clickable, keyboard-reachable, and delivered
> to `onCommand` by identity. What the bar now decides is **placement**: which of two labelled zones
> a chit is filed under, and whether the second zone begins expanded. Both answers come from static
> tables keyed on the engine's own vocabulary — `ACTION_THEME[kind].zone` and
> `PHASE_EMPHASIS[phase]` — evaluated against nothing. There is still no `filter`, no `sort`, no
> `slice`, no `disabled`, no comparison of a figure against a figure, and no code path that
> constructs a command. A wrong entry in either table can move a chit or leave a zone folded; it
> cannot remove one, and `ActionBar.test.tsx` proves that over seven phases including a
> debt-settlement position by clicking every chit and comparing the delivered objects against the
> input by identity.

The distinction that carries the weight: **the old property was about DOM order; the new one is
about the set and its operability.** Order was never the thing worth guaranteeing — it was a proxy
for "nothing was dropped", and the proxy has been replaced with the assertion itself.

### 3.3 Why a new table and not `HINT_ORDER`

`hints.ts` was read first, and its *reasoning* is reused rather than its table:

- It ranks seventeen kinds; this needs a two-valued classification. A seventeen-entry total order
  where two buckets are wanted is fifteen decisions nobody will maintain.
- Its `terminal`-last invariant is a claim about **advice**, not layout: `declare_bankruptcy` sorts
  last there and belongs in the *flow* zone here, because during `DEBT_SETTLEMENT` it is one of the
  two answers the game is waiting for.
- Its order is deliberately *not* phase-aware ("what decision is in front of you" is answered by
  the command set, which the engine already narrowed). Placement has to be phase-aware, because
  `RAISING_PHASES` exist.

So `zone` goes where the other static per-kind presentation metadata lives — as a field on
`ACTION_THEME`, under the same `Record<CommandKind, …>` coverage gate that makes an unthemed new
command a compile error. Two tables, one per question, each cheap to correct without touching the
other.

### 3.4 Phase emphasis, and why reading the phase is presentation

`PHASE_EMPHASIS: Record<Phase, ActionZone>` (in `theme/prominence.ts`) answers one question: *when
this phase is live, which zone is the point?* It is `"portfolio"` for `debt_settlement` and
`auction`, `"flow"` for the other nine.

This mirrors the engine's `RAISING_PHASES` and does not import it. The line, which is the same one
`presentation.ts` draws for Kids Mode:

- Reading a projected field to decide **how to draw** is presentation. `presentationFor(ruleset)`
  already reads four.
- Reading one to decide **what may be sent** is a rule, and would be a bug.

`PHASE_EMPHASIS` is on the first side of that line by construction: its output is a boolean handed
to `useState` as an *initial* value. The strongest argument that this is safe is the failure mode —
if the table were wrong in every entry, the estate zone would always start folded, and every command
in it would still be present, labelled, focusable and operable, two keystrokes away. There is no
value of this table that can make a legal move unreachable. `Record<Phase, …>` means a new phase in
the engine is a TypeScript error here rather than a silent `"flow"`.

Both raising phases are emphasised, not only the one the brief required. `DEBT_SETTLEMENT` is
obvious. `AUCTION` is included because the engine's own reason for opening sale and mortgage there
is "the bidder who needs to fund a bid" (`phases.py`) — a bidder short of cash with the estate
folded away is the §3.1 failure with a different name.

### 3.5 The three a11y commitments, and how each is met

| Risk | Answer |
|---|---|
| Focus falls to `<body>` when the zone collapses | The zone is collapsed **only by the player**, and the only control that collapses it is its own summary, which already holds focus. Programmatic emphasis is monotonic: the effect opens the zone and never closes it, so a phase change cannot unmount a focused chit. Escape inside the zone closes it and returns focus to the summary — the same handler `CommandGroupDisclosure` uses. |
| The hint points into a closed zone | The badge propagates to the summary, exactly as it propagates to a collapsed command group's toggle, and the member keeps its own badge once revealed. Tested. |
| Nothing may be disabled | Nothing is. There is no `disabled` and no `aria-disabled` in the file, and the existing test that asserts that over every button still passes — a collapsed zone is *folded*, which is a different thing from unavailable, and it says so with `aria-expanded`. |

Targets: the summary carries `.target`, so it inherits the 44 px floor and Kids Mode's 56 px from
`data-comfort` on the chrome, like every other control. Kids Mode gains nothing new: with
`mortgages_enabled: false` the engine offers no mortgage command, so in a kids game the estate zone
holds at most `build_house`/`sell_house` and usually collapses to one row — strictly less on screen
than before, and `kids.spec.ts`'s "no mortgage affordance anywhere" claim is untouched.

### 3.6 `propose_trade`

Moved out from directly under the bar to below the property card, and given the `swap` glyph so it
has the icon-and-text pair every chit has had since `ACTION_THEME` landed. It stays a `GameScreen`
affordance — the bar never gains a slot for non-commands, because a bar that can render something
the engine did not offer is precisely the thing §1.3 forbids, whoever supplies the node.

Placement is (d)'s argument at the level it survives: a trade offers things the card above it just
listed. It is *after* the card rather than inside it, so it makes no claim about the seat being
shown — the builder picks its own counterparty.

### 3.7 Deliberately rejected

- **An overflow "⋯" menu.** The pattern hides labels behind a glyph with no name, and the audience
  includes pre-readers. It also has no good open-by-default story for `DEBT_SETTLEMENT`.
- **Sorting the bar globally by prominence** (option (a) alone) — §2(a).
- **Command buttons on the dossier's deed rows** — §2(d).
- **A `portfolioExtras` slot on `ActionBar`** so the trade button could sit inside the estate zone.
  Attractive: it is where a player would look. Rejected because the bar's whole value is that it
  *cannot* show a thing the engine did not offer, and a slot re-opens that by delegation. §3.6.
- **Opening the estate zone whenever it holds the hinted command.** The hint is only marked when
  hints are prominent, which is a kids game, which is where the shorter bar helps most — a zone
  that flew open on every hint would be a zone that is never folded for the audience it was folded
  for. The badge is the answer, and it is the answer the collapsed command group already uses.
- **Keeping the zoning even when one zone is empty.** Two headings over one button is scaffolding
  the player has to read past. §3.1.

---

## 4. The property card: only what was bought

### 4.1 The report

> The player's property panel shows every colour group, including ones the player owns nothing in.
> Should it show only what was actually purchased?

Yes. Ten bands — eight colour sets plus railroads and utilities — of which a new player holds none
and a mid-game player typically holds three. `PlayerDossier.tsx`'s own comment defended it:

> `group_holdings` in the order the server sent it — all eight colour groups, always, which is what
> keeps two dossiers side by side aligned in the compare case. Not sorted, not filtered: "0 of 3" is
> real information about a set that is still wide open.

Both halves of that are true and neither survives contact with the column it lives in. The card sits
in a 22 rem aside above the event log; the deed list was already folded behind a `<details>` in
response to *this same complaint* ("the card left no room for the history"). Seven rows of zeros
inside the fold push the three rows that matter below it — worst on a phone, worst for a child, and
worst exactly when the player has enough property for the card to be worth opening.

The "wide open set" argument is answered by the board. The board shows all forty squares, every
colour band, and who owns what, at all times; it is the *authoritative* answer to "what is still
available", and it is the larger, more legible one. The dossier answering the same question worse is
not redundancy, it is noise.

The alignment argument is real and is outweighed: aligning ten rows of zeros is aligning noise. What
a player compares in the tray is holdings, and the four figures — cash, net worth, squares, jail
cards — are a fixed grid that stays aligned whatever is below it.

### 4.2 Decision

- The deed list shows a group row when the player **holds something in that set** —
  `group_holdings[i].owned > 0`, the projection's own count, read and never computed — **or** when a
  deed was filed under it. The `|| deeds.length > 0` half is not belt-and-braces: it is the same
  argument the existing `others` computation makes, that losing a holding is a worse failure than
  showing one without a fraction, so no square can be dropped even if the roll-up and the board
  disagree.
- **The completion counts and the "Complete set" badge stay** on the sets they do hold. That is the
  teaching moment — `2 of 3` with two pips inked is how a child learns what building requires — and
  it is exactly the figure that is meaningless at `0 of 3`.
- **The full set stays reachable**, behind a nested, labelled, closed-by-default disclosure: *"Sets
  with no properties"*. Planning value is genuinely lost otherwise — "which colours are still
  completely untouched" is a question a player asks around turn ten, and answering it by counting
  the board is worse. It is one keystroke, it holds its own state, it is exposed as an expandable
  group, and it is findable by in-page search while closed. One row of cost for the case where the
  card is doing nothing else.

Same mechanism, same reasoning, one level deeper — which is also why it is a native `<details>` like
its parent and not a hand-rolled toggle.

### 4.3 What did not change

No figure is computed. `owned`, `total`, `complete`, `houses`, `mortgaged_count` are still read from
`GroupHoldings`; the only new expression is `owned > 0`, which is a *presence* test on a projected
count and not a re-derivation of any claim the card makes. In particular `complete` is still the
engine's `owns_whole_group`, never `owned === total`, and the test that feeds the card a
`group_holdings` where those two disagree in both directions still passes unchanged.

---

## 5. How "nothing became unreachable" is proved

`ActionBar.test.tsx`, `describe("nothing the engine offered can become unreachable")`:

For each of seven representative positions — `awaiting_roll`, `awaiting_end_turn`,
`awaiting_purchase_decision`, `jail_decision`, `auction`, `debt_settlement`, `trade_review`, the
last four built to the shape `legal_commands` has when that phase is live, and the
debt-settlement one holding sell/mortgage/trade/bankruptcy together — the test:

1. renders the bar with that command list and that phase;
2. opens every affordance reporting `aria-expanded="false"`, repeatedly, until none is left;
3. asserts the number of rendered command chits equals the number of commands;
4. **clicks every one of them**, answering any confirm dialog, and asserts the set of objects
   delivered to `onCommand` is the input set compared by identity.

Step 4 is the one that earns its keep. Counting chits proves presence; clicking them proves
*operability*, which is what "reachable" has to mean — and comparing by identity rather than by
shape is what makes a fabricated or re-created command fail the test, the same reason `hinted` is
compared by identity.

Deleting the zoning leaves it green (it is a claim about the set, not the layout). Deleting a zone's
`<ul>`, mis-typing a `zone` value so a kind lands nowhere, or forgetting to render a zone's members
turns it red at step 3 or 4.

---

## 6. Amendment (MON-724): the estate zone and the move that had no signal

**Owner report, 2026-08-05**: *"when I get a complete series of streets, how can I purchase houses? I
don't see a button."*

### 6.1 What was actually on screen

Nothing was broken below the presentation layer, which is worth stating first because it is the
expensive thing to get wrong. `legality.py` was offering `BuildHouse` for every square in the group,
`transport.view` was passing the tuple through unaltered, `useGame` was handing it over verbatim, and
`ActionBar` was rendering all of it. Reproduced by rendering the bar with the legal set an owner of a
complete light-blue group actually has in `AWAITING_ROLL`, the buttons present on arrival were:

```
[🎲 Roll the dice]
+ YOUR PROPERTIES · 6 moves          ← aria-expanded="false", 11px, opacity 70
```

Reaching a build took **three presses** — the zone fold, then the collapsed `build_house` group, then
the street — and neither of the first two contained the word "build". §3.4's safety argument ("a wrong
entry can only leave a labelled, one-keystroke disclosure folded") was sound and still is. What it did
not anticipate is that *one keystroke away is not the same as discoverable* when the player does not
know the move exists yet, and the player who has just completed their first colour group is by
definition in that position.

### 6.2 Why the phase table could not fix this on its own

`PHASE_EMPHASIS` answers "the estate is the only way out of this position", which is why it names the
two raising phases and nothing else. Completing a colour group is **not a phase** — it is a fact about
the legal set, and there is no phase to key it on. `AWAITING_ROLL` is the same phase whether the player
owns nothing or has just completed Mayfair.

### 6.3 What changed

Two entries, in the two tables that already existed for this class of decision:

| Table | Entry | Effect |
|---|---|---|
| `prominence.ts` → `GROWTH_COMMANDS` | `build_house` | The estate zone **arrives open** when a build is in the legal set, whatever the phase says |
| `actions.ts` → `NEVER_COLLAPSED` | `build_house` | Builds render **one chit per street** instead of collapsing behind a count |

Three presses become one, and the words "Build a house" and the street's name are on screen the moment
the group is completed:

```
[🎲 Roll the dice]

− YOUR PROPERTIES · 6 moves
   [🏠+ Build a house]  Oriental Avenue
   [🏠+ Build a house]  Vermont Avenue
   [🏠+ Build a house]  Connecticut Avenue
   [📄− Mortgage · 3 squares]
```

### 6.4 Why building alone, in both tables

The exemption is one kind wide in both, and the boundary carries the whole argument — a second entry
in either would undo MON-711.

Building is the only portfolio move that **creates** rather than raises. It is the point of collecting
a complete group, and it becomes legal at a moment the game gives no other signal for: a deed changes
hands and nothing on the screen says "you may now build". Every other portfolio kind is either
available from the first deed (`mortgage_property`) or a response to a position the phase table already
covers (`sell_house`, `unmortgage_property` while raising). Putting one of those in `GROWTH_COMMANDS`
would emphasise the estate on nearly every turn, which is exactly the clutter this document set out to
remove.

`NEVER_COLLAPSED` has a real cost and it is accepted rather than denied: a player holding three
complete groups is offered a build on every square at the group minimum, so the estate zone can reach
nine rows late in a game. The rows are the *point* of that position — a player with three complete
groups is a player who is building — where nine mortgage rows would be noise. If it proves too dense in
play, the correction is a threshold in `groupCommands`, not a removal of the entry.

### 6.5 The invariant, unchanged

Both are placement tables, evaluated against the engine's own vocabulary and nothing else. Their
answers reach one `useState` initial value and one `collapsible` boolean. **Neither can add, remove,
filter, reorder across kinds, or disable a command**, and §5's reachability suite — which opens every
fold and clicks every chit, comparing delivered objects to the input set by identity — passes unchanged
over all seven positions. What is new is a suite that asserts the *opposite* direction for one kind:
`describe("a completed colour group announces itself")` renders the position above and requires the
three streets to be pressable **with no gesture at all**, which is a claim no reachability test can
make.

`prominence.test.ts` additionally pins the boundary from the other side: every portfolio kind *except*
building, all at once, must still leave the zone folded.

### 6.6 Why you cannot build is never said — closed by MON-725

The absent button is the mechanism (§1.3), and it is the right mechanism — but it is silent. A player
who has a complete group and is ₪40 short of a house sees no build button and no reason, which is the
same screen as a player whose group is mortgaged, and the same screen as one who does not have the
group at all. MON-723 already wrote the sentence this wants — `error.insufficient_funds` now reads
"Not enough cash — that costs {{required, money}} and you have {{available, money}}" — and nothing can
currently trigger it for a build, because a command that is not offered is never sent and so is never
rejected.

The architecturally clean route exists: `POST /validate` returns `LegalityView{legal, reason_key,
params}`, which is how `TradeBuilder`'s seal explains a refusal without owning a rule.

**That is what MON-725 built**, as `panels/SquareBuild.tsx`, on the square-detail panel the board
already opens — the surface `SquareRent` (MON-420) established for "tell me about this square", and
the one a player reaches by the route the owner described: find the city, find the street.

Open a street somebody owns and the panel now says either *"A house can go here"* or the engine's own
refusal — **"Not enough cash — that costs ₪100 and you have ₪60"**, *"You need the whole Tel Aviv set
before you can build"*, *"The bank has run out of houses"*. Five of `_build_house`'s checks, none of
them re-implemented, and the group named through the same `groupLabel` the dossier and the log use.

Three things worth knowing about it:

- **It asks; it does not decide.** There is no `if cash < cost` in the component and there could not
  be — it does not know what a house costs. The one condition it evaluates is *which square to ask
  about*: a `property` that somebody owns, both projected fields.
- **It constructs a command, which `ActionBar` may never do.** That is exactly ADR-005's exception and
  the whole distinction: a constructed command that is **sent** is the UI deciding legality; one that
  is only ever **validated** is the UI asking a question. `SquareBuild` has no `onSend` prop, so the
  difference is structural rather than remembered.
- **A stale answer cannot be shown.** Two guards, and each is pinned by a test that fails without it:
  the tile guard catches a fast answer for the square you just left, and the cleanup flag catches a
  square that is *traded* while you are looking at it — same tile, different owner, so a tile
  comparison alone would pass an answer about the previous owner.

The absent chit is unchanged and remains the mechanism. This adds a second channel that *explains*
rather than a disabled button that lies.

---

## 7. Amendment (MON-726): the bar stops being verbatim, and says why

§1.3 stated the invariant this document exists to protect:

> `commands` is `GameView.legal_commands`, rendered **verbatim** … There is no `filter`.

That is still true of `ActionBar`. It is **no longer true of the screen**, and this section is the
argument, because a change to that sentence which is not written down will be reverted by the next
person who reads it.

### 7.1 What flattening exposed

MON-724 was right and it made an older problem visible. `legal_commands` answers for every seat that
*may* act, not for the seat being waited on (MON-204, and a real rule — the estate is open in any
portfolio phase). So a table where two other seats held complete groups produced:

```
[🏠+ Build a house]  Mediterranean Avenue     ← yours
[🏠+ Build a house]  Baltic Avenue            ← Dan's
[🏠+ Build a house]  Oriental Avenue          ← a bot's
```

Identical rows spending three different people's money. While builds collapsed behind one affordance
this was one ambiguous row; flattened, it is three, and the one belonging to a bot is a move nobody
would ever mean to make.

### 7.2 The two answers, because there are two questions

**A bot's estate is not offered.** `bots.py` plays a bot's portfolio for whichever seat the engine is
waiting on. A chit that builds for it is not a move a human is choosing between.

**A human's estate is offered, and says whose.** "Any mix of six seats, all on one screen" is the
product. Taking another person's moves off the bar would remove a rule the engine deliberately grants
— and MON-204's whole point is that you need not wait for your turn to build.

Both live in `game/seatedCommands.ts`, not in `ActionBar`, and the split is the same one §2(d) drew
for a different reason: the bar's guarantee is about the set it is *given*, so keeping the narrowing
outside it lets §5's reachability suite go on meaning what it says.

### 7.3 Why this is not the start of a slope

The objection to a filter has always been that a UI which can drop a command can develop opinions
about legality. Two bounds prevent that here, and each is tested against the **contract's own list of
kinds** rather than a sample, so a new command kind cannot slip past either:

1. **Turn flow is never filtered**, for any seat. The asymmetry is the argument: hiding an estate move
   costs a player a convenience, and hiding the move the game is waiting on costs them the game. So
   the failure this could have is bounded at "mildly annoying" by construction.
2. **No `portfolio` kind is ever dropped for a human seat.**

The predicate is `is_bot`, **read from the projection** rather than re-derived from
`kind.bot_level` — the engine owns what makes a seat a bot, and a second copy of that rule in the web
package is exactly the defect this document keeps arguing against. A test feeds a self-contradicting
seat to pin which field is authoritative.

### 7.4 What this does not do

Seat *ownership* still does not exist. Two browser windows on the same game can act for either
player, because nothing anywhere knows which seat a connection speaks for (`DEPLOYMENT.md` §6.6).
This settles who the moves are offered to on **one shared screen**, which is the mode the product is
built around; the online question is still open and is MON-901's.

---

## 8. Amendment (MON-753): the estate belongs to the seat in play

§7 answered "whose moves reach the bar" by **labelling**: a bot's estate was dropped, another
human's was offered with their name against it. Played, that was still confusing.

> "When first player has city1 and player2 has city2, the ability to purchase houses is presented for
> both — it causes confusion. Only present buy-house on the owner's turn, and only his series."
> — owner, 2026-08-07

### 8.1 What changed

One condition. `movesAtThisScreen` used to drop a portfolio command when its seat was a **bot**; it
now keeps one only when its seat is the **one in play**:

```
portfolio command survives  ⟺  seat in play is a human  ∧  command.player is that seat
```

That subsumes the bot rule — a bot is never a human seat in play — and adds the case the label was
trying to cover with words. Nothing else moved: `actingFor`, the zoning, the flattening and the fold
are untouched.

### 8.2 Why a label was not enough

A name on a row is a weaker signal than the row not being there. Under §7 a player holding a complete
group saw their three streets *and* another player's three, distinguished only by a name in 12px on
the second line — six rows where two players' money was one mis-tap apart. The failure mode of a
label is silent; the failure mode of an absent row is a player asking "where is it?", which is a
question with an answer.

### 8.3 What this gives up, and why it is written down rather than discovered

**The engine allows building off-turn and the screen no longer offers it.** `PORTFOLIO_PHASES` opens
the estate to every solvent player in any quiet phase — that is MON-204 and GAP G-5, a deliberate
reading of the printed rules — and this is the UI being narrower than the rules on purpose.

The trade: on one shared screen the turn comes round in seconds, so waiting costs a player almost
nothing, while the confusion cost them a mis-tap that spends somebody else's money. A player who
knows the printed rules is *not wrong* to expect otherwise, which is exactly why it belongs in this
document and in `seatedCommands.ts`'s docstring rather than in a diff nobody re-reads.

Reversing it is one condition wide, and the tests say which one.

### 8.4 Why the seat label survives the change

Because turn flow still reaches seats whose turn it is not, and those are the moments a player most
needs telling. `legality.py` puts `place_bid` / `withdraw_from_auction` on the **bidder**,
`declare_bankruptcy` on the **debtor**, and `respond_to_trade` / `cancel_trade` on the two sides of an
offer — none of which need be the current seat, because the interrupt phases exist *for* another
actor. `actingFor` names those, and only those. It is no longer reachable for an estate move, which is
the point.

### 8.5 The bound is unchanged and now matters more

**Turn flow is never filtered.** Under §7 that was belt-and-braces about bots; under §8 it is
load-bearing, because "not the current player" is now an ordinary thing for a *legal, waited-on* flow
command to be. The test asserts it over the contract's own list of kinds, for a seat that is
deliberately not in play — so no value of `players` or `currentPlayerId` can hide the move a game is
waiting on.

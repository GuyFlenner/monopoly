# How the Hebrew gender problem was solved without a native-speaker pass

**Written**: 2026-07-29 · **Supersedes**: `MON-501_HEBREW_WORKSHEET.md` (deleted) · **Status**: closed

This file exists because the decision it records is the kind that looks arbitrary a year later, and
because the reasoning generalises to the next language with grammatical gender.

## The problem

Hebrew conjugates the verb to its subject's gender. `רותי עבר` ("Ruti moved", masculine) is wrong to
every Hebrew speaker when Ruti is a woman, and wrong in a children's game is worse than absent. 45
catalogue keys named a player and hung a verb off them — every log line, every spoken announcement,
the auction's standing bid, the trade builder's two sides.

The original plan was for the owner to supply masculine/feminine pairs for all 45, selected at runtime
via i18next context from `grammatical_gender`. A worksheet was generated for that.

## Why that plan was dropped

Three things, in order of weight.

**1. `grammatical_gender` defaults to `"n"`.** `SetupScreen` seats a new player as neutral and the
pronoun picker is optional, so most seats in most games carry `n`. A gendered catalogue therefore
*still* needs a form with no gender in it — and that form is the one most players actually read. It
had to be written either way, which collapses the choice: writing it is the whole job, and the
masculine and feminine forms are an optional extra on top.

**2. Gender-free phrasing is the documented practice for Hebrew UI, not a workaround.** Google
Israel's localization project moved Hebrew interfaces off the masculine singular; the standard
technique is to choose constructions spelled the same for both genders, accepting slightly less
natural phrasing as the price. Hebrew has no agreement on a **noun**, so putting the noun in the head
position removes the problem rather than working around it.

**3. It removes a whole dimension from the code.** Selecting a form means every component that renders
a sentence about a player has to know that player's gender: `narration.ts`, `EventLogLines.ts`,
`AuctionPanel`, `TradeBuilder`, and the two context objects behind them. That is real plumbing, all of
it in service of a distinction the catalogue no longer draws. **No component knows a player's gender,
because there is no form to select between.**

## The technique, so the next one matches

Put the noun in the head position and let the person be the object of a preposition:

| English | Hebrew | what moved |
|---|---|---|
| `{{name}} moved to {{tile}}.` | `{{name}} — מעבר אל {{tile}}.` | verb → noun (`מעבר`) |
| `{{name}} bought {{tile}} for {{price}}.` | `{{name}} — קניית {{tile}} תמורת {{price}}.` | verb → noun (`קנייה`) |
| `{{payer}} paid {{owner}} {{amount}} in rent.` | `תשלום שכר דירה של {{amount}}: {{payer}} אל {{owner}}.` | both people become objects |
| `{{recipient}} turned down {{proposer}}'s trade.` | `הצעת {{proposer}} נדחתה על ידי {{recipient}}.` | subject becomes the *offer* |

A verb is kept only where its subject is a **thing** whose gender is fixed and known:

- money is plural — `{{amount}} נכנסו לקופה`
- an offer is feminine — `הצעת {{proposer}} נדחתה`
- a mortgage is feminine — `המשכנתא סולקה`

This is the same register English already uses in the log (`Turn 3 begins · Ruti`), so it costs less
here than it would in prose.

### Two rules it must obey

1. **Nothing inflects across an interpolation boundary** (G-F8). No `ל{{owner}}`, which renders
   `להבנק` where Hebrew wants `לבנק`, because the value arrives carrying its own definite article. Use
   standalone prepositions — `אל`, `על`, `בין … ובין` — or a leading `{{name}}:`. A *hyphenated*
   prefix is fine and is used where conventional (`ו-{{second}}`, `כ-{{minutes}}`, `ב-{{amount}}`):
   the hyphen does not change with the value. Enforced by
   `test_no_hebrew_word_is_glued_to_an_interpolation`.
2. **Placeholders are a subset of English's.** Dropping one only fails to show a value; naming one
   nothing supplies puts literal braces on screen. Enforced by
   `test_no_translation_names_a_placeholder_nobody_supplies`.

## What this is not

**Not a claim that the Hebrew is beyond improvement.** These 45 strings were written by a model, not a
native speaker, and the nominal register is deliberately plainer than a person would write. A native
pass would make some of them warmer. Nothing is *blocked* on that any more, which is the point — and
`grammatical_gender` still reaches the wire, so adding `_m`/`_f` forms later is additive: i18next
falls back to the gender-free key wherever a pair is absent, so a partial pass is safe.

**Not applicable to card text.** MON-506's 31 Chance / Community Chest cards are flavour prose, where
the plain register would be a real loss and where the English is doing work this technique cannot
preserve. Those stay on the English fallback until the owner supplies them.

## What it closed

`AWAITING_HEBREW` is gone, along with its rot tripwire. It began as nine frozensets covering ~270
keys; MON-501 emptied it in three passes. Both languages are now held to the same bar with nothing to
opt out of, and `cards` is the only remaining exemption (`ENGLISH_ONLY_CATALOGUES`, with its own
tripwire).

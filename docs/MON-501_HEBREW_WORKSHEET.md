# MON-501 — the Hebrew sentences that need you

**For**: Guy (owner) · **Written**: 2026-07-28 · **Blocks**: nothing else in M5

You chose option 2: you supply the sentences that need verb-gender agreement, I do the mechanical
rest. **The mechanical rest is done** — 225 keys are in `common.he.json` and the Hebrew build is
live. What is left is this list: **45 keys**, every one of which names a player.

## Why exactly these

Hebrew conjugates the verb to the subject's gender. `רותי עבר` is wrong to every Hebrew speaker, and
wrong in a children's game is worse than absent. Every row below **names a person and hangs a verb or
a possessive off them**, so there is no way to write it without knowing whether that player is
masculine or feminine.

Nothing else needed you, and an earlier count of 67 was wrong on two points worth knowing:

- **"You" is not a problem.** Once niqqud is off (your decision 4), `שלך` and `שלכם` read as either
  gender, so every "you"/"your" string — the confirm dialogs, the refusals, the hints — is already
  written and needs no pair.
- **A reason inside a sentence should be a noun.** `cash_reason.*` reads as a verb in English ("won
  an auction"), which would have to agree with whoever won. In Hebrew they are noun phrases
  (`זכייה במכירה פומבית`), so there is nothing to agree with.

## How to fill it in

Two forms per row. `grammatical_gender` already exists on `SeatConfig` and reaches the wire (your
decision 5), so i18next picks between them by context — no code changes needed from you.

```
"a11y.moved_male":   "{{name}} התקדם ל{{tile}}"
"a11y.moved_female": "{{name}} התקדמה ל{{tile}}"
```

Three rules that will save a re-do:

1. **Keep every `{{placeholder}}` spelled exactly as it is.** A test fails the build if a Hebrew
   string names a placeholder nothing supplies.
2. **Never glue a letter onto a `{{placeholder}}`.** `ל{{owner}}` produces `להבנק` instead of `לבנק`.
   If a preposition has to inflect, say so and I will add a field per form — that is defect G-F8.
   (A prefix with a hyphen, like `ו-{{second}}` or `כ-{{minutes}}`, is fine and already used.)
3. **No niqqud** (your decision 4).

Numbers and Latin names inside these sentences are safe now: bidi isolation went in with the
mechanical pass, so `{{amount}}` will not reorder its neighbours.

Where a sentence names **two** people, only the verb's subject needs the pair — the other name is
just a noun. Those rows are marked **two people**.

---


## narration (MON-411) — 6 keys

*spoken by the Announcer*

| # | key | English | placeholders |
|---|---|---|---|
| 1 | `a11y.cash_gained` | {{name}} received {{amount}}. | `{{name}}`, `{{amount}}` |
| 2 | `a11y.cash_paid` | {{name}} paid {{amount}}. | `{{name}}`, `{{amount}}` |
| 3 | `a11y.moved` | {{name}} moved to {{tile}}. | `{{name}}`, `{{tile}}` |
| 4 | `a11y.passed_go` | {{name}} passed GO. | `{{name}}` |
| 5 | `a11y.rent_charged` | {{payer}} paid {{amount}} in rent to {{owner}}. **two people** | `{{payer}}`, `{{amount}}`, `{{owner}}` |
| 6 | `a11y.turn` | It is {{name}}'s turn. | `{{name}}` |

## event log (MON-407) — 34 keys

*the written history panel*

| # | key | English | placeholders |
|---|---|---|---|
| 7 | `log.auction_ended` | {{name}} won {{lot}} for {{price}}. | `{{name}}`, `{{lot}}`, `{{price}}` |
| 8 | `log.bid_placed` | {{name}} bid {{amount}}. | `{{name}}`, `{{amount}}` |
| 9 | `log.bidder_withdrew` | {{name}} dropped out of the auction. | `{{name}}` |
| 10 | `log.card_drawn` | {{name}} drew a {{deck}} card. | `{{name}}`, `{{deck}}` |
| 11 | `log.cash_gained` | {{name}} collected {{amount}} for {{reason}}. | `{{name}}`, `{{amount}}`, `{{reason}}` |
| 12 | `log.cash_paid` | {{name}} paid {{amount}} for {{reason}}. | `{{name}}`, `{{amount}}`, `{{reason}}` |
| 13 | `log.debt_incurred` | {{debtor}} owes {{creditor}} {{amount}}. **two people** | `{{debtor}}`, `{{creditor}}`, `{{amount}}` |
| 14 | `log.debt_settled` | {{debtor}} settled {{amount}} with {{creditor}}. **two people** | `{{debtor}}`, `{{amount}}`, `{{creditor}}` |
| 15 | `log.dice_rolled_jail` | {{name}} rolled {{first}} and {{second}}, trying for doubles to get out of jail. | `{{name}}`, `{{first}}`, `{{second}}` |
| 16 | `log.dice_rolled_move` | {{name}} rolled {{first}} and {{second}} — {{total}} in all. | `{{name}}`, `{{first}}`, `{{second}}`, `{{total}}` |
| 17 | `log.dice_rolled_rent` | {{name}} rolled {{first}} and {{second}} — {{total}} — to work out the rent. | `{{name}}`, `{{first}}`, `{{second}}`, `{{total}}` |
| 18 | `log.game_ended` | {{name}} wins — {{reason}}. | `{{name}}`, `{{reason}}` |
| 19 | `log.left_jail_card` | {{name}} used a Get Out of Jail card. | `{{name}}` |
| 20 | `log.left_jail_doubles` | {{name}} rolled doubles and left jail. | `{{name}}` |
| 21 | `log.left_jail_fine` | {{name}} paid the bail and left jail. | `{{name}}` |
| 22 | `log.left_jail_time_served` | {{name}} served the full stretch and left jail. | `{{name}}` |
| 23 | `log.player_bankrupted` | {{name}} is out of the game — everything goes to {{creditor}}. **two people** | `{{name}}`, `{{creditor}}` |
| 24 | `log.property_acquired_auction` | {{name}} won {{tile}} at auction for {{price}}. | `{{name}}`, `{{tile}}`, `{{price}}` |
| 25 | `log.property_acquired_bankruptcy` | {{name}} took over {{tile}} from a bankruptcy. | `{{name}}`, `{{tile}}` |
| 26 | `log.property_acquired_purchase` | {{name}} bought {{tile}} for {{price}}. | `{{name}}`, `{{tile}}`, `{{price}}` |
| 27 | `log.property_acquired_trade` | {{name}} picked up {{tile}} in a trade. | `{{name}}`, `{{tile}}` |
| 28 | `log.rent_charged` | {{payer}} paid {{owner}} {{amount}} in rent for {{tile}}. **two people** | `{{payer}}`, `{{owner}}`, `{{amount}}`, `{{tile}}` |
| 29 | `log.sent_to_jail_card` | A card sent {{name}} to jail. | `{{name}}` |
| 30 | `log.sent_to_jail_three_doubles` | Three doubles in a row sent {{name}} to jail. | `{{name}}` |
| 31 | `log.sent_to_jail_tile` | {{name}} landed on Go To Jail and went straight there. | `{{name}}` |
| 32 | `log.token_moved` | {{name}} moved to {{tile}}. | `{{name}}`, `{{tile}}` |
| 33 | `log.token_moved_back` | {{name}} moved backwards to {{tile}}. | `{{name}}`, `{{tile}}` |
| 34 | `log.token_moved_passed_go` | {{name}} moved to {{tile}}, passing GO on the way. | `{{name}}`, `{{tile}}` |
| 35 | `log.trade_cancelled_proposer` | {{proposer}} took the trade offer back. | `{{proposer}}` |
| 36 | `log.trade_cancelled_system` | The trade between {{proposer}} and {{recipient}} was called off. **two people** | `{{proposer}}`, `{{recipient}}` |
| 37 | `log.trade_declined` | {{recipient}} turned down {{proposer}}'s trade. **two people** | `{{recipient}}`, `{{proposer}}` |
| 38 | `log.trade_executed` | {{proposer}} and {{recipient}} shook on a trade. **two people** | `{{proposer}}`, `{{recipient}}` |
| 39 | `log.trade_proposed` | {{proposer}} offered {{recipient}} a trade. **two people** | `{{proposer}}`, `{{recipient}}` |
| 40 | `log.turn_started` | Turn {{turn}} begins · {{name}} | `{{turn}}`, `{{name}}` |

## auction (MON-409) — 2 keys

*the auction panel*

| # | key | English | placeholders |
|---|---|---|---|
| 41 | `auction.standing_bid` | {{name}} holds the bid at {{amount}}. | `{{name}}`, `{{amount}}` |
| 42 | `auction.your_turn_to_bid` | {{name}}, it's your turn to bid | `{{name}}` |

## trade builder (MON-410) — 3 keys

*the trade builder*

| # | key | English | placeholders |
|---|---|---|---|
| 43 | `trade.between` | {{proposer}} offers {{recipient}} a trade **two people** | `{{proposer}}`, `{{recipient}}` |
| 44 | `trade.side_cash` | Cash from {{name}} | `{{name}}` |
| 45 | `trade.side_gives` | {{name}} gives | `{{name}}` |

---

## When you are done

Send them back in any form. I will put them in `common.he.json`, add the i18next gender context, and
delete `AWAITING_HEBREW` from `tests/test_locale_parity.py` — at which point the exemption mechanism
itself is gone and the parity check covers the whole catalogue.

**Still separately blocked**: MON-506, the 31 Chance / Community Chest card texts, which you chose to
leave on the English fallback.

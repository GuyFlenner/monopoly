# MON-501 — the Hebrew sentences that need you

**For**: Guy (owner) · **Written**: 2026-07-28 · **Blocks**: the Hebrew half of M5

You chose option 2: you supply the sentences that need verb-gender agreement, and I do the
mechanical rest. This is that list — **67 keys**, all of them written out below with their English
and their placeholders.

## Why these and not the other 203

Hebrew conjugates the verb to the subject's gender. `רותי עבר` is wrong to every Hebrew speaker,
and wrong in a children's game is worse than absent — so every sentence here either names a person
(`{{name}}`, `{{payer}}`, `{{owner}}`) or addresses one ("you", "your"), and a machine-plausible
masculine would put the error in front of a child rather than a translator.

The other 203 keys are labels, nouns and impersonal sentences with nothing to agree with. Those are
mine and are not in this document.

## How to fill it in

For each row, write **two** forms. `grammatical_gender` already exists on `SeatConfig` and
`PlayerState` and reaches the wire (your decision 5), so i18next selects between them by context —
you do not need to touch any code.

```
"a11y.moved_male":   "{{name}} התקדם ל{{tile}}"
"a11y.moved_female": "{{name}} התקדמה ל{{tile}}"
```

Three rules that will save a re-do:

1. **Keep every `{{placeholder}}` exactly as spelled**, including the ones you do not move. A test
   fails the build if English and Hebrew disagree on placeholders.
2. **Never glue a prefix or suffix onto a `{{placeholder}}`.** `ל{{owner}}` produces `להבנק`
   instead of `לבנק`. If a preposition has to inflect, tell me and I will add a separate field for
   each form — that is defect G-F8 and it is already live in one place.
3. **No niqqud** (your decision 4).

Where a sentence has *two* people in it (`a11y.rent_charged`, `log.rent_charged`,
`log.trade_executed`), only the **verb's subject** needs the pair — the other name is just a noun.
Those rows are marked **two people**.

---


## narration (MON-411) — 6 keys

*spoken by `<Announcer>` (aria-live)*

| # | key | English | placeholders |
|---|---|---|---|
| 1 | `a11y.cash_gained` | {{name}} received {{amount}}. | `{{name}}`, `{{amount}}` |
| 2 | `a11y.cash_paid` | {{name}} paid {{amount}}. | `{{name}}`, `{{amount}}` |
| 3 | `a11y.moved` | {{name}} moved to {{tile}}. | `{{name}}`, `{{tile}}` |
| 4 | `a11y.passed_go` | {{name}} passed GO. | `{{name}}` |
| 5 | `a11y.rent_charged` | {{payer}} paid {{amount}} in rent to {{owner}}. **two people** | `{{payer}}`, `{{amount}}`, `{{owner}}` |
| 6 | `a11y.turn` | It is {{name}}'s turn. | `{{name}}` |

## event log (MON-407) — 32 keys

*the written history panel*

| # | key | English | placeholders |
|---|---|---|---|
| 7 | `log.auction_ended` | {{name}} won {{lot}} for {{price}}. | `{{name}}`, `{{lot}}`, `{{price}}` |
| 8 | `log.bid_placed` | {{name}} bid {{amount}}. | `{{name}}`, `{{amount}}` |
| 9 | `log.bidder_withdrew` | {{name}} dropped out of the auction. | `{{name}}` |
| 10 | `log.card_drawn` | {{name}} drew a {{deck}} card. | `{{name}}`, `{{deck}}` |
| 11 | `log.cash_gained` | {{name}} collected {{amount}} for {{reason}}. | `{{name}}`, `{{amount}}`, `{{reason}}` |
| 12 | `log.cash_paid` | {{name}} paid {{amount}} for {{reason}}. | `{{name}}`, `{{amount}}`, `{{reason}}` |
| 13 | `log.dice_rolled_jail` | {{name}} rolled {{first}} and {{second}}, trying for doubles to get out of jail. | `{{name}}`, `{{first}}`, `{{second}}` |
| 14 | `log.dice_rolled_move` | {{name}} rolled {{first}} and {{second}} — {{total}} in all. | `{{name}}`, `{{first}}`, `{{second}}`, `{{total}}` |
| 15 | `log.dice_rolled_rent` | {{name}} rolled {{first}} and {{second}} — {{total}} — to work out the rent. | `{{name}}`, `{{first}}`, `{{second}}`, `{{total}}` |
| 16 | `log.game_ended` | {{name}} wins — {{reason}}. | `{{name}}`, `{{reason}}` |
| 17 | `log.left_jail_card` | {{name}} used a Get Out of Jail card. | `{{name}}` |
| 18 | `log.left_jail_doubles` | {{name}} rolled doubles and left jail. | `{{name}}` |
| 19 | `log.left_jail_fine` | {{name}} paid the bail and left jail. | `{{name}}` |
| 20 | `log.left_jail_time_served` | {{name}} served the full stretch and left jail. | `{{name}}` |
| 21 | `log.player_bankrupted` | {{name}} is out of the game — everything goes to {{creditor}}. | `{{name}}`, `{{creditor}}` |
| 22 | `log.property_acquired_auction` | {{name}} won {{tile}} at auction for {{price}}. | `{{name}}`, `{{tile}}`, `{{price}}` |
| 23 | `log.property_acquired_bankruptcy` | {{name}} took over {{tile}} from a bankruptcy. | `{{name}}`, `{{tile}}` |
| 24 | `log.property_acquired_purchase` | {{name}} bought {{tile}} for {{price}}. | `{{name}}`, `{{tile}}`, `{{price}}` |
| 25 | `log.property_acquired_trade` | {{name}} picked up {{tile}} in a trade. | `{{name}}`, `{{tile}}` |
| 26 | `log.rent_charged` | {{payer}} paid {{owner}} {{amount}} in rent for {{tile}}. **two people** | `{{payer}}`, `{{owner}}`, `{{amount}}`, `{{tile}}` |
| 27 | `log.sent_to_jail_card` | A card sent {{name}} to jail. | `{{name}}` |
| 28 | `log.sent_to_jail_three_doubles` | Three doubles in a row sent {{name}} to jail. | `{{name}}` |
| 29 | `log.sent_to_jail_tile` | {{name}} landed on Go To Jail and went straight there. | `{{name}}` |
| 30 | `log.token_moved` | {{name}} moved to {{tile}}. | `{{name}}`, `{{tile}}` |
| 31 | `log.token_moved_back` | {{name}} moved backwards to {{tile}}. | `{{name}}`, `{{tile}}` |
| 32 | `log.token_moved_passed_go` | {{name}} moved to {{tile}}, passing GO on the way. | `{{name}}`, `{{tile}}` |
| 33 | `log.trade_cancelled_proposer` | {{proposer}} took the trade offer back. | `{{proposer}}` |
| 34 | `log.trade_cancelled_system` | The trade between {{proposer}} and {{recipient}} was called off. **two people** | `{{proposer}}`, `{{recipient}}` |
| 35 | `log.trade_declined` | {{recipient}} turned down {{proposer}}'s trade. **two people** | `{{recipient}}`, `{{proposer}}` |
| 36 | `log.trade_executed` | {{proposer}} and {{recipient}} shook on a trade. **two people** | `{{proposer}}`, `{{recipient}}` |
| 37 | `log.trade_proposed` | {{proposer}} offered {{recipient}} a trade. **two people** | `{{proposer}}`, `{{recipient}}` |
| 38 | `log.turn_started` | Turn {{turn}} begins · {{name}} | `{{turn}}`, `{{name}}` |

## auction/trade (MON-409/410) — 12 keys

*the auction panel / trade builder*

| # | key | English | placeholders |
|---|---|---|---|
| 39 | `auction.above_ceiling` | The most you can bid is {{amount}}. | `{{amount}}` |
| 40 | `auction.ceiling` | Highest you can bid: {{amount}} | `{{amount}}` |
| 41 | `auction.confirm_whole_cash` | Bidding {{amount}} spends nearly everything you have. Bid it anyway? | `{{amount}}` |
| 42 | `auction.confirm_withdraw` | Dropping out is final — you cannot bid on this one again. Drop out? | — |
| 43 | `auction.floor` | Lowest you can bid: {{amount}} | `{{amount}}` |
| 44 | `auction.share_of_cash` | {{percent}}% of your {{cash}} | `{{percent}}`, `{{cash}}` |
| 45 | `auction.standing_bid` | {{name}} holds the bid at {{amount}}. | `{{name}}`, `{{amount}}` |
| 46 | `auction.warn_half_cash` | That is more than half of your money. | — |
| 47 | `auction.your_turn_to_bid` | {{name}}, it's your turn to bid | `{{name}}` |
| 48 | `trade.between` | {{proposer}} offers {{recipient}} a trade **two people** | `{{proposer}}`, `{{recipient}}` |
| 49 | `trade.side_cash` | Cash from {{name}} | `{{name}}` |
| 50 | `trade.side_gives` | {{name}} gives | `{{name}}` |

## panels (MON-405/406) — 4 keys

*the action bar and dossier*

| # | key | English | placeholders |
|---|---|---|---|
| 51 | `confirm.consequence.declare_bankruptcy` | You are out of the game. Everything you own goes to whoever you owe. This cannot be undone. | — |
| 52 | `confirm.consequence.decline_purchase` | The square goes up for auction instead. Anyone at the table can buy it, and it may go for less than you would have paid. | — |
| 53 | `confirm.consequence.withdraw_from_auction` | You will not be able to bid on this square again. | — |
| 54 | `confirm.title` | Are you sure? | — |

## rejections (MON-501) — 9 keys

*shown when the engine refuses a command*

| # | key | English | placeholders |
|---|---|---|---|
| 55 | `error.bid_above_ceiling` | The most you can bid here is {{maximum}}. | `{{maximum}}` |
| 56 | `error.jail_card_not_held` | You don't have that Get Out of Jail card. | — |
| 57 | `error.no_jail_card` | You don't have a Get Out of Jail card. | — |
| 58 | `error.not_buildable` | You can't build on this kind of square. | — |
| 59 | `error.not_in_jail` | You aren't in jail. | — |
| 60 | `error.not_owner` | You don't own this square. | — |
| 61 | `error.not_your_bid_turn` | It isn't your turn to bid. | — |
| 62 | `error.not_your_offer` | That isn't your offer. | — |
| 63 | `error.wrong_phase` | That isn't something you can do right now. | — |

## setup (MON-408) — 1 keys

*the setup screen*

| # | key | English | placeholders |
|---|---|---|---|
| 64 | `ruleset.max_jail_turns` | Turns you can sit in jail | — |

## board (MON-403) — 1 keys

*the board and its spoken square description*

| # | key | English | placeholders |
|---|---|---|---|
| 65 | `board.open_tile` | Open {{name}} | `{{name}}` |

## dice (MON-404) — 1 keys

*the dice tray*

| # | key | English | placeholders |
|---|---|---|---|
| 66 | `dice.reduced_motion_active` | Your device already asks for reduced motion. | — |

## app shell — 1 keys

*the two-screen chrome*

| # | key | English | placeholders |
|---|---|---|---|
| 67 | `status.offline` | Not connected to the table. What you see may be out of date. | — |

---

## When you are done

Send them back in any form — a list, a spreadsheet, a message. I will put them in
`common.he.json`, add the i18next gender context, and remove the corresponding entries from
`AWAITING_HEBREW` in `tests/test_locale_parity.py`, which is what turns the exemption off and the
parity check on.

**Still separately blocked**: MON-506, the 31 Chance / Community Chest card texts. You chose to
leave those on the English fallback for now.

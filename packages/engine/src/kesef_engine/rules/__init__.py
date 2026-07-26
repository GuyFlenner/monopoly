"""Rule implementations, one module per cohesive rule area.

The reducer in :mod:`kesef_engine.reducer` is a dispatcher; the rules themselves live
here so that no single file grows past the point where it can be reasoned about — and so
that "where does rent get calculated" has exactly one answer.

Planned modules (see docs/BACKLOG.md for the owning items):

============================  ==========================================================
``movement``   (MON-102)      dice, doubles, three-doubles-to-jail, passing GO, backwards
``purchase``   (MON-103)      list-price purchase, decline, ownership transfer
``rent``       (MON-104)      property tiers, full-group doubling, railroad and utility
                              rent, mortgaged properties charge nothing
``development``(MON-201)      build/sell, even-build rule, bank building shortage
``mortgage``   (MON-202)      mortgage, unmortgage at +10%, no rent while mortgaged
``auction``    (MON-203)      bidding order, withdrawal, no-bid outcome
``trade``      (MON-204)      validation, atomic execution, simplified-trade mode
``jail``       (MON-205)      fine, card, rolling for doubles, compulsory release
``cards``      (MON-206)      Chance and Community Chest decks and their effects
``insolvency`` (MON-207)      forced asset sales, bankruptcy to a player or to the bank
``endgame``    (MON-208)      last-solvent-player, time limit, net-worth tie-break
============================  ==========================================================

Every module here is a pure function of ``(state, ...) -> (state, events)``. None of them
import anything from :mod:`kesef_server` or perform I/O.
"""

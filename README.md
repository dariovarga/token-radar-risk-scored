# Token Radar — Risk-Scored

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar that ranks pre-token protocols by **risk-adjusted implied value**:
what a token would be worth if the protocol's record stayed as it is, discounted by
how risky the farm is.

## The model (risk-2)

- **Raw implied value** = TVL × 0.30 × growth × maturity. Growth is the 7-day TVL
  change clamped to −50…+100%, weighted 0.6. Maturity is 0.5 + min(age, 1460 days) /
  1460 × 0.5; unknown age counts as 365 days.
- **Risk score (0–100)** = concentration + momentum + age + category + scale, each 0–20.
  One chain scores 20, six or more score 2. A violent 7-day swing scores up to 20.
  Very young (<90 days) scores 18 and very old without a token (>5 years) scores 17,
  while 1–3 years scores 4. Category scores 5 for Dexs and Lending up to 15 for wrappers
  and exotic structures. TVL under $10M scores 18; over $1B scores 2.
- **Adjusted value** = raw × (1 − 0.5 × risk / 100). Rank 1 is the highest adjusted value.
  Grades: A 0–30 Low, B 31–42 Guarded, C 43–52 Moderate, D 53–62 Elevated, E 63–72 High,
  F 73–100 Severe.
- Every farm plan sizes its position to the risk grade — a severe-risk farm is a small
  farm by construction.

The board covers the whole watchlist plus every other rankable pre-token protocol in
the snapshot (194 rows). Protocols whose token already trades are kept apart in the
Live token view, shown at the market's own values, never mixed into the ranking.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>
```

Node 22.18+ (the grader runs Node 22.23.4), standard library only, no network.
`main.ts` reads the sealed snapshot, writes `board.json`, `data.js`, `dashboard/`,
`screenshots/` and `dossier.json` to the output directory. It runs twice and writes
the same bytes both times.

## The dashboard

A static page, no framework and no network: a sortable, filterable board (search,
category, chain, risk grade, watchlist-only), a detail view per protocol with its
five risk-factor bars and a six-step farm plan, and the live-token table. State lives
in the URL hash, so the board, a detail view and a filtered view are each a link.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>

# congreso-api

Open JSON API of the Spanish Congress, built by scraping `congreso.es` open data once a day
and publishing the normalized result as static files. No server, no database.

## Endpoints

| File | Contents |
| --- | --- |
| `v1/index.json` | Manifest: generation date, legislature, one entry per voting day, totals |
| `v1/initiatives.json` | Legislative files in progress, keyed by `expediente` |
| `v1/laws.json` | Laws already published, with their PDF |
| `v1/sessions/{YYYY-MM-DD}.json` | One plenary day: roster plus every roll-call vote |
| `v1/expedientes.json` | Every file that reached a vote, with its date range and vote count |
| `v1/expedientes/{123-000456}.json` | Every voting of one file, without the roll call |

To show what happened to a bill, read `v1/expedientes/{id}.json`: it lists its votings in
order with their totals. Only fetch the session file when you need who voted what.

A session file holds the roster of that day (`deputies`, an array sorted by name, each with
its group and seat) and a list of `votings`. Each voting carries its `expediente`, its
totals and `votes`: one character per deputy, positionally aligned with `deputies`, where
`Y` yes, `N` no, `A` abstention, `X` did not vote and `.` was not in that roll call. So
`votes[i]` is how `deputies[i]` voted. The string is empty for secret ballots.

The roster is per day because seats and group membership change during a legislature, and
because everyone without a seat (ministers) shares seat `-1`.

## What the source does not give

- **The voting JSON does not name the file it belongs to.** The `expediente` only exists
  in the day's HTML, as a link preceding the block of votings it covers. `v1/index.json`
  reports how many votings ended up without one.
- **Published laws carry no `expediente`**, so `laws.json` cannot be joined to
  `initiatives.json` without matching titles by hand.
- **Some plenary days were never published as data**, only as a PNG chart. They are listed
  in `v1/index.json` under `missingData`.
- **The text of a bill is a PDF**, linked from `bocg` in each initiative.

## Running it

```sh
pnpm run build          # initiatives + votes
pnpm run check:freshness
```

Requires Node 22.18+ (runs TypeScript directly, no build step, no dependencies).
Session files already on disk are not re-fetched, except the most recent day.

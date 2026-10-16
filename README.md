# Cadencia y Decadencia — decadencia.es

Static site on GitHub Pages (`index.html`, custom domain in `CNAME`). Routes are loaded at runtime from `data/routes.json`.

## Add a ride (GPX)

1. Export the activity as GPX (Garmin Connect: activity → ⚙ → *Export to GPX*; Strava: your own activity → ⋯ → *Export GPX*; Wahoo/Apple Watch: via the companion app or HealthFit).
2. On github.com open `imports/inbox/<your-name>/` (e.g. `imports/inbox/jorge/`) → *Add file* → *Upload files* → commit to `main`.
3. The **Import routes** workflow parses the file, computes the missing stats, groups it with other riders' recordings of the same outing, updates `data/routes.json` + `data/tracks/`, removes the GPX from the inbox and republishes the site (≈1–2 min).

Files without timestamps need the date in the name: `2026-10-18-rivas.gpx`. Files that fail are moved to `imports/failed/` with a `.error.txt`.

## Group rides and review

Activities are merged into one ride only when time **and** GPS positions show the riders were together. Partial or uncertain matches (and anything matching only by date) are published separately and listed as an open review in `data/routes.json` → `reviews` and in the workflow summary. Resolve them in *Actions → Review routes → Run workflow*:

| command | target | value |
|---|---|---|
| `merge` | route id | route id to merge into |
| `split` | activity id | — |
| `dismiss` | review id | — |
| `rename` | route id | new title |

Titles, participants and notes can also be edited directly in `data/routes.json` (the **Validate** workflow checks the edit). `stats_locked: true` keeps reviewed numbers from being recomputed.

## Privacy

The repository is public. Published tracks are simplified and the first/last 200 m are removed; raw GPX files are deleted after import (they remain in git history of the upload commit). Heart rate is only published for riders with `share_heart_rate: true` in `data/riders.json`. No credentials are stored in the repository.

## Automatic sync (experimental, off by default)

Garmin's Connect Developer Program is business-only and not accepting applications; Strava's API terms do not allow showing one athlete's data to others. The supported path is **intervals.icu** (free, official Garmin/Wahoo/Coros/Suunto/Polar sync, personal API keys):

1. Each rider connects their device account in intervals.icu and creates an API key (Settings → Developer).
2. Repo *Settings → Secrets and variables → Actions*: secret `INTERVALS_ACCOUNTS` = `[{"rider":"jorge","api_key":"…"}]`, variable `INTERVALS_SYNC_ENABLED` = `true`.
3. **Sync providers** runs every 6 h (or manually). Activities intervals.icu received from Strava are skipped.

The adapter is covered by mocked tests but has not yet been run against the live API.

## Development

```
npm test                 # GPX parsing, stats, duplicates, group matching, data preservation
node scripts/validate.mjs
GEOCODE=off node scripts/import.mjs
python3 -m http.server   # then open http://localhost:8000
```

No runtime dependencies (Node ≥ 20 for the scripts).

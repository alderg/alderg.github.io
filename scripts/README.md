# scripts

Command-line Node tooling for this repo, kept separate from the static HTML
site at the repo root. Nothing here is published by GitHub Pages — these are
run locally from your machine.

## slack-logbuch

Fetches Slack access logs for one user via the
[`team.accessLogs`](https://docs.slack.dev/reference/methods/team.accessLogs/)
admin API and reports the number of workdays that user logged in from a given
IP range. It is the headless equivalent of `../slack.html`: same IP
include/exclude rules, same day counting, same report table — but it pulls the
data directly from Slack instead of a pasted CSV, so the admin token never
leaves your machine.

### Requirements

- **Node 18+** (uses the global `fetch`).
- A workspace on a **paid plan** (`team.accessLogs` returns `paid_only`
  otherwise).
- A **Slack user token with the `admin` scope** (`xoxp-...`).

### Getting the token

1. Go to <https://api.slack.com/apps> → **Create New App** → *From scratch* →
   pick the draw.io workspace.
2. **OAuth & Permissions** → **User Token Scopes** → add `admin`.
3. **Install to Workspace** (you must authorize as a Workspace Owner/Admin).
4. Copy the **User OAuth Token** (`xoxp-...`).

Keep this token out of the repo — pass it on the command line via `--token`.
(Note: a CLI argument is visible in your shell history and in process listings,
so treat the token accordingly and rotate it if needed.)

### Usage

```bash
# Default full-year report (1.1 – 31.12 of the current year):
node slack-logbuch.mjs --user UQ5209A75 --token xoxp-...

# Write the report into a folder (filename auto-generated):
node slack-logbuch.mjs --user UQ5209A75 --token xoxp-... --out reports
#   -> reports/Logbuch-Obwalden-2026-01-01_2026-12-31.html
#   then open it in Chrome and print to PDF

# Explicit range, options and an exact output file:
node slack-logbuch.mjs --user UQ5209A75 --token xoxp-... \
  --from 1.1.2026 --to 31.12.2026 --days 240 \
  --include "144. 178." --exclude "178.197." --label Obwalden \
  --out reports/2026.html
```

Output:

```
Obwalden 3.1.2026 - 19.6.2026: 142 of 240 workdays (59.2%)
```

| Flag        | Default                        | Meaning                                              |
| ----------- | ------------------------------ | ---------------------------------------------------- |
| `--user`    | *(required)*                   | Slack user ID to report on                           |
| `--token`   | *(required)*                   | Admin-scoped `xoxp-...` token                         |
| `--from`    | `1.1.<current year>`           | Start date (inclusive), `d.m.yyyy`                   |
| `--to`      | `31.12.<current year>`         | End date (inclusive), `d.m.yyyy`                     |
| `--days`    | `240`                          | Working days in the period (the percentage divisor)  |
| `--include` | `"144. 178."`                  | Space-separated IP prefixes that count               |
| `--exclude` | `"178.197."`                   | Space-separated IP prefixes that are excluded        |
| `--label`   | `Obwalden`                     | Place label in the report                            |
| `--out`     | *(off)*                        | Write the HTML report to a **file** (`reports/2026.html`) or a **folder** (`reports` → filename auto-generated). Also `--output` / `-o` |
| `--all-pages` | *(off)*                      | Disable early-stop and page through the entire access-log history (slower; for verification) |
| `--verbose` | *(off)*                        | Trace config, each API request, and per-entry filtering (to stderr); also `-verbose` / `-v` |

`--out` writes the report as an **HTML file**. It is treated as a **folder** when
it has a trailing slash, no file extension, or already exists as a directory —
then the script creates it if needed and writes
`Logbuch-<label>-<from>_<to>.html` inside it. Otherwise it is treated as an exact
file path. With `--out` omitted, it just prints the summary line (the number of
days). To get a PDF, open the HTML in Chrome and print to PDF (Cmd/Ctrl-P → Save
as PDF) — there is no Slack API that returns a PDF, and the report has to be
rendered by a browser.
All trace/progress output goes to **stderr**, so the summary on **stdout** stays
clean and parseable. Run with `--verbose` to see exactly what is happening:

```
$ node slack-logbuch.mjs --user UQ5209A75 --token xoxp-... --verbose
Configuration:
  user    = UQ5209A75
  from    = 1.1.2026
  to      = 31.12.2026
  ...
Fetching workspace access logs from Slack...
  POST team.accessLogs?count=1000&page=1&before=1767225600
Fetched page 1/3 (+1000, 1000 entries so far, oldest 14.8.2026)
  pausing 3.5s (rate limit)
  ...
Page 3 is entirely older than --from; stopping early (pass --all-pages to disable).
  keep 3.1.2026  ip=144.x.x.x  count=12
  skip 5.1.2026  ip=178.197.x.x  (ip excluded)
  ...
Total entries fetched : 2431
Entries for user      : 188
  kept (in range+ip)  : 142
  distinct valid days : 142
Obwalden 3.1.2026 - 19.6.2026: 142 of 240 workdays (59.2%)
```

### Notes

- **Day field.** Each log entry is counted on its `date_first`. If your
  existing reports key off the *last* access instead, change `login.date_first`
  to `login.date_last` in `slack-logbuch.mjs`.
- **Runtime / rate limits.** `team.accessLogs` has no per-user filter, so the
  script pages through the **whole workspace's** logs (newest first) and filters
  client-side. It is Tier 2 (~20 requests/min), so requests are paced ~3.5s
  apart and automatically back off on HTTP 429 (honoring `Retry-After`).
  Progress is printed to stderr; a busy workspace can take a few minutes.
- **Early stop.** The API has only a `before` (upper) bound, not an `after`
  (lower) one. Since results come newest-first, the script stops paging once it
  reaches a page entirely older than `--from`, instead of fetching years of
  history it would only discard. This is safe — an in-window entry always has
  `date_last >= from`, so a fully-past page means nothing older can still count.
  Use `--all-pages` to disable this and fetch everything (e.g. to confirm the
  total matches).
- **History retention.** Slack only keeps access-log history for a limited
  window, so a very old `--from` may simply return no data.
- **Privacy.** Generated reports contain IP addresses. Write them into
  `reports/` (gitignored) and do not commit them — this repo is public.

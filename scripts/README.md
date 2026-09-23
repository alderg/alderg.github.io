# scripts

Command-line Node tooling for this repo, kept separate from the static HTML
site at the repo root. These are run locally from your machine. Note that
GitHub Pages still serves them as plain files (e.g.
`https://www.alderg.com/scripts/slack-logbuch.mjs`), so never put secrets or
generated data in here.

## slack-logbuch

Fetches one user's Slack access log for a year via the
[`team.accessLogs`](https://docs.slack.dev/reference/methods/team.accessLogs/)
admin API and writes:

- `slack-access-logs-<year>.csv` — the raw data, in the same format as the CSV
  export at `https://my.slack.com/account/logs` (which only returns the first
  page since 2026).
- `<yyyymmdd>-Logbuch-<code>-<year>.pdf` — the report of `../slack.html`, printed
  like its *Print Report* button (A4, no browser header/footer).

The report is built from the CSV text with the same code as `slack.html`, so
you can also run it on an old CSV export with `--csv`.

### Quick start

With the token in the Keychain (see below), this fetches the current year and
prints the summary line:

```bash
~/Developer/alderg.github.io/scripts/slack-logbuch.mjs
```

Every run writes both files into `reports/` in the current folder, e.g. for
2026:

- `reports/slack-access-logs-2026.csv` — the raw access log (the CSV)
- `reports/<today>-Logbuch-<code>-2026.pdf` — the report

For another year, add it: `slack-logbuch.mjs 2025`. For another folder, add
`--out <folder>`.

### Requirements

- **Node 18+** (uses the global `fetch`).
- **Google Chrome** (or Chromium/Edge) to print the PDF; pass `--chrome <path>`
  if it is not in the default location.
- A workspace on a **paid plan** (`team.accessLogs` returns `paid_only`
  otherwise).
- A **Slack user token with the `admin` scope** (`xoxp-...`).

### Getting the token

The Slack app only needs to be created once; it is listed at
<https://api.slack.com/apps>. To create it:

1. Go to <https://api.slack.com/apps> → **Create New App** → *From scratch* →
   pick the draw.io workspace.
2. **OAuth & Permissions** → **User Token Scopes** → add `admin`.
3. **Install to Workspace** (you must authorize as a Workspace Owner/Admin).
4. Copy the **User OAuth Token** (`xoxp-...`), not a bot token.

Keep the token in the macOS Keychain rather than in the repo or your shell
history:

```bash
security add-generic-password -a "$USER" -s slack-logbuch -w
```

### Usage

```bash
# Current year, token from the Keychain: writes reports/slack-access-logs-2026.csv
# and reports/<today>-Logbuch-<code>-2026.pdf
node slack-logbuch.mjs

# Any other year
node slack-logbuch.mjs 2025

# Report from an existing CSV export (no token needed)
node slack-logbuch.mjs 2024 --csv slack-access-logs-2024.csv

# Explicit range and filters, as in slack.html
SLACK_TOKEN=... node slack-logbuch.mjs --from 1.1.2026 --to 30.6.2026 --days 120 \
  --include "<prefix> <prefix>" --exclude "<prefix>" --label <place> --code <code>
```

Progress goes to stderr, the summary to stdout:

```
Fetching access logs for U0123456789, 1.1.2025 - 31.12.2025 (Slack allows ~20 requests/min, about 3 minutes per year)
Fetching [##########----------] 52%  back to 24.6.2025, page 27, 1000 entries, ~1m35s left
...
Wrote 2000 entries to reports/slack-access-logs-2025.csv
Printing PDF...
Wrote reports/<today>-Logbuch-<code>-2025.pdf
<place> <first day> - <last day>: <days> of 240 workdays (<percent>%)
```

| Flag          | Default               | Meaning                                                  |
| ------------- | --------------------- | -------------------------------------------------------- |
| `YEAR`        | current year          | Year to fetch and report (first positional argument)     |
| `--csv`       | *(off)*               | Use an existing access log CSV instead of the API        |
| `--token`     | `$SLACK_TOKEN`, then Keychain item `slack-logbuch` | Admin-scoped `xoxp-...` token |
| `--user`      | the token's owner     | Slack user ID to report on                               |
| `--from`      | `1.1.<YEAR>`          | Start date (inclusive), `d.m.yyyy`                       |
| `--to`        | `31.12.<YEAR>`        | End date (inclusive), `d.m.yyyy`                         |
| `--days`      | `240`                 | Working days in the period (the percentage divisor)      |
| `--include`   | as in `slack.html`    | Space-separated IP prefixes that count; empty = all      |
| `--exclude`   | as in `slack.html`    | Space-separated IP prefixes that are excluded first      |
| `--label`     | as in `slack.html`    | Place label in the total line                            |
| `--code`      | built in              | Place code in the PDF filename                           |
| `--out`       | `reports`             | Output folder (also `-o`)                                |
| `--html`      | *(off)*               | Write the report as HTML instead of printing the PDF     |
| `--chrome`    | auto-detected         | Path to Chrome/Chromium/Edge                             |
| `--tz`        | `Europe/Zurich`       | Time zone for the timestamps and for grouping by day     |
| `--all-pages` | *(off)*               | Page through the whole log history instead of stopping at `--from` |
| `--verbose`   | *(off)*               | Trace each API request (to stderr); also `-v`            |

With `--from`/`--to`, files are named by date range instead of the year, e.g.
`slack-access-logs-20260101_20260630.csv`.

### Notes

- **Same data as the export.** Checked against earlier CSV exports and
  reports made with `slack.html`: the API returns the same rows and the
  script produces the same report. The API
  prefixes some user agents with client tags (`SlackWeb/0 `, `ApiApp/…`),
  which the export does not show; the script strips them. The export's
  *User Agent - Simple* column is not in the API and is filled in on a
  best-effort basis; the report does not use it.
- **Order within a day.** Entries that share the same second may be listed in
  a different order than in an old export. Days, logins and IPs are unaffected.
- **Runtime / rate limits.** `team.accessLogs` has no per-user filter, so the
  script pages through the **whole workspace's** logs (newest first) and
  filters client-side. It is Tier 2 (~20 requests/min), so requests are paced
  ~3.5s apart and back off on HTTP 429. A year takes about 3 minutes.
- **Paging.** The API has only a `before` (upper) bound, so the script stops
  at the first page that is entirely older than `--from`. Classic pagination
  ends at page 100; if that is reached, it continues with `before` set below
  the oldest entry seen.
- **Day field.** Each entry is counted on the local day of its `date_first`
  (*Date Accessed*), like `slack.html`.
- **Empty filters.** In `slack.html` an empty *Exclude* field excludes every
  address. Here an empty `--exclude` excludes nothing.
- **Privacy.** The CSV and PDF contain IP addresses. `reports/` is gitignored;
  do not commit them — this repo is public.

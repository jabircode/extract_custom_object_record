# Custom Object Extractor

A small client + proxy to pull custom object records from SleekFlow, page through
continuation tokens, and view, filter, and export them in the browser.

## Features

- **Object lookup by key.** Entering an object key resolves it against
  `GET /api/customObjects/{key}` and shows its display name, field count, and
  relationship type before you fetch anything.
- **Schema-driven table.** Column headers, order, and types come from the object
  schema: `UTM Source` instead of `utm_source`, datetime fields get a local-time
  twin (`Touched At (UTC+8)`), and single-choice fields filter on their declared
  options.
- **Progressive loading.** The first page paints immediately (~0.6 s) and the
  remaining pages stream in with a running count (10k records ≈ 10 sequential
  requests ≈ 6 s). Pages cannot be parallelised — each continuation token comes
  from the previous response.
- **Honest counts.** Filters and exports stay hidden until every page is in, so a
  filter never silently covers only part of the dataset. Cancelling keeps what
  loaded, marks it `partial`, and only then enables filtering.
- **Continuation-token paging** until exhaustion (hard cap 50 pages × 1000 = 50k
  records, with a warning when the cap is hit).
- **Filters**: exact-value dropdown for text/choice/boolean fields, UTC date range
  for datetime fields.
- **Contact enrichment** runs after the table renders, so large objects are usable
  immediately; names are cached for the session.
- **CSV export** of the filtered dataset (BOM + formula-injection escaping),
  **file download** as a ZIP, and **contact-list import** from the filtered records.
- **Regional failover** across SleekFlow base URLs, pinning the first healthy one.

## Requirements

- Node.js 18+ (uses the built-in `fetch` and `AbortSignal.timeout`).

## Run locally

```bash
node server.js
```

Then open <http://localhost:3000>.

Optional HTTP basic auth (recommended before exposing the service anywhere):

```bash
AUTH_USER=team AUTH_PASS=secret node server.js
```

## Routes

| Route | Purpose |
| --- | --- |
| `POST /api/schema` | `{apiKey, objectKey}` → object schema |
| `POST /api/records` | `{apiKey, objectKey, continuationToken}` → one page |
| `POST /api/contact` | `{apiKey, userProfileId}` → contact |
| `POST /api/contact/list` | `{apiKey, groupListName, userProfileIds}` → create list |
| `GET /proxy-image?url=` | SSRF-guarded file proxy for ZIP downloads |
| `GET /api/health` | liveness probe |

API keys are sent in the `X-Sleekflow-Api-Key` header, never in a URL.

## Notes

- The upstream expects **GET with a JSON body** for records, and only honours the
  continuation token there — passing it as a query parameter returns page 1 again.
  `server.js` uses the `http(s)` module directly for that request.
- `limit` maxes at **1000**; `limit=2000` returns a 400.
- Times are rendered in the **browser's timezone**; date-range inputs are
  interpreted as UTC.
- The static file handler serves an allowlist (`index.html`, `style.css`,
  `script.js`) only — source files are never exposed.
- `jszip` loads from cdnjs (pinned with SRI) and is only needed for ZIP downloads.

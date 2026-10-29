# @pipeworx/ebsa — EBSA civil-penalty enforcement

Closed US Department of Labor **Employee Benefits Security Administration**
civil-penalty enforcement actions since 2000 — deficient-filer, late-filer
and non-filer penalty assessments against ERISA benefit-plan sponsors for
their Form 5500 filings. `form5500` already covers the filings themselves
(what sponsors reported); this is EBSA's own enforcement record against
sponsors who filed deficiently, late, or not at all — distinct from
`dol-whd` (Wage & Hour back-wage/overtime cases) and `osha` (safety
citations), both of which already live on this same DOL API gateway.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

This is a civil-**penalty** / filing-compliance enforcement record, **not**
a fiduciary-breach litigation docket — EBSA does not publish a bulk dataset
of individual fiduciary-breach case outcomes. This is the enforcement
dataset that actually exists in structured, bulk-queryable form.

## Tools

| Tool | Answers |
|---|---|
| `ebsa_search` | Search cases by sponsor name, case type, state, plan year |
| `ebsa_sponsor` | Full enforcement history and case-type breakdown for one named sponsor |
| `ebsa_recent` | "What EBSA enforcement actions closed recently?" |
| `ebsa_coverage` | What the dataset covers, its publication date and close-date range |

## Auth

Platform key (`PLATFORM_DOL_KEY`, already set on the gateway for `dol-whd`
and `osha`) with BYO override via `_apiKey`. A free key from
<https://dataportal.dol.gov> covers every DOL dataset on this gateway. A
live sibling call (`dol_whd whd_search`) confirmed the platform key is valid
right now (2026-10-17) — no new key needed.

## Live proxy, same gateway as dol-whd and osha

This pack calls `apiprod.dol.gov/v4` — the identical gateway, auth shape and
query grammar `dol-whd` already documents in full in its own README and
`src/index.ts` header. Every trap there applies verbatim here and is not
re-derived:

- The catalog endpoint (`/v4/datasets/10361`) takes an `X-API-KEY` **header**
  or no key at all; the row endpoint (`/v4/get/EBSA/ocats/json`) **rejects**
  a header and needs the key as a **query parameter**.
- A zero-match query answers **HTTP 204 with an empty body**, not a 200 with
  `{"data":[]}`.
- The upstream throttles by **source IP**, not by key, and sends no
  `Retry-After` — this pack backs off twice, then returns
  `{ found: false, reason: "upstream_rate_limited" }`.
- `filter_object` keywords (`field`, `operator`, `value`, `and`, `or`) must
  be lowercase; a wrong dataset name and a malformed filter both answer a
  generic HTTP 500.

## Fields (from the live dataset, not guessed)

Verified live 2026-10-17 against the dataset's own 10-row preview (no key
needed to read it): `case_type`, `ein`, `pn` (plan number), `plan_year`,
`plan_name`, `plan_admin`, `plan_admin_state`, `plan_admin_zip_code`,
`final_close_reason`, `final_close_date`, `penalty_amount`, `load_dt`.

**`penalty_amount` is a DOL-assigned STRING BUCKET**, not an exact dollar
figure — observed live values include `"over $100,000"`,
`"$50,001 - $100,000"`, `"$0-$10,000"`. This pack passes it through verbatim
as `penalty_amount_bucket` and never parses it into a number.

**`case_type` values observed live**: `"Deficient Filer"` (the only value in
the 10-row preview sample); the dataset's own description also names "late
filers" and "non-filers" among the enforcement focus. `case_type` is matched
with `like` (substring), not an exact enum, since the precise casing of
every value was not exhaustively observed.

## No individual PII

`plan_admin` identifies the plan administrator/sponsor — almost always a
business entity making a mandatory public filing (e.g. "Shell USA, Inc.",
"Veeva Systems Inc.", "Spectrum Brands, Inc." in the live preview), not a
private person. Unlike the LCA/PERM record layouts, OCATS carries no
point-of-contact or attorney name/email/phone columns at all — there is
nothing to drop because the dataset never collected it.

## Data sources

- U.S. Department of Labor, Employee Benefits Security Administration —
  Office of the Chief Accountant Case Tracking System (OCATS). Closed
  enforcement cases with a penalty assessment since 2000, published
  quarterly.
- <https://dataportal.dol.gov> — key registration and the API Query Builder
  (same portal `dol-whd` documents).

## Gotchas

- `ebsa_coverage`'s close-date sample needs a key (same as `whd_coverage`);
  the catalog half (name/description/frequency/published_at) does not.
- A `sponsor` query matches both `plan_admin` and `plan_name` with `like`,
  and the response says which field matched (`matched_fields`) — a plan's
  own name sometimes names the sponsor (e.g. "Shell USA, Inc. Health &
  Wellbeing Plan") when the administrator field alone would miss it.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "ebsa": {
      "url": "https://gateway.pipeworx.io/ebsa/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/ebsa/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ebsa_search \
  -H 'Content-Type: application/json' \
  -d '{"sponsor":"Shell"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ebsa_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-ebsa` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/ebsa/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "ebsa": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-ebsa"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Ebsa data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT

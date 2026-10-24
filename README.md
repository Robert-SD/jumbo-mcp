# Jumbo MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-0.4.0-green.svg)](https://modelcontextprotocol.io/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)

A Model Context Protocol (MCP) server for **Jumbo Supermarkten**.

Connect your AI assistant (Claude Desktop, Cursor, Antigravity, OpenClaw, …) to your personal Jumbo account to read **digital receipts (*kassabonnen*)**, itemized prices and discounts, Extra's loyalty points, stores and products, and to manage your **shopping list (*lijstje*)**.

---

## Installation & Setup

Requires Node.js `>= 20`.

### 1. Clone & Build
```bash
git clone https://github.com/Robert-SD/jumbo-mcp.git
cd jumbo-mcp
npm install
npm run build
```

### 2. Authentication (One-time setup)

Run the automated login wizard:
```bash
npm run login     # opens Chrome, solves Turnstile automatically, and captures the callback
```

Upon successful login, the CLI prints your permanent refresh token directly in the terminal:
```text
JUMBO_REFRESH_TOKEN=v1.MbOzCg2...
```

Add this line directly to your `.env` file or environment:
```bash
JUMBO_REFRESH_TOKEN="your_refresh_token_here"
```

Verify your active connection and loyalty balance:
```bash
npm run status    # verify active connection and loyalty points
```

*(Recommended: persist the session with `npm run login -- --save` and point `JUMBO_TOKENS_FILE` at a writable path — Jumbo rotates refresh tokens on every use, so the env value above is only a bootstrap fallback. Containers must mount a persistent volume; see [Persistent token storage](#persistent-token-storage-required-for-containers).)*

---

## Client Integration

### Method 1: Local Path (Recommended)
Add the compiled server to your MCP client config:

```json
{
  "mcpServers": {
    "jumbo": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/jumbo-mcp/dist/index.js"],
      "env": {
        "JUMBO_REFRESH_TOKEN": "your_refresh_token_here"
      }
    }
  }
}
```

| Client | Config file |
| :--- | :--- |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)<br>`%APPDATA%\Claude\claude_desktop_config.json` (Windows) |
| Cursor | `~/.cursor/mcp.json` |
| Other clients | the same `mcpServers` block |

### Method 2: Global Link (`npm link`)
Run `npm link` inside the cloned directory to register `jumbo-mcp` globally on your system:
```bash
npm link
```
Then use:
```json
{
  "mcpServers": {
    "jumbo": {
      "command": "jumbo-mcp",
      "env": {
        "JUMBO_REFRESH_TOKEN": "your_refresh_token_here"
      }
    }
  }
}
```

### Method 3: Docker Deployment
A multi-stage [`Dockerfile`](Dockerfile) is included for containerized environments:

```bash
# Build Docker image
docker build -t jumbo-mcp .

# One-time login on the host, into a directory you will mount
docker run --rm -it -v jumbo-tokens:/data \
  -e JUMBO_TOKENS_FILE=/data/tokens.json \
  jumbo-mcp login --save
```

Run the server against the same volume:
```json
{
  "mcpServers": {
    "jumbo": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-v",
        "jumbo-tokens:/data",
        "-e",
        "JUMBO_TOKENS_FILE=/data/tokens.json",
        "-e",
        "JUMBO_REFRESH_TOKEN=your_refresh_token_here",
        "jumbo-mcp"
      ]
    }
  }
}
```

`-v jumbo-tokens:/data` is **not** optional — see below.

### Persistent token storage (required for containers)

Jumbo's Auth0 tenant issues **rotating refresh tokens**: every refresh returns a
new refresh token and invalidates the previous one, with reuse detection. That
makes the tokens file part of the credential, not a cache.

* The server writes each rotated token to the file returned by
  `JUMBO_TOKENS_FILE`. That path **must be on a persistent, writable volume** for
  any container or headless deployment.
* If the tokens file sits on the container's ephemeral layer, the rotated token
  is lost on the next restart. The process then falls back to the stale
  `JUMBO_REFRESH_TOKEN`, Auth0 sees a reused token, and the whole token family is
  revoked — every tool call fails with
  `Auth0 token refresh failed (403): {"error":"invalid_grant"}`.
* **`JUMBO_REFRESH_TOKEN` alone is not safe with rotation enabled.** It is a
  bootstrap value, read only when no tokens file exists; the token it produces
  must still be persisted for the next start.
* A tokens file that already carries a refresh token **always wins** over
  `JUMBO_REFRESH_TOKEN`, so a stale env value can never overwrite a live session.
* If the tokens path cannot be written, the server now fails the refresh loudly
  (naming the path and this requirement) instead of continuing in memory.

Recommended configuration:

```bash
JUMBO_TOKENS_FILE=/data/tokens.json   # on a mounted volume, writable by the container user
JUMBO_REFRESH_TOKEN=...               # bootstrap only; ignored once tokens.json has a refresh token
```

**Recovery after an `invalid_grant`:** re-run `jumbo-mcp login --save` (or
`docker run … jumbo-mcp login --save` against the same volume), set
`JUMBO_REFRESH_TOKEN` to the new value if you keep one, and confirm
`JUMBO_TOKENS_FILE` points at persistent storage. No retry can revive a token
family Auth0 has already invalidated.

---

## Tools

| Tool | Description | Parameters |
| :--- | :--- | :--- |
| `jumbo_login` | Verify the connection and return the loyalty identity and points balance. | None |
| `jumbo_get_profile` | Loyalty profile: name, customer ID, Extra's card, receipt preferences. | None |
| `jumbo_list_receipts` | Recent receipts with timestamps, store and transaction IDs. | `page` (`0`), `page_size` (`10`, max `30`) |
| `jumbo_get_receipt_details` | Full itemized lines, unit prices, discounts, total, payment method, VAT. | `transaction_id` (required) |
| `jumbo_search_receipts` | Find items bought across recent receipts by keyword (e.g. `'havermelk'`). | `query` (required), `max_receipts` (`10`) |
| `jumbo_get_balance` | Live Extra's loyalty points balance. | None |
| `jumbo_get_shopping_list` | The shopping list: `isActive` plus every item. | None |
| `jumbo_add_shopping_list_items` | **Write.** Add free-text items (e.g. `['eieren']`); activates the list if needed. | `items` (required), `ensure_active` (`true`), `dedupe` (`true`) |
| `jumbo_remove_shopping_list_items` | **Write.** Remove items by id. | `item_ids` (required) |
| `jumbo_set_shopping_list_item_completed` | **Write.** Tick an item off or back on. | `item_id`, `completed` (both required) |
| `jumbo_set_shopping_list_active` | **Write.** Activate or deactivate the list. | `active` (required) |
| `jumbo_search_stores` | Nearby stores by city, address or coordinates: address, distance, hours. | `query`, `latitude`, `longitude` (all optional) |
| `jumbo_search_products` | Search the catalog: prices, promotions, unit prices, links, SKUs. | `query` (required), `sort`, `limit` (`20`, max `200`) |
| `jumbo_get_product_recommendations` | Recommendations, alternatives, cross-sells, or weekly promotions. | `sku`, `query`, `promotions_only` (`false`) |
| `jumbo_get_promo_digest` | What's on offer among the things you actually buy (read-only). | `days` (`90`), `min_times` (`2`), `limit` (`25`), `category` |
| `jumbo_get_basket` | Current basket: lines, quantities, unit prices, promotions, subtotal. | None |
| `jumbo_get_deposits` | Statiegeld for one order: catalogue plus deposits returned. | `order_id` (required) |
| `jumbo_get_statiegeld_summary` | Statiegeld totals: returned, charged, and net balance across receipts in a date range or year. | `year`, `start_date`, `end_date`, `max_receipts` (`50`) |
| `jumbo_get_stamps` | Digital stamps, active saving (spaar) campaigns, buying-stamps balance. | None |
| `jumbo_cache_stats` | Combined counters for the response and geocoding caches: enabled, hits, misses, hit rate, entries, evictions. | None |

---

## Caching & Data Freshness

Jumbo's API cannot be cached at the HTTP layer, so this server keeps a
**process-local TTL cache** in front of its single GraphQL choke point. It cuts
request volume and speeds up repeat lookups — the promo digest alone resolves
one receipt detail per receipt, plus a product lookup per basket term.

**Scope:** in memory only, for the lifetime of the running MCP server process.
Nothing is written to disk, no cache survives a restart, and entries are scoped
to the signed-in account. No cached response contains your tokens — but a cached
receipt detail does carry that receipt's account data (customer ID and loyalty
card number), which is why it never leaves process memory.

### What is cached, and for how long

| Data | TTL | Why |
| :--- | :---: | :--- |
| Store list, city geocoding | 24 hours | A store's location does not move |
| Product detail | 24 hours | A product's page is stable for a day |
| Product search results, promo search | 30 minutes | Offer prices churn daily |
| Promotions and customer promotions | 30 minutes | Weekly campaign, daily markdowns |
| Closed receipt line items, order deposits | 30 days | A closed receipt is immutable |
| Everything else | — | See below |

### What is never cached

Your profile, the receipt **overview** list, your shopping list, the basket,
your Extra's balance and your stamps are **always fetched live**, never served
from the cache. Those carry live personal state, and a stale read there would
make the assistant re-add an item you just added.

### What this means for you

* **Prices and offers can be up to 30 minutes old**, and **product pages up to
  24 hours old**. A price change during that window is not reflected.
* **Caching is per process.** If your client spawns a fresh server for every
  session, each session starts with a cold cache and the benefit is limited to
  repeats within one session.
* **Kill switch:** set `JUMBO_MCP_CACHE=off` to disable the cache entirely.
  `JUMBO_MCP_CACHE_MAX_ENTRIES` caps the number of cached responses
  (default 500).
* **Verify it:** call `jumbo_cache_stats` for the live hit/miss counters of the
  running server — they cover both the GraphQL response cache and the city
  geocoding cache, so a store search that reused coordinates is visible. `npm run status` prints the cache *configuration* (enabled
  state and size cap) — it starts a separate process, so it cannot show the
  running server's counters.

---

---

## Usage examples

```text
"Show my last 5 receipts."                     → jumbo_list_receipts
"What did I pay for milk last month?"          → jumbo_search_receipts { "query": "melk" }
"How many Extra's points do I have?"           → jumbo_get_balance
"Add eggs and milk to my shopping list."       → jumbo_add_shopping_list_items
"What's on offer that I actually buy?"         → jumbo_get_promo_digest
"Which Jumbo is closest to Utrecht?"           → jumbo_search_stores { "query": "utrecht" }
```

---

## Notes

- **Prices:** Catalog, basket, deposit, and promo-digest tools return prices as **integer cents** (e.g. `139` = €1.39). Receipt tools (`jumbo_get_receipt_details`, `jumbo_search_receipts`) return prices parsed from the receipt document as **decimal euros** (e.g. `2.19` = €2.19).
- The shopping-list tools are the only writes. Basket, deposits, stamps and promotion tools are read-only.
- When Jumbo rejects a call, the tool returns an error payload with Jumbo's own `reason` and `errorMessage` rather than a generic message.

---

## Local Development

| Command | Purpose |
| :--- | :--- |
| `npm run dev` | Run the server via `tsx` (development mode) |
| `npm test` | Run the unit tests (mocked HTTP, no live Jumbo calls) |
| `npm run login` | Authentication CLI wizard |
| `npm run status` | Verify the live connection and token status |
| `npm run build` | Compile TypeScript to `dist/` |

---

## License

MIT License - Copyright (c) 2026 Robert Schulze Dieckhoff

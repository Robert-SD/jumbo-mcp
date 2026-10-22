# Jumbo MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-0.5.0-green.svg)](https://modelcontextprotocol.io/)
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

*(Optional: If you want tokens saved to disk instead of using environment variables, run `npm run login -- --save`)*

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
```

Run with `JUMBO_REFRESH_TOKEN`:
```json
{
  "mcpServers": {
    "jumbo": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "JUMBO_REFRESH_TOKEN=your_refresh_token_here",
        "jumbo-mcp"
      ]
    }
  }
}
```

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
| `jumbo_get_payment_link` | Pay-by-link hand-off for an unpaid order: state, amount, pay URL, retry URL and a ready-to-send message. | `order_id`, `link_id`, `attempt` (all optional; one of the first two required) |
| `jumbo_payment_status` | Reconcile whether the payment settled: `AWAITING_PAYMENT` / `PROCESSING` / `PAID` / `FAILED` / `EXPIRED`. | `link_id`, `order_id`, `attempt` (all optional; one of the first two required) |
| `jumbo_cache_stats` | Combined counters for the response and geocoding caches: enabled, hits, misses, hit rate, entries, evictions. | None |

---

## Pay-by-Link Hand-off

Jumbo's checkout is Adyen-hosted: `createPaymentSession` returns `sessionData` +
`sessionId`, the browser mounts Adyen Web **on jumbo.com's own origin**, and the
`returnUrl` is built from `window.location.origin`. The Adyen client key is
origin-restricted, so the SDK cannot be mounted anywhere else. No MCP process can
therefore *complete* a payment — the only supported design is to hand the person a
URL and reconcile the outcome from Jumbo's own records. Two read-only tools do
exactly that.

**`jumbo_get_payment_link`** resolves an unpaid order into an envelope:

```json
{
  "state": "AWAITING_PAYMENT",
  "settled": false,
  "settled_source": "order.paymentLink.isAuthorized",
  "order_id": "4821337",
  "link_id": "8f2c1d3e-9a44-4a2b-9f31-6c1d7b2a4e55",
  "amount": { "amount": 6845, "currency": "EUR" },
  "payment_reference": "PAY-9F31-88213",
  "pay_url": "https://www.jumbo.com/service/betalen/8f2c1d3e-…",
  "retry_url": null,
  "expires_at": null,
  "poll_after_seconds": 30,
  "poll_budget_seconds": 2700,
  "link_status": "ACTIVE",
  "link_result": null,
  "degraded": [],
  "forward": {
    "message": "Jumbo — payment needed\n€ 68,45 · order 4821337\nhttps://www.jumbo.com/service/betalen/8f2c1d3e-…\nI'll confirm with Jumbo's API — no need to reply.",
    "dm_only": true,
    "unfurl_links": false,
    "unfurl_media": false
  }
}
```

Forward `forward.message` verbatim and honour the three transport fields:

- **Direct message only** — a pay page posted in a channel is a public link, and
  its preview leaks the amount and order contents.
- **Link unfurling off** (`unfurl_links`/`unfurl_media`) — otherwise the platform
  crawls the payment page on the person's behalf.
- **Raw URL as text**, never a button or card block: it has to survive
  copy-paste onto a phone, where the bank app lives.

**`jumbo_payment_status`** reconciles the outcome on the same envelope, with
`forward` always `null`. The state machine has four working states:

| `link.status` / `link.result` | Envelope state | Meaning |
| :--- | :--- | :--- |
| `result: Authorised`, or `isAuthorized: true` | `PAID` | terminal |
| `result: Received` or `Pending` | `PROCESSING` | keep polling; never a success |
| `result: Cancelled` / `Refused` / `Error` | `FAILED` | offer `retry_url` |
| `status: EXPIRED` | `EXPIRED` | terminal; re-issuing needs a fresh slot |

Poll again after `poll_after_seconds` (30 s for the first ten attempts, then
120 s) and stop at a terminal state or after `JUMBO_MCP_PAYLINK_BUDGET_SECONDS`
(default 45 minutes). Every read also cross-checks the order's own
`paymentLink.isAuthorized` flag: it advances from the PSP webhook, while the link
entity may only advance when a browser lands on the result page. Two sources for
one reason — the cross-check is what keeps a headless hand-off honest.

**Never** mark a payment complete because the person said they paid. Only a
vendor result code or the settlement flag read back from the API counts. The URL
is never logged, never persisted, and never returned once the state is terminal.

Safety rails: URLs are forwarded only when they are `https` and on
`jumbo.com`/`adyen.com` (override with `JUMBO_MCP_PAY_URL_HOSTS`); anything else
is withheld and reported in `degraded`. `retry_url` is exposed only while the
state is `FAILED`. A supplied `link_id` that contradicts the order's own pay link
is rejected rather than merged — by id when both sides expose one, otherwise by
comparing the two pay URLs once the link is in hand. When neither record exposes a
comparable URL the pair is flagged in `degraded`, never merged silently: reporting
one payment's settlement flag against another payment's URL is how a stale id
turns into a false `PAID`.
`JUMBO_MCP_PAYLINK=off` removes both tools entirely, leaving the read-only
toolset untouched. Neither tool places an order, cancels one, or accepts card
data.

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

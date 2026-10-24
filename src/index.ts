#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import * as dotenv from "dotenv";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GEOCODE_CACHE_MAX_ENTRIES,
  JumboClient,
  JumboShoppingListError,
} from "./client.js";
import {
  decodeJwtPayload,
  getTokensFilePath,
  loadTokens,
  loginCli,
  refreshTokens,
} from "./auth.js";

// Load local .env if present
dotenv.config();

const client = new JumboClient();

/**
 * Shape an MCP tool error. Shopping-list union errors carry the API's own
 * `reason`/`errorMessage`; surface both verbatim, never as a generic message.
 */
function toolError(error: any) {
  if (error instanceof JumboShoppingListError) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              status: "error",
              error: "ShoppingListError",
              reason: error.reason,
              errorMessage: error.errorMessage,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
  return {
    content: [{ type: "text" as const, text: `Error: ${error.message}` }],
    isError: true,
  };
}

async function showStatus(): Promise<void> {
  let tokens = await loadTokens();
  if (!tokens && process.env.JUMBO_REFRESH_TOKEN) {
    // Bootstrap: the only moment JUMBO_REFRESH_TOKEN is authoritative. The
    // rotated token it yields is only useful if it lands on disk, so a failed
    // write/refresh is reported, never swallowed.
    try {
      tokens = await refreshTokens();
    } catch (error: any) {
      console.error(`⚠️ Bootstrap from JUMBO_REFRESH_TOKEN failed: ${error.message}`);
    }
  }
  if (!tokens) {
    console.log("❌ Not logged in. No tokens found.");
    console.log(`Expected tokens at: ${getTokensFilePath()}`);
    console.log("\nRun 'npx jumbo-mcp login' or set JUMBO_REFRESH_TOKEN.");
    console.log(
      "In a container, also set JUMBO_TOKENS_FILE to a writable path on a persistent volume " +
        "(the env token is bootstrap-only; the rotated token must be persisted)."
    );
    return;
  }

  console.log("=" .repeat(60));
  console.log("📋 JUMBO MCP STATUS");
  console.log("=" .repeat(60));
  console.log(`Token storage: ${getTokensFilePath()}`);

  const cacheStats = client.cacheStats();
  console.log(
    `Response cache: ${cacheStats.enabled ? "enabled" : "disabled"} — ` +
      `max ${client.responseCacheMaxEntries} entries, plus ` +
      `${GEOCODE_CACHE_MAX_ENTRIES} for city geocoding. ` +
      `Call jumbo_cache_stats for live hit/miss counters of the running server.`
  );

  const hasRefresh = Boolean(tokens.refresh_token);
  console.log(`Refresh Token: ${hasRefresh ? "✅ Active (Permanent)" : "❌ Missing"}`);
  console.log(`Last Saved:    ${tokens.saved_at || "Unknown"}`);

  const claims = decodeJwtPayload(tokens.access_token);
  if (claims) {
    console.log(`Customer ID:   ${claims["https://jumbo.com/customerId"] || "Unknown"}`);
    console.log(`Account:       ${claims["https://jumbo.com/username"] || "Unknown"}`);
  }

  console.log("\nVerifying live API connection...");
  try {
    const prof = await client.getProfile();
    console.log(`Loyalty Name:  ${prof.name}`);
    console.log(`Card Number:   ${prof.loyalty_card_number}`);
    const bal = await client.getBalance();
    console.log(`Points:        ${bal.balance}`);
    console.log("✅ Connection healthy and operational!");
  } catch (err: any) {
    console.log(`⚠️ Live check failed: ${err.message}`);
  }
}

/**
 * Build the MCP server with all tools registered. Exported so tests can drive
 * the real handler over an in-memory transport.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "jumbo-mcp",
    version: "0.4.0",
  });

  // Tool: Login (Agent auth verification)
  server.registerTool("jumbo_login", { title: "Check Jumbo Login Status", description: "Check authentication status or establish session with Jumbo. The MCP server uses persistent pre-configured Auth0 tokens, so this verifies active connection and returns user loyalty identity.", annotations: { readOnlyHint: true }, inputSchema: z.object({}) }, async () => {
              try {
                const profile = await client.getProfile();
                const balance = await client.getBalance();
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify(
                        {
                          status: "authenticated",
                          authenticated: true,
                          message: "Successfully authenticated with Jumbo.",
                          customer_name: profile.name,
                          customer_id: profile.customer_id,
                          loyalty_card: profile.loyalty_card_number,
                          points: balance.balance,
                        },
                        null,
                        2
                      ),
                    },
                  ],
                };
              } catch (error: any) {
                return {
                  content: [{ type: "text", text: `Error: ${error.message}` }],
                  isError: true,
                };
              }
            });

  // Tool: Get Profile
  server.registerTool("jumbo_get_profile", { title: "Get Jumbo Profile", description: "Get customer loyalty profile, name, customer ID, Extra's card details, and digital receipt preferences.", annotations: { readOnlyHint: true }, inputSchema: z.object({}) }, async () => {
              try {
                const profile = await client.getProfile();
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify(profile, null, 2),
                    },
                  ],
                };
              } catch (error: any) {
                return {
                  content: [{ type: "text", text: `Error: ${error.message}` }],
                  isError: true,
                };
              }
            });

  // Tool: List Receipts
  server.registerTool("jumbo_list_receipts", { title: "List Jumbo Receipts", description: "List recent Jumbo supermarket store receipts (kassabonnen) with date, store location, and transaction ID.", annotations: { readOnlyHint: true }, inputSchema: z.object({
              page: z.number().int().min(0).default(0).describe("Page number (default 0)"),
              page_size: z
                .number()
                .int()
                .min(1)
                .max(30)
                .default(10)
                .describe("Number of receipts to return (default 10)"),
            }) }, async ({ page, page_size }) => {
              try {
                const receipts = await client.listReceipts(page, page_size);
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify(receipts, null, 2),
                    },
                  ],
                };
              } catch (error: any) {
                return {
                  content: [{ type: "text", text: `Error: ${error.message}` }],
                  isError: true,
                };
              }
            });

  // Tool: Get Receipt Details
  server.registerTool("jumbo_get_receipt_details", { title: "Get Jumbo Receipt Details", description: "Get detailed line items, unit prices, discounts, total, amount paid, returned deposit (statiegeld), payment method, and Extra's points for a specific Jumbo receipt.", annotations: { readOnlyHint: true }, inputSchema: z.object({
              transaction_id: z
                .string()
                .describe("The transactionId of the receipt (from jumbo_list_receipts)"),
            }) }, async ({ transaction_id }) => {
              try {
                const details = await client.getReceiptDetails(transaction_id);
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify(details, null, 2),
                    },
                  ],
                };
              } catch (error: any) {
                return {
                  content: [{ type: "text", text: `Error: ${error.message}` }],
                  isError: true,
                };
              }
            });

  // Tool: Search Receipts
  server.registerTool("jumbo_search_receipts", { title: "Search Jumbo Receipts", description: "Search for specific grocery items purchased across recent Jumbo receipts by keyword (e.g. 'havermelk', 'bio ei', 'skyr').", annotations: { readOnlyHint: true }, inputSchema: z.object({
              query: z.string().describe("Product keyword to search for"),
              max_receipts: z
                .number()
                .int()
                .min(1)
                .max(30)
                .default(10)
                .describe("Maximum number of recent receipts to inspect (default 10)"),
            }) }, async ({ query, max_receipts }) => {
              try {
                const results = await client.searchReceipts(query, max_receipts);
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify(results, null, 2),
                    },
                  ],
                };
              } catch (error: any) {
                return {
                  content: [{ type: "text", text: `Error: ${error.message}` }],
                  isError: true,
                };
              }
            });

  // Tool: Get Balance
  server.registerTool("jumbo_get_balance", { title: "Get Jumbo Extra's Balance", description: "Get customer's live Jumbo Extra's loyalty points balance.", annotations: { readOnlyHint: true }, inputSchema: z.object({}) }, async () => {
              try {
                const balance = await client.getBalance();
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify(balance, null, 2),
                    },
                  ],
                };
              } catch (error: any) {
                return {
                  content: [{ type: "text", text: `Error: ${error.message}` }],
                  isError: true,
                };
              }
            });

  // Tool: Get Shopping List
  server.registerTool("jumbo_get_shopping_list", { title: "Get Jumbo Shopping List", description: "Get the user's Jumbo shopping list ('lijstje'): whether it is active and every item (id, term, sku, completed).", annotations: { readOnlyHint: true }, inputSchema: z.object({}) }, async () => {
              try {
                const list = await client.getShoppingList();
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify(list, null, 2),
                    },
                  ],
                };
              } catch (error: any) {
                return toolError(error);
              }
            });

  // Tool: Search Stores
  server.registerTool("jumbo_search_stores", { title: "Search Jumbo Stores", description: "Search nearby Jumbo supermarket stores by city name, address, or geographic coordinates (latitude, longitude). Returns address, distance, opening hours, and facilities.", annotations: { readOnlyHint: true }, inputSchema: z.object({
              query: z
                .string()
                .optional()
                .describe("Dutch city, address, or postal code (e.g. 'Amsterdam', 'Utrecht', '1011NG')"),
              latitude: z.number().optional().describe("Optional latitude (e.g. 52.3702)"),
              longitude: z.number().optional().describe("Optional longitude (e.g. 4.8952)"),
            }) }, async ({ query, latitude, longitude }) => {
              try {
                const result = await client.searchStores({ query, latitude, longitude });
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify(result, null, 2),
                    },
                  ],
                };
              } catch (error: any) {
                return {
                  content: [{ type: "text", text: `Error: ${error.message}` }],
                  isError: true,
                };
              }
            });

  // Tool: Product Recommendations
  server.registerTool("jumbo_get_product_recommendations", { title: "Get Jumbo Product Recommendations", description: "Get product recommendations, alternatives, and cross-sell suggestions for a product by SKU or search query, or retrieve current weekly promotional recommendations.", annotations: { readOnlyHint: true }, inputSchema: z.object({
              sku: z
                .string()
                .optional()
                .describe("Product SKU (e.g. '293407STK') to find direct brand alternatives and substitutes"),
              query: z
                .string()
                .optional()
                .describe("Search product keyword (e.g. 'havermelk', 'yoghurt', 'koffie') to find top products and their alternatives"),
              promotions_only: z
                .boolean()
                .optional()
                .default(false)
                .describe("Set to true to retrieve current weekly promotional recommendations"),
            }) }, async ({ sku, query, promotions_only }) => {
              try {
                const result = await client.getProductRecommendations({
                  sku,
                  query,
                  promotionsOnly: promotions_only,
                });
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify(result, null, 2),
                    },
                  ],
                };
              } catch (error: any) {
                return {
                  content: [{ type: "text", text: `Error: ${error.message}` }],
                  isError: true,
                };
              }
            });

  // Tool: Search Products
  server.registerTool("jumbo_search_products", { title: "Search Jumbo Products", description: "Search the entire Jumbo supermarket grocery catalog by keyword. Returns matching products with prices, active discounts, unit prices, web links, and SKUs.", annotations: { readOnlyHint: true }, inputSchema: z.object({
              query: z
                .string()
                .describe("Grocery product keyword to search for (e.g. 'koffie', 'havermelk', 'biologische bananen')"),
              sort: z
                .enum(["PRICE_ASC", "PRICE_DESC"])
                .optional()
                .describe("Optional sort order: 'PRICE_ASC' (cheapest first) or 'PRICE_DESC' (most expensive first)"),
              limit: z
                .number()
                .int()
                .min(1)
                .max(200)
                .default(20)
                .describe("Maximum number of products to return (default: 20, max: 200 — Jumbo serves at most 200 per search)"),
            }) }, async ({ query, sort, limit }) => {
              try {
                const result = await client.searchProducts({ query, sort, limit });
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify(result, null, 2),
                    },
                  ],
                };
              } catch (error: any) {
                return {
                  content: [{ type: "text", text: `Error: ${error.message}` }],
                  isError: true,
                };
              }
            });

  // Tool: Add Shopping List Items (WRITE)
  server.registerTool("jumbo_add_shopping_list_items", { title: "Add Jumbo Shopping List Items", description: "Add one or more free-text items to the user's Jumbo shopping list (e.g. ['eieren']). " +
              "This WRITES to the user's real Jumbo account. If the list is inactive it is activated first " +
              "(set ensure_active=false to skip). Never touches the basket, checkout, orders or payments.", annotations: { readOnlyHint: false, destructiveHint: false }, inputSchema: z.object({
              items: z
                .array(z.string().min(1))
                .min(1)
                .describe("One or more free-text item names to add, e.g. ['eieren', 'melk']"),
              ensure_active: z
                .boolean()
                .default(true)
                .describe("Activate the shopping list first if it is inactive (default true)"),
              dedupe: z
                .boolean()
                .default(true)
                .describe(
                  "Skip terms already on the list (case-insensitive, trimmed). Set false to allow duplicates (default true)"
                ),
            }) }, async ({ items, ensure_active, dedupe }) => {
              try {
                const result = await client.addShoppingListItems(items, {
                  ensureActive: ensure_active,
                  dedupe,
                });
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify(
                        {
                          status: "ok",
                          is_active: result.isActive,
                          activated_first: result.activated,
                          added: result.added,
                          skipped: result.skipped,
                        },
                        null,
                        2
                      ),
                    },
                  ],
                };
              } catch (error: any) {
                return toolError(error);
              }
            });

  // Tool: Set Shopping List Active (WRITE)
  server.registerTool("jumbo_set_shopping_list_active", { title: "Set Jumbo Shopping List Active", description: "Activate or deactivate the user's Jumbo shopping list ('lijstje'). " +
              "This WRITES to the user's real Jumbo account; it does not add or remove items.", annotations: { readOnlyHint: false, destructiveHint: false }, inputSchema: z.object({
              active: z.boolean().describe("true to activate the shopping list, false to deactivate"),
            }) }, async ({ active }) => {
              try {
                const isActive = await client.setShoppingListActive(active);
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({ status: "ok", is_active: isActive }, null, 2),
                    },
                  ],
                };
              } catch (error: any) {
                return toolError(error);
              }
            });

  // Tool: Remove Shopping List Items (WRITE)
  server.registerTool("jumbo_remove_shopping_list_items", { title: "Remove Jumbo Shopping List Items", description: "Remove one or more items from the user's Jumbo shopping list by item id (ids come from jumbo_get_shopping_list). " +
              "This WRITES to the user's real Jumbo account. Shopping list only.", annotations: { readOnlyHint: false, destructiveHint: true }, inputSchema: z.object({
              item_ids: z
                .array(z.string().min(1))
                .min(1)
                .describe("One or more shopping-list item ids to remove"),
            }) }, async ({ item_ids }) => {
              try {
                const removed = await client.removeShoppingListItems(item_ids);
                return {
                  content: [
                    { type: "text", text: JSON.stringify({ status: "ok", removed }, null, 2) },
                  ],
                };
              } catch (error: any) {
                return toolError(error);
              }
            });

  // Tool: Complete / un-complete a shopping list item (WRITE)
  server.registerTool("jumbo_set_shopping_list_item_completed", { title: "Complete Jumbo Shopping List Item", description: "Tick an item on the user's Jumbo shopping list off (completed=true) or back on (completed=false). " +
              "This WRITES to the user's real Jumbo account.", annotations: { readOnlyHint: false, destructiveHint: false }, inputSchema: z.object({
              item_id: z.string().min(1).describe("Shopping-list item id (from jumbo_get_shopping_list)"),
              completed: z.boolean().describe("true to tick off, false to un-tick"),
            }) }, async ({ item_id, completed }) => {
              try {
                const items = await client.setShoppingListItemCompleted(item_id, completed);
                return {
                  content: [
                    { type: "text", text: JSON.stringify({ status: "ok", items }, null, 2) },
                  ],
                };
              } catch (error: any) {
                return toolError(error);
              }
            });

  // Tool: Get Basket (read-only)
  server.registerTool("jumbo_get_basket", { title: "Get Jumbo Basket", description: "Read-only view of the current Jumbo basket: lines with quantity, unit price, line total, promotions applied, and the basket subtotal. " +
              "Uses the GraphQL ActiveBasket operation. No basket writes, no checkout, no order, no payment operations.", annotations: { readOnlyHint: true }, inputSchema: z.object({}) }, async () => {
              try {
                const basket = await client.getBasket();
                return { content: [{ type: "text", text: JSON.stringify(basket, null, 2) }] };
              } catch (error: any) {
                return toolError(error);
              }
            });

  // Tool: Get Deposits (read-only)
  server.registerTool("jumbo_get_deposits", { title: "Get Jumbo Order Deposits", description: "Read statiegeld (deposit) information for one order: the deposit catalogue and the deposits returned on that order, with the returned total. " +
              "Requires an order_id — Jumbo's returned-deposits query is order-scoped.", annotations: { readOnlyHint: true }, inputSchema: z.object({
              order_id: z.string().min(1).describe("Order id (from the order history / receipts)"),
            }) }, async ({ order_id }) => {
              try {
                const deposits = await client.getDeposits(order_id);
                return { content: [{ type: "text", text: JSON.stringify(deposits, null, 2) }] };
              } catch (error: any) {
                return toolError(error);
              }
            });

  // Tool: Get Statiegeld Summary (read-only)
  server.registerTool("jumbo_get_statiegeld_summary", {
    title: "Get Jumbo Statiegeld Summary",
    description:
      "Calculate total returned and charged statiegeld (bottle/can deposits) across store receipts in a date range or calendar year (e.g. 2026). " +
      "Reports total returned, total charged, net deposit balance, and detailed per-receipt breakdown.",
    annotations: { readOnlyHint: true },
    inputSchema: z.object({
      year: z.number().int().optional().describe("Filter by calendar year (e.g. 2026)"),
      start_date: z.string().optional().describe("Start date in YYYY-MM-DD format (inclusive)"),
      end_date: z.string().optional().describe("End date in YYYY-MM-DD format (inclusive)"),
      max_receipts: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(50)
        .optional()
        .describe("Maximum number of receipts to scan (default 50)"),
    }),
  }, async ({ year, start_date, end_date, max_receipts }) => {
    try {
      const summary = await client.getStatiegeldSummary({
        year,
        startDate: start_date,
        endDate: end_date,
        maxReceipts: max_receipts,
      });
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    } catch (error: any) {
      return toolError(error);
    }
  });

  // Tool: Get Stamps (read-only)
  server.registerTool("jumbo_get_stamps", { title: "Get Jumbo Stamps", description: "Read the user's digital stamps: per-campaign stamp counts, active saving (spaar) campaigns, and the buying-stamps balance.", annotations: { readOnlyHint: true }, inputSchema: z.object({}) }, async () => {
              try {
                const stamps = await client.getStamps();
                return { content: [{ type: "text", text: JSON.stringify(stamps, null, 2) }] };
              } catch (error: any) {
                return toolError(error);
              }
            });

  // Tool: Promo Digest (read-only)
  server.registerTool("jumbo_get_promo_digest", { title: "Get Jumbo Promo Digest", description: "Answer \"of the things I actually buy, what is on offer right now?\". " +
              "Mines recent receipts for purchase frequency, resolves each frequent item to a current " +
              "assortment product, and reports the offer price (was/now), discount, promo type, validity " +
              "window and unit price for everything currently promoted. Read-only: no writes, no basket, " +
              "no checkout, no order or payment operations.", annotations: { readOnlyHint: true }, inputSchema: z.object({
              days: z
                .number()
                .int()
                .positive()
                .max(365)
                .default(90)
                .describe("How many days of receipts to mine (default 90)"),
              min_times: z
                .number()
                .int()
                .positive()
                .default(2)
                .describe("Minimum times a product must have been bought to count as frequent (default 2)"),
              limit: z
                .number()
                .int()
                .positive()
                .max(100)
                .default(25)
                .describe("Maximum offers to return (default 25)"),
              category: z
                .string()
                .optional()
                .describe("Optional category filter (case-insensitive substring of the product category)"),
            }) }, async ({ days, min_times, limit, category }) => {
              try {
                const digest = await client.getPromoDigest({
                  days,
                  minTimes: min_times,
                  limit,
                  category,
                });
                return { content: [{ type: "text", text: JSON.stringify(digest, null, 2) }] };
              } catch (error: any) {
                return toolError(error);
              }
            });

  server.registerTool("jumbo_cache_stats", { title: "Get Jumbo Response Cache Statistics", description: "Report the in-process caches (GraphQL responses and store geocoding): enabled state, hits, misses, hit rate, stored entries and evictions. Use to verify that cached Jumbo responses are reused instead of re-fetched.", annotations: { readOnlyHint: true }, inputSchema: z.object({}) }, async () => {
    try {
      const stats = client.cacheStats();
      return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
    } catch (error: any) {
      return toolError(error);
    }
  });

  return server;
}

async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0]?.toLowerCase();

  if (cmd === "login") {
    const manual = args.includes("--manual");
    const save = args.includes("--save");
    await loginCli({ manual, save });
  } else if (cmd === "status") {
    await showStatus();
  } else {
    await startServer();
  }
}

// Only auto-run when executed directly (not when imported by tests).
const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(path.resolve(entry)) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`Fatal error: ${err.message}\n`);
    process.exit(1);
  });
}

/**
 * MCP tool-layer tests. These drive the *real* server from src/index.ts over an
 * in-memory transport pair, so `tools/call` flows through the actual handler
 * (zod schema + toolError shaping) against the mocked fetch router. No live
 * Jumbo calls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const TOKEN = "TOKEN-DO-NOT-LEAK-abc123";
process.env.JUMBO_TOKEN = TOKEN;
process.env.JUMBO_TOKENS_FILE = "/nonexistent/jumbo-mcp/tokens.json";
delete process.env.JUMBO_REFRESH_TOKEN;

const { createServer } = await import("../src/index.js");
const { Client } = await import("@modelcontextprotocol/client");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");

type Call = { op: string | undefined; body: any };
let calls: Call[] = [];
let handler: (body: any) => any = () => json({ data: {} });

const op = (body: any) => (/(?:query|mutation)\s+(\w+)/.exec(body?.query || "") || [])[1];

function json(data: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return data;
    },
    async text() {
      return JSON.stringify(data);
    },
  };
}

(globalThis as any).fetch = async (_url: string, init: any) => {
  const body = init?.body ? JSON.parse(init.body) : null;
  calls.push({ op: op(body), body });
  return handler(body);
};

/** Wire the real server to a real client over an in-memory transport pair. */
async function withServer<T>(fn: (c: any) => Promise<T>): Promise<T> {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tool-layer-test", version: "1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const textOf = (r: any) => (r?.content || []).map((c: any) => c.text).join("\n");

const EXPECTED_TOOLS = [
  "jumbo_login",
  "jumbo_get_profile",
  "jumbo_list_receipts",
  "jumbo_get_receipt_details",
  "jumbo_search_receipts",
  "jumbo_get_balance",
  "jumbo_get_shopping_list",
  "jumbo_search_stores",
  "jumbo_get_product_recommendations",
  "jumbo_search_products",
  "jumbo_add_shopping_list_items",
  "jumbo_set_shopping_list_active",
  "jumbo_remove_shopping_list_items",
  "jumbo_set_shopping_list_item_completed",
  "jumbo_get_basket",
  "jumbo_get_deposits",
  "jumbo_get_statiegeld_summary",
  "jumbo_get_stamps",
  "jumbo_get_promo_digest",
  "jumbo_get_payment_link",
  "jumbo_payment_status",
  "jumbo_cache_stats",];

// --------------------------------------------------------------------- tools/list

test("tools/list exposes all 22 tools with the expected names", async () => {
  await withServer(async (c) => {
    const { tools } = await c.listTools();
    assert.equal(tools.length, 22);    assert.deepEqual(tools.map((t: any) => t.name).sort(), [...EXPECTED_TOOLS].sort());
  });
});

test("tools/list schemas: required vs optional params and defaults", async () => {
  await withServer(async (c) => {
    const { tools } = await c.listTools();
    const by = (n: string) => tools.find((t: any) => t.name === n)!;
    const req = (n: string) => by(n).inputSchema.required ?? [];

    // add: items required; ensure_active/dedupe optional with defaults
    const add = by("jumbo_add_shopping_list_items").inputSchema;
    assert.deepEqual(req("jumbo_add_shopping_list_items"), ["items"]);
    assert.equal(add.properties.items.type, "array");
    assert.equal(add.properties.items.minItems, 1);
    assert.equal(add.properties.ensure_active.default, true);
    assert.equal(add.properties.dedupe.default, true);

    // remove: item_ids required
    assert.deepEqual(req("jumbo_remove_shopping_list_items"), ["item_ids"]);
    assert.equal(by("jumbo_remove_shopping_list_items").inputSchema.properties.item_ids.type, "array");

    // complete: item_id + completed required
    assert.deepEqual(req("jumbo_set_shopping_list_item_completed").sort(), ["completed", "item_id"]);
    assert.equal(by("jumbo_set_shopping_list_item_completed").inputSchema.properties.completed.type, "boolean");

    // deposits: order_id required (order-scoped query)
    assert.deepEqual(req("jumbo_get_deposits"), ["order_id"]);

    // no-arg tools: nothing required
    assert.deepEqual(req("jumbo_get_basket"), []);
    assert.deepEqual(req("jumbo_get_stamps"), []);

    // promo digest: all optional, with documented defaults
    const dig = by("jumbo_get_promo_digest").inputSchema;
    assert.deepEqual(req("jumbo_get_promo_digest"), []);
    assert.equal(dig.properties.days.default, 90);
    assert.equal(dig.properties.min_times.default, 2);
    assert.equal(dig.properties.limit.default, 25);
    assert.equal(dig.properties.category.type, "string");
  });
});

// ------------------------------------------------------------- zod validation gate

test("zod rejects bad input before any HTTP call", async () => {
  const bad: Array<{ name: string; args: any }> = [
    { name: "jumbo_add_shopping_list_items", args: { items: [] } },
    { name: "jumbo_add_shopping_list_items", args: { items: "eieren" } },
    { name: "jumbo_get_deposits", args: {} },
    { name: "jumbo_get_deposits", args: { order_id: "" } },
    { name: "jumbo_remove_shopping_list_items", args: { item_ids: "abc" } },
    { name: "jumbo_remove_shopping_list_items", args: { item_ids: [] } },
    { name: "jumbo_set_shopping_list_item_completed", args: { item_id: "x" } },
    { name: "jumbo_get_promo_digest", args: { days: 0 } },
    { name: "jumbo_get_promo_digest", args: { days: 400 } },
    { name: "jumbo_get_promo_digest", args: { limit: 999 } },
  ];

  await withServer(async (c) => {
    for (const b of bad) {
      calls = [];
      const r: any = await c.callTool({ name: b.name, arguments: b.args });
      assert.equal(r.isError, true, `${b.name} ${JSON.stringify(b.args)} should be rejected`);
      assert.match(textOf(r), /validation error|MCP error/i);
      assert.equal(calls.length, 0, `${b.name} must not hit the network for bad input`);
    }
  });
});

// -------------------------------------------------------- failure -> isError payload

test("a client failure becomes isError:true (never a thrown exception)", async () => {
  handler = () => json({ errors: [{ message: "upstream exploded" }] });
  const tools: Array<{ name: string; args: any }> = [
    { name: "jumbo_add_shopping_list_items", args: { items: ["eieren"], ensure_active: false } },
    { name: "jumbo_set_shopping_list_active", args: { active: true } },
    { name: "jumbo_remove_shopping_list_items", args: { item_ids: ["1"] } },
    { name: "jumbo_get_basket", args: {} },
    { name: "jumbo_get_deposits", args: { order_id: "order-1" } },
    { name: "jumbo_get_stamps", args: {} },
  ];
  await withServer(async (c) => {
    for (const t of tools) {
      const r: any = await c.callTool({ name: t.name, arguments: t.args });
      assert.equal(r.isError, true, `${t.name} should return isError`);
      assert.match(textOf(r), /Error/i);
    }
  });
});

test("union ShoppingListError surfaces the API's own reason (no silent success)", async () => {
  handler = (body) => {
    if (op(body) === "RemoveShoppingListItems") {
      return json({
        data: {
          removeShoppingListItems: {
            __typename: "ShoppingListError",
            reason: "ITEM_NOT_FOUND",
            errorMessage: "Unknown item id",
          },
        },
      });
    }
    return json({ data: {} });
  };
  await withServer(async (c) => {
    const r: any = await c.callTool({
      name: "jumbo_remove_shopping_list_items",
      arguments: { item_ids: ["nope"] },
    });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /ITEM_NOT_FOUND/);
    assert.match(textOf(r), /Unknown item id/);
  });
});

test("union BasketError surfaces instead of an empty basket", async () => {
  handler = () =>
    json({
      data: {
        activeBasket: {
          __typename: "BasketError",
          reason: "NO_BASKET",
          errorMessage: "No active basket",
        },
      },
    });
  await withServer(async (c) => {
    const r: any = await c.callTool({ name: "jumbo_get_basket", arguments: {} });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /NO_BASKET/);
  });
});

test("promo digest degrades to a well-formed digest on upstream failure (no throw)", async () => {
  handler = () => json({ errors: [{ message: "upstream exploded" }] });
  await withServer(async (c) => {
    const r: any = await c.callTool({ name: "jumbo_get_promo_digest", arguments: {} });
    assert.notEqual(r.isError, true, "digest is resilient by design: partial failures go to notes");
    const parsed = JSON.parse(textOf(r));
    assert.equal(parsed.matched_count, 0);
    assert.ok(Array.isArray(parsed.not_matched));
    assert.ok(parsed.notes.some((n: string) => /receipt lookup stopped/.test(n)));
  });
});

test("the access token never appears in an isError payload", async () => {
  handler = () => json({ errors: [{ message: "unauthorized" }] });
  await withServer(async (c) => {
    for (const t of [
      { name: "jumbo_get_basket", args: {} },
      { name: "jumbo_get_stamps", args: {} },
      { name: "jumbo_get_deposits", args: { order_id: "o1" } },
      { name: "jumbo_set_shopping_list_active", args: { active: true } },
      { name: "jumbo_remove_shopping_list_items", args: { item_ids: ["1"] } },
    ]) {
      const r: any = await c.callTool({ name: t.name, arguments: t.args });
      assert.equal(r.isError, true);
      assert.equal(textOf(r).includes(TOKEN), false, `${t.name} leaked the token`);
    }
  });
});

test("a successful tool call flows through the real handler (add + basket)", async () => {
  handler = (body) => {
    switch (op(body)) {
      case "GetShoppingList":
        return json({
          data: { shoppingList: { __typename: "ShoppingList", isActive: true, items: [] } },
        });
      case "EditShoppingListItems":
        return json({
          data: {
            editShoppingListItems: {
              __typename: "EditShoppingListItemsResult",
              items: [{ id: "3", term: "eieren", sku: null, completed: false }],
            },
          },
        });
      case "ActiveBasket":
        return json({
          data: {
            activeBasket: {
              __typename: "ActiveBasketResult",
              basket: {
                id: "bk1",
                totalProductCount: 1,
                lines: [
                  {
                    sku: "SKU1",
                    id: "l1",
                    quantity: 1,
                    details: { title: "Melk", price: { price: 139, promoPrice: null }, promotions: [] },
                  },
                ],
                calculation: { totals: { itemSubtotal: { amount: 139, currency: "EUR" }, totalToPay: { amount: 139, currency: "EUR" } } },
              },
            },
          },
        });
      default:
        return json({ data: {} });
    }
  };

  await withServer(async (c) => {
    const add: any = await c.callTool({
      name: "jumbo_add_shopping_list_items",
      arguments: { items: ["eieren"], ensure_active: false },
    });
    assert.notEqual(add.isError, true);
    const addBody = JSON.parse(textOf(add));
    assert.equal(addBody.status, "ok");
    assert.equal(addBody.added.length, 1);

    const basket: any = await c.callTool({ name: "jumbo_get_basket", arguments: {} });
    assert.notEqual(basket.isError, true);
    const b = JSON.parse(textOf(basket));
    assert.equal(b.subtotal, 139);
    assert.equal(b.lines[0].title, "Melk");
  });
});

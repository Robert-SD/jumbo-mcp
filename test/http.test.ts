import test from "node:test";
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { TtlCache } from "../src/cache.js";
import { JumboClient } from "../src/client.js";
import { resolveHttpConfigFromEnv, startHttpServer } from "../src/http.js";
import { createServer } from "../src/index.js";
import { MemoryTokenStore, setTokenStore } from "../src/token-store.js";

test("Streamable HTTP server: stateful sessions share TtlCache, healthz works, and DELETE cleans up", async () => {
  setTokenStore(
    new MemoryTokenStore({
      access_token: "test-access-token",
      refresh_token: "test-refresh-token",
      expires_in: 7200,
      saved_at: new Date().toISOString(),
    })
  );

  const cache = new TtlCache({ maxEntries: 500 });
  const client = new JumboClient(cache);

  let upstreamCalls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("http://127.0.0.1:")) {
      return origFetch(input, init);
    }
    upstreamCalls += 1;
    return new Response(
      JSON.stringify({
        data: {
          searchProducts: {
            count: 1,
            products: [
              {
                title: "Jumbo Havermelk",
                sku: "123456",
                link: "/producten/jumbo-havermelk-123456",
                price: { price: 149, promoPrice: null, pricePerUnit: { price: 149 } },
                availability: { isAvailable: true },
              },
            ],
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const running = await startHttpServer({
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
    client,
    createServer,
    version: "0.6.0-test",
  });

  try {
    const healthRes = await origFetch(running.healthUrl);
    assert.strictEqual(healthRes.status, 200);
    const healthBody = (await healthRes.json()) as any;
    assert.strictEqual(healthBody.status, "ok");
    assert.strictEqual(healthBody.server, "jumbo-mcp");
    assert.strictEqual(healthBody.transport, "streamable-http");
    assert.strictEqual(healthBody.sessions, 0);

    // Session 1
    const client1 = new Client({ name: "test-client-1", version: "1.0.0" });
    const transport1 = new StreamableHTTPClientTransport(new URL(running.url));
    await client1.connect(transport1);
    assert.strictEqual(running.getSessionCount(), 1);

    const listed = await client1.listTools();
    assert.strictEqual(listed.tools.length, 20);

    const search1 = await client1.callTool({
      name: "jumbo_search_products",
      arguments: { query: "havermelk", limit: 5 },
    });
    assert.ok(!search1.isError);
    assert.strictEqual(upstreamCalls, 1);

    await transport1.terminateSession();
    await client1.close();
    assert.strictEqual(running.getSessionCount(), 0);

    // Session 2 reuses the shared in-process TtlCache!
    const client2 = new Client({ name: "test-client-2", version: "1.0.0" });
    const transport2 = new StreamableHTTPClientTransport(new URL(running.url));
    await client2.connect(transport2);
    assert.strictEqual(running.getSessionCount(), 1);

    const search2 = await client2.callTool({
      name: "jumbo_search_products",
      arguments: { query: "havermelk", limit: 5 },
    });
    assert.ok(!search2.isError);
    assert.strictEqual(upstreamCalls, 1, "Second HTTP session should hit warm shared cache");

    const statsResp = await client2.callTool({ name: "jumbo_cache_stats", arguments: {} });
    const stats = JSON.parse((statsResp.content as Array<{ text: string }>)[0].text);
    assert.strictEqual(stats.hits, 1);
    assert.strictEqual(stats.misses, 1);
    assert.strictEqual(stats.entries, 1);

    await transport2.terminateSession();
    await client2.close();
    assert.strictEqual(running.getSessionCount(), 0);
  } finally {
    globalThis.fetch = origFetch;
    setTokenStore(null);
    await running.close();
  }
});

test("Streamable HTTP server: auth, error status codes, and stateless POST fallback", async () => {
  const running = await startHttpServer({
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
    authToken: "super-secret-token",
    client: new JumboClient(new TtlCache({ maxEntries: 100 })),
    createServer,
  });

  try {
    const health = await fetch(running.healthUrl);
    assert.strictEqual(health.status, 200);

    const notFound = await fetch(running.healthUrl.replace("/healthz", "/nope"));
    assert.strictEqual(notFound.status, 404);

    const unauth = await fetch(running.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.strictEqual(unauth.status, 401);

    const badSession = await fetch(running.url, {
      method: "POST",
      headers: {
        authorization: "Bearer super-secret-token",
        "mcp-session-id": "non-existent-session",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.strictEqual(badSession.status, 404);

    const missingSidGet = await fetch(running.url, {
      method: "GET",
      headers: { authorization: "Bearer super-secret-token" },
    });
    assert.strictEqual(missingSidGet.status, 400);

    const statelessList = await fetch(running.url, {
      method: "POST",
      headers: {
        authorization: "Bearer super-secret-token",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }),
    });
    assert.strictEqual(statelessList.status, 200);
    const listJson = (await statelessList.json()) as any;
    assert.strictEqual(listJson.id, 7);
    assert.strictEqual(listJson.result.tools.length, 20);

    const authedClient = new Client({ name: "authed-client", version: "1.0.0" });
    const authedTransport = new StreamableHTTPClientTransport(new URL(running.url), {
      requestInit: { headers: { Authorization: "Bearer super-secret-token" } },
    });
    await authedClient.connect(authedTransport);
    const callRes = await authedClient.callTool({ name: "jumbo_cache_stats", arguments: {} });
    assert.ok(!callRes.isError);
    await authedTransport.terminateSession();
    await authedClient.close();
  } finally {
    await running.close();
  }
});

test("resolveHttpConfigFromEnv: ignores generic HOST and reads MCP_HTTP_* variables", () => {
  const prevHost = process.env.HOST;
  const prevMcpHost = process.env.MCP_HTTP_HOST;
  const prevPort = process.env.MCP_HTTP_PORT;
  const prevPath = process.env.MCP_HTTP_PATH;

  process.env.HOST = "0.0.0.0";
  delete process.env.MCP_HTTP_HOST;
  process.env.MCP_HTTP_PORT = "8092";
  process.env.MCP_HTTP_PATH = "jumbo/";
  try {
    const cfg = resolveHttpConfigFromEnv();
    assert.strictEqual(cfg.host, "127.0.0.1");
    assert.strictEqual(cfg.port, 8092);
    assert.strictEqual(cfg.path, "/jumbo");
  } finally {
    if (prevHost === undefined) delete process.env.HOST;
    else process.env.HOST = prevHost;
    if (prevMcpHost === undefined) delete process.env.MCP_HTTP_HOST;
    else process.env.MCP_HTTP_HOST = prevMcpHost;
    if (prevPort === undefined) delete process.env.MCP_HTTP_PORT;
    else process.env.MCP_HTTP_PORT = prevPort;
    if (prevPath === undefined) delete process.env.MCP_HTTP_PATH;
    else process.env.MCP_HTTP_PATH = prevPath;
  }
});

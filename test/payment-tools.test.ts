/**
 * Tool-layer tests for the pay-by-link hand-off. These drive the real server
 * from src/index.ts over an in-memory transport, so the zod schemas, the tool
 * error shaping and the envelope all go through the actual handler.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.JUMBO_TOKEN = "***";
process.env.JUMBO_TOKENS_FILE = "/nonexistent/jumbo-mcp/tokens.json";
delete process.env.JUMBO_REFRESH_TOKEN;

const { createServer } = await import("../src/index.js");
const { Client } = await import("@modelcontextprotocol/client");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");

const UUID = "8f2c1d3e-1111-4222-8333-444455556666";
const PAY_URL = `https://www.jumbo.com/service/betalen/${UUID}`;

type Call = { op: string | undefined };
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
  calls.push({ op: op(body) });
  return handler(body);
};

async function withServer<T>(fn: (c: any) => Promise<T>): Promise<T> {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "payment-tools-test", version: "1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const textOf = (r: any) => (r?.content || []).map((c: any) => c.text).join("\n");
const payloadOf = (r: any) => JSON.parse(textOf(r));

/** Route both reads: order first, then the link record. */
function route(over: { order?: any; link?: any } = {}) {
  handler = (body: any) => {
    const name = op(body);
    if (name === "OrderPayment") {
      return json({
        data: {
          order: {
            orderId: 12345,
            fulfilmentType: "HOME_DELIVERY",
            paymentMethod: "online",
            paymentLink: { url: PAY_URL, isAuthorized: false },
            ...(over.order ?? {}),
          },
        },
      });
    }
    if (name === "PaymentLink") {
      return json({
        data: {
          paymentLink: {
            success: true,
            result: {
              uuid: UUID,
              status: "ACTIVE",
              result: null,
              url: PAY_URL,
              paymentReference: "PAY-2026-0001",
              amount: { amount: 4235, currency: "EUR" },
              retryPaymentUrl: null,
              description: "Bestelling 12345",
              ...(over.link ?? {}),
            },
          },
        },
      });
    }
    return json({ data: {} });
  };
}

// ----------------------------------------------------------------- registration

test("payments: both tools are registered read-only", async () => {
  await withServer(async (c) => {
    const { tools } = await c.listTools();
    for (const name of ["jumbo_get_payment_link", "jumbo_payment_status"]) {
      const tool = tools.find((t: any) => t.name === name);
      assert.ok(tool, `${name} missing from tools/list`);
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.notEqual(tool.annotations?.destructiveHint, true);
    }
  });
});

test("payments: schemas bound the poll counter and require nothing implicitly", async () => {
  await withServer(async (c) => {
    const { tools } = await c.listTools();
    const link = tools.find((t: any) => t.name === "jumbo_get_payment_link")!;
    const props = (link as any).inputSchema.properties;

    assert.equal(props.attempt.type, "integer");
    assert.equal(props.attempt.minimum, 0);
    assert.equal(props.attempt.maximum, 500);
    assert.equal(props.order_id.type, "integer");
    // zod renders `.positive()` as an exclusive bound, not `minimum: 1`.
    assert.equal(props.order_id.exclusiveMinimum, 0);
    assert.deepEqual((link as any).inputSchema.required ?? [], []);
  });
});

// ------------------------------------------------------------- get_payment_link

test("get_payment_link: an unpaid order yields a forward-ready message", async () => {
  route();
  await withServer(async (c) => {
    const r: any = await c.callTool({
      name: "jumbo_get_payment_link",
      arguments: { order_id: 12345 },
    });
    assert.ok(!r.isError, textOf(r));
    const envelope = payloadOf(r);

    assert.equal(envelope.state, "AWAITING_PAYMENT");
    assert.equal(envelope.settled, false);
    assert.equal(envelope.pay_url, PAY_URL);
    assert.equal(envelope.link_id, UUID);
    assert.deepEqual(envelope.amount, { amount: 4235, currency: "EUR" });
    assert.equal(envelope.poll_after_seconds, 30);
    assert.deepEqual(envelope.degraded, []);

    assert.ok(envelope.forward.message.includes(PAY_URL));
    assert.equal(envelope.forward.dm_only, true);
    assert.equal(envelope.forward.unfurl_links, false);
    assert.equal(envelope.forward.unfurl_media, false);
  });
});

test("get_payment_link: resolves the link id out of the order's pay URL", async () => {
  route();
  calls = [];
  await withServer(async (c) => {
    await c.callTool({ name: "jumbo_get_payment_link", arguments: { order_id: 12345 } });
  });
  assert.deepEqual(
    calls.map((x) => x.op),
    ["OrderPayment", "PaymentLink"]
  );
});

test("get_payment_link: a link_id alone needs no order lookup", async () => {
  route();
  calls = [];
  await withServer(async (c) => {
    const r: any = await c.callTool({
      name: "jumbo_get_payment_link",
      arguments: { link_id: UUID },
    });
    const envelope = payloadOf(r);
    assert.equal(envelope.state, "AWAITING_PAYMENT");
    assert.equal(envelope.order_id, null);
    assert.ok(envelope.forward.message.includes(PAY_URL));
  });
  assert.deepEqual(
    calls.map((x) => x.op),
    ["PaymentLink"]
  );
});

test("get_payment_link: neither handle is a tool error, not a crash", async () => {
  route();
  await withServer(async (c) => {
    const r: any = await c.callTool({ name: "jumbo_get_payment_link", arguments: {} });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /order_id or a link_id/);
  });
});

test("get_payment_link: a paid order forwards nothing", async () => {
  route({ order: { paymentLink: { url: null, isAuthorized: true } } });
  await withServer(async (c) => {
    const r: any = await c.callTool({
      name: "jumbo_get_payment_link",
      arguments: { order_id: 12345 },
    });
    const envelope = payloadOf(r);
    assert.equal(envelope.state, "PAID");
    assert.equal(envelope.settled, true);
    assert.equal(envelope.forward, null);
    assert.equal(envelope.pay_url, null);
  });
});

test("get_payment_link: an opaque pay URL degrades to order-only state", async () => {
  route({ order: { paymentLink: { url: "https://checkoutshopper-live.adyen.com/pay/abc", isAuthorized: false } } });
  calls = [];
  await withServer(async (c) => {
    const r: any = await c.callTool({
      name: "jumbo_get_payment_link",
      arguments: { order_id: 12345 },
    });
    const envelope = payloadOf(r);
    assert.equal(envelope.state, "AWAITING_PAYMENT");
    assert.equal(envelope.link_id, null);
    assert.ok(
      envelope.degraded.some((d: string) => /no link id/i.test(d)),
      "a missing link id must be reported, not hidden"
    );
  });
  assert.deepEqual(
    calls.map((x) => x.op),
    ["OrderPayment"],
    "no link lookup is attempted without an id"
  );
});

test("get_payment_link: a failing link read degrades instead of failing the call", async () => {
  handler = (body: any) => {
    if (op(body) === "OrderPayment") {
      return json({
        data: {
          order: {
            orderId: 12345,
            fulfilmentType: "HOME_DELIVERY",
            paymentMethod: "online",
            paymentLink: { url: PAY_URL, isAuthorized: false },
          },
        },
      });
    }
    return json({ data: { paymentLink: { success: false, code: "BOOM", error: { errorMessage: "down" } } } });
  };

  await withServer(async (c) => {
    const r: any = await c.callTool({
      name: "jumbo_get_payment_link",
      arguments: { order_id: 12345 },
    });
    assert.ok(!r.isError, textOf(r));
    const envelope = payloadOf(r);
    assert.equal(envelope.state, "AWAITING_PAYMENT");
    assert.equal(envelope.pay_url, PAY_URL, "the order's own URL still stands");
    assert.ok(envelope.degraded.some((d: string) => /lookup failed/i.test(d)));
  });
});

// --------------------------------------------------------------- payment_status

test("payment_status: reconciles to PAID without a forward block", async () => {
  route({ order: { paymentLink: { url: PAY_URL, isAuthorized: true } } });
  await withServer(async (c) => {
    const r: any = await c.callTool({
      name: "jumbo_payment_status",
      arguments: { order_id: 12345, link_id: UUID },
    });
    const envelope = payloadOf(r);
    assert.equal(envelope.state, "PAID");
    assert.equal(envelope.settled_source, "order.paymentLink.isAuthorized");
    assert.equal(envelope.forward, null);
  });
});

test("payment_status: a refused payment exposes the retry URL for re-forwarding", async () => {
  route({ link: { status: "COMPLETED", result: "Refused", retryPaymentUrl: "https://www.jumbo.com/service/betalen/retry-1" } });
  await withServer(async (c) => {
    const r: any = await c.callTool({
      name: "jumbo_payment_status",
      arguments: { order_id: 12345 },
    });
    const envelope = payloadOf(r);
    assert.equal(envelope.state, "FAILED");
    assert.equal(envelope.retry_url, "https://www.jumbo.com/service/betalen/retry-1");
    assert.equal(envelope.forward, null, "status never re-sends a message");
  });
});

test("payment_status: pending stays PROCESSING and keeps the poll interval", async () => {
  route({ link: { status: "COMPLETED", result: "Pending" } });
  await withServer(async (c) => {
    const r: any = await c.callTool({
      name: "jumbo_payment_status",
      arguments: { order_id: 12345, attempt: 12 },
    });
    const envelope = payloadOf(r);
    assert.equal(envelope.state, "PROCESSING");
    assert.equal(envelope.poll_after_seconds, 120);
  });
});

// --------------------------------------------------- degraded / id validation

test("get_payment_link: a failing order read degrades when a link_id is supplied", async () => {
  handler = (body: any) => {
    if (op(body) === "OrderPayment") return json({ errors: [{ message: "order service down" }] });
    return json({
      data: {
        paymentLink: {
          success: true,
          result: {
            uuid: UUID,
            status: "ACTIVE",
            result: null,
            url: PAY_URL,
            amount: { amount: 4235, currency: "EUR" },
          },
        },
      },
    });
  };

  await withServer(async (c) => {
    const r: any = await c.callTool({
      name: "jumbo_get_payment_link",
      arguments: { order_id: 12345, link_id: UUID },
    });
    assert.ok(!r.isError, textOf(r));
    const envelope = payloadOf(r);
    assert.equal(envelope.state, "AWAITING_PAYMENT");
    assert.equal(envelope.pay_url, PAY_URL);
    assert.equal(envelope.settled, null, "no order record means no settlement answer");
    assert.ok(envelope.degraded.some((d: string) => /Order lookup failed/.test(d)));
  });
});

test("get_payment_link: a failing order read with no link_id is a tool error", async () => {
  handler = (body: any) =>
    op(body) === "OrderPayment"
      ? json({ errors: [{ message: "order service down" }] })
      : json({ data: {} });

  await withServer(async (c) => {
    const r: any = await c.callTool({
      name: "jumbo_get_payment_link",
      arguments: { order_id: 12345 },
    });
    assert.equal(r.isError, true);
  });
});

test("get_payment_link: a link_id that contradicts the order's pay link is rejected", async () => {
  const other = "11111111-2222-4333-8444-555555555555";
  route();
  calls = [];
  await withServer(async (c) => {
    const r: any = await c.callTool({
      name: "jumbo_get_payment_link",
      arguments: { order_id: 12345, link_id: other },
    });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /does not match the pay link of order 12345/);
  });
  assert.deepEqual(
    calls.map((x) => x.op),
    ["OrderPayment"],
    "a mismatched link must never be read or merged"
  );
});

test("get_payment_link: the id comparison is case-insensitive", async () => {
  route();
  await withServer(async (c) => {
    const r: any = await c.callTool({
      name: "jumbo_get_payment_link",
      arguments: { order_id: 12345, link_id: UUID.toUpperCase() },
    });
    assert.ok(!r.isError, textOf(r));
    assert.equal(payloadOf(r).state, "AWAITING_PAYMENT");
  });
});

test("get_payment_link: an opaque order URL plus a different link URL is rejected", async () => {
  const orderUrl = "https://checkoutshopper-live.adyen.com/pay/order-a";
  const linkUrl = "https://checkoutshopper-live.adyen.com/pay/link-b";
  handler = (body: any) => {
    if (op(body) === "OrderPayment") {
      return json({
        data: {
          order: {
            orderId: 12345,
            fulfilmentType: "HOME_DELIVERY",
            paymentMethod: "online",
            paymentLink: { url: orderUrl, isAuthorized: true },
          },
        },
      });
    }
    return json({
      data: {
        paymentLink: {
          success: true,
          result: { uuid: UUID, status: "ACTIVE", result: null, url: linkUrl },
        },
      },
    });
  };

  await withServer(async (c) => {
    const r: any = await c.callTool({
      name: "jumbo_payment_status",
      arguments: { order_id: 12345, link_id: UUID },
    });
    assert.equal(r.isError, true, "two different payments must never be merged");
    assert.match(textOf(r), /belongs to a different payment than order 12345/);
  });
});

test("get_payment_link: an identical opaque URL pair is accepted", async () => {
  const same = "https://checkoutshopper-live.adyen.com/pay/order-a";
  handler = (body: any) => {
    if (op(body) === "OrderPayment") {
      return json({
        data: {
          order: {
            orderId: 12345,
            fulfilmentType: "HOME_DELIVERY",
            paymentMethod: "online",
            paymentLink: { url: same, isAuthorized: false },
          },
        },
      });
    }
    return json({
      data: {
        paymentLink: { success: true, result: { uuid: UUID, status: "ACTIVE", result: null, url: same } },
      },
    });
  };

  await withServer(async (c) => {
    const r: any = await c.callTool({
      name: "jumbo_get_payment_link",
      arguments: { order_id: 12345, link_id: UUID },
    });
    assert.ok(!r.isError, textOf(r));
    const envelope = payloadOf(r);
    assert.equal(envelope.state, "AWAITING_PAYMENT");
    assert.deepEqual(envelope.degraded, [], "matching URLs need no warning");
  });
});

test("get_payment_link: an order without a paymentLink cannot be verified and says so", async () => {
  handler = (body: any) => {
    if (op(body) === "OrderPayment") {
      return json({
        data: {
          order: {
            orderId: 12345,
            fulfilmentType: "HOME_DELIVERY",
            paymentMethod: "online",
            paymentLink: null,
          },
        },
      });
    }
    return json({
      data: {
        paymentLink: {
          success: true,
          result: {
            uuid: UUID,
            status: "ACTIVE",
            result: null,
            url: PAY_URL,
            amount: { amount: 4235, currency: "EUR" },
          },
        },
      },
    });
  };

  await withServer(async (c) => {
    const r: any = await c.callTool({
      name: "jumbo_get_payment_link",
      arguments: { order_id: 12345, link_id: UUID },
    });
    assert.ok(!r.isError, textOf(r));
    const envelope = payloadOf(r);
    assert.ok(
      envelope.degraded.some((d: string) => /Could not verify that link/.test(d)),
      "an unverifiable pair must be reported, not merged silently"
    );
  });
});

// ---------------------------------------------------------------- kill switch
test("payments: JUMBO_MCP_PAYLINK=off removes the whole payment surface", async () => {
  const before = process.env.JUMBO_MCP_PAYLINK;
  process.env.JUMBO_MCP_PAYLINK = "off";
  try {
    await withServer(async (c) => {
      const { tools } = await c.listTools();
      assert.equal(tools.length, 20, "the read-only toolset must stand on its own");
      assert.ok(!tools.some((t: any) => t.name.startsWith("jumbo_get_payment_link")));
      assert.ok(!tools.some((t: any) => t.name === "jumbo_payment_status"));
      await assert.rejects(() =>
        c.callTool({ name: "jumbo_get_payment_link", arguments: { link_id: UUID } })
      );
    });
  } finally {
    if (before === undefined) delete process.env.JUMBO_MCP_PAYLINK;
    else process.env.JUMBO_MCP_PAYLINK = before;
  }
});

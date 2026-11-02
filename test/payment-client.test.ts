/**
 * Client-layer tests for the pay-by-link reads: `getPaymentLink` and
 * `getOrderPayment`. Mocked HTTP only — no live Jumbo calls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.JUMBO_TOKEN = "***";
process.env.JUMBO_TOKENS_FILE = "/nonexistent/jumbo-mcp/tokens.json";
delete process.env.JUMBO_REFRESH_TOKEN;

const { JumboClient, JumboApiError } = await import("../src/client.js");

const UUID = "8f2c1d3e-1111-4222-8333-444455556666";
const PAY_URL = `https://www.jumbo.com/service/betalen/${UUID}`;

type Call = { op: string | undefined; client: string | undefined; body: any };
let calls: Call[] = [];

const op = (body: any) => (/(?:query|mutation)\s+(\w+)/.exec(body?.query || "") || [])[1];

function installFetch(handler: (body: any) => any): void {
  calls = [];
  (globalThis as any).fetch = async (_url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ op: op(body), client: init?.headers?.["apollographql-client-name"], body });
    return handler(body);
  };
}
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

const linkPayload = (over: any = {}) => ({
  data: {
    paymentLink: {
      success: true,
      code: null,
      error: null,
      result: {
        uuid: UUID,
        status: "ACTIVE",
        result: null,
        url: PAY_URL,
        paymentReference: "PAY-2026-0001",
        amount: { amount: 4235, currency: "EUR" },
        retryPaymentUrl: null,
        description: "Bestelling 12345",
        ...over,
      },
    },
  },
});

// ------------------------------------------------------------ getPaymentLink

test("getPaymentLink: sends PaymentLink(input:{linkId}) to the orders app", async () => {
  installFetch(() => json(linkPayload()));
  await new JumboClient().getPaymentLink(UUID);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, "PaymentLink");
  assert.equal(calls[0].client, "JUMBO_WEB-orders");
  assert.deepEqual(calls[0].body.variables, { input: { linkId: UUID } });
  assert.match(calls[0].body.query, /query PaymentLink\(\$input: PaymentLinkInput!\)/);
});

test("getPaymentLink: maps the record into the hand-off shape", async () => {
  installFetch(() =>
    json(
      linkPayload({
        retryPaymentUrl: "https://www.jumbo.com/service/betalen/retry-1",
        result: "Refused",
        status: "COMPLETED",
      })
    )
  );
  const record = await new JumboClient().getPaymentLink(UUID);

  assert.deepEqual(record, {
    link_id: UUID,
    status: "COMPLETED",
    result: "Refused",
    url: PAY_URL,
    retry_url: "https://www.jumbo.com/service/betalen/retry-1",
    payment_reference: "PAY-2026-0001",
    description: "Bestelling 12345",
    amount: { amount: 4235, currency: "EUR" },
  });
});

test("getPaymentLink: missing amount becomes null, currency defaults to EUR", async () => {
  installFetch(() => json(linkPayload({ amount: null })));
  const record = await new JumboClient().getPaymentLink(UUID);
  assert.equal(record.amount, null);

  installFetch(() => json(linkPayload({ amount: { amount: 100 } })));
  const partial = await new JumboClient().getPaymentLink(UUID);
  assert.deepEqual(partial.amount, { amount: 100, currency: "EUR" });
});

test("getPaymentLink: success:false raises with the API's own code and message", async () => {
  installFetch(() =>
    json({
      data: {
        paymentLink: {
          success: false,
          code: "LINK_NOT_FOUND",
          error: { errorMessage: "Payment link does not exist." },
          result: null,
        },
      },
    })
  );

  await assert.rejects(
    () => new JumboClient().getPaymentLink(UUID),
    (err: any) => {
      assert.ok(err instanceof JumboApiError);
      assert.equal(err.reason, "LINK_NOT_FOUND");
      assert.match(err.message, /Payment link does not exist/);
      return true;
    }
  );
});

test("getPaymentLink: a success envelope with no result raises", async () => {
  installFetch(() => json({ data: { paymentLink: { success: true, result: null } } }));
  await assert.rejects(() => new JumboClient().getPaymentLink(UUID), /no result/);
});

test("getPaymentLink: an empty payload raises instead of returning a blank record", async () => {
  installFetch(() => json({ data: { paymentLink: null } }));
  await assert.rejects(() => new JumboClient().getPaymentLink(UUID), /no payload/);
});

test("getPaymentLink: rejects an empty id without touching the network", async () => {
  installFetch(() => json(linkPayload()));
  await assert.rejects(() => new JumboClient().getPaymentLink("   "), /requires a link id/);
  assert.equal(calls.length, 0);
});

// ------------------------------------------------------------ getOrderPayment

const orderPayload = (over: any = {}) => ({
  data: {
    order: {
      orderId: 12345,
      fulfilmentType: "HOME_DELIVERY",
      paymentMethod: "online",
      paymentLink: { url: PAY_URL, isAuthorized: false },
      ...over,
    },
  },
});

test("getOrderPayment: sends the order id as a Float and reads the settlement flag", async () => {
  installFetch(() => json(orderPayload()));
  const info = await new JumboClient().getOrderPayment(12345);

  assert.equal(calls[0].op, "OrderPayment");
  assert.equal(calls[0].client, "JUMBO_WEB-orders");
  assert.deepEqual(calls[0].body.variables, { orderId: 12345 });
  assert.equal(typeof calls[0].body.variables.orderId, "number");

  // Unused web-document variables must never be declared: Jumbo rejects them.
  assert.doesNotMatch(calls[0].body.query, /\$orderChannel/);
  assert.doesNotMatch(calls[0].body.query, /\$customerId/);

  assert.deepEqual(info, {
    order_id: "12345",
    fulfilment_type: "HOME_DELIVERY",
    payment_method: "online",
    pay_url: PAY_URL,
    is_authorized: false,
  });
});

test("getOrderPayment: accepts a numeric string and coerces it", async () => {
  installFetch(() => json(orderPayload()));
  const info = await new JumboClient().getOrderPayment("12345");
  assert.equal(calls[0].body.variables.orderId, 12345);
  assert.equal(info.order_id, "12345");
});

test("getOrderPayment: a missing paymentLink leaves the flag null", async () => {
  installFetch(() => json(orderPayload({ paymentLink: null })));
  const info = await new JumboClient().getOrderPayment(12345);
  assert.equal(info.pay_url, null);
  assert.equal(info.is_authorized, null);
});

test("getOrderPayment: isAuthorized true is preserved as a boolean", async () => {
  installFetch(() => json(orderPayload({ paymentLink: { url: null, isAuthorized: true } })));
  const info = await new JumboClient().getOrderPayment(12345);
  assert.equal(info.is_authorized, true);
});

test("getOrderPayment: unknown order raises NOT_FOUND", async () => {
  installFetch(() => json({ data: { order: null } }));
  await assert.rejects(
    () => new JumboClient().getOrderPayment(999),
    (err: any) => err instanceof JumboApiError && err.reason === "NOT_FOUND"
  );
});

test("getOrderPayment: rejects a non-numeric or non-positive id without a request", async () => {
  installFetch(() => json(orderPayload()));
  await assert.rejects(() => new JumboClient().getOrderPayment("abc"), /numeric order id/);
  await assert.rejects(() => new JumboClient().getOrderPayment(0), /positive numeric order id/);
  assert.equal(calls.length, 0);
});

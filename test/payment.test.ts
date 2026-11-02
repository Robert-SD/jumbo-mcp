/**
 * Pure pay-by-link logic: state mapping, URL allowlist, poll policy and the
 * hand-off message. No network, no clock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildEnvelope,
  formatForwardMessage,
  isForwardablePayUrl,
  mapPaymentState,
  nextPollSeconds,
  parseLinkIdFromUrl,
  payUrlHosts,
  pollBudgetSeconds,
  samePayUrl,
  type OrderPaymentInfo,
  type PaymentLinkRecord,
} from "../src/payment.js";

const UUID = "8f2c1d3e-1111-4222-8333-444455556666";
const PAY_URL = `https://www.jumbo.com/service/betalen/${UUID}`;

const link = (over: Partial<PaymentLinkRecord> = {}): PaymentLinkRecord => ({
  link_id: UUID,
  status: "ACTIVE",
  result: null,
  url: PAY_URL,
  retry_url: null,
  payment_reference: "PAY-2026-0001",
  description: "Bestelling 12345",
  amount: { amount: 4235, currency: "EUR" },
  ...over,
});

const order = (over: Partial<OrderPaymentInfo> = {}): OrderPaymentInfo => ({
  order_id: "12345",
  fulfilment_type: "HOME_DELIVERY",
  payment_method: "online",
  pay_url: PAY_URL,
  is_authorized: false,
  ...over,
});

/** Run a body with an env var set, restoring the previous value afterwards. */
function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const before = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
}

// ------------------------------------------------------------- state mapping

test("mapPaymentState: authorised result is PAID", () => {
  assert.equal(mapPaymentState({ status: "COMPLETED", result: "Authorised" }), "PAID");
});

test("mapPaymentState: received and pending are PROCESSING, never PAID", () => {
  assert.equal(mapPaymentState({ status: "COMPLETED", result: "Received" }), "PROCESSING");
  assert.equal(mapPaymentState({ status: "COMPLETED", result: "Pending" }), "PROCESSING");
});

test("mapPaymentState: cancelled, refused and error are FAILED", () => {
  for (const result of ["Cancelled", "Refused", "Error"]) {
    assert.equal(mapPaymentState({ result }), "FAILED", result);
  }
});

test("mapPaymentState: expired status wins only when no result code is known", () => {
  assert.equal(mapPaymentState({ status: "EXPIRED", result: null }), "EXPIRED");
  assert.equal(mapPaymentState({ status: "EXPIRED", result: "Authorised" }), "PAID");
});

test("mapPaymentState: completed without a known result stays PROCESSING", () => {
  assert.equal(mapPaymentState({ status: "COMPLETED", result: "SomethingNew" }), "PROCESSING");
});

test("mapPaymentState: a live link with no result is AWAITING_PAYMENT", () => {
  assert.equal(mapPaymentState({ status: "ACTIVE", result: null }), "AWAITING_PAYMENT");
  assert.equal(mapPaymentState({}), "AWAITING_PAYMENT");
});

test("mapPaymentState: the settlement flag outranks the link's own result", () => {
  assert.equal(mapPaymentState({ result: "Error", isAuthorized: true }), "PAID");
});

// --------------------------------------------------------------- URL allowlist

test("isForwardablePayUrl: jumbo and adyen https URLs pass", () => {
  assert.equal(isForwardablePayUrl(PAY_URL), true);
  assert.equal(isForwardablePayUrl(`https://jumbo.com/service/betalen/${UUID}`), true);
  assert.equal(isForwardablePayUrl("https://checkoutshopper-live.adyen.com/x"), true);
});

test("isForwardablePayUrl: rejects http, look-alike hosts and non-URLs", () => {
  assert.equal(isForwardablePayUrl(`http://www.jumbo.com/service/betalen/${UUID}`), false);
  assert.equal(isForwardablePayUrl(`https://jumbo.com.evil.example/${UUID}`), false);
  assert.equal(isForwardablePayUrl(`https://evil.example/?jumbo.com`), false);
  assert.equal(isForwardablePayUrl("javascript:alert(1)"), false);
  assert.equal(isForwardablePayUrl(""), false);
  assert.equal(isForwardablePayUrl(null), false);
  assert.equal(isForwardablePayUrl(undefined), false);
});

test("isForwardablePayUrl: rejects control characters that URL parsing would strip", () => {
  // `new URL()` removes tabs and newlines before parsing, so these clear the
  // host check while the raw value would still break the forwarded message line.
  for (const injected of [
    `https://www.jumbo.com/service/betalen/${UUID}\nINJECTED`,
    `https://www.jumbo.com/service/betalen/${UUID}\tINJECTED`,
    `https://www.jumbo.com/service/betalen/${UUID}\r\nINJECTED`,
    `https://www.jumbo.com/service/betalen/${UUID}\u0000`,
    `https://www.jumbo.com/service/betalen/${UUID}\u007f`,
  ]) {
    assert.equal(isForwardablePayUrl(injected), false, JSON.stringify(injected));
  }
});

test("payUrlHosts: env override replaces the allowlist and empty falls back", () => {
  withEnv("JUMBO_MCP_PAY_URL_HOSTS", "pay.example, jumbo.nl", () => {
    assert.deepEqual(payUrlHosts(), ["pay.example", "jumbo.nl"]);
    assert.equal(isForwardablePayUrl("https://pay.example/t/1"), true);
    assert.equal(isForwardablePayUrl(PAY_URL), false);
  });
  withEnv("JUMBO_MCP_PAY_URL_HOSTS", "   ", () => {
    assert.deepEqual(payUrlHosts(), ["jumbo.com", "adyen.com"]);
  });
});

// --------------------------------------------------------------- link id parse

test("parseLinkIdFromUrl: reads the trailing UUID, with or without a slash", () => {
  assert.equal(parseLinkIdFromUrl(PAY_URL), UUID);
  assert.equal(parseLinkIdFromUrl(`${PAY_URL}/`), UUID);
});

test("parseLinkIdFromUrl: returns null for opaque or malformed URLs", () => {
  assert.equal(parseLinkIdFromUrl("https://checkoutshopper-live.adyen.com/pay/abc"), null);
  assert.equal(parseLinkIdFromUrl("not a url"), null);
  assert.equal(parseLinkIdFromUrl(null), null);
});

// ---------------------------------------------------------------- poll policy

test("nextPollSeconds: 30s for the first ten attempts, then 120s", () => {
  assert.equal(nextPollSeconds(0), 30);
  assert.equal(nextPollSeconds(9), 30);
  assert.equal(nextPollSeconds(10), 120);
  assert.equal(nextPollSeconds(500), 120);
  assert.equal(nextPollSeconds(-5), 30);
  assert.equal(nextPollSeconds(Number.NaN), 30);
});

test("pollBudgetSeconds: default 45 minutes, env override, invalid falls back", () => {
  assert.equal(pollBudgetSeconds(), 2700);
  withEnv("JUMBO_MCP_PAYLINK_BUDGET_SECONDS", "600", () => assert.equal(pollBudgetSeconds(), 600));
  withEnv("JUMBO_MCP_PAYLINK_BUDGET_SECONDS", "-1", () => assert.equal(pollBudgetSeconds(), 2700));
});

// -------------------------------------------------------------- buildEnvelope

test("buildEnvelope: an unpaid order with a live link is forwardable", () => {
  const env = buildEnvelope({ order: order(), link: link() });
  assert.equal(env.state, "AWAITING_PAYMENT");
  assert.equal(env.settled, false);
  assert.equal(env.settled_source, "order.paymentLink.isAuthorized");
  assert.equal(env.pay_url, PAY_URL);
  assert.equal(env.link_id, UUID);
  assert.equal(env.order_id, "12345");
  assert.deepEqual(env.amount, { amount: 4235, currency: "EUR" });
  assert.equal(env.poll_after_seconds, 30);
  assert.ok(env.forward, "an awaiting payment must produce a forward block");
  assert.equal(env.forward!.dm_only, true);
  assert.equal(env.forward!.unfurl_links, false);
  assert.equal(env.forward!.unfurl_media, false);
});

test("buildEnvelope: a paid order carries no URL and no forward block", () => {
  const env = buildEnvelope({ order: order({ is_authorized: true }), link: link() });
  assert.equal(env.state, "PAID");
  assert.equal(env.settled, true);
  assert.equal(env.pay_url, null);
  assert.equal(env.poll_after_seconds, 0);
  assert.equal(env.forward, null);
});

test("buildEnvelope: an expired link is terminal and not forwarded", () => {
  const env = buildEnvelope({ order: order(), link: link({ status: "EXPIRED" }) });
  assert.equal(env.state, "EXPIRED");
  assert.equal(env.pay_url, null);
  assert.equal(env.forward, null);
  assert.equal(env.poll_after_seconds, 0);
});

test("buildEnvelope: a failed link forwards the retry URL instead of the pay URL", () => {
  const retry = "https://www.jumbo.com/service/betalen/retry-1";
  const env = buildEnvelope({
    order: order(),
    link: link({ status: "COMPLETED", result: "Refused", retry_url: retry }),
  });
  assert.equal(env.state, "FAILED");
  assert.equal(env.pay_url, null);
  assert.equal(env.retry_url, retry);
  assert.ok(env.forward);
  assert.match(env.forward!.message, /did not go through/);
  assert.match(env.forward!.message, new RegExp(retry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("buildEnvelope: a pay URL off the allowlist is withheld and explained", () => {
  const foreign = `https://evil.example/service/betalen/${UUID}`;
  const env = buildEnvelope({
    order: order({ pay_url: foreign }),
    link: link({ url: foreign }),
  });
  assert.equal(env.state, "AWAITING_PAYMENT");
  assert.equal(env.pay_url, null);
  assert.equal(env.forward, null);
  assert.ok(
    env.degraded.some((d) => /allowed host/i.test(d)),
    "withholding a URL must be explained to the caller"
  );
});

test("buildEnvelope: a newline-bearing pay URL is withheld, not forwarded", () => {
  const injected = `https://www.jumbo.com/service/betalen/${UUID}\nINJECTED`;
  const env = buildEnvelope({
    order: order({ pay_url: injected }),
    link: link({ url: injected }),
  });
  assert.equal(env.pay_url, null);
  assert.equal(env.retry_url, null);
  assert.equal(env.forward, null, "a line break in the URL must never reach the message");
  assert.ok(
    env.degraded.some((d) => /allowed host/i.test(d)),
    "withholding a URL must be explained to the caller"
  );
});

test("buildEnvelope: order-only input still yields a forwardable envelope", () => {
  const env = buildEnvelope({ order: order() });
  assert.equal(env.state, "AWAITING_PAYMENT");
  assert.equal(env.pay_url, PAY_URL);
  assert.equal(env.amount, null);
  assert.ok(env.forward);
});

test("buildEnvelope: carries the caller's degraded notes through", () => {
  const env = buildEnvelope({
    order: order(),
    link: link(),
    degraded: ["Payment-link lookup failed: HTTP 500"],
  });
  assert.deepEqual(env.degraded, ["Payment-link lookup failed: HTTP 500"]);
});

test("buildEnvelope: PROCESSING keeps polling and is not forwarded", () => {
  const env = buildEnvelope({
    order: order(),
    link: link({ status: "COMPLETED", result: "Received" }),
    attempt: 3,
  });
  assert.equal(env.state, "PROCESSING");
  assert.equal(env.poll_after_seconds, 30);
  assert.equal(env.forward, null);
});

test("buildEnvelope: refuses to build from nothing", () => {
  assert.throws(() => buildEnvelope({}), /requires an order or a payment link/);
});

// ---------------------------------------------------------- message formatting

test("formatForwardMessage: amount, order reference and a bare URL line", () => {
  const env = buildEnvelope({ order: order(), link: link() });
  const message = formatForwardMessage(env)!;
  const lines = message.split("\n");
  assert.equal(lines[0], "Jumbo — payment needed");
  assert.match(lines[1], /€/);
  assert.match(lines[1], /42,35/);
  assert.match(lines[1], /order 12345/);
  assert.equal(lines[2], PAY_URL, "the URL must stand alone so it survives copy-paste");
});

test("formatForwardMessage: no message when there is nothing to forward", () => {
  const paid = buildEnvelope({ order: order({ is_authorized: true }), link: link() });
  assert.equal(formatForwardMessage(paid), null);
});

test("formatForwardMessage: never mentions a card, CVC or payment credential", () => {
  const env = buildEnvelope({ order: order(), link: link() });
  const message = formatForwardMessage(env)!;
  assert.doesNotMatch(message, /card|cvc|iban|pan\b/i);
});

// ------------------------------------------------- review-hardening regression

test("buildEnvelope: a link result that settles an unsettled order is attributed to the link", () => {
  const env = buildEnvelope({
    order: order({ is_authorized: false }),
    link: link({ status: "COMPLETED", result: "Authorised" }),
  });
  assert.equal(env.state, "PAID");
  assert.equal(env.settled, true);
  assert.equal(
    env.settled_source,
    "link.result",
    "the order flag reads false and did not decide this"
  );
});

test("buildEnvelope: the order flag is still named when it decides the answer", () => {
  const paid = buildEnvelope({ order: order({ is_authorized: true }), link: link() });
  assert.equal(paid.settled_source, "order.paymentLink.isAuthorized");

  const unpaid = buildEnvelope({ order: order({ is_authorized: false }), link: link() });
  assert.equal(unpaid.settled, false);
  assert.equal(unpaid.settled_source, "order.paymentLink.isAuthorized");
});

test("buildEnvelope: retry_url is exposed only while the state is FAILED", () => {
  const retry = "https://www.jumbo.com/service/betalen/retry-1";

  const paid = buildEnvelope({
    order: order({ is_authorized: true }),
    link: link({ status: "COMPLETED", result: "Authorised", retry_url: retry }),
  });
  assert.equal(paid.state, "PAID");
  assert.equal(paid.retry_url, null, "a settled payment must not hand out a payable URL");

  const expired = buildEnvelope({
    order: order(),
    link: link({ status: "EXPIRED", retry_url: retry }),
  });
  assert.equal(expired.state, "EXPIRED");
  assert.equal(expired.retry_url, null);

  const awaiting = buildEnvelope({ order: order(), link: link({ retry_url: retry }) });
  assert.equal(awaiting.state, "AWAITING_PAYMENT");
  assert.equal(awaiting.retry_url, null);

  const failed = buildEnvelope({
    order: order(),
    link: link({ status: "COMPLETED", result: "Refused", retry_url: retry }),
  });
  assert.equal(failed.state, "FAILED");
  assert.equal(failed.retry_url, retry);
});

test("buildEnvelope: carries the configured poll budget", () => {
  assert.equal(buildEnvelope({ order: order(), link: link() }).poll_budget_seconds, 2700);
  withEnv("JUMBO_MCP_PAYLINK_BUDGET_SECONDS", "900", () => {
    assert.equal(buildEnvelope({ order: order(), link: link() }).poll_budget_seconds, 900);
  });
});

test("buildEnvelope: a withheld retry URL is explained, like a withheld pay URL", () => {
  const env = buildEnvelope({
    order: order(),
    link: link({
      status: "COMPLETED",
      result: "Refused",
      retry_url: "https://evil.example/service/betalen/retry-1",
    }),
  });
  assert.equal(env.state, "FAILED");
  assert.equal(env.retry_url, null);
  assert.ok(
    env.degraded.some((d) => /retry URL is not on an allowed host/i.test(d)),
    "the README promises this reason for every withheld URL"
  );
});

// ------------------------------------------------------------- samePayUrl

test("samePayUrl: equal URLs match, ignoring query and trailing slash", () => {
  assert.equal(samePayUrl(PAY_URL, PAY_URL), true);
  assert.equal(samePayUrl(PAY_URL, `${PAY_URL}/`), true);
  assert.equal(samePayUrl(PAY_URL, `${PAY_URL}?ref=mail`), true);
  assert.equal(samePayUrl(PAY_URL, PAY_URL.replace("www.jumbo.com", "WWW.JUMBO.COM")), true);
});

test("samePayUrl: a different path or host does not match", () => {
  assert.equal(samePayUrl(PAY_URL, `https://www.jumbo.com/service/betalen/other`), false);
  assert.equal(
    samePayUrl(PAY_URL, `https://checkoutshopper-live.adyen.com/pay/${UUID}`),
    false
  );
});

test("samePayUrl: a missing or unparsable side is 'not comparable', never a match", () => {
  assert.equal(samePayUrl(PAY_URL, null), null);
  assert.equal(samePayUrl(null, PAY_URL), null);
  assert.equal(samePayUrl(undefined, undefined), null);
  assert.equal(samePayUrl("not a url", PAY_URL), null);
});

test("samePayUrl: recognises an opaque PSP pair as the same payment", () => {
  const opaque = "https://checkoutshopper-live.adyen.com/pay/abc";
  assert.equal(samePayUrl(opaque, opaque), true);
  assert.equal(samePayUrl(opaque, "https://checkoutshopper-live.adyen.com/pay/zzz"), false);
});

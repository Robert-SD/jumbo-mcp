/**
 * Pay-by-link hand-off.
 *
 * Jumbo's checkout is ADYEN-hosted: the server creates a payment session, the
 * browser mounts Adyen Web on jumbo.com's own origin (the `returnUrl` is derived
 * from `window.location.origin` and the Adyen client key is origin-restricted),
 * so no MCP process can complete the payment. This module models the only
 * supported design: hand the person a URL, then reconcile the outcome from
 * Jumbo's own records.
 *
 * Everything here is pure — no network, no clock — so the state machine, the URL
 * allowlist and the message format are testable without an account.
 */

export type PaymentState =
  | "AWAITING_PAYMENT"
  | "PROCESSING"
  | "PAID"
  | "FAILED"
  | "EXPIRED";

export interface PaymentAmount {
  /** Minor units (cents), as the API returns them. */
  amount: number;
  currency: string;
}

/** `PaymentLink.result` — the link entity's own view. */
export interface PaymentLinkRecord {
  link_id: string;
  status: string | null;
  result: string | null;
  url: string | null;
  retry_url: string | null;
  payment_reference: string | null;
  description: string | null;
  amount: PaymentAmount | null;
}

/** `order { paymentLink }` — the order's view, which settles from the PSP webhook. */
export interface OrderPaymentInfo {
  order_id: string;
  fulfilment_type: string | null;
  payment_method: string | null;
  pay_url: string | null;
  is_authorized: boolean | null;
}

export interface PaymentForward {
  message: string;
  dm_only: true;
  unfurl_links: false;
  unfurl_media: false;
}

export interface PaymentLinkEnvelope {
  state: PaymentState;
  /** Independent settlement flag: the authoritative "has money moved" answer. */
  settled: boolean | null;
  settled_source: "order.paymentLink.isAuthorized" | "link.result" | null;
  order_id: string | null;
  link_id: string | null;
  amount: PaymentAmount | null;
  payment_reference: string | null;
  description: string | null;
  pay_url: string | null;
  retry_url: string | null;
  expires_at: string | null;
  poll_after_seconds: number;
  /** Hard stop for reconciliation, from `JUMBO_MCP_PAYLINK_BUDGET_SECONDS`. */
  poll_budget_seconds: number;
  link_status: string | null;
  link_result: string | null;
  /** Why the picture is incomplete — surfaced to the model, never swallowed. */
  degraded: string[];
  forward: PaymentForward | null;
}

/**
 * Hosts a pay URL may point at. A tool that forwards a URL taken from an API
 * response is a phishing vector if the response is ever wrong or tampered with,
 * so only the vendor's and the PSP's own domains are allowed through.
 */
const DEFAULT_PAY_URL_HOSTS = ["jumbo.com", "adyen.com"];

export function payUrlHosts(): string[] {
  const raw = process.env.JUMBO_MCP_PAY_URL_HOSTS;
  if (!raw) return DEFAULT_PAY_URL_HOSTS;
  const hosts = raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return hosts.length > 0 ? hosts : DEFAULT_PAY_URL_HOSTS;
}

/**
 * Control characters inside a URL. `new URL()` strips tabs and newlines before
 * parsing, so a hostile `https://jumbo.com/pay\nINJECTED` clears the host check
 * while the raw string keeps its line break — which then lands in the forwarded
 * message as a second line.
 */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

export function isForwardablePayUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  if (CONTROL_CHARS_RE.test(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return payUrlHosts().some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

const UUID_RE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * Compare two pay URLs without the noise: host and path only, so a query string
 * or a trailing slash cannot make the same payment look different.
 *
 * `null` means "not comparable" — one side is missing or unparsable — which the
 * caller must report rather than treat as a match.
 */
export function samePayUrl(
  a: string | null | undefined,
  b: string | null | undefined
): boolean | null {
  if (!a || !b) return null;
  let ua: URL;
  let ub: URL;
  try {
    ua = new URL(a.trim());
    ub = new URL(b.trim());
  } catch {
    return null;
  }
  const norm = (u: URL) => `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
  return norm(ua) === norm(ub);
}

/**
 * The pay page is `/service/betalen/{linkId}`; the app resolves the id the same
 * way (last path segment, UUID-shaped). Returns null rather than guessing when
 * the URL is an opaque PSP-hosted page.
 */
export function parseLinkIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? "";
  return UUID_RE.test(last) ? last : null;
}

const PAID_RESULTS = new Set(["Authorised", "Authorized", "Success"]);
const PROCESSING_RESULTS = new Set(["Received", "Pending"]);
const FAILED_RESULTS = new Set(["Cancelled", "Canceled", "Refused", "Error"]);

/**
 * Map Jumbo's two codes onto one of four terminal-free states. `Received` and
 * `Pending` are PROCESSING, never success — the result page in the app maps them
 * the same way.
 */
export function mapPaymentState(input: {
  status?: string | null;
  result?: string | null;
  isAuthorized?: boolean | null;
}): PaymentState {
  if (input.isAuthorized === true) return "PAID";

  const result = (input.result ?? "").trim();
  if (PAID_RESULTS.has(result)) return "PAID";
  if (PROCESSING_RESULTS.has(result)) return "PROCESSING";
  if (FAILED_RESULTS.has(result)) return "FAILED";

  const status = (input.status ?? "").trim().toUpperCase();
  if (status === "EXPIRED") return "EXPIRED";
  // Link marked complete but without a terminal result code we understand:
  // hold it at PROCESSING so the caller keeps reconciling.
  if (status === "COMPLETED") return "PROCESSING";

  return "AWAITING_PAYMENT";
}

/** Short interval for the first 5 minutes, then back off. */
export function nextPollSeconds(attempt: number): number {
  const n = Number.isFinite(attempt) ? Math.max(0, Math.trunc(attempt)) : 0;
  return n < 10 ? 30 : 120;
}

export function pollBudgetSeconds(): number {
  const raw = Number(process.env.JUMBO_MCP_PAYLINK_BUDGET_SECONDS ?? 2700);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 2700;
}

function formatAmount(amount: PaymentAmount | null): string | null {
  if (!amount || !Number.isFinite(amount.amount)) return null;
  try {
    return new Intl.NumberFormat("nl-NL", {
      style: "currency",
      currency: amount.currency || "EUR",
    }).format(amount.amount / 100);
  } catch {
    return `${(amount.amount / 100).toFixed(2)} ${amount.currency || "EUR"}`;
  }
}

/**
 * The text the person receives. Raw URL on its own line so it survives
 * copy-paste onto a phone, where the bank app lives.
 */
export function formatForwardMessage(envelope: PaymentLinkEnvelope): string | null {
  const lines: string[] = [];
  const total = formatAmount(envelope.amount);
  const orderRef = envelope.order_id ? `order ${envelope.order_id}` : null;
  const context = [total, orderRef].filter(Boolean).join(" · ");

  if (envelope.state === "FAILED" && envelope.retry_url) {
    lines.push("Jumbo — the last payment attempt did not go through.");
    if (context) lines.push(context);
    lines.push(envelope.retry_url);
    lines.push("I'll confirm with Jumbo's API — no need to reply.");
    return lines.join("\n");
  }

  if (envelope.state !== "AWAITING_PAYMENT" || !envelope.pay_url) return null;

  lines.push("Jumbo — payment needed");
  if (context) lines.push(context);
  lines.push(envelope.pay_url);
  lines.push("I'll confirm with Jumbo's API — no need to reply.");
  return lines.join("\n");
}

/**
 * Compose the envelope from whatever the API returned. A missing link record is
 * not fatal: the order's `isAuthorized` flag alone can still settle an order, and
 * the `degraded` list tells the caller which half is missing.
 */
export function buildEnvelope(input: {
  order?: OrderPaymentInfo | null;
  link?: PaymentLinkRecord | null;
  attempt?: number;
  degraded?: string[];
}): PaymentLinkEnvelope {
  const order = input.order ?? null;
  const link = input.link ?? null;
  const degraded = [...(input.degraded ?? [])];

  if (!order && !link) {
    throw new Error("buildEnvelope requires an order or a payment link.");
  }

  const isAuthorized = order?.is_authorized ?? null;
  const state = mapPaymentState({
    status: link?.status,
    result: link?.result,
    isAuthorized,
  });

  const settled =
    isAuthorized === true
      ? true
      : state === "PAID"
        ? true
        : isAuthorized === false
          ? false
          : null;
  // Same precedence as `settled`: the order flag only names the source when it
  // actually decided the answer. A link result that settles an unsettled order
  // must be attributed to the link, not to a flag that reads false.
  const settledSource =
    isAuthorized === true
      ? ("order.paymentLink.isAuthorized" as const)
      : state === "PAID"
        ? ("link.result" as const)
        : isAuthorized === false
          ? ("order.paymentLink.isAuthorized" as const)
          : null;

  const rawPayUrl = link?.url ?? order?.pay_url ?? null;
  const rawRetryUrl = link?.retry_url ?? null;

  const payUrl =
    state === "AWAITING_PAYMENT" && isForwardablePayUrl(rawPayUrl) ? rawPayUrl : null;
  if (state === "AWAITING_PAYMENT" && rawPayUrl && !payUrl) {
    degraded.push(
      "The pay URL is not on an allowed host and was withheld; set JUMBO_MCP_PAY_URL_HOSTS to forward it."
    );
  }
  // A retry handle only means something while the payment failed: a terminal
  // PAID/EXPIRED link must not hand out a URL that can move money again.
  const retryUrl =
    state === "FAILED" && isForwardablePayUrl(rawRetryUrl) ? rawRetryUrl : null;
  if (state === "FAILED" && rawRetryUrl && !retryUrl) {
    degraded.push(
      "The retry URL is not on an allowed host and was withheld; set JUMBO_MCP_PAY_URL_HOSTS to forward it."
    );
  }

  const envelope: PaymentLinkEnvelope = {
    state,
    settled,
    settled_source: settledSource,
    order_id: order?.order_id ?? null,
    link_id: link?.link_id ?? null,
    amount: link?.amount ?? null,
    payment_reference: link?.payment_reference ?? null,
    description: link?.description ?? null,
    pay_url: payUrl,
    retry_url: retryUrl,
    // The API exposes no explicit expiry on the link; it reports EXPIRED instead.
    expires_at: null,
    poll_after_seconds:
      state === "AWAITING_PAYMENT" || state === "PROCESSING"
        ? nextPollSeconds(input.attempt ?? 0)
        : 0,
    poll_budget_seconds: pollBudgetSeconds(),
    link_status: link?.status ?? null,
    link_result: link?.result ?? null,
    degraded,
    forward: null,
  };

  const message = formatForwardMessage(envelope);
  envelope.forward = message
    ? { message, dm_only: true, unfurl_links: false, unfurl_media: false }
    : null;

  return envelope;
}

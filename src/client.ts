import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CUSTOMER_ID_CLAIM,
  decodeJwtPayload,
  getValidAccessToken,
  refreshTokens,
} from "./auth.js";
import { CacheStats, TtlCache, cacheKey, combineStats } from "./cache.js";
import {
  LoyaltyProfile,
  ReceiptDetails,
  ReceiptItem,
  ReceiptOverviewItem,
  StoreInfo,
  ProductRecommendationsResult,
  RecommendedProduct,
  ProductSearchItem,
  ProductSearchResult,
  ShoppingList,
  ShoppingListItem,
  ShoppingListItemInput,
  EditShoppingListItemsInput,
  Basket,
  DepositsResult,
  StampsResult,
  PromoDigest,
  PromoDigestEntry,
  DigestPromotion,
  DigestAccountOffer,
  VatBreakdownItem,
  StatiegeldReceiptEntry,
  StatiegeldSummaryResult,
} from "./types.js";
import type { OrderPaymentInfo, PaymentLinkRecord } from "./payment.js";

const GRAPHQL_URL = "https://www.jumbo.com/api/graphql";

/**
 * Jumbo's product search has one pagination knob — `ProductSearchInput.limit` —
 * and serves at most 200 products per call (a larger limit is silently clamped
 * server-side). There is no offset/cursor field, so a deep result set can only
 * be reached by widening the window.
 */
const JUMBO_SEARCH_MAX_LIMIT = 200;

/**
 * Raised when a shopping-list mutation returns the `ShoppingListError` union
 * member. Carries the API's `reason` and `errorMessage` verbatim so callers (and
 * the MCP tool layer) can surface them instead of reporting a false success.
 */
/**
 * Generic union error. Jumbo's write/read unions return their failure member as
 * a *successful* GraphQL response (HTTP 200, no top-level `errors`), so callers
 * must branch on `__typename` and raise. Carries the API's own values.
 */
export class JumboApiError extends Error {
  readonly typename: string;
  readonly reason: string;
  readonly errorMessage: string;

  constructor(typename: string, reason: string, errorMessage: string) {
    super(`Jumbo ${typename} [${reason}]: ${errorMessage}`);
    this.name = "JumboApiError";
    this.typename = typename;
    this.reason = reason;
    this.errorMessage = errorMessage;
  }
}

export class JumboShoppingListError extends JumboApiError {
  constructor(reason: string, errorMessage: string) {
    super("ShoppingListError", reason, errorMessage);
    this.name = "JumboShoppingListError";
  }
}

/**
 * Raised when Jumbo rejects the token we sent (as opposed to never having one),
 * i.e. the session is genuinely no longer valid for the Jumbo API. Carries the
 * upstream text for diagnosis but always leads with an actionable instruction.
 */
export class JumboSessionInvalidError extends Error {
  readonly code = "JUMBO_SESSION_INVALID";

  constructor(upstreamDetail: string) {
    const detail = upstreamDetail.trim().slice(0, 200);
    super(
      "Jumbo rejected the current session: the token was accepted by Auth0 but " +
        "Jumbo's API could not resolve a customer from it. Run 'jumbo-mcp login' to " +
        "re-authenticate (for headless deployments, set JUMBO_REFRESH_TOKEN from that " +
        "login)." +
        (detail ? ` [upstream: ${detail}]` : "")
    );
    this.name = "JumboSessionInvalidError";
  }
}

export type ReceiptIdForm = "raw" | "stem" | "uuid" | "prefix";

const RECEIPT_KEY_UUID_RE =
  /^(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * Single source of truth for `JUMBO_MCP_CACHE`. Read per operation so the flag
 * applies to every cache in the process, including ones built before a change.
 */
const cachingEnabled = () => process.env.JUMBO_MCP_CACHE !== "off";

/**
 * City -> coordinates lookups are not customer-specific, so they live in a
 * module-level cache. Nominatim asks for at most one request per second;
 * caching keeps a repeated store search from hammering it.
 */
export const GEOCODE_CACHE_MAX_ENTRIES = 200;

const geocodeCache = new TtlCache({
  enabled: cachingEnabled,
  maxEntries: GEOCODE_CACHE_MAX_ENTRIES,
});

/**
 * Cache TTLs in milliseconds. Only immutable or slow-moving upstream data is
 * cached — live customer state (profile, basket, shopping list, balance,
 * stamps, receipt overview) is always fetched live.
 */
export const CACHE_TTL = {
  /** Search results and promo prices: offers churn daily. */
  search: 30 * 60 * 1000,
  /** Product detail: a product's page is stable for a day. */
  productDetail: 24 * 60 * 60 * 1000,
  /** Store list, promotions and other near-static reference data. */
  catalog: 24 * 60 * 60 * 1000,
  /** Bonus folder, promotions and clearance-style markdowns. */
  offers: 30 * 60 * 1000,
  /** A closed receipt (and its deposit lines) is immutable; 30 days covers corrections. */
  receiptDetail: 30 * 24 * 60 * 60 * 1000,
  /** City -> coordinates geocoding: a city does not move. */
  geocode: 24 * 60 * 60 * 1000,
} as const;

/**
 * Allowlist by GraphQL operation. Anything not listed is fetched live, so a
 * new operation is uncached until it is classified.
 */
const OPERATION_TTL: Record<string, number> = {
  // Catalogue
  GetStoreList: CACHE_TTL.catalog,
  ProductDetail: CACHE_TTL.productDetail,
  SearchProductsByKeyword: CACHE_TTL.search,
  PromoDigestSearch: CACHE_TTL.search,
  // Offers
  getPromotions: CACHE_TTL.offers,
  PromoDigestCustomerPromotions: CACHE_TTL.offers,
  // Immutable per-record data
  GetDigitalReceipt: CACHE_TTL.receiptDetail,
  GetDeposits: CACHE_TTL.receiptDetail,
  // Never cached (live customer state):
  // GetProfile, GetReceiptOverview, GetBalance, GetShoppingList, GetStamps,
  // ActiveBasket
};

const OPERATION_NAME_RE = /(?:query|mutation)\s+(\w+)/;

/**
 * Operations whose *successful* GraphQL payload can still carry a domain-level
 * failure. Such a response must never be cached: a receipt that becomes
 * resolvable later would stay hidden, and an error union would be replayed for
 * the whole TTL. Mirrors the error conditions in the calling methods.
 */
const OPERATION_CACHE_PREDICATE: Record<string, (data: any) => boolean> = {
  GetDigitalReceipt: (data) => Boolean(data?.receipt),
  GetDeposits: (data) => {
    // `returnedDeposits: null` means the deposit record is not available yet,
    // not that the order returned nothing: caching it would hide deposits that
    // appear later for the whole TTL.
    if (!data?.returnedDeposits) return false;
    const typename = data.returnedDeposits.__typename;
    return !typename || typename === "ReturnedDepositsResponseSuccess";
  },
  // A product that the API cannot resolve stays retryable.
  ProductDetail: (data) => Boolean(data?.product),
};

export class JumboClient {
  private userAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

  private readonly cache: TtlCache;
  private lastAuthScope: string | null = null;

  constructor(cache?: TtlCache) {
    this.cache =
      cache ??
      new TtlCache({
        enabled: cachingEnabled,
        maxEntries: Number(process.env.JUMBO_MCP_CACHE_MAX_ENTRIES ?? 500),
      });
  }

  /**
   * Counters for every cache the server runs: the GraphQL response cache plus
   * the module-level geocode cache that backs `searchStores`. Reporting only the
   * instance cache would hide geocode hits/misses from `jumbo_cache_stats`.
   */
  cacheStats(): CacheStats {
    const stats = combineStats([this.cache.stats(), geocodeCache.stats()]);
    return { ...stats, enabled: stats.enabled && cachingEnabled() };
  }

  /**
   * Capacity of the GraphQL response cache alone: the value
   * `JUMBO_MCP_CACHE_MAX_ENTRIES` configures. `cacheStats().maxEntries` sums both
   * caches, so it is not the configured cap.
   */
  get responseCacheMaxEntries(): number {
    return this.cache.stats().maxEntries;
  }

  /**
   * Fingerprint of the credential snapshot the request will be sent with. It
   * keeps a re-login (a new token file) from serving the previous account's
   * cached data, and it clears the cache when the principal actually changes.
   * The raw credential never appears in the key: only its digest does.
   *
   * The headers are passed in, not resolved here: the key and the request must
   * describe the same credentials, or a re-login between the two could store
   * account B's response under account A's key.
   */
  private authScope(headers: Record<string, string>): string {
    // Scope on the account, not on the credential. A refreshed access token is a
    // different string for the same customer, so hashing the header would drop
    // the long-lived receipt and deposit entries on every refresh.
    const bearer = headers.Authorization?.replace(/^Bearer\s+/i, "");
    const customerId = bearer ? decodeJwtPayload(bearer)[CUSTOMER_ID_CLAIM] : undefined;
    const material = customerId
      ? `customer:${customerId}`
      : headers.Authorization ?? headers.Cookie ?? "anonymous";
    const scope = cacheKey("auth", [material]).split(" ").pop()!;
    if (this.lastAuthScope !== null && this.lastAuthScope !== scope) {
      this.cache.clear();
    }
    this.lastAuthScope = scope;
    return scope;
  }

  /** Last candidate form that resolved a receipt on `GetDigitalReceipt`. */
  private preferredReceiptIdForm: ReceiptIdForm | null = null;

  private async getAuthHeaders(accessTokenOverride?: string): Promise<Record<string, string>> {
    // An explicit override (a token we just refreshed) must win over the stored
    // session and over JUMBO_TOKEN; otherwise refresh+retry re-sends the very
    // token that just failed, and the retry can never succeed.
    const token =
      accessTokenOverride !== undefined
        ? accessTokenOverride
        : await getValidAccessToken();
    if (token) {
      return { Authorization: `Bearer ${token}` };
    }

    // Cookie fallback
    let cookie = process.env.JUMBO_COOKIE;
    if (!cookie) {
      const cookieFile =
        process.env.JUMBO_COOKIE_FILE ||
        path.join(os.homedir(), ".config", "jumbo-mcp", "cookie.txt");
      if (fs.existsSync(cookieFile)) {
        try {
          cookie = fs.readFileSync(cookieFile, "utf-8").trim();
        } catch {
          // Ignore
        }
      }
    }

    if (cookie) {
      return { Cookie: cookie };
    }

    throw new Error(
      "Not authenticated with Jumbo. Please run 'jumbo-mcp login' or set JUMBO_TOKEN / JUMBO_COOKIE."
    );
  }

  /**
   * Cached entry point for every GraphQL call. Only operations on the
   * allowlist are cached; everything else goes straight to the API, so live
   * customer state is never served stale.
   */
  async executeGraphql<T = any>(
    query: string,
    variables?: Record<string, any>,
    clientName: string = "JUMBO_WEB-loyalty",
    retryOn401: boolean = true,
    accessTokenOverride?: string
  ): Promise<T> {
    const operationName = OPERATION_NAME_RE.exec(query)?.[1] ?? "";
    // The kill switch is checked here, not only when the cache is built: an
    // injected TtlCache must not serve cached responses either.
    const ttl = cachingEnabled() ? OPERATION_TTL[operationName] : undefined;

    if (ttl === undefined) {
      return await this.executeGraphqlRaw<T>(
        query,
        variables,
        clientName,
        retryOn401,
        accessTokenOverride
      );
    }

    const authHeaders = await this.getAuthHeaders(accessTokenOverride);
    const scope = this.authScope(authHeaders);
    // The document text and the client name are part of the key: two
    // different GraphQL documents can share an operation name and variables
    // (e.g. `SearchProductsByKeyword` used for search and for recommendations)
    // while requesting different fields.
    const key = cacheKey(`POST ${GRAPHQL_URL} ${operationName}`, [
      scope,
      clientName,
      query,
      variables ?? {},
    ]);
    return await this.cache.wrap<T>(
      key,
      ttl,
      () =>
        this.executeGraphqlRaw<T>(
          query,
          variables,
          clientName,
          retryOn401,
          accessTokenOverride,
          authHeaders
        ),
      OPERATION_CACHE_PREDICATE[operationName]
    );
  }

  private async executeGraphqlRaw<T = any>(
    query: string,
    variables?: Record<string, any>,
    clientName: string = "JUMBO_WEB-loyalty",
    retryOn401: boolean = true,
    accessTokenOverride?: string,
    authHeadersOverride?: Record<string, string>
  ): Promise<T> {
    // A caller that already resolved credentials (the cache path) passes them in
    // so the request cannot drift onto a different principal than its cache key.
    const authHeaders =
      authHeadersOverride ?? (await this.getAuthHeaders(accessTokenOverride));
    const payload: { query: string; variables?: Record<string, any> } = { query };
    if (variables) payload.variables = variables;

    const headers: Record<string, string> = {
      "User-Agent": this.userAgent,
      "Content-Type": "application/json",
      Accept: "application/json",
      "apollographql-client-name": clientName,
      "apollographql-client-version": "master-v39.2.0-web",
      "x-source": clientName,
      ...authHeaders,
    };

    let resp: Response;
    try {
      resp = await fetch(GRAPHQL_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
    } catch (err: any) {
      throw new Error(`Network error calling Jumbo GraphQL API: ${err.message}`);
    }

    if (resp.status === 401 && retryOn401) {
      // `await` the retry: without it the recursive failure resolves the
      // returned promise asynchronously, escapes this try/catch, and surfaces to
      // the caller as a raw transport error instead of an actionable one.
      const fresh = await refreshTokens();
      return await this.executeGraphqlRaw<T>(
        query,
        variables,
        clientName,
        false,
        fresh.access_token
      );
    }

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`Jumbo API error (HTTP ${resp.status}): ${errBody}`);
    }

    const res = (await resp.json()) as any;
    if (res.errors && res.errors.length > 0) {
      const errMsgs = res.errors.map((e: any) => e.message || "Unknown error").join("; ");
      const isAuthFailure =
        errMsgs.includes("401 UNAUTHORIZED") ||
        errMsgs.includes("Customer ID") ||
        /unauthorized/i.test(errMsgs);

      if (isAuthFailure && retryOn401) {
        // Renew once, then replay with the NEW token explicitly. If this still
        // fails the session is genuinely dead -- say so, don't leak raw text.
        const fresh = await refreshTokens();
        return await this.executeGraphqlRaw<T>(
          query,
          variables,
          clientName,
          false,
          fresh.access_token
        );
      }

      if (isAuthFailure) {
        throw new JumboSessionInvalidError(errMsgs);
      }

      throw new Error(`GraphQL Error: ${errMsgs}`);
    }

    return res.data as T;
  }

  parseReceiptDoc(rawImageStr: string): {
    items: ReceiptItem[];
    total: number | null;
    amount_paid: number | null;
    returned_deposit: number | null;
    charged_deposit: number | null;
    total_discount: number | null;
    subtotal: number | null;
    payment_method: string | null;
    vat_overview: string[];
    vat_breakdown: VatBreakdownItem[];
    raw_lines: string[];
  } {
    try {
      const data = JSON.parse(rawImageStr);
      const doc = data.documents[0].documents[0];

      const lines: string[] = [];
      for (const sec of doc.printSections || []) {
        for (const obj of sec.textObjects || []) {
          for (const tl of obj.textLines || []) {
            const t = (tl.texts || []).map((seg: any) => seg.text || "").join("");
            if (t.trim()) lines.push(t);
          }
        }
      }

      const items: ReceiptItem[] = [];
      let inItems = false;
      let total: number | null = null;
      let amountPaid: number | null = null;
      let returnedDeposit: number | null = null;
      let paymentMethod: string | null = null;
      const vatLines: string[] = [];
      let inVat = false;
      let inPayments = false;
      let pendingName: string | null = null;

      for (const line of lines) {
        if (line.includes("OMSCHRIJVING")) {
          inItems = true;
          continue;
        }

        if (inItems) {
          if (line.startsWith("Totaal")) {
            const m = line.match(/Totaal\s+([\d,]+)/);
            if (m) total = parseFloat(m[1].replace(",", "."));
            inItems = false;
            pendingName = null;
            continue;
          }

          if (/^[=-]+$/.test(line.trim())) continue;

          // Multiplier subline: e.g. "  2 X 4,99                            9,98"
          const mult = line.match(
            /^\s*([\d]+(?:,[\d]+)?)\s*(?:kg)?\s*[xX]\s+([\d]+,[\d]{2})(?:\s+P)?\s+(-?[\d]+,[\d]{2})$/i
          );
          const isPromo =
            line.includes(" P ") || line.endsWith(" P") || line.includes("  P  ");

          if (mult && pendingName) {
            const quantity = parseFloat(mult[1].replace(",", "."));
            const unitPrice = parseFloat(mult[2].replace(",", "."));
            const price = parseFloat(mult[3].replace(",", "."));
            items.push({
              name: pendingName,
              price,
              is_promotion: isPromo,
              quantity,
              unit_price: unitPrice,
            });
            pendingName = null;
            continue;
          }

          const m = line.match(/^(.*?)(?:\s+P)?\s+(-?[\d]+,[\d]{2})$/);
          if (m) {
            const name = pendingName
              ? `${pendingName} ${m[1].trim()}`.trim()
              : m[1].trim();
            const price = parseFloat(m[2].replace(",", "."));
            items.push({
              name,
              price,
              is_promotion: isPromo,
              quantity: 1,
              unit_price: price,
            });
            pendingName = null;
          } else {
            const trimmed = line.trim();
            if (trimmed) pendingName = trimmed;
          }
          continue;
        }

        if (line.startsWith("Betaald:")) {
          inPayments = true;
          continue;
        }

        if (
          line.includes("BTW overzicht") ||
          line.includes("Customer's receipt") ||
          line.startsWith("Terminal:")
        ) {
          inPayments = false;
        }

        if (inPayments || line.startsWith("VISA") || line.startsWith("PIN")) {
          const emballageMatch = line.match(
            /(?:ret(?:our)?\s+emballage(?:\s+gekoppeld)?|emballage|statiegeld\s+retour|statiegeldbon)\s+([\d]+,[\d]{2})/i
          );
          if (emballageMatch) {
            const val = parseFloat(emballageMatch[1].replace(",", "."));
            returnedDeposit = Math.round(((returnedDeposit ?? 0) + val) * 100) / 100;
            continue;
          }

          const payMatch = line.match(
            /^(VISA(?:\s+DEBIT)?|PIN|MASTERCARD|MAESTRO|CONTANT|V-PAY|AMEX)(?:\s+([\d]+,[\d]{2}))?/i
          );
          if (payMatch) {
            if (!paymentMethod) {
              paymentMethod = payMatch[1].trim();
            }
            if (payMatch[2]) {
              const val = parseFloat(payMatch[2].replace(",", "."));
              amountPaid = Math.round(((amountPaid ?? 0) + val) * 100) / 100;
            }
            continue;
          }

          if (
            !paymentMethod &&
            !/^[=-]+$/.test(line.trim()) &&
            !line.startsWith("Totaal korting") &&
            !line.startsWith("Customer")
          ) {
            const m = line.match(/^([A-Za-z0-9\-]+)(?:\s+([\d]+,[\d]{2}))?$/);
            if (m) {
              paymentMethod = m[1].trim();
              if (m[2]) {
                const val = parseFloat(m[2].replace(",", "."));
                amountPaid = Math.round(((amountPaid ?? 0) + val) * 100) / 100;
              }
            }
          }
        }

        if (line.includes("BTW overzicht")) {
          inVat = true;
        } else if (inVat) {
          if (line.includes("Totaal")) {
            inVat = false;
          } else if (line.trim()) {
            vatLines.push(line.trim());
          }
        }
      }

      let chargedDeposit: number | null = null;
      for (const it of items) {
        if (it.name.toUpperCase().includes("STATIEGELD")) {
          chargedDeposit = Math.round(((chargedDeposit ?? 0) + it.price) * 100) / 100;
        }
      }

      if (amountPaid === null && total !== null) {
        amountPaid = Math.round((total - (returnedDeposit ?? 0)) * 100) / 100;
      }

      let totalDiscount: number | null = null;
      for (const line of lines) {
        const discountMatch = line.match(/Totaal korting:\s*-?([\d]+,[\d]{2})/i);
        if (discountMatch) {
          totalDiscount = parseFloat(discountMatch[1].replace(",", "."));
          break;
        }
      }
      if (totalDiscount === null) {
        const sumDiscounts = items
          .filter((it) => it.price < 0)
          .reduce((s, it) => s + Math.abs(it.price), 0);
        if (sumDiscounts > 0) {
          totalDiscount = Math.round(sumDiscounts * 100) / 100;
        }
      }

      let subtotal: number | null = null;
      if (total !== null) {
        subtotal =
          totalDiscount !== null
            ? Math.round((total + totalDiscount) * 100) / 100
            : total;
      }

      const vatBreakdown: VatBreakdownItem[] = [];
      for (const vl of vatLines) {
        const vm = vl.match(
          /^\s*([\d]+(?:,[\d]+)?)\s*%\s+([\d]+,[\d]{2})\s+([\d]+,[\d]{2})$/
        );
        if (vm) {
          const rate = parseFloat(vm[1].replace(",", "."));
          const excl = parseFloat(vm[2].replace(",", "."));
          const vat = parseFloat(vm[3].replace(",", "."));
          vatBreakdown.push({
            rate_percent: rate,
            amount_excl: excl,
            vat_amount: vat,
            amount_incl: Math.round((excl + vat) * 100) / 100,
          });
        }
      }

      return {
        items,
        total,
        amount_paid: amountPaid,
        returned_deposit: returnedDeposit,
        charged_deposit: chargedDeposit,
        total_discount: totalDiscount,
        subtotal,
        payment_method: paymentMethod,
        vat_overview: vatLines,
        vat_breakdown: vatBreakdown,
        raw_lines: lines,
      };
    } catch {
      return {
        items: [],
        total: null,
        amount_paid: null,
        returned_deposit: null,
        charged_deposit: null,
        total_discount: null,
        subtotal: null,
        payment_method: null,
        vat_overview: [],
        vat_breakdown: [],
        raw_lines: [],
      };
    }
  }

  async getProfile(): Promise<LoyaltyProfile> {
    const q = `
    query GetProfile {
      getProfile {
        customerId
        name { givenName }
        loyaltyCard { number }
        checkoutPreferences { printReceipt promotionStamps }
        digitalStamps { optIn }
      }
    }
    `;
    const data = await this.executeGraphql<any>(q, undefined, "JUMBO_WEB-loyalty");
    const prof = data?.getProfile || {};
    return {
      name: prof.name?.givenName || "",
      customer_id: prof.customerId || "",
      loyalty_card_number: prof.loyaltyCard?.number || "",
      digital_receipt_enabled: prof.checkoutPreferences?.printReceipt === false,
      digital_stamps_opt_in: Boolean(prof.digitalStamps?.optIn),
    };
  }

  async listReceipts(
    page: number = 0,
    pageSize: number = 10
  ): Promise<{
    total_results: number;
    page: number;
    page_size: number;
    receipts: ReceiptOverviewItem[];
  }> {
    const q = `
    query GetReceiptOverview {
      receiptOverview(page: ${page}, pageSize: ${pageSize}) {
        totalResults
        pageSize
        currentPage
        receipts {
          transactionId
          purchaseEndOn
          receiptSource
          store {
            storeId
            name
          }
          pointBalance
        }
      }
    }
    `;
    const data = await this.executeGraphql<any>(q, undefined, "JUMBO_WEB-orders");
    const overview = data?.receiptOverview || {};
    const receipts: ReceiptOverviewItem[] = (overview.receipts || []).map((r: any) => ({
      transaction_id: r.transactionId,
      datetime: r.purchaseEndOn,
      store: r.store?.name,
      store_id: r.store?.storeId,
      points_earned: r.pointBalance,
    }));

    return {
      total_results: overview.totalResults,
      page: overview.currentPage,
      page_size: overview.pageSize,
      receipts,
    };
  }

  /**
   * Candidate `transactionId` values to try against `receipt(transactionId:)`.
   *
   * `receiptOverview` (what `listReceipts` reads) hands back the receipt's
   * storage key -- `<opaque>-<uuid>.json` -- and that key is what the app threads
   * through `/bonnetjes/:digitalReceiptId` into `getDigitalReceipt`. The detail
   * endpoint has been observed to resolve on one of the canonical segments of
   * that key rather than the whole key, and there is no mapping endpoint to ask
   * which one. Instead of hard-failing on whichever single form the caller
   * happened to pass, try every form that key can denote.
   *
   * Default order: the exact key first (that is the value the app sends), then
   * the same key without its `.json` suffix, then the bare UUID, then the bare
   * opaque prefix. If `preferredForm` is supplied (from a prior hit on this
   * client), that form is promoted to index 0 so batch callers (`searchReceipts`,
   * `getPromoDigest`) resolve on the first attempt instead of re-probing.
   * Blanks and duplicates are dropped.
   */
  static receiptIdCandidates(
    input: string,
    preferredForm?: ReceiptIdForm | null
  ): string[] {
    return JumboClient.receiptIdTaggedCandidates(input, preferredForm).map(
      (c) => c.value
    );
  }

  private static receiptIdTaggedCandidates(
    input: string,
    preferredForm?: ReceiptIdForm | null
  ): Array<{ form: ReceiptIdForm; value: string }> {
    const raw = (input || "").trim();
    if (!raw) return [];

    const out: Array<{ form: ReceiptIdForm; value: string }> = [
      { form: "raw", value: raw },
    ];
    const push = (form: ReceiptIdForm, v: string) => {
      const s = v.trim();
      if (s && !out.some((c) => c.value === s)) {
        out.push({ form, value: s });
      }
    };

    const stem = raw.replace(/\.json$/i, "");
    push("stem", stem);

    const m = RECEIPT_KEY_UUID_RE.exec(stem);
    if (m) {
      push("uuid", m[2]);
      push("prefix", m[1]);
    }

    if (preferredForm) {
      const idx = out.findIndex((c) => c.form === preferredForm);
      if (idx > 0) {
        const [promoted] = out.splice(idx, 1);
        out.unshift(promoted);
      }
    }

    return out;
  }

  async getReceiptDetails(transactionId: string): Promise<ReceiptDetails> {
    const q = `
    query GetDigitalReceipt($transactionId: String) {
      receipt(transactionId: $transactionId) {
        receiptImage {
          image
          type
          receiptPoints {
            earned
            newBalance
            oldBalance
            redeemed
          }
        }
        store {
          storeId
          name
          location {
            address {
              city
              houseNumber
              postalCode
              street
            }
          }
        }
        purchaseEndOn
        receiptSource
        customerDetails {
          customerId
          loyaltyCard {
            number
          }
        }
      }
    }
    `;
    // Try each id form the storage key can denote. A null `receipt` is the API
    // saying "no such transaction under this id" -- a rejected request would
    // have thrown from executeGraphql instead -- so it is safe to fall through
    // to the next form. Any real failure propagates unchanged. Once a form hits,
    // remember it so subsequent receipts try the winning form first.
    const candidates = JumboClient.receiptIdTaggedCandidates(
      transactionId,
      this.preferredReceiptIdForm
    );
    let receipt: any = null;
    for (const candidate of candidates) {
      const data = await this.executeGraphql<any>(
        q,
        { transactionId: candidate.value },
        "JUMBO_WEB-orders"
      );
      if (data?.receipt) {
        receipt = data.receipt;
        this.preferredReceiptIdForm = candidate.form;
        break;
      }
    }
    if (!receipt) {
      throw new Error(
        `Receipt not found for transactionId: ${transactionId} ` +
          `(tried ${candidates.length} id form(s): ${candidates.map((c) => c.value).join(", ")})`
      );
    }

    const rawImage = receipt.receiptImage?.image || "{}";
    const parsed = this.parseReceiptDoc(rawImage);

    let storeId = receipt.store?.storeId || "";
    if (!storeId) {
      for (const line of parsed.raw_lines) {
        const sm = line.match(/\bSTORE\s+(\d+)\b/i);
        if (sm) {
          storeId = sm[1];
          break;
        }
      }
    }

    const rp = receipt.receiptImage?.receiptPoints;

    return {
      transaction_id: transactionId,
      datetime: receipt.purchaseEndOn || "",
      store: receipt.store?.name || "",
      store_id: storeId,
      points_earned: rp?.earned ?? 0,
      points_redeemed: rp?.redeemed ?? null,
      points_balance: rp?.newBalance ?? null,
      total: parsed.total,
      amount_paid: parsed.amount_paid,
      returned_deposit: parsed.returned_deposit,
      charged_deposit: parsed.charged_deposit,
      total_discount: parsed.total_discount,
      subtotal: parsed.subtotal,
      payment_method: parsed.payment_method,
      items_count: parsed.items.length,
      items: parsed.items,
      vat_overview: parsed.vat_overview,
      vat_breakdown: parsed.vat_breakdown,
      raw_lines: parsed.raw_lines,
    };
  }

  async searchReceipts(
    query: string,
    maxReceipts: number = 10
  ): Promise<{
    query: string;
    receipts_scanned: number;
    matches: Array<{
      datetime: string;
      store: string;
      transaction_id: string;
      matched_items: ReceiptItem[];
    }>;
  }> {
    const overview = await this.listReceipts(0, maxReceipts);
    const matches: Array<{
      datetime: string;
      store: string;
      transaction_id: string;
      matched_items: ReceiptItem[];
    }> = [];
    const qLower = query.toLowerCase();

    for (const r of overview.receipts) {
      if (!r.transaction_id) continue;
      try {
        const details = await this.getReceiptDetails(r.transaction_id);
        const matchingItems = details.items.filter((it) =>
          it.name.toLowerCase().includes(qLower)
        );
        if (matchingItems.length > 0) {
          matches.push({
            datetime: details.datetime,
            store: details.store,
            transaction_id: r.transaction_id,
            matched_items: matchingItems,
          });
        }
      } catch {
        continue;
      }
    }

    return {
      query,
      receipts_scanned: overview.receipts.length,
      matches,
    };
  }

  async getBalance(): Promise<{ balance: number }> {
    const q = `
    query GetBalance {
      getBalance {
        balance
      }
    }
    `;
    const data = await this.executeGraphql<any>(q, undefined, "JUMBO_WEB-loyalty");
    return data?.getBalance || { balance: 0 };
  }

  /**
   * The GraphQL unions return `ShoppingListError` as a *successful* response
   * (no top-level `errors`), so a mutation that failed semantically still looks
   * like a 200. Always branch on `__typename` and raise, never swallow.
   */
  private raiseIfShoppingListError(value: any, operation: string): void {
    if (value && value.__typename === "ShoppingListError") {
      throw new JumboShoppingListError(
        value.reason || "UNKNOWN",
        value.errorMessage || `Jumbo rejected ${operation}.`
      );
    }
  }

  private mapShoppingListItems(raw: any[]): ShoppingListItem[] {
    return (raw || []).map((i: any) => ({
      id: i.id ?? null,
      term: i.term ?? "",
      sku: i.sku ?? null,
      completed: Boolean(i.completed),
    }));
  }

  async getShoppingList(): Promise<ShoppingList> {
    const q = `
    query GetShoppingList {
      shoppingList {
        __typename
        ... on ShoppingList {
          isActive
          items {
            id
            term
            sku
            completed
          }
        }
        ... on ShoppingListError {
          reason
          errorMessage
        }
      }
    }
    `;
    const data = await this.executeGraphql<any>(q, undefined, "JUMBO_WEB-loyalty");
    const list = data?.shoppingList;
    this.raiseIfShoppingListError(list, "reading the shopping list");
    return {
      isActive: Boolean(list?.isActive),
      items: this.mapShoppingListItems(list?.items),
    };
  }

  /**
   * Add or edit shopping-list items via `mutation EditShoppingListItems`.
   * Returns the resulting item set as echoed by the API.
   */
  async editShoppingListItems(
    input: EditShoppingListItemsInput
  ): Promise<ShoppingListItem[]> {
    if (!input.items || input.items.length === 0) {
      throw new Error("editShoppingListItems requires at least one item.");
    }
    const q = `
    mutation EditShoppingListItems($input: EditShoppingListItemsInput!) {
      editShoppingListItems(input: $input) {
        __typename
        ... on EditShoppingListItemsResult {
          items {
            id
            term
            sku
            completed
          }
        }
        ... on ShoppingListError {
          reason
          errorMessage
        }
      }
    }
    `;
    const data = await this.executeGraphql<any>(q, { input }, "JUMBO_WEB-loyalty");
    const result = data?.editShoppingListItems;
    this.raiseIfShoppingListError(result, "editing shopping-list items");
    if (result?.__typename !== "EditShoppingListItemsResult") {
      throw new JumboShoppingListError(
        "UNEXPECTED_RESULT",
        `Unexpected result type '${result?.__typename ?? "null"}' from editShoppingListItems.`
      );
    }
    return this.mapShoppingListItems(result.items);
  }

  /**
   * Convenience wrapper for the common "add eggs" case: one or more free-text
   * terms, optionally auto-activating an inactive list first.
   */
  async addShoppingListItems(
    terms: string[],
    options?: {
      sku?: string | null;
      completed?: boolean;
      ensureActive?: boolean;
      /** Skip terms already on the list (case-insensitive, trimmed). Default true. */
      dedupe?: boolean;
    }
  ): Promise<{
    isActive: boolean;
    added: ShoppingListItem[];
    activated: boolean;
    skipped: string[];
  }> {
    const cleaned = (terms || [])
      .map((t) => String(t).trim())
      .filter((t) => t.length > 0);
    if (cleaned.length === 0) {
      throw new Error("addShoppingListItems requires at least one non-empty term.");
    }

    const ensureActive = options?.ensureActive ?? true;
    const dedupe = options?.dedupe ?? true;

    const before = await this.getShoppingList();
    let activated = false;
    if (ensureActive && !before.isActive) {
      await this.setShoppingListActive(true);
      activated = true;
    }

    const existing = new Set(before.items.map((i) => i.term.trim().toLowerCase()));
    const skipped: string[] = [];
    const toAdd: string[] = [];
    for (const term of cleaned) {
      const key = term.toLowerCase();
      const alreadyThere =
        existing.has(key) || toAdd.some((t) => t.toLowerCase() === key);
      if (dedupe && alreadyThere) {
        skipped.push(term);
        continue;
      }
      toAdd.push(term);
    }

    const added = toAdd.length
      ? await this.editShoppingListItems({
          items: toAdd.map((term) => ({
            term,
            ...(options?.sku ? { sku: options.sku } : {}),
            completed: options?.completed ?? false,
          })),
        })
      : [];

    const list = await this.getShoppingList();
    return { isActive: list.isActive, added, activated, skipped };
  }

  /** Activate/deactivate the shopping list via `mutation toggleShoppingList`. */
  async setShoppingListActive(active: boolean): Promise<boolean> {
    const q = `
    mutation toggleShoppingList($input: ToggleShoppingListInput!) {
      toggleShoppingList(input: $input) {
        __typename
        ... on ShoppingListState {
          isActive
        }
        ... on ShoppingListError {
          reason
          errorMessage
        }
      }
    }
    `;
    const data = await this.executeGraphql<any>(
      q,
      { input: { active } },
      "JUMBO_WEB-loyalty"
    );
    const result = data?.toggleShoppingList;
    this.raiseIfShoppingListError(result, "toggling the shopping list");
    if (result?.__typename !== "ShoppingListState") {
      throw new JumboShoppingListError(
        "UNEXPECTED_RESULT",
        `Unexpected result type '${result?.__typename ?? "null"}' from toggleShoppingList.`
      );
    }
    return Boolean(result.isActive);
  }

  async searchStores(options?: {
    query?: string;
    latitude?: number;
    longitude?: number;
  }): Promise<{
    searched_location: { latitude: string; longitude: string };
    total_found: number;
    stores: StoreInfo[];
  }> {
    const coords = await resolveCoordinates(
      options?.query,
      options?.latitude,
      options?.longitude
    );

    const q = `
    query GetStoreList($input: StoresByCoordinatesInput!) {
      storesByCoordinates(input: $input) {
        stores {
          storeId
          name
          distance
          location {
            address {
              street
              houseNumber
              city
              postalCode
            }
          }
          openingHours {
            monday { opensAt closesAt }
            tuesday { opensAt closesAt }
            wednesday { opensAt closesAt }
            thursday { opensAt closesAt }
            friday { opensAt closesAt }
            saturday { opensAt closesAt }
            sunday { opensAt closesAt }
          }
          facilities {
            locationType
          }
        }
        totalCount
      }
    }
    `;

    const data = await this.executeGraphql<any>(
      q,
      { input: { latitude: coords.lat, longitude: coords.lon } },
      "JUMBO_WEB-loyalty"
    );

    const rawStores = data?.storesByCoordinates?.stores || [];
    const stores: StoreInfo[] = rawStores.map((s: any) => ({
      storeId: s.storeId,
      name: s.name,
      distanceKm: s.distance ? parseFloat(s.distance) : null,
      address: {
        street: s.location?.address?.street,
        houseNumber: s.location?.address?.houseNumber,
        city: s.location?.address?.city,
        postalCode: s.location?.address?.postalCode,
      },
      openingHours: s.openingHours,
      locationType: s.facilities?.locationType,
    }));

    return {
      searched_location: { latitude: coords.lat, longitude: coords.lon },
      total_found: data?.storesByCoordinates?.totalCount ?? stores.length,
      stores,
    };
  }

  async getProductRecommendations(options?: {
    sku?: string;
    query?: string;
    promotionsOnly?: boolean;
  }): Promise<ProductRecommendationsResult> {
    const promotionsOnly = options?.promotionsOnly ?? false;

    if (promotionsOnly || (!options?.sku && !options?.query)) {
      const promoQ = `
      query getPromotions {
        promotionTab(id: "actieprijs") {
          runtimes {
            sections {
              promotions {
                products {
                  title
                  sku
                  price { price promoPrice }
                }
              }
            }
          }
        }
      }
      `;
      const data = await this.executeGraphql<any>(promoQ, {}, "JUMBO_WEB-loyalty");
      const proms: RecommendedProduct[] = [];
      const runtimes = data?.promotionTab?.runtimes || [];
      for (const rt of runtimes) {
        for (const sec of rt.sections || []) {
          for (const p of sec.promotions || []) {
            for (const pr of p.products || []) {
              if (pr && pr.sku) {
                proms.push({
                  sku: pr.sku,
                  title: pr.title,
                  price: pr.price ? { price: pr.price.price, promoPrice: pr.price.promoPrice } : null,
                });
              }
            }
          }
        }
      }
      return {
        alternatives: [],
        promotions: proms.slice(0, 15),
      };
    }

    let targetSku = options?.sku;
    let sourceProduct: RecommendedProduct | undefined;

    if (!targetSku && options?.query) {
      const searchQ = `
      query SearchProductsByKeyword($input: ProductSearchInput!) {
        searchProducts(input: $input) {
          products {
            title
            sku
            price { price promoPrice }
            promotions { tags { text } }
          }
        }
      }
      `;
      const searchRes = await this.executeGraphql<any>(
        searchQ,
        { input: { searchType: "KEYWORD", searchTerms: options.query } },
        "JUMBO_WEB-loyalty"
      );
      const found = searchRes?.searchProducts?.products || [];
      if (found.length > 0) {
        targetSku = found[0].sku;
        sourceProduct = {
          sku: found[0].sku,
          title: found[0].title,
          price: found[0].price ? { price: found[0].price.price, promoPrice: found[0].price.promoPrice } : null,
          promotions: found[0].promotions?.flatMap((p: any) => p.tags?.map((t: any) => t.text) || []) || [],
        };
      } else {
        return {
          sourceProduct: null,
          alternatives: [],
          crossSells: [],
        };
      }
    }

    if (!targetSku) {
      return { alternatives: [] };
    }

    const detailQ = `
    query ProductDetail($sku: String!) {
      product(sku: $sku) {
        title
        sku
        price { price promoPrice }
        alternatives {
          title
          sku
          price { price promoPrice }
        }
        crossSells {
          title
          sku
          price { price promoPrice }
        }
      }
    }
    `;
    const detailRes = await this.executeGraphql<any>(detailQ, { sku: targetSku }, "JUMBO_WEB-loyalty");
    const prod = detailRes?.product;

    if (prod && !sourceProduct) {
      sourceProduct = {
        sku: prod.sku,
        title: prod.title,
        price: prod.price ? { price: prod.price.price, promoPrice: prod.price.promoPrice } : null,
      };
    }

    const alternatives: RecommendedProduct[] = (prod?.alternatives || []).map((a: any) => ({
      sku: a.sku,
      title: a.title,
      price: a.price ? { price: a.price.price, promoPrice: a.price.promoPrice } : null,
    }));

    const crossSells: RecommendedProduct[] = (prod?.crossSells || []).map((c: any) => ({
      sku: c.sku,
      title: c.title,
      price: c.price ? { price: c.price.price, promoPrice: c.price.promoPrice } : null,
    }));

    return {
      sourceProduct: sourceProduct || null,
      alternatives,
      crossSells,
    };
  }

  async searchProducts(options: {
    query: string;
    sort?: "PRICE_ASC" | "PRICE_DESC";
    limit?: number;
  }): Promise<ProductSearchResult> {
    const q = `
    query SearchProductsByKeyword($input: ProductSearchInput!) {
      searchProducts(input: $input) {
        count
        products {
          title
          sku
          link
          price {
            price
            promoPrice
            pricePerUnit {
              price
            }
          }
          availability {
            isAvailable
          }
          promotions {
            tags {
              text
            }
          }
        }
      }
    }
    `;

    const input: Record<string, any> = {
      searchType: "KEYWORD",
      searchTerms: options.query,
    };
    if (options.sort) {
      input.sort = options.sort;
    }

    const limit = Math.min(
      Math.max(1, Math.trunc(options.limit ?? 25)),
      JUMBO_SEARCH_MAX_LIMIT
    );
    input.limit = limit;

    const res = await this.executeGraphql<any>(q, { input }, "JUMBO_WEB-loyalty");
    const rawProducts = res?.searchProducts?.products || [];

    const products: ProductSearchItem[] = rawProducts.slice(0, limit).map((p: any) => {
      const priceCents = p.price?.price ?? 0;
      const promoCents = p.price?.promoPrice ?? null;
      const unitCents = p.price?.pricePerUnit?.price ?? null;
      const tags: string[] = p.promotions?.flatMap((pr: any) => pr.tags?.map((t: any) => t.text) || []) || [];

      return {
        sku: p.sku,
        title: p.title,
        url: p.link ? `https://www.jumbo.com${p.link}` : "",
        price: priceCents,
        price_formatted: `€${(priceCents / 100).toFixed(2)}`,
        promo_price: promoCents,
        promo_price_formatted: promoCents !== null ? `€${(promoCents / 100).toFixed(2)}` : null,
        unit_price: unitCents,
        unit_price_formatted: unitCents !== null ? `€${(unitCents / 100).toFixed(2)}` : null,
        is_available: p.availability?.isAvailable ?? true,
        promotions: tags,
      };
    });

    const totalCount = res?.searchProducts?.count ?? products.length;

    return {
      query: options.query,
      total_count: totalCount,
      // Jumbo has no offset/cursor, so a result set larger than the 200-product
      // window can only be reported as partial — never silently as complete.
      truncated: totalCount > products.length,
      products,
    };
  }

  /**
   * Keyword product search used by the promo digest. Selects the offer-bearing
   * fields `SearchProductDetails` proves exist on `Product` (price, unit price,
   * promotions with validity + volume discounts) — nothing invented.
   */
  private async searchProductForDigest(term: string): Promise<any | null> {
    const q = `
    query PromoDigestSearch($input: ProductSearchInput!) {
      searchProducts(input: $input) {
        count
        products {
          sku
          title
          link
          category: rootCategory
          price {
            price
            promoPrice
            pricePerUnit {
              price
              unit
            }
          }
          availability {
            isAvailable
          }
          promotions {
            id
            group
            tags {
              text
            }
            start {
              date
            }
            end {
              date
            }
            durationTexts {
              shortTitle
            }
            volumeDiscounts {
              discount
              volume
            }
            maxPromotionQuantity
          }
        }
      }
    }
    `;
    const res = await this.executeGraphql<any>(
      q,
      { input: { searchType: "KEYWORD", searchTerms: term } },
      "JUMBO_WEB-loyalty"
    );
    let products = res?.searchProducts?.products;
    if (Array.isArray(products) && products.length > 0) {
      return products[0];
    }

    // Fallback: if search by literal term returned 0 hits, try stripped store brand
    const stripped = term.replace(/^JUMBO['’S]*\s+/i, "").trim();
    if (stripped && stripped !== term) {
      const resFallback = await this.executeGraphql<any>(
        q,
        { input: { searchType: "KEYWORD", searchTerms: stripped } },
        "JUMBO_WEB-loyalty"
      );
      products = resFallback?.searchProducts?.products;
      if (Array.isArray(products) && products.length > 0) {
        return products[0];
      }
    }

    return null;
  }

  /** Personalised, account-level offers (not tied to one product). */
  private async getAccountOffers(): Promise<DigestAccountOffer[]> {
    const q = `
    query PromoDigestCustomerPromotions {
      getCustomerPromotions {
        id
        active
        canBeRedeemed
        description
        expirationDate
        eurosDiscount
        percentageDiscount
        minimumSpent
        startDate
        title
      }
    }
    `;
    const res = await this.executeGraphql<any>(q, undefined, "JUMBO_WEB-loyalty");
    const list = res?.getCustomerPromotions;
    if (!Array.isArray(list)) return [];
    return list
      .filter((p: any) => p && p.active !== false)
      .slice(0, 25)
      .map((p: any) => ({
        id: p.id ?? null,
        title: p.title ?? null,
        description: p.description ?? null,
        euros_discount: p.eurosDiscount ?? null,
        percentage_discount: p.percentageDiscount ?? null,
        minimum_spent: p.minimumSpent ?? null,
        expires_on: p.expirationDate ?? null,
      }));
  }

  /** Shape one mined term into a digest row. Pure mapping — no I/O. */
  private toDigestEntry(term: string, timesBought: number, p: any): PromoDigestEntry {
    const rawPromos = Array.isArray(p?.promotions) ? p.promotions : [];
    const promoTypes: string[] = [];
    const promotions: DigestPromotion[] = rawPromos.map((pr: any) => {
      const tags: string[] = (pr?.tags || [])
        .map((t: any) => t?.text)
        .filter((t: any): t is string => typeof t === "string" && t.length > 0);
      for (const t of tags) if (!promoTypes.includes(t)) promoTypes.push(t);
      return {
        id: pr?.id ?? null,
        group: pr?.group ?? null,
        tags,
        short_title: pr?.durationTexts?.shortTitle ?? null,
        starts_on: pr?.start?.date ?? null,
        ends_on: pr?.end?.date ?? null,
        volume_discounts: (pr?.volumeDiscounts || []).map((v: any) => ({
          discount: v?.discount ?? null,
          volume: v?.volume ?? null,
        })),
        max_promotion_quantity: pr?.maxPromotionQuantity ?? null,
      };
    });

    const was = p?.price?.price ?? null;
    const now = p?.price?.promoPrice ?? null;
    const discount = was !== null && now !== null && now < was ? was - now : null;
    const pct = discount !== null && was ? Math.round((discount / was) * 100) : null;
    const starts = promotions.map((x) => x.starts_on).filter((d): d is string => !!d).sort();
    const ends = promotions.map((x) => x.ends_on).filter((d): d is string => !!d).sort();

    return {
      term,
      times_bought: timesBought,
      product: p
        ? {
            sku: p.sku ?? "",
            title: p.title ?? "",
            url: p.link ? `https://www.jumbo.com${p.link}` : "",
            category: p.category ?? null,
          }
        : null,
      was_price: was,
      now_price: now,
      discount,
      discount_percent: pct,
      unit_price: p?.price?.pricePerUnit?.price ?? null,
      unit: p?.price?.pricePerUnit?.unit ?? null,
      promo_types: promoTypes,
      promotions,
      is_available: p?.availability?.isAvailable ?? false,
      valid_from: starts.length > 0 ? starts[0] : null,
      valid_until: ends.length > 0 ? ends[ends.length - 1] : null,
    };
  }

  /**
   * Small jittered pause between digest API calls (120-200ms). The digest issues
   * back-to-back requests — up to one per scanned receipt plus one search per
   * frequent term — so this keeps the mine from hammering Jumbo's API in a burst.
   * Timing only; results stay deterministic.
   */
  private async digestPause(): Promise<void> {
    const ms = 120 + Math.floor(Math.random() * 80);
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * "Of the things I actually buy, what is on offer right now?"
   *
   * Read-only and deterministic: mines recent receipts for purchase frequency,
   * resolves each frequent basket term to a current assortment product via
   * `searchProducts`, and reports the offer price/validity the product carries.
   * Side-effect free — it never writes, never builds a basket, never checks out.
   */
  async getPromoDigest(
    options: {
      days?: number;
      minTimes?: number;
      limit?: number;
      category?: string;
      /** Hard cap on receipt-detail fetches (one request per receipt). */
      maxReceipts?: number;
    } = {}
  ): Promise<PromoDigest> {
    const days = options.days ?? 90;
    const minTimes = options.minTimes ?? 2;
    const limit = options.limit ?? 25;
    const category = options.category?.trim() ? options.category.trim().toLowerCase() : null;
    const maxReceipts = Math.max(1, options.maxReceipts ?? 40);
    const notes: string[] = [];

    // ---- 1. mine recent receipts for what the customer actually buys
    const cutoff = Date.now() - days * 86_400_000;
    const PAGE = 25;
    const receipts: ReceiptOverviewItem[] = [];
    let available = 0;
    for (let page = 0; page < 10 && receipts.length < maxReceipts; page++) {
      let overview: { total_results: number; receipts: ReceiptOverviewItem[] };
      try {
        overview = await this.listReceipts(page, PAGE);
      } catch (e: any) {
        notes.push(`receipt lookup stopped at page ${page}: ${e.message}`);
        break;
      }
      available = overview.total_results ?? available;
      if (!overview.receipts.length) break;
      let stop = false;
      for (const r of overview.receipts) {
        const t = Date.parse(r.datetime);
        if (!Number.isNaN(t) && t < cutoff) {
          stop = true;
          break;
        }
        receipts.push(r);
        if (receipts.length >= maxReceipts) {
          stop = true;
          break;
        }
      }
      if (stop) break;
    }

    // ---- 2. count distinct basket terms across those receipts
    const counts = new Map<string, { display: string; n: number }>();
    for (const r of receipts) {
      let d: ReceiptDetails;
      try {
        await this.digestPause();
        d = await this.getReceiptDetails(r.transaction_id);
      } catch {
        continue;
      }
      for (const item of d.items) {
        // Only count actual grocery items: skip discounts, bottle deposits, and non-product line items
        if (
          item.price <= 0 ||
          item.name.toUpperCase() === "STATIEGELD" ||
          /^\d+\s*X\b/i.test(item.name)
        ) {
          continue;
        }

        const key = normalizeTerm(item.name);
        if (!key) continue;
        const qty = item.quantity > 0 ? item.quantity : 1;
        const existing = counts.get(key);
        if (existing) existing.n += qty;
        else counts.set(key, { display: item.name.trim(), n: qty });
      }
    }

    const frequent = [...counts.values()]
      .filter((e) => e.n >= minTimes)
      .sort((a, b) => b.n - a.n || a.display.localeCompare(b.display));

    // ---- 3. resolve each frequent term and keep the ones currently on offer
    const matched: PromoDigestEntry[] = [];
    const notMatched: string[] = [];
    for (const f of frequent) {
      let product: any = null;
      try {
        await this.digestPause();
        product = await this.searchProductForDigest(f.display);
      } catch {
        product = null;
      }
      const entry = this.toDigestEntry(f.display, f.n, product);
      if (category) {
        const cat = (entry.product?.category || "").toLowerCase();
        if (!cat.includes(category)) continue; // out of the requested category
      }
      if (entry.product && entry.promo_types.length > 0) matched.push(entry);
      else notMatched.push(f.display);
    }

    matched.sort(
      (a, b) =>
        b.times_bought - a.times_bought ||
        (b.discount ?? 0) - (a.discount ?? 0) ||
        a.term.localeCompare(b.term)
    );
    const limited = matched.slice(0, limit);

    // ---- 4. supplementary account-level offers
    let accountOffers: DigestAccountOffer[] = [];
    try {
      accountOffers = await this.getAccountOffers();
    } catch (e: any) {
      notes.push(`customer promotions unavailable: ${e.message}`);
    }

    notes.push(
      `Resolution is one keyword search per frequent term; the top hit is used. ${frequent.length} frequent term(s) scanned.`
    );
    notes.push(
      `Receipt mining is capped at the ${maxReceipts} most recent receipt(s) inside ${days} day(s).`
    );

    return {
      days,
      min_times: minTimes,
      limit,
      category,
      matched: limited,
      not_matched: notMatched,
      matched_count: limited.length,
      not_matched_count: notMatched.length,
      account_offers: accountOffers,
      scanned: {
        receipts_scanned: receipts.length,
        receipts_available: available,
        distinct_terms: counts.size,
        frequent_terms: frequent.length,
      },
      notes,
    };
  }

  /** Generic union unwrap: raise on the `*Error` member, enforce the success member. */
  private unwrapUnion<T = any>(
    value: any,
    successTypes: string[],
    operation: string
  ): T {
    const tn = value?.__typename;
    if (typeof tn === "string" && tn.endsWith("Error")) {
      throw new JumboApiError(
        tn,
        value.reason ?? "UNKNOWN",
        value.errorMessage ?? value.message ?? `Jumbo rejected ${operation}.`
      );
    }
    if (typeof tn !== "string" || !successTypes.includes(tn)) {
      throw new JumboApiError(
        tn ?? "Unknown",
        "UNEXPECTED_RESULT",
        `Unexpected result type '${tn ?? "null"}' from ${operation}.`
      );
    }
    return value as T;
  }

  /** Remove shopping-list items by id. `ShoppingListItemIdsResult | ShoppingListError`. */
  async removeShoppingListItems(itemIds: string[]): Promise<string[]> {
    const ids = (itemIds || []).map((s) => String(s).trim()).filter(Boolean);
    if (ids.length === 0) {
      throw new Error("removeShoppingListItems requires at least one item id.");
    }
    const q = `
    mutation RemoveShoppingListItems($input: RemoveShoppingListItemsInput!) {
      removeShoppingListItems(input: $input) {
        __typename
        ... on ShoppingListItemIdsResult {
          itemIds
        }
        ... on ShoppingListError {
          reason
          errorMessage
        }
      }
    }
    `;
    const data = await this.executeGraphql<any>(
      q,
      { input: { shoppingListItemIds: ids } },
      "JUMBO_WEB-loyalty"
    );
    const result = data?.removeShoppingListItems;
    this.raiseIfShoppingListError(result, "removing shopping-list items");
    if (result?.__typename !== "ShoppingListItemIdsResult") {
      throw new JumboShoppingListError(
        "UNEXPECTED_RESULT",
        `Unexpected result type '${result?.__typename ?? "null"}' from removeShoppingListItems.`
      );
    }
    return result.itemIds ?? [];
  }

  /**
   * Tick an item off (or back on). Looks the item up first so the edit payload
   * carries the server's own `term`/`sku` alongside `completed`.
   */
  async setShoppingListItemCompleted(
    itemId: string,
    completed: boolean
  ): Promise<ShoppingListItem[]> {
    const list = await this.getShoppingList();
    const item = list.items.find((i) => i.id === itemId);
    if (!item) {
      throw new JumboShoppingListError(
        "ITEM_NOT_FOUND",
        `No shopping-list item with id '${itemId}'.`
      );
    }
    const input: ShoppingListItemInput = {
      term: item.term,
      completed,
      ...(item.id ? { id: item.id } : {}),
      ...(item.sku ? { sku: item.sku } : {}),
    };
    return this.editShoppingListItems({ items: [input] });
  }

  /** Read-only active basket via the GraphQL `ActiveBasket` operation. */
  async getBasket(): Promise<Basket> {
    // NOTE: the app's own document declares `$voucherCodes, $shippingCosts,
    // $orderChannel, $customerId` but uses none of them, and Apollo Client strips
    // unused variables before sending. We must not declare or send them: Jumbo's
    // router rejects the request with GRAPHQL_VALIDATION_FAILED
    // ("Variable \"$orderChannel\" is never used.").
    const q = `
    query ActiveBasket {
      activeBasket {
        __typename
        ... on ActiveBasketResult {
          basket {
            id
            totalProductCount
            lines {
              sku
              id
              quantity
              details {
                title
                price {
                  price
                  promoPrice
                }
                promotions {
                  tags {
                    text
                  }
                }
              }
            }
            calculation {
              totals {
                itemSubtotal {
                  amount
                  currency
                }
                totalToPay {
                  amount
                  currency
                }
              }
            }
          }
        }
        ... on BasketError {
          reason
          errorMessage
        }
      }
    }
    `;
    const data = await this.executeGraphql<any>(q, undefined, "JUMBO_WEB-basket");
    const res = this.unwrapUnion<any>(
      data?.activeBasket,
      ["ActiveBasketResult"],
      "reading the active basket"
    );
    const b = res.basket;
    const lines = (b?.lines ?? []).map((l: any) => {
      const d = l.details ?? {};
      const unit = d.price?.price ?? null;
      const promo = d.price?.promoPrice ?? null;
      const qty = l.quantity ?? 0;
      const effective = promo ?? unit;
      return {
        sku: l.sku ?? null,
        id: l.id ?? null,
        title: d.title ?? "",
        quantity: qty,
        unit_price: unit,
        promo_price: promo,
        line_total: effective !== null ? effective * qty : null,
        promotions: (d.promotions ?? []).flatMap(
          (p: any) => (p.tags ?? []).map((t: any) => t.text).filter(Boolean)
        ),
      };
    });
    const totals = b?.calculation?.totals;
    return {
      id: b?.id ?? null,
      total_product_count:
        b?.totalProductCount ?? lines.reduce((a: number, l: any) => a + l.quantity, 0),
      lines,
      subtotal: totals?.itemSubtotal?.amount ?? null,
      total_to_pay: totals?.totalToPay?.amount ?? null,
      currency: totals?.itemSubtotal?.currency ?? null,
    };
  }

  /**
   * Deposits (statiegeld) for a single order. `GetDeposits` requires an orderId:
   * `deposits` is the global catalogue, `returnedDeposits(orderId:)` is per-order.
   */
  async getDeposits(orderId: string): Promise<DepositsResult> {
    const id = String(orderId ?? "").trim();
    if (!id) throw new Error("getDeposits requires an orderId.");
    const q = `
    query GetDeposits($orderId: String!) {
      deposits {
        sku
        description
        category
        chargeType
        unitPrice {
          amount
          currency
        }
      }
      returnedDeposits(orderId: $orderId) {
        __typename
        ... on ReturnedDepositsResponseSuccess {
          returnedDeposits {
            sku
            price {
              amount
              currency
            }
            returnedByCustomerQuantity
          }
          returnedDepositsTotalAmount {
            amount
            currency
          }
        }
      }
    }
    `;
    const data = await this.executeGraphql<any>(q, { orderId: id }, "JUMBO_WEB-orders");

    // The error member's fields are not in the teardown, so only __typename is
    // selected above; surface it verbatim rather than guessing at a message.
    const returned = data?.returnedDeposits;
    if (returned?.__typename && returned.__typename !== "ReturnedDepositsResponseSuccess") {
      throw new JumboApiError(
        returned.__typename,
        returned.reason ?? "UNKNOWN",
        returned.errorMessage ?? `returnedDeposits returned '${returned.__typename}'.`
      );
    }

    return {
      order_id: id,
      deposits: (data?.deposits ?? []).map((d: any) => ({
        sku: d.sku,
        description: d.description ?? "",
        category: d.category ?? null,
        charge_type: d.chargeType ?? null,
        unit_price: d.unitPrice?.amount ?? null,
        currency: d.unitPrice?.currency ?? null,
      })),
      returned: {
        items: (returned?.returnedDeposits ?? []).map((r: any) => ({
          sku: r.sku,
          unit_price: r.price?.amount ?? null,
          currency: r.price?.currency ?? null,
          returned_quantity: r.returnedByCustomerQuantity ?? null,
        })),
        total: returned?.returnedDepositsTotalAmount?.amount ?? null,
        currency: returned?.returnedDepositsTotalAmount?.currency ?? null,
      },
    };
  }

  /**
   * Statiegeld summary across store receipts: calculates returned deposits (emballage)
   * and charged deposits across receipts in a date range or calendar year.
   */
  async getStatiegeldSummary(options?: {
    startDate?: string;
    endDate?: string;
    year?: number;
    maxReceipts?: number;
  }): Promise<StatiegeldSummaryResult> {
    const maxReceipts = options?.maxReceipts ?? 50;
    const pageSize = 25;
    let page = 0;
    const matchingReceipts: ReceiptOverviewItem[] = [];

    while (matchingReceipts.length < maxReceipts) {
      const overview = await this.listReceipts(page, pageSize);
      if (!overview.receipts || overview.receipts.length === 0) break;

      let reachedOlderThanRange = false;
      for (const r of overview.receipts) {
        const dateStr = r.datetime.slice(0, 10);
        if (options?.year && !r.datetime.startsWith(String(options.year))) {
          if (r.datetime < String(options.year)) {
            reachedOlderThanRange = true;
            break;
          }
          continue;
        }
        if (options?.startDate && dateStr < options.startDate) {
          reachedOlderThanRange = true;
          break;
        }
        if (options?.endDate && dateStr > options.endDate) {
          continue;
        }
        matchingReceipts.push(r);
        if (matchingReceipts.length >= maxReceipts) break;
      }

      if (reachedOlderThanRange) break;
      if (overview.receipts.length < pageSize) break;
      page++;
    }

    let totalReturned = 0;
    let totalCharged = 0;
    let tripsReturned = 0;
    let tripsCharged = 0;
    const entries: StatiegeldReceiptEntry[] = [];

    for (const r of matchingReceipts) {
      if (!r.transaction_id) continue;
      let details: ReceiptDetails;
      try {
        details = await this.getReceiptDetails(r.transaction_id);
      } catch {
        continue;
      }

      const ret = details.returned_deposit ?? 0;
      const chg = details.charged_deposit ?? 0;
      if (ret > 0) tripsReturned++;
      if (chg > 0) tripsCharged++;
      totalReturned += ret;
      totalCharged += chg;

      if (ret > 0 || chg > 0) {
        entries.push({
          datetime: details.datetime,
          transaction_id: details.transaction_id,
          store: details.store,
          returned_deposit: details.returned_deposit,
          charged_deposit: details.charged_deposit,
          net_deposit: Math.round((ret - chg) * 100) / 100,
          amount_paid: details.amount_paid,
          total: details.total,
        });
      }
    }

    totalReturned = Math.round(totalReturned * 100) / 100;
    totalCharged = Math.round(totalCharged * 100) / 100;
    const netReturned = Math.round((totalReturned - totalCharged) * 100) / 100;

    return {
      period: {
        start_date: options?.startDate || null,
        end_date: options?.endDate || null,
        year: options?.year || null,
      },
      receipts_scanned: matchingReceipts.length,
      trips_with_returned_deposit: tripsReturned,
      trips_with_charged_deposit: tripsCharged,
      total_returned: totalReturned,
      total_charged: totalCharged,
      net_returned: netReturned,
      receipts: entries,
    };
  }

  /** Digital stamps: per-campaign stamp counts, active saving campaigns, buying-stamp balance. */
  async getStamps(): Promise<StampsResult> {
    const q = `
    query GetStamps {
      getDigitalStamps {
        digitalStamps {
          campaignId
          numberStamps
        }
      }
      getCampaigns(active: true, campaignType: "SAVING") {
        active
        id
        title
        campaignCode
        campaignData {
          numberOfStampsPerCard
          stampsNeededForRedemption {
            stamps
            subTitle
          }
          stampType
        }
      }
      getBuyingStampsBalance {
        monetaryValue
        amountOfStamps
        amountOfStampsPerCard
      }
    }
    `;
    const data = await this.executeGraphql<any>(q, undefined, "JUMBO_WEB-loyalty");
    return {
      digital_stamps: (data?.getDigitalStamps?.digitalStamps ?? []).map((s: any) => ({
        campaign_id: s.campaignId,
        number_stamps: s.numberStamps ?? 0,
      })),
      saving_campaigns: (data?.getCampaigns ?? []).map((c: any) => ({
        id: c.id,
        title: c.title ?? "",
        campaign_code: c.campaignCode ?? null,
        active: Boolean(c.active),
        stamps_needed_for_redemption:
          c.campaignData?.stampsNeededForRedemption?.stamps ?? null,
        number_of_stamps_per_card: c.campaignData?.numberOfStampsPerCard ?? null,
        stamp_type: c.campaignData?.stampType ?? null,
        starts_at: null,
        ends_at: null,
      })),
      buying_stamps: data?.getBuyingStampsBalance
        ? {
            monetary_value: data.getBuyingStampsBalance.monetaryValue ?? null,
            amount_of_stamps: data.getBuyingStampsBalance.amountOfStamps ?? null,
            amount_of_stamps_per_card:
              data.getBuyingStampsBalance.amountOfStampsPerCard ?? null,
          }
        : null,
    };
  }

  /**
   * Resolve a pay-by-link record (`PaymentLink`). The response is a success
   * envelope with an inner `result`; `success:false` carries the reason in
   * `code`/`error.errorMessage` and is raised, never returned as data.
   *
   * Client name: the link page is served by the orders app, which is also what
   * `x-source` advertises for the other order queries.
   */
  async getPaymentLink(linkId: string): Promise<PaymentLinkRecord> {
    const id = String(linkId ?? "").trim();
    if (!id) throw new Error("getPaymentLink requires a link id.");
    const q = `
    query PaymentLink($input: PaymentLinkInput!) {
      paymentLink(input: $input) {
        success
        code
        error {
          errorMessage
        }
        result {
          uuid
          status
          result
          url
          paymentReference
          amount {
            amount
            currency
          }
          retryPaymentUrl
          description
        }
      }
    }
    `;
    const data = await this.executeGraphql<any>(
      q,
      { input: { linkId: id } },
      "JUMBO_WEB-orders"
    );
    const payload = data?.paymentLink;
    if (!payload) {
      throw new JumboApiError(
        "PaymentLink",
        "UNEXPECTED_RESULT",
        "paymentLink returned no payload."
      );
    }
    if (payload.success === false) {
      throw new JumboApiError(
        "PaymentLinkError",
        payload.code ?? "UNKNOWN",
        payload.error?.errorMessage ??
          `Jumbo rejected the payment-link lookup (${payload.code ?? "unknown"}).`
      );
    }
    const r = payload.result;
    if (!r) {
      throw new JumboApiError(
        "PaymentLink",
        "UNEXPECTED_RESULT",
        "paymentLink returned no result."
      );
    }
    return {
      link_id: r.uuid ?? id,
      status: r.status ?? null,
      result: r.result ?? null,
      url: r.url ?? null,
      retry_url: r.retryPaymentUrl ?? null,
      payment_reference: r.paymentReference ?? null,
      description: r.description ?? null,
      amount:
        r.amount?.amount != null
          ? { amount: r.amount.amount, currency: r.amount.currency ?? "EUR" }
          : null,
    };
  }

  /**
   * Read an order's payment handle: `paymentLink { url isAuthorized }`. The
   * `isAuthorized` flag is the settlement cross-check — it advances from the PSP
   * webhook, while the link entity may only advance when a browser lands on the
   * result page.
   *
   * `orderId` is a Float in Jumbo's schema, not an ID. `$orderChannel` and
   * `$customerId` are declared by the web document but unused in its body, and
   * Apollo strips unused variables before sending — declaring them here would
   * earn a GRAPHQL_VALIDATION_FAILED.
   */
  async getOrderPayment(orderId: string | number): Promise<OrderPaymentInfo> {
    const id = Number(orderId);
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error("getOrderPayment requires a positive numeric order id.");
    }
    const q = `
    query OrderPayment($orderId: Float!, $mergeItemsWithSameSkuAndPrice: Boolean! = true) {
      order(orderId: $orderId, options: {mergeItemsWithSameSkuAndPrice: $mergeItemsWithSameSkuAndPrice}) {
        orderId
        fulfilmentType
        paymentMethod
        paymentLink {
          url
          isAuthorized
        }
      }
    }
    `;
    const data = await this.executeGraphql<any>(q, { orderId: id }, "JUMBO_WEB-orders");
    const order = data?.order;
    if (!order) {
      throw new JumboApiError("OrderPayment", "NOT_FOUND", `No order found for orderId ${id}.`);
    }
    return {
      order_id: order.orderId != null ? String(order.orderId) : String(id),
      fulfilment_type: order.fulfilmentType ?? null,
      payment_method: order.paymentMethod ?? null,
      pay_url: order.paymentLink?.url ?? null,
      is_authorized:
        typeof order.paymentLink?.isAuthorized === "boolean"
          ? order.paymentLink.isAuthorized
          : null,
    };
  }
}

/** Receipt terms are compared lowercase, trimmed, ignoring the printed promo marker. */
function normalizeTerm(name: string): string {
  return (name || "")
    .replace(/\s+p\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const DUTCH_CITIES: Record<string, { lat: number; lon: number }> = {
  amsterdam: { lat: 52.3676, lon: 4.9041 },
  rotterdam: { lat: 51.9244, lon: 4.4777 },
  "den haag": { lat: 52.0705, lon: 4.3007 },
  "'s-gravenhage": { lat: 52.0705, lon: 4.3007 },
  utrecht: { lat: 52.0907, lon: 5.1214 },
  eindhoven: { lat: 51.4416, lon: 5.4697 },
  groningen: { lat: 53.2194, lon: 6.5665 },
  tilburg: { lat: 51.5719, lon: 5.0672 },
  almere: { lat: 52.3702, lon: 5.2144 },
  breda: { lat: 51.5719, lon: 4.7683 },
  nijmegen: { lat: 51.8126, lon: 5.8372 },
  enschede: { lat: 52.2215, lon: 6.8937 },
  haarlem: { lat: 52.3874, lon: 4.6462 },
  arnhem: { lat: 51.9851, lon: 5.8987 },
  amersfoort: { lat: 52.1561, lon: 5.3878 },
  apeldoorn: { lat: 52.2112, lon: 5.9699 },
  "den bosch": { lat: 51.6978, lon: 5.3037 },
  "'s-hertogenbosch": { lat: 51.6978, lon: 5.3037 },
  maastricht: { lat: 50.8514, lon: 5.691 },
  leiden: { lat: 52.1601, lon: 4.497 },
  dordrecht: { lat: 51.8133, lon: 4.6901 },
  zoetermeer: { lat: 52.0607, lon: 4.494 },
  zwolle: { lat: 52.5168, lon: 6.083 },
  deventer: { lat: 52.255, lon: 6.162 },
  delft: { lat: 52.0116, lon: 4.3571 },
  alkmaar: { lat: 52.6324, lon: 4.7534 },
  venlo: { lat: 51.37, lon: 6.1724 },
  leeuwarden: { lat: 53.2012, lon: 5.7999 },
};

async function resolveCoordinates(
  query?: string,
  latitude?: number,
  longitude?: number
): Promise<{ lat: string; lon: string }> {
  if (latitude !== undefined && longitude !== undefined) {
    return { lat: String(latitude), lon: String(longitude) };
  }
  if (query && query.trim()) {
    const q = query.trim().toLowerCase();
    if (DUTCH_CITIES[q]) {
      return {
        lat: DUTCH_CITIES[q].lat.toFixed(4),
        lon: DUTCH_CITIES[q].lon.toFixed(4),
      };
    }
    try {
      const geoUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
        query + ", Netherlands"
      )}&format=json&limit=1`;
      const data = await geocodeCache.wrap<any[]>(
        cacheKey("GET https://nominatim.openstreetmap.org/search", [query]),
        CACHE_TTL.geocode,
        async () => {
          const res = await fetch(geoUrl, {
            headers: { "User-Agent": "jumbo-mcp/0.5.0" },
          });
          // A failed lookup must not be cached: an empty result would look
          // like "no coordinates" and silently pin the fallback for 24 hours.
          if (!res.ok) {
            throw new Error(`Nominatim lookup failed (HTTP ${res.status})`);
          }
          return (await res.json()) as any[];
        }
      );
      if (Array.isArray(data) && data.length > 0 && data[0].lat && data[0].lon) {
        return { lat: String(data[0].lat), lon: String(data[0].lon) };
      }
    } catch {
      // Fallback
    }
  }
  return { lat: "52.3676", lon: "4.9041" };
}

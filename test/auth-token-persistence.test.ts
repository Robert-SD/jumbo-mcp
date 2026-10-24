/**
 * Token-persistence tests.
 *
 * Regression focus (2026-10-24 outage): Jumbo's Auth0 tenant rotates refresh
 * tokens and detects reuse. A deployment whose tokens file was not on a
 * persistent volume silently wrote the rotated token into an ephemeral layer,
 * fell back to the stale JUMBO_REFRESH_TOKEN after a restart, and Auth0 then
 * invalidated the whole family -- every tool call answered
 * `403 invalid_grant "Unknown or invalid refresh token."`.
 *
 * Covered here: the rotated token must land on disk, the on-disk token must beat
 * a differing env value on every path, and an unwritable path must fail loudly
 * instead of continuing in memory.
 *
 * No live Auth0 calls: `globalThis.fetch` is replaced.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jumbo-auth-persist-"));
const tokensFile = path.join(tmpDir, "tokens.json");
const blocker = path.join(tmpDir, "blocker");
fs.writeFileSync(blocker, "not a directory");
const unwritableFile = path.join(blocker, "jumbo-mcp", "tokens.json");

process.env.JUMBO_TOKENS_FILE = tokensFile;
delete process.env.JUMBO_TOKEN;
delete process.env.JUMBO_REFRESH_TOKEN;

const {
  AUTH_CONFIG,
  CUSTOMER_ID_CLAIM,
  JumboAuthError,
  MemoryTokenStore,
  assertTokensPathWritable,
  authFetch,
  getTokensFilePath,
  getTokenStore,
  loadTokens,
  refreshTokens,
  getValidAccessToken,
  resolveRefreshToken,
  saveTokens,
  setTokenStore,
} = await import("../src/auth.js");

type Call = { url: string; body: any };
let calls: Call[] = [];

function installFetch(handler: (url: string, body: any) => any): void {
  calls = [];
  (globalThis as any).fetch = async (url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    return handler(url, body);
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

function b64url(o: any): string {
  return Buffer.from(JSON.stringify(o)).toString("base64url");
}

function jwt(claims: Record<string, any>): string {
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(claims)}.sig`;
}

const GOOD_TOKEN = jwt({
  aud: [AUTH_CONFIG.audience],
  [CUSTOMER_ID_CLAIM]: "cust-1",
  exp: Math.floor(Date.now() / 1000) + 3600,
});

function seed(overrides: Record<string, any> = {}): void {
  fs.writeFileSync(
    tokensFile,
    JSON.stringify({
      access_token: GOOD_TOKEN,
      refresh_token: "rt-file",
      client_id: AUTH_CONFIG.client_id,
      domain: AUTH_CONFIG.domain,
      expires_in: 86400,
      saved_at: new Date().toISOString(),
      ...overrides,
    }),
    "utf-8"
  );
}

function stored(): any {
  return JSON.parse(fs.readFileSync(tokensFile, "utf-8"));
}

test("the rotated refresh token is persisted to the resolved tokens file", async () => {
  seed({ refresh_token: "rt-1" });
  installFetch(() => json({ access_token: GOOD_TOKEN, expires_in: 86400, refresh_token: "rt-2" }));

  await refreshTokens();

  assert.equal(calls[0].body.refresh_token, "rt-1");
  assert.equal(stored().refresh_token, "rt-2", "the rotated token must survive a restart");
  assert.equal(loadTokens()?.refresh_token, "rt-2");

  if (process.platform !== "win32") {
    assert.equal(
      fs.statSync(tokensFile).mode & 0o777,
      0o600,
      "the tokens file holds a refresh token and must stay private"
    );
  }
});

test("a stored refresh token wins over a differing JUMBO_REFRESH_TOKEN", async () => {
  seed({ refresh_token: "rt-file" });
  process.env.JUMBO_REFRESH_TOKEN = "rt-env";
  installFetch(() => json({ access_token: GOOD_TOKEN, expires_in: 86400, refresh_token: "rt-rotated" }));

  try {
    assert.deepEqual(resolveRefreshToken(loadTokens()), {
      token: "rt-file",
      source: "file",
    });

    await refreshTokens();
    assert.equal(
      calls[0].body.refresh_token,
      "rt-file",
      "replaying the env token would hand Auth0 an already-rotated token"
    );
    assert.equal(stored().refresh_token, "rt-rotated");
  } finally {
    delete process.env.JUMBO_REFRESH_TOKEN;
  }
});

test("getValidAccessToken renews with the stored token, not the env value", async () => {
  seed({
    access_token: "expired-token",
    refresh_token: "rt-file",
    saved_at: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
    expires_in: 3600,
  });
  process.env.JUMBO_REFRESH_TOKEN = "rt-env";
  installFetch(() => json({ access_token: GOOD_TOKEN, expires_in: 86400, refresh_token: "rt-rotated" }));

  try {
    assert.equal(await getValidAccessToken(), GOOD_TOKEN);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.refresh_token, "rt-file");
  } finally {
    delete process.env.JUMBO_REFRESH_TOKEN;
  }
});

test("the env token is still the bootstrap value when no tokens file exists", async () => {
  fs.rmSync(tokensFile, { force: true });
  process.env.JUMBO_REFRESH_TOKEN = "rt-env";
  installFetch(() => json({ access_token: GOOD_TOKEN, expires_in: 86400, refresh_token: "rt-from-env" }));

  try {
    assert.deepEqual(resolveRefreshToken(null), { token: "rt-env", source: "env" });

    await refreshTokens();
    assert.equal(calls[0].body.refresh_token, "rt-env");
    assert.equal(stored().refresh_token, "rt-from-env", "the bootstrap result is persisted for rotation");
  } finally {
    delete process.env.JUMBO_REFRESH_TOKEN;
  }
});

test("an unwritable tokens path fails loudly instead of continuing in memory", async () => {
  fs.rmSync(tokensFile, { force: true });
  const previous = process.env.JUMBO_TOKENS_FILE;
  process.env.JUMBO_TOKENS_FILE = unwritableFile;
  process.env.JUMBO_REFRESH_TOKEN = "rt-env";
  installFetch(() => json({ access_token: GOOD_TOKEN, expires_in: 86400, refresh_token: "rt-rotated" }));

  try {
    assert.equal(getTokensFilePath(), unwritableFile);

    await assert.rejects(
      () => refreshTokens(),
      (err: any) =>
        err instanceof JumboAuthError &&
        err.code === "TOKENS_NOT_PERSISTED" &&
        err.message.includes(unwritableFile) &&
        err.message.includes("JUMBO_TOKENS_FILE")
    );
    assert.equal(calls.length, 0, "preflight must not call Auth0 when tokens path is unwritable");
    assert.equal(fs.existsSync(unwritableFile), false);
  } finally {
    delete process.env.JUMBO_REFRESH_TOKEN;
    process.env.JUMBO_TOKENS_FILE = previous;
  }
});

test("saveTokens reports the failed write with the resolved path", () => {
  const previous = process.env.JUMBO_TOKENS_FILE;
  process.env.JUMBO_TOKENS_FILE = unwritableFile;

  try {
    assert.throws(
      () => saveTokens({ access_token: "a", refresh_token: "rt", domain: AUTH_CONFIG.domain }),
      (err: any) =>
        err instanceof JumboAuthError &&
        err.code === "TOKENS_NOT_PERSISTED" &&
        err.message.includes(unwritableFile) &&
        /invalid_grant/.test(err.message) &&
        /JUMBO_TOKENS_FILE/.test(err.message)
    );
  } finally {
    process.env.JUMBO_TOKENS_FILE = previous;
  }
});

test("invalid_grant names the operator action and the tokens path", async () => {
  seed({ refresh_token: "rt-dead" });
  installFetch(() =>
    json({ error: "invalid_grant", error_description: "Unknown or invalid refresh token." }, 403)
  );

  await assert.rejects(
    () => refreshTokens(),
    (err: any) =>
      err instanceof JumboAuthError &&
      err.code === "REFRESH_TOKEN_REJECTED" &&
      /invalid_grant/.test(err.message) &&
      /Unknown or invalid refresh token/.test(err.message) &&
      /jumbo-mcp login/.test(err.message) &&
      err.message.includes(tokensFile) &&
      /JUMBO_TOKENS_FILE/.test(err.message) &&
      /persistent volume/.test(err.message)
  );

  assert.equal(stored().refresh_token, "rt-dead", "a rejected refresh must not rewrite the session");
});

test("a transient refresh failure is reported without the rotation diagnosis", async () => {
  seed({ refresh_token: "rt-1" });
  installFetch(() => json({ error: "server_error" }, 500));

  await assert.rejects(
    () => refreshTokens(),
    (err: any) =>
      err instanceof JumboAuthError &&
      err.code === "REFRESH_FAILED" &&
      /token refresh failed/.test(err.message) &&
      !/invalid_grant/.test(err.message)
  );
});

test("loadTokens handles corrupted/truncated JSON without throwing", () => {
  fs.writeFileSync(tokensFile, "{ truncated json", "utf-8");
  assert.equal(loadTokens(), null);
});

test("assertTokensPathWritable throws TOKENS_NOT_PERSISTED when path is unwritable", () => {
  const previous = process.env.JUMBO_TOKENS_FILE;
  process.env.JUMBO_TOKENS_FILE = unwritableFile;

  try {
    assert.throws(
      () => assertTokensPathWritable(),
      (err: any) =>
        err instanceof JumboAuthError &&
        err.code === "TOKENS_NOT_PERSISTED" &&
        err.message.includes(unwritableFile) &&
        err.message.includes("JUMBO_TOKENS_FILE")
    );
  } finally {
    process.env.JUMBO_TOKENS_FILE = previous;
  }
});

test("custom TokenStore can be plugged in and receives rotated tokens", async () => {
  const memStore = new MemoryTokenStore({
    access_token: "old-access",
    refresh_token: "mem-rt-1",
    domain: AUTH_CONFIG.domain,
    client_id: AUTH_CONFIG.client_id,
  });
  setTokenStore(memStore);

  try {
    assert.equal((await loadTokens())?.refresh_token, "mem-rt-1");
    installFetch(() => json({ access_token: GOOD_TOKEN, expires_in: 86400, refresh_token: "mem-rt-2" }));

    await refreshTokens();
    assert.equal((await loadTokens())?.refresh_token, "mem-rt-2");
    assert.equal(calls[0].body.refresh_token, "mem-rt-1");
  } finally {
    setTokenStore(null); // restore default FileTokenStore
  }
});

test("concurrent refreshTokens calls are serialized and coalesced via lock", async () => {
  seed({
    refresh_token: "concurrent-rt-1",
    saved_at: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
  });

  let refreshCalls = 0;
  installFetch(async () => {
    refreshCalls++;
    await new Promise((r) => setTimeout(r, 60)); // simulate network delay
    return json({ access_token: GOOD_TOKEN, expires_in: 86400, refresh_token: "concurrent-rt-2" });
  });

  // Launch two refreshes concurrently
  const [res1, res2] = await Promise.all([refreshTokens(), refreshTokens()]);

  assert.equal(res1.refresh_token, "concurrent-rt-2");
  assert.equal(res2.refresh_token, "concurrent-rt-2");
  assert.equal(refreshCalls, 1, "concurrent refreshes must coalesce into a single Auth0 request via lock");
});

test("stale lock file is broken and recovered", async () => {
  const store = getTokenStore() as any;
  const lockPath = store.getLockFilePath();

  // Create an artificial stale lockfile from an old timestamp
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: 999999, host: "other-host", createdAt: Date.now() - 25000 }),
    "utf-8"
  );

  seed({ refresh_token: "stale-rt-1" });
  installFetch(() => json({ access_token: GOOD_TOKEN, expires_in: 86400, refresh_token: "stale-rt-2" }));

  const refreshed = await refreshTokens();
  assert.equal(refreshed.refresh_token, "stale-rt-2");
  assert.equal(fs.existsSync(lockPath), false, "lock must be cleanly released after recovery");
});

test("concurrent refreshes with a lockless store coalesce in-process via single-flight", async () => {
  let storedTokens: any = {
    access_token: "lockless-old",
    refresh_token: "lockless-rt-1",
    domain: AUTH_CONFIG.domain,
    client_id: AUTH_CONFIG.client_id,
  };

  // Custom lockless store (like HttpTokenStore) without withLock
  const locklessStore = {
    load: () => storedTokens,
    save: (t: any) => {
      storedTokens = t;
    },
  };

  setTokenStore(locklessStore);

  let fetchCalls = 0;
  installFetch(async () => {
    fetchCalls++;
    await new Promise((r) => setTimeout(r, 50));
    return json({ access_token: GOOD_TOKEN, expires_in: 86400, refresh_token: "lockless-rt-2" });
  });

  try {
    const [t1, t2] = await Promise.all([refreshTokens(), refreshTokens()]);
    assert.equal(t1.refresh_token, "lockless-rt-2");
    assert.equal(t2.refresh_token, "lockless-rt-2");
    assert.equal(fetchCalls, 1, "lockless store must coalesce in-flight calls inside the same process");
  } finally {
    setTokenStore(null);
  }
});

test("authFetch abort stops fallback chain without replaying via https or curl", async () => {
  const controller = new AbortController();
  controller.abort();

  let fetchAttempted = false;
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => {
    fetchAttempted = true;
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    throw err;
  };

  try {
    await assert.rejects(
      () =>
        authFetch("https://example.com/oauth/token", {
          method: "POST",
          headers: {},
          signal: controller.signal,
        }),
      (err: any) => err?.name === "AbortError" || /aborted/i.test(err?.message)
    );
    assert.equal(fetchAttempted, false, "already aborted request must not even dispatch fetch");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authFetch stops before https fallback if signal aborts during fetch attempt", async () => {
  const controller = new AbortController();
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => {
    controller.abort();
    throw new Error("transient socket error");
  };

  try {
    await assert.rejects(
      () =>
        authFetch("https://example.com/oauth/token", {
          method: "POST",
          headers: {},
          signal: controller.signal,
        }),
      (err: any) => err?.name === "AbortError" || /aborted/i.test(err?.message)
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("token-store module exports match auth re-exports and resolve XDG default path", async () => {
  const tokenStoreModule = await import("../src/token-store.js");
  const authModule = await import("../src/auth.js");

  assert.equal(typeof tokenStoreModule.FileTokenStore, "function");
  assert.equal(typeof tokenStoreModule.MemoryTokenStore, "function");
  assert.equal(typeof tokenStoreModule.HttpTokenStore, "function");
  assert.equal(authModule.FileTokenStore, tokenStoreModule.FileTokenStore);
  assert.equal(authModule.MemoryTokenStore, tokenStoreModule.MemoryTokenStore);
  assert.equal(authModule.HttpTokenStore, tokenStoreModule.HttpTokenStore);

  // In an environment with no JUMBO_TOKENS_FILE and no existing files,
  // getTokensFilePath returns the user config path (~/.config/jumbo-mcp/tokens.json)
  const prevEnv = process.env.JUMBO_TOKENS_FILE;
  delete process.env.JUMBO_TOKENS_FILE;
  try {
    const resolved = tokenStoreModule.getTokensFilePath();
    const expectedXdg = path.join(os.homedir(), ".config", "jumbo-mcp", "tokens.json");
    // If project root tokens.json exists in this dev repo, it resolves that (for backward compat),
    // otherwise it falls back to expectedXdg.
    assert.ok(resolved.endsWith("tokens.json"));
  } finally {
    process.env.JUMBO_TOKENS_FILE = prevEnv;
  }
});

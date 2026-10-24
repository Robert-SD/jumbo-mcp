import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { TokensData } from "./types.js";

/**
 * Raised when the stored Jumbo session cannot be used or renewed. `code` lets
 * callers distinguish "we never had a usable session" from "Jumbo rejected the
 * token we sent", instead of leaking raw upstream GraphQL text.
 */
export class JumboAuthError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "JumboAuthError";
    this.code = code;
  }
}

export function getProjectDir(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidate = path.resolve(here, "..");
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
  } catch {
    // Ignore
  }
  return process.cwd();
}

/**
 * Env var naming the tokens file. Named here because every actionable error
 * about token persistence has to point the operator at it.
 */
export const TOKENS_FILE_ENV_VAR = "JUMBO_TOKENS_FILE";

/**
 * Resolve the path for tokens.json following the XDG Base Directory standard.
 *
 * Priority:
 * 1. Explicit JUMBO_TOKENS_FILE environment variable override
 * 2. Mounted container data volume (/data/tokens.json) if present
 * 3. User config directory (~/.config/jumbo-mcp/tokens.json) if existing
 * 4. Project root tokens.json if existing (for backward compatibility)
 * 5. Current working directory tokens.json if existing
 * 6. Legacy path ~/.gemini/config/jumbo-mcp/tokens.json if existing
 * 7. Default for new sessions: ~/.config/jumbo-mcp/tokens.json (keeps project working tree clean)
 */
export function getTokensFilePath(): string {
  const envPath = process.env[TOKENS_FILE_ENV_VAR];
  if (envPath) return path.resolve(envPath.replace(/^~/, os.homedir()));

  // 1. Container data directory if present
  const containerData = "/data/tokens.json";
  if (fs.existsSync(containerData)) return containerData;

  // 2. Global user config (~/.config/jumbo-mcp/tokens.json) if it exists
  const globalConfig = path.join(os.homedir(), ".config", "jumbo-mcp", "tokens.json");
  if (fs.existsSync(globalConfig)) return globalConfig;

  // 3. Project root tokens.json if it exists (for backward compatibility)
  const projectFile = path.join(getProjectDir(), "tokens.json");
  if (fs.existsSync(projectFile)) return projectFile;

  // 4. Working directory tokens.json if it exists
  const cwdFile = path.resolve(process.cwd(), "tokens.json");
  if (fs.existsSync(cwdFile)) return cwdFile;

  // 5. Legacy path if present
  const legacy = path.join(os.homedir(), ".gemini", "config", "jumbo-mcp", "tokens.json");
  if (fs.existsSync(legacy)) return legacy;

  // Default: XDG standard ~/.config/jumbo-mcp/tokens.json
  return globalConfig;
}

export function getSessionFilePath(): string {
  const baseDir = path.dirname(getTokensFilePath());
  return path.join(baseDir, ".pkce_session.json");
}

/**
 * Pluggable store interface for persisting and loading tokens.
 * By default, `FileTokenStore` is used (supporting local files & volume mounts).
 * Applications can supply a custom store (e.g. `MemoryTokenStore`, `HttpTokenStore`,
 * Vault, AWS Secrets Manager, or Redis) via `setTokenStore()`.
 */
export interface TokenStore {
  load(): TokensData | null | Promise<TokensData | null>;
  save(tokens: TokensData): void | Promise<void>;
  assertWritable?(): void | Promise<void>;
  withLock?<T>(fn: (ctx: { waited: boolean }) => Promise<T>): Promise<T>;
}

export class FileTokenStore implements TokenStore {
  constructor(private getFilePath: () => string = getTokensFilePath) {}

  load(): TokensData | null {
    const filePath = this.getFilePath();
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        return JSON.parse(content);
      } catch (error: any) {
        console.error(
          `[jumbo-mcp] WARNING: tokens file exists at ${filePath} but could not be read/parsed ` +
            `(${error?.message || error}). Ignoring corrupted tokens file.`
        );
        return null;
      }
    }
    return null;
  }

  assertWritable(): void {
    const filePath = this.getFilePath();
    try {
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(
        fs.existsSync(filePath) ? filePath : dir,
        fs.constants.W_OK
      );
    } catch (error: any) {
      const reason = error?.message || error?.code || String(error);
      throw new JumboAuthError(
        "TOKENS_NOT_PERSISTED",
        `Could not verify that the Jumbo tokens can be persisted to ${filePath} before refresh (${reason}). ` +
          `Auth0 rotates the refresh token on every refresh; refreshing now would consume the live token ` +
          `without saving the replacement. Fix the cause above and set ${TOKENS_FILE_ENV_VAR} to a writable ` +
          `file on persistent storage (for a container: mount a volume and use ${TOKENS_FILE_ENV_VAR}=/data/tokens.json).`
      );
    }
  }

  save(tokens: TokensData): void {
    const filePath = this.getFilePath();
    const dir = path.dirname(filePath);
    const tempPath = path.join(
      dir,
      `.tokens.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
    );

    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tempPath, JSON.stringify(tokens, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });
      fs.renameSync(tempPath, filePath);
    } catch (error: any) {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        // Ignore temp file cleanup error
      }
      // Node's fs errors already lead with their code ("EACCES: permission denied, mkdir …").
      const reason = error?.message || error?.code || String(error);
      throw new JumboAuthError(
        "TOKENS_NOT_PERSISTED",
        `Could not persist the Jumbo tokens to ${filePath} (${reason}). Auth0 rotates the refresh ` +
          `token on every refresh, so the rotated token was not persisted and is unavailable to ` +
          `subsequent refresh attempts. If the previous token is replayed, Auth0's reuse detection ` +
          `invalidates the whole token family, and every call fails with invalid_grant. Fix the cause ` +
          `above and set ${TOKENS_FILE_ENV_VAR} to a writable file on persistent storage (for a container: ` +
          `mount a volume and use ${TOKENS_FILE_ENV_VAR}=/data/tokens.json).`
      );
    }

    try {
      fs.chmodSync(filePath, 0o600);
    } catch (error: any) {
      console.error(
        `[jumbo-mcp] WARNING: tokens were written to ${filePath} but chmod 600 failed ` +
          `(${error?.code || error?.message || error}). The refresh token may be readable by other ` +
          `accounts on this host; restrict the file's permissions or point ${TOKENS_FILE_ENV_VAR} at ` +
          `a private path.`
      );
    }
  }

  getLockFilePath(): string {
    const filePath = this.getFilePath();
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    return path.join(dir, `.${base}.lock`);
  }

  /**
   * Acquire an advisory lock on the token file to prevent concurrent processes
   * from simultaneously refreshing and triggering Auth0 token-reuse revocation.
   */
  async acquireLock(
    timeoutMs = 15000,
    staleMs = 10000
  ): Promise<{ release: () => void; waited: boolean }> {
    const lockPath = this.getLockFilePath();
    const dir = path.dirname(lockPath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // Ignore directory creation failure
    }

    const start = Date.now();
    let waited = false;
    const owner = crypto.randomUUID();
    const host = os.hostname();

    while (true) {
      try {
        const fd = fs.openSync(
          lockPath,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
          0o600
        );
        try {
          fs.writeFileSync(
            fd,
            JSON.stringify({ pid: process.pid, host, owner, createdAt: Date.now() }),
            "utf-8"
          );
        } finally {
          fs.closeSync(fd);
        }

        return {
          release: () => {
            try {
              if (fs.existsSync(lockPath)) {
                const cur = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
                if (cur?.owner === owner) {
                  fs.unlinkSync(lockPath);
                }
              }
            } catch {
              // Ignore lockfile removal failure
            }
          },
          waited,
        };
      } catch (err: any) {
        if (err?.code !== "EEXIST") {
          // If filesystem does not support atomic O_EXCL or directory is read-only,
          // warn and proceed without locking rather than crashing.
          console.warn(
            `[jumbo-mcp] WARNING: Could not acquire file lock at ${lockPath}: ${err.message}`
          );
          return { release: () => {}, waited: false };
        }
        waited = true;

        // Lock file exists: check if it's stale (orphaned by a dead process)
        try {
          const content = fs.readFileSync(lockPath, "utf-8");
          const info = JSON.parse(content);
          const age = Date.now() - (info.createdAt || 0);

          const sameHost = !info.host || info.host === host;
          let isDead = false;
          if (sameHost && typeof info.pid === "number" && process.platform !== "win32") {
            try {
              process.kill(info.pid, 0);
            } catch (killErr: any) {
              if (killErr?.code === "ESRCH") {
                isDead = true;
              }
            }
          }

          if (isDead || (!sameHost && age > staleMs) || age > staleMs * 2) {
            try {
              fs.unlinkSync(lockPath);
              continue; // Retry lock acquisition immediately
            } catch {
              // Ignore race on unlink
            }
          }
        } catch {
          try {
            const stat = fs.statSync(lockPath);
            if (Date.now() - stat.mtimeMs > 5000) {
              fs.unlinkSync(lockPath);
              continue;
            }
          } catch {
            // Ignore
          }
        }

        if (Date.now() - start > timeoutMs) {
          throw new JumboAuthError(
            "LOCK_TIMEOUT",
            `Timed out waiting for Jumbo token file lock at ${lockPath}. ` +
              `Another process may be refreshing the token or died unexpectedly.`
          );
        }

        // Wait with jitter between 40ms and 80ms before retrying
        await new Promise((r) => setTimeout(r, 40 + Math.random() * 40));
      }
    }
  }

  async withLock<T>(fn: (ctx: { waited: boolean }) => Promise<T>): Promise<T> {
    const { release, waited } = await this.acquireLock();
    try {
      return await fn({ waited });
    } finally {
      release();
    }
  }
}

export class MemoryTokenStore implements TokenStore {
  private tokens: TokensData | null = null;
  private lockPromise: Promise<void> = Promise.resolve();
  private pendingLocks = 0;

  constructor(initialTokens?: TokensData | null) {
    this.tokens = initialTokens ?? null;
  }
  load(): TokensData | null {
    return this.tokens;
  }
  save(tokens: TokensData): void {
    this.tokens = tokens;
  }
  assertWritable(): void {}

  async withLock<T>(fn: (ctx: { waited: boolean }) => Promise<T>): Promise<T> {
    const waited = this.pendingLocks > 0;
    this.pendingLocks++;
    let release: () => void;
    const nextLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prevLock = this.lockPromise;
    this.lockPromise = nextLock;
    await prevLock;
    try {
      return await fn({ waited });
    } finally {
      this.pendingLocks--;
      release!();
    }
  }
}

export class HttpTokenStore implements TokenStore {
  constructor(private url: string, private authHeader?: string) {}

  async load(): Promise<TokensData | null> {
    try {
      const res = await fetch(this.url, {
        headers: this.authHeader ? { Authorization: this.authHeader } : {},
      });
      if (!res.ok) return null;
      return (await res.json()) as TokensData;
    } catch (error: any) {
      console.error(`[jumbo-mcp] WARNING: failed to load tokens from ${this.url}: ${error.message}`);
      return null;
    }
  }

  async assertWritable(): Promise<void> {}

  async save(tokens: TokensData): Promise<void> {
    try {
      const res = await fetch(this.url, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...(this.authHeader ? { Authorization: this.authHeader } : {}),
        },
        body: JSON.stringify(tokens),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (error: any) {
      throw new JumboAuthError(
        "TOKENS_NOT_PERSISTED",
        `Could not persist the Jumbo tokens to ${this.url} (${error.message}).`
      );
    }
  }
}

let activeTokenStore: TokenStore | null = null;

export function getTokenStore(): TokenStore {
  if (!activeTokenStore) {
    if (process.env.JUMBO_TOKEN_STORE_URL) {
      activeTokenStore = new HttpTokenStore(
        process.env.JUMBO_TOKEN_STORE_URL,
        process.env.JUMBO_TOKEN_STORE_AUTH
      );
    } else {
      activeTokenStore = new FileTokenStore();
    }
  }
  return activeTokenStore;
}

export function setTokenStore(store: TokenStore | null): void {
  activeTokenStore = store;
}

export function loadTokens(): TokensData | null | Promise<TokensData | null> {
  return getTokenStore().load();
}

export function assertTokensPathWritable(): void | Promise<void> {
  const store = getTokenStore();
  if (store.assertWritable) {
    return store.assertWritable();
  }
}

export function saveTokens(tokens: TokensData): void | Promise<void> {
  return getTokenStore().save(tokens);
}

/**
 * Refresh-token precedence, in one place: a refresh token stored on disk always
 * wins over `JUMBO_REFRESH_TOKEN`. Rotation is enabled on Jumbo's Auth0 tenant,
 * so after the first refresh the file holds the only live token; replaying the
 * env value would hand Auth0 an already-used token and kill the family. The env
 * var is a bootstrap value only -- read when no stored token exists at all.
 */
export function resolveRefreshToken(tokens: TokensData | null): {
  token: string | null;
  source: "file" | "env" | null;
} {
  const stored = tokens?.refresh_token?.trim();
  if (stored) return { token: stored, source: "file" };

  const fromEnv = process.env.JUMBO_REFRESH_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: "env" };

  return { token: null, source: null };
}

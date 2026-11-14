import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  DEFAULT_MAX_REQUEST_BODY_SIZE,
  WebStandardStreamableHTTPServerTransport,
  isInitializeRequest,
  readRequestBody,
  type McpServer,
} from "@modelcontextprotocol/server";
import { JumboClient } from "./client.js";

export type ServerFactory = (client: JumboClient) => McpServer;

export interface HttpServerOptions {
  host?: string;
  port?: number;
  path?: string;
  authToken?: string;
  sessionIdleMs?: number;
  enableJsonResponse?: boolean;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  enableDnsRebindingProtection?: boolean;
  version?: string;
  client?: JumboClient;
  createServer: ServerFactory;
  log?: (message: string) => void;
}

export interface RunningHttpServer {
  server: http.Server;
  url: string;
  healthUrl: string;
  host: string;
  port: number;
  path: string;
  client: JumboClient;
  getSessionCount: () => number;
  close: () => Promise<void>;
}

interface SessionEntry {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  lastActivity: number;
  closing: boolean;
}

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PATH = "/mcp";
const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000;

function normalizePath(rawPath?: string): string {
  const trimmed = (rawPath || DEFAULT_PATH).trim();
  if (!trimmed || trimmed === "/") return "/";
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeading.replace(/\/+$/, "") || "/";
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function isAuthorized(req: IncomingMessage, expectedToken?: string): boolean {
  if (!expectedToken) return true;
  const authHeader = req.headers.authorization;
  if (typeof authHeader !== "string") return false;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  return timingSafeEqual(sha256(match[1].trim()), sha256(expectedToken));
}

function jsonRpcErrorResponse(
  status: number,
  code: number,
  message: string,
  extraHeaders?: Record<string, string>
): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    },
    {
      status,
      headers: {
        "Content-Type": "application/json",
        ...extraHeaders,
      },
    }
  );
}

function toWebRequest(req: IncomingMessage, includeBody: boolean): Request {
  const host = req.headers.host || "localhost";
  const url = new URL(req.url || "/", `http://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }

  const method = (req.method || "GET").toUpperCase();
  if (!includeBody || method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }

  const body = Readable.toWeb(req) as unknown as ReadableStream;
  return new Request(url, {
    method,
    headers,
    body,
    duplex: "half",
  } as RequestInit);
}

async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  if (res.writableEnded || res.destroyed) return;

  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.appendHeader(key, value);
  });

  if (!response.body) {
    res.end();
    return;
  }

  res.flushHeaders();

  const reader = response.body.getReader();
  const cancelReader = () => {
    void reader.cancel().catch(() => {});
  };
  res.on("close", cancelReader);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || res.writableEnded || res.destroyed) break;
      if (value && value.byteLength > 0) {
        res.write(value);
      }
    }
  } finally {
    res.off("close", cancelReader);
    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  }
}

function containsInitializeRequest(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.some((item) => isInitializeRequest(item));
  }
  return isInitializeRequest(body);
}

export function resolveHttpConfigFromEnv(
  overrides: Partial<HttpServerOptions> = {}
): Omit<HttpServerOptions, "createServer"> {
  const envPort = process.env.MCP_HTTP_PORT || process.env.PORT;
  const parsedPort = envPort ? Number.parseInt(envPort, 10) : undefined;
  const port =
    overrides.port ??
    (parsedPort !== undefined && Number.isFinite(parsedPort) && parsedPort >= 0
      ? parsedPort
      : DEFAULT_PORT);

  const envIdle = process.env.MCP_HTTP_SESSION_IDLE_MS;
  const parsedIdle = envIdle ? Number.parseInt(envIdle, 10) : undefined;
  const sessionIdleMs =
    overrides.sessionIdleMs ??
    (parsedIdle !== undefined && Number.isFinite(parsedIdle) && parsedIdle > 0
      ? parsedIdle
      : DEFAULT_SESSION_IDLE_MS);

  const allowedHosts =
    overrides.allowedHosts ??
    process.env.MCP_HTTP_ALLOWED_HOSTS?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const allowedOrigins =
    overrides.allowedOrigins ??
    process.env.MCP_HTTP_ALLOWED_ORIGINS?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  return {
    host: overrides.host ?? process.env.MCP_HTTP_HOST ?? DEFAULT_HOST,
    port,
    path: normalizePath(overrides.path ?? process.env.MCP_HTTP_PATH ?? DEFAULT_PATH),
    authToken: overrides.authToken ?? (process.env.MCP_HTTP_AUTH_TOKEN || undefined),
    sessionIdleMs,
    enableJsonResponse:
      overrides.enableJsonResponse ?? process.env.MCP_HTTP_JSON_RESPONSE === "true",
    allowedHosts: allowedHosts?.length ? allowedHosts : undefined,
    allowedOrigins: allowedOrigins?.length ? allowedOrigins : undefined,
    enableDnsRebindingProtection:
      overrides.enableDnsRebindingProtection ??
      Boolean(allowedHosts?.length || allowedOrigins?.length),
    version: overrides.version,
    client: overrides.client,
    log: overrides.log,
  };
}

export async function startHttpServer(
  options: HttpServerOptions
): Promise<RunningHttpServer> {
  const host = options.host ?? DEFAULT_HOST;
  const requestedPort = options.port ?? DEFAULT_PORT;
  const mcpPath = normalizePath(options.path);
  const sessionIdleMs = options.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
  const client = options.client ?? new JumboClient();
  const version = options.version ?? "0.6.0";
  const log = options.log ?? ((msg: string) => process.stderr.write(`${msg}\n`));

  const sessions = new Map<string, SessionEntry>();

  const closeSession = async (sessionId: string): Promise<void> => {
    const entry = sessions.get(sessionId);
    if (!entry || entry.closing) return;
    entry.closing = true;
    sessions.delete(sessionId);
    await entry.transport.close().catch(() => {});
    await entry.server.close().catch(() => {});
  };

  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, entry] of sessions.entries()) {
      if (now - entry.lastActivity > sessionIdleMs) {
        void closeSession(sessionId);
      }
    }
  }, Math.min(Math.max(Math.floor(sessionIdleMs / 2), 1000), 60_000));
  sweepTimer.unref();

  const buildTransportOptions = (
    extra: Partial<ConstructorParameters<typeof WebStandardStreamableHTTPServerTransport>[0]>
  ) => ({
    enableJsonResponse: options.enableJsonResponse ?? false,
    allowedHosts: options.allowedHosts,
    allowedOrigins: options.allowedOrigins,
    enableDnsRebindingProtection: options.enableDnsRebindingProtection ?? false,
    ...extra,
  });

  const handleMcpRequest = async (req: IncomingMessage): Promise<Response> => {
    if (!isAuthorized(req, options.authToken)) {
      return jsonRpcErrorResponse(401, -32000, "Unauthorized", {
        "WWW-Authenticate": 'Bearer realm="jumbo-mcp"',
      });
    }

    const method = (req.method || "GET").toUpperCase();
    const rawSessionId = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;

    if (sessionId) {
      const existing = sessions.get(sessionId);
      if (!existing) {
        return jsonRpcErrorResponse(404, -32001, "Session not found");
      }
      existing.lastActivity = Date.now();
      const webReq = toWebRequest(req, true);
      return existing.transport.handleRequest(webReq);
    }

    if (method !== "POST") {
      return jsonRpcErrorResponse(
        400,
        -32000,
        "Bad Request: Mcp-Session-Id header is required"
      );
    }

    const webReq = toWebRequest(req, true);
    const bodyResult = await readRequestBody(webReq, DEFAULT_MAX_REQUEST_BODY_SIZE);
    if (bodyResult.tooLarge) {
      return jsonRpcErrorResponse(
        413,
        -32000,
        `Request body exceeds ${DEFAULT_MAX_REQUEST_BODY_SIZE} bytes`
      );
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(bodyResult.text);
    } catch {
      return jsonRpcErrorResponse(400, -32700, "Parse error: Invalid JSON");
    }

    if (containsInitializeRequest(parsedBody)) {
      const server = options.createServer(client);
      let initializedSessionId: string | undefined;

      const transport = new WebStandardStreamableHTTPServerTransport(
        buildTransportOptions({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            initializedSessionId = sid;
            sessions.set(sid, {
              server,
              transport,
              lastActivity: Date.now(),
              closing: false,
            });
          },
          onsessionclosed: (sid) => {
            sessions.delete(sid);
            void server.close().catch(() => {});
          },
        })
      );

      transport.onclose = () => {
        if (initializedSessionId) {
          const entry = sessions.get(initializedSessionId);
          sessions.delete(initializedSessionId);
          if (entry && !entry.closing) {
            entry.closing = true;
            void server.close().catch(() => {});
          }
        }
      };

      await server.connect(transport);
      return transport.handleRequest(webReq, { parsedBody });
    }

    // Stateless fallback for clients posting requests/notifications without an initialize handshake
    const statelessServer = options.createServer(client);
    const statelessTransport = new WebStandardStreamableHTTPServerTransport(
      buildTransportOptions({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
    );

    await statelessServer.connect(statelessTransport);
    try {
      return await statelessTransport.handleRequest(webReq, { parsedBody });
    } finally {
      await statelessTransport.close().catch(() => {});
      await statelessServer.close().catch(() => {});
    }
  };

  const server = http.createServer(async (req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).pathname;
    } catch {
      await writeWebResponse(res, jsonRpcErrorResponse(400, -32600, "Invalid request URL"));
      return;
    }

    const normalizedPathname = normalizePath(pathname);
    const method = (req.method || "GET").toUpperCase();

    if (normalizedPathname === "/healthz" && (method === "GET" || method === "HEAD")) {
      const body =
        method === "HEAD"
          ? null
          : JSON.stringify({
              status: "ok",
              server: "jumbo-mcp",
              version,
              transport: "streamable-http",
              sessions: sessions.size,
              cache: client.cacheStats(),
            });
      await writeWebResponse(
        res,
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
      return;
    }

    if (normalizedPathname !== mcpPath) {
      await writeWebResponse(
        res,
        Response.json({ error: "Not found" }, { status: 404 })
      );
      return;
    }

    try {
      const response = await handleMcpRequest(req);
      await writeWebResponse(res, response);
    } catch (error: any) {
      log(`HTTP handler error: ${error?.message || String(error)}`);
      if (!res.headersSent) {
        await writeWebResponse(
          res,
          jsonRpcErrorResponse(500, -32603, "Internal server error")
        );
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(requestedPort, host);
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : requestedPort;
  const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const baseUrl = `http://${displayHost}:${actualPort}`;

  return {
    server,
    url: `${baseUrl}${mcpPath === "/" ? "" : mcpPath}`,
    healthUrl: `${baseUrl}/healthz`,
    host,
    port: actualPort,
    path: mcpPath,
    client,
    getSessionCount: () => sessions.size,
    close: async () => {
      clearInterval(sweepTimer);
      await Promise.all([...sessions.keys()].map((sid) => closeSession(sid)));
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

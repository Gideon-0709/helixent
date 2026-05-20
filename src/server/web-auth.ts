export interface WebAuthUser {
  username: string;
  password: string;
}

export interface WebAuthOptions {
  users?: WebAuthUser[];
  handleAuthorized: (..._args: [Request]) => Promise<Response>;
}

const SESSION_COOKIE_NAME = "helixent_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24;

/** Wraps a request handler with password-based web authentication. */
export function createWebAuth({ users = parseWebAuthUsers(Bun.env.HELIXENT_WEB_USERS), handleAuthorized }: WebAuthOptions) {
  const sessions = new Map<string, string>();
  const userMap = new Map(users.map((user) => [user.username, user.password]));

  return {
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/api/health") {
        return handleAuthorized(request);
      }

      if (request.method === "GET" && url.pathname === "/api/auth/me") {
        const username = readSessionUsername(request, sessions);
        return username ? jsonResponse({ authenticated: true, username }) : jsonResponse({ authenticated: false }, 401);
      }

      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        const body = await readJson<{ username?: string; password?: string }>(request);
        const username = body.username?.trim() ?? "";
        const password = body.password ?? "";
        if (!username || userMap.get(username) !== password) {
          return jsonResponse({ error: "invalid username or password" }, 401);
        }

        const sessionId = crypto.randomUUID();
        sessions.set(sessionId, username);
        return jsonResponse(
          { ok: true, username },
          200,
          { "set-cookie": serializeSessionCookie({ value: sessionId, request }) },
        );
      }

      if (request.method === "POST" && url.pathname === "/api/auth/logout") {
        const sessionId = readCookie(request, SESSION_COOKIE_NAME);
        if (sessionId) {
          sessions.delete(sessionId);
        }
        return jsonResponse(
          { ok: true },
          200,
          { "set-cookie": serializeSessionCookie({ value: "", maxAge: 0, request }) },
        );
      }

      if (url.pathname.startsWith("/api/") && !readSessionUsername(request, sessions)) {
        return jsonResponse({ error: "authentication required" }, 401);
      }

      return handleAuthorized(request);
    },
  };
}

/** Parses web users from `username:password` pairs and always includes admin/admin. */
export function parseWebAuthUsers(raw: string | undefined): WebAuthUser[] {
  const users = new Map<string, string>([["admin", "admin"]]);
  for (const part of raw?.split(",") ?? []) {
    const separator = part.indexOf(":");
    if (separator <= 0) continue;
    const username = part.slice(0, separator).trim();
    const password = part.slice(separator + 1);
    if (!username || !password) continue;
    if (!users.has(username)) {
      users.set(username, password);
    }
  }
  return [...users].map(([username, password]) => ({ username, password }));
}

function readSessionUsername(request: Request, sessions: Map<string, string>): string | null {
  const sessionId = readCookie(request, SESSION_COOKIE_NAME);
  return sessionId ? sessions.get(sessionId) ?? null : null;
}

function readCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) {
      return decodeURIComponent(rawValue.join("="));
    }
  }
  return null;
}

function serializeSessionCookie({
  value,
  maxAge = SESSION_MAX_AGE_SECONDS,
  request,
}: {
  value: string;
  maxAge?: number;
  request: Request;
}): string {
  const url = new URL(request.url);
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

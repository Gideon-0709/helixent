import { describe, expect, test } from "bun:test";

import { createWebAuth, parseWebAuthUsers } from "../web-auth";

describe("web auth", () => {
  test("rejects protected requests without a session cookie", async () => {
    const auth = createWebAuth({
      users: [{ username: "admin", password: "admin" }],
      handleAuthorized: async () => new Response("ok"),
    });

    const response = await auth.fetch(new Request("http://localhost/api/internal/resources"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "authentication required" });
  });

  test("accepts admin credentials and authorizes later requests with the session cookie", async () => {
    const auth = createWebAuth({
      users: [{ username: "admin", password: "admin" }],
      handleAuthorized: async () => new Response("ok"),
    });

    const loginResponse = await auth.fetch(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: "admin", password: "admin" }),
      }),
    );
    const cookie = loginResponse.headers.get("set-cookie");
    const authorizedResponse = await auth.fetch(
      new Request("http://localhost/api/internal/resources", {
        headers: cookie ? { cookie } : undefined,
      }),
    );

    expect(loginResponse.status).toBe(200);
    expect(await loginResponse.json()).toEqual({ ok: true, username: "admin" });
    expect(cookie).toContain("helixent_session=");
    expect(authorizedResponse.status).toBe(200);
    expect(await authorizedResponse.text()).toBe("ok");
  });

  test("authorizes main system api requests with bearer api keys", async () => {
    const auth = createWebAuth({
      apiKeys: ["main-system-secret"],
      users: [{ username: "admin", password: "admin" }],
      handleAuthorized: async () => new Response("ok"),
    });

    const response = await auth.fetch(
      new Request("http://localhost/api/v1/agents", {
        headers: { authorization: "Bearer main-system-secret" },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  test("rejects main system api requests without a valid bearer api key", async () => {
    const auth = createWebAuth({
      apiKeys: ["main-system-secret"],
      users: [{ username: "admin", password: "admin" }],
      handleAuthorized: async () => new Response("ok"),
    });

    const response = await auth.fetch(new Request("http://localhost/api/v1/agents"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "valid api key is required" });
  });

  test("parses additional users while keeping the default admin account", () => {
    expect(parseWebAuthUsers("admin:changed,alice:secret,bob:another-secret")).toEqual([
      { username: "admin", password: "admin" },
      { username: "alice", password: "secret" },
      { username: "bob", password: "another-secret" },
    ]);
  });
});

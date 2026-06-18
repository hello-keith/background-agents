import { describe, expect, it, vi } from "vitest";
import { generateInternalToken } from "./auth/internal";
import { handleRequest } from "./router";

const secret = "test-internal-secret";

function createEnv() {
  const fetch = vi.fn(async (_request: Request) => Response.json({ ok: true }, { status: 202 }));
  const statement = {
    bind: vi.fn(() => statement),
    first: vi.fn(async () => null),
    all: vi.fn(async () => ({ results: [] })),
    run: vi.fn(async () => ({ meta: { changes: 0 } })),
  };

  return {
    fetch,
    env: {
      INTERNAL_CALLBACK_SECRET: secret,
      DB: {
        prepare: vi.fn(() => statement),
        batch: vi.fn(),
        exec: vi.fn(),
        dump: vi.fn(),
      },
      SESSION: {
        idFromName: (name: string) => name,
        get: () => ({ fetch }),
      },
    },
  };
}

describe("Git credential broker router integration", () => {
  it("proxies sandbox credential requests to the session runtime", async () => {
    const { env, fetch } = createEnv();
    const token = await generateInternalToken(secret);

    const response = await handleRequest(
      new Request("https://test.local/sessions/session-1/scm-credentials", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
      env as never
    );

    expect(response.status).toBe(202);
    expect(fetch).toHaveBeenCalledOnce();
    const request = fetch.mock.calls[0][0];
    expect(new URL(request.url).pathname).toBe("/internal/scm-credentials");
  });

  it("proxies tunnel URL requests to the session runtime", async () => {
    const { env, fetch } = createEnv();
    const token = await generateInternalToken(secret);

    const response = await handleRequest(
      new Request("https://test.local/sessions/session-1/tunnel-urls", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      }),
      env as never
    );

    expect(response.status).toBe(202);
    expect(fetch).toHaveBeenCalledOnce();
    const request = fetch.mock.calls[0][0];
    expect(new URL(request.url).pathname).toBe("/internal/tunnel-urls");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateInternalToken } from "./auth/internal";
import { handleRequest } from "./router";

const mockUserStore = {
  resolveOrCreateUser: vi.fn(),
};

vi.mock("./db/user-store", () => ({
  UserStore: vi.fn().mockImplementation(function () {
    return mockUserStore;
  }),
}));

describe("provider identity router integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserStore.resolveOrCreateUser.mockResolvedValue({
      id: "0123456789abcdef0123456789abcdef",
      displayName: "Ada",
      email: "ada@example.com",
      isNew: false,
    });
  });

  it("serves GitHub provider identity upserts", async () => {
    const env = {
      INTERNAL_CALLBACK_SECRET: "test-secret",
      DB: {
        prepare: vi.fn(),
        batch: vi.fn(),
        exec: vi.fn(),
        dump: vi.fn(),
      },
    };

    const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET);
    const response = await handleRequest(
      new Request("https://test.local/provider-identities/github/12345", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          providerLogin: "ada",
        }),
      }),
      env as never
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      userId: "0123456789abcdef0123456789abcdef",
    });
  });

  it("serves Google provider identity upserts", async () => {
    const env = {
      INTERNAL_CALLBACK_SECRET: "test-secret",
      DB: {
        prepare: vi.fn(),
        batch: vi.fn(),
        exec: vi.fn(),
        dump: vi.fn(),
      },
    };

    const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET);
    const response = await handleRequest(
      new Request("https://test.local/provider-identities/google/google-sub-1", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          providerEmail: "pm@corp.com",
        }),
      }),
      env as never
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      userId: "0123456789abcdef0123456789abcdef",
    });
    expect(mockUserStore.resolveOrCreateUser).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "google", providerUserId: "google-sub-1" })
    );
  });

  it("rejects unsupported provider identity paths", async () => {
    const env = {
      INTERNAL_CALLBACK_SECRET: "test-secret",
      DB: {
        prepare: vi.fn(),
        batch: vi.fn(),
        exec: vi.fn(),
        dump: vi.fn(),
      },
    };

    const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET);
    const response = await handleRequest(
      new Request("https://test.local/provider-identities/unsupported/U123", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      }),
      env as never
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "provider must be one of: github, slack, linear, google",
    });
    expect(mockUserStore.resolveOrCreateUser).not.toHaveBeenCalled();
  });
});

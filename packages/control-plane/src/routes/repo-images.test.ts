import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateInternalToken } from "../auth/internal";
import { createRequestMetrics } from "../db/instrumented-d1";
import { repoImageRoutes } from "./repo-images";
import type { RepoImageProvider } from "../db/repo-images";
import type { Env } from "../types";
import type { RequestContext, Route } from "./shared";

interface RepoImageRow {
  id: string;
  repo_owner: string;
  repo_name: string;
  provider: RepoImageProvider;
  provider_session_id: string | null;
  base_branch: string;
  provider_image_id: string;
  status: "building" | "ready" | "failed";
  base_sha: string;
  build_duration_seconds: number | null;
  error_message: string | null;
  callback_token_hash: string | null;
  callback_token_expires_at: number | null;
  callback_token_used_at: number | null;
  created_at: number;
}

function createRepoImageDb(
  row: RepoImageRow,
  oldReady?: { id: string; provider_image_id: string }
): D1Database {
  const prepare = (sql: string) => ({
    bind: (...args: unknown[]) => ({
      first: async () => {
        if (sql.includes("SELECT repo_owner, repo_name, provider, base_branch")) {
          return row.id === args[0] && row.provider === args[1] && row.status === "building"
            ? {
                repo_owner: row.repo_owner,
                repo_name: row.repo_name,
                provider: row.provider,
                base_branch: row.base_branch,
              }
            : null;
        }
        if (sql.includes("SELECT id, provider_image_id")) {
          return oldReady ?? null;
        }
        return null;
      },
      run: async () => {
        if (sql.includes("UPDATE repo_images SET status = 'ready'")) {
          row.status = "ready";
          row.provider_image_id = String(args[0]);
          row.base_sha = String(args[1]);
          row.build_duration_seconds = Number(args[2]);
        } else if (sql.includes("DELETE FROM repo_images")) {
          oldReady = undefined;
        }
        return { meta: { changes: 1 } };
      },
    }),
  });

  return {
    prepare,
    batch: async (statements: Array<{ run: () => Promise<unknown> }>) => {
      for (const statement of statements) {
        await statement.run();
      }
      return [];
    },
  } as unknown as D1Database;
}

function buildCompleteRoute(): Route {
  const route = repoImageRoutes.find((candidate) =>
    candidate.pattern.test("/repo-images/build-complete")
  );
  if (!route) throw new Error("build-complete route not found");
  return route;
}

function createContext(waitUntilPromises: Promise<unknown>[]): RequestContext {
  return {
    request_id: "request-1",
    trace_id: "trace-1",
    metrics: createRequestMetrics(),
    executionCtx: {
      waitUntil: (promise: Promise<unknown>) => {
        waitUntilPromises.push(promise);
      },
    } as unknown as ExecutionContext,
  };
}

function createEnv(db: D1Database): Env {
  return {
    DB: db,
    INTERNAL_CALLBACK_SECRET: "callback-secret",
    SANDBOX_PROVIDER: "modal",
    MODAL_API_SECRET: "modal-secret",
    MODAL_WORKSPACE: "surface",
    TOKEN_ENCRYPTION_KEY: "token-key",
    DEPLOYMENT_NAME: "test",
  } as Env;
}

function createBuildingRow(): RepoImageRow {
  return {
    id: "build-1",
    repo_owner: "acme",
    repo_name: "repo",
    provider: "modal",
    provider_session_id: "modal-session-1",
    base_branch: "main",
    provider_image_id: "",
    status: "building",
    base_sha: "",
    build_duration_seconds: null,
    error_message: null,
    callback_token_hash: null,
    callback_token_expires_at: null,
    callback_token_used_at: null,
    created_at: Date.now(),
  };
}

describe("repo image routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks Modal repo image builds ready from authenticated callbacks", async () => {
    const row = createBuildingRow();
    const token = await generateInternalToken("callback-secret");

    const response = await buildCompleteRoute().handler(
      new Request("https://test.local/repo-images/build-complete", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          build_id: "build-1",
          provider_image_id: "modal-image-1",
          base_sha: "abc123",
          build_duration_seconds: 42.25,
        }),
      }),
      createEnv(createRepoImageDb(row)),
      [] as unknown as RegExpMatchArray,
      createContext([])
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, replacedImageId: null });
    expect(row.status).toBe("ready");
    expect(row.provider_image_id).toBe("modal-image-1");
    expect(row.base_sha).toBe("abc123");
    expect(row.build_duration_seconds).toBe(42.25);
  });

  it("rejects callbacks that target a build that is not accepting completion", async () => {
    const row = createBuildingRow();
    row.status = "failed";
    const token = await generateInternalToken("callback-secret");

    const response = await buildCompleteRoute().handler(
      new Request("https://test.local/repo-images/build-complete", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          build_id: "build-1",
          provider_image_id: "modal-image-1",
          base_sha: "abc123",
          build_duration_seconds: 42.25,
        }),
      }),
      createEnv(createRepoImageDb(row)),
      [] as unknown as RegExpMatchArray,
      createContext([])
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Build is not accepting completion",
    });
    expect(row.status).toBe("failed");
    expect(row.provider_image_id).toBe("");
  });
});

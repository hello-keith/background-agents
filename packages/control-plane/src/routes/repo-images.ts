/**
 * Repo image build routes.
 *
 * Handles:
 * - Build callbacks from Modal repo image builders
 * - Manual build triggers
 * - Image build status queries
 * - Maintenance operations
 */

import { RepoImageStore, type RepoImageProvider } from "../db/repo-images";
import { verifyInternalToken } from "../auth/internal";
import { RepoMetadataStore } from "../db/repo-metadata";
import { GlobalSecretsStore } from "../db/global-secrets";
import { RepoSecretsStore } from "../db/repo-secrets";
import { mergeSecrets } from "../db/secrets-validation";
import { createModalClient } from "../sandbox/client";
import { resolveSandboxBackendName } from "../sandbox/provider-name";
import { createLogger } from "../logger";
import type { Env } from "../types";
import {
  type Route,
  type RequestContext,
  parsePattern,
  json,
  error,
  parseJsonBody,
  extractRepoParams,
  createRouteSourceControlProvider,
  resolveInstalledRepo,
} from "./shared";

const logger = createLogger("router:repo-images");
const REPO_IMAGE_PROVIDER: RepoImageProvider = "modal";

function requireRepoImages(env: Env): Response | null {
  try {
    resolveSandboxBackendName(env.SANDBOX_PROVIDER);
    return null;
  } catch {
    return error("Repo images are only available when SANDBOX_PROVIDER=modal", 501);
  }
}

async function requireBuildCallbackAuth(
  request: Request,
  env: Env,
  ctx: RequestContext
): Promise<Response | null> {
  if (!env.INTERNAL_CALLBACK_SECRET) {
    logger.error("repo_image.callback_auth_misconfigured", {
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Internal authentication not configured", 500);
  }

  const authorized = await verifyInternalToken(
    request.headers.get("Authorization"),
    env.INTERNAL_CALLBACK_SECRET
  );

  if (!authorized) {
    logger.warn("repo_image.callback_auth_failed", {
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Unauthorized", 401);
  }

  return null;
}

function createConfiguredModalClient(env: Env) {
  if (!env.MODAL_API_SECRET || !env.MODAL_WORKSPACE) {
    throw new Error("Modal configuration not available");
  }
  return createModalClient(
    env.MODAL_API_SECRET,
    env.MODAL_WORKSPACE,
    env.MODAL_ENVIRONMENT_WEB_SUFFIX
  );
}

async function loadBuildSecrets(
  env: Env,
  owner: string,
  name: string
): Promise<Record<string, string> | undefined> {
  if (!env.REPO_SECRETS_ENCRYPTION_KEY) {
    return undefined;
  }

  let globalSecrets: Record<string, string> = {};
  try {
    const globalStore = new GlobalSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY);
    globalSecrets = await globalStore.getDecryptedSecrets();
  } catch (e) {
    logger.warn("repo_image.global_secrets_failed", {
      error: e instanceof Error ? e.message : String(e),
      repo_owner: owner,
      repo_name: name,
    });
  }

  let repoSecrets: Record<string, string> = {};
  try {
    const provider = createRouteSourceControlProvider(env);
    const resolved = await resolveInstalledRepo(provider, owner, name);
    if (resolved) {
      const repoStore = new RepoSecretsStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY);
      repoSecrets = await repoStore.getDecryptedSecrets(resolved.repoId);
    }
  } catch (e) {
    logger.warn("repo_image.repo_secrets_failed", {
      error: e instanceof Error ? e.message : String(e),
      repo_owner: owner,
      repo_name: name,
    });
  }

  const { merged, totalBytes, exceedsLimit } = mergeSecrets(globalSecrets, repoSecrets);
  if (Object.keys(merged).length === 0) {
    return undefined;
  }

  const logLevel = exceedsLimit ? "warn" : "info";
  logger[logLevel]("repo_image.secrets_loaded", {
    global_count: Object.keys(globalSecrets).length,
    repo_count: Object.keys(repoSecrets).length,
    merged_count: Object.keys(merged).length,
    payload_bytes: totalBytes,
    exceeds_limit: exceedsLimit,
    repo_owner: owner,
    repo_name: name,
  });

  return merged;
}

/**
 * POST /repo-images/build-complete
 * Callback from repo image builders on success.
 */
async function handleBuildComplete(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const providerError = requireRepoImages(env);
  if (providerError) return providerError;

  if (!env.DB) {
    return error("Database not configured", 503);
  }

  const authError = await requireBuildCallbackAuth(request, env, ctx);
  if (authError) return authError;

  const body = await parseJsonBody<{
    build_id?: string;
    provider_image_id?: string;
    base_sha?: string;
    build_duration_seconds?: number;
  }>(request);
  if (body instanceof Response) return body;

  const buildId = body.build_id;
  const providerImageId = body.provider_image_id;

  if (!buildId) {
    return error("build_id is required", 400);
  }
  if (!providerImageId) {
    return error("provider_image_id is required", 400);
  }

  const store = new RepoImageStore(env.DB);

  try {
    const result = await store.markReady(
      buildId,
      REPO_IMAGE_PROVIDER,
      providerImageId,
      body.base_sha || "",
      body.build_duration_seconds ?? 0
    );
    if (!result.updated) {
      return error("Build is not accepting completion", 409);
    }

    logger.info("repo_image.build_complete", {
      build_id: buildId,
      provider_image_id: providerImageId,
      base_sha: body.base_sha,
      replaced_image_id: result.replacedImageId,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    if (result.replacedImageId) {
      ctx.executionCtx?.waitUntil(
        (async () => {
          try {
            await createConfiguredModalClient(env).deleteProviderImage({
              providerImageId: result.replacedImageId!,
            });
          } catch (e) {
            logger.warn("repo_image.delete_old_failed", {
              provider_image_id: result.replacedImageId,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        })()
      );
    }

    return json({ ok: true, replacedImageId: result.replacedImageId });
  } catch (e) {
    logger.error("repo_image.build_complete_error", {
      error: e instanceof Error ? e.message : String(e),
      build_id: buildId,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to mark build as ready", 500);
  }
}

/**
 * POST /repo-images/build-failed
 * Callback from repo image builders on failure.
 */
async function handleBuildFailed(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const providerError = requireRepoImages(env);
  if (providerError) return providerError;

  if (!env.DB) {
    return error("Database not configured", 503);
  }

  const authError = await requireBuildCallbackAuth(request, env, ctx);
  if (authError) return authError;

  const body = await parseJsonBody<{ build_id?: string; error?: string }>(request);
  if (body instanceof Response) return body;

  const buildId = body.build_id;
  if (!buildId) {
    return error("build_id is required", 400);
  }

  const store = new RepoImageStore(env.DB);

  try {
    const updated = await store.markFailed(
      buildId,
      REPO_IMAGE_PROVIDER,
      body.error || "Unknown error"
    );
    if (!updated) {
      return error("Build is not accepting failure", 409);
    }

    logger.info("repo_image.build_failed", {
      build_id: buildId,
      error_message: body.error,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ ok: true });
  } catch (e) {
    logger.error("repo_image.build_failed_error", {
      error: e instanceof Error ? e.message : String(e),
      build_id: buildId,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to mark build as failed", 500);
  }
}

/**
 * POST /repo-images/trigger/:owner/:name
 * Manually trigger a build for a repo.
 */
async function handleTriggerBuild(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const providerError = requireRepoImages(env);
  if (providerError) return providerError;

  if (!env.DB) {
    return error("Database not configured", 503);
  }
  if (!env.WORKER_URL) {
    return error("WORKER_URL not configured", 503);
  }

  const params = extractRepoParams(match);
  if (params instanceof Response) return params;
  const { owner, name } = params;

  const store = new RepoImageStore(env.DB);
  const now = Date.now();
  const buildId = `img-${owner}-${name}-${now}`;

  try {
    await store.registerBuild({
      id: buildId,
      repoOwner: owner,
      repoName: name,
      provider: REPO_IMAGE_PROVIDER,
      baseBranch: "main",
    });

    const userEnvVars = await loadBuildSecrets(env, owner, name);
    const callbackUrl = `${env.WORKER_URL}/repo-images/build-complete`;

    await createConfiguredModalClient(env).buildRepoImage(
      {
        repoOwner: owner,
        repoName: name,
        defaultBranch: "main",
        buildId,
        callbackUrl,
        userEnvVars,
      },
      { trace_id: ctx.trace_id, request_id: ctx.request_id }
    );

    logger.info("repo_image.build_triggered", {
      build_id: buildId,
      repo_owner: owner,
      repo_name: name,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ buildId, status: "building" });
  } catch (e) {
    try {
      await store.markFailed(
        buildId,
        REPO_IMAGE_PROVIDER,
        e instanceof Error ? e.message : String(e)
      );
    } catch (markFailedError) {
      logger.warn("repo_image.trigger_mark_failed_error", {
        error: markFailedError instanceof Error ? markFailedError.message : String(markFailedError),
        build_id: buildId,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
    }

    logger.error("repo_image.trigger_error", {
      error: e instanceof Error ? e.message : String(e),
      repo_owner: owner,
      repo_name: name,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to trigger build", 500);
  }
}

/**
 * GET /repo-images/status
 * Get image build status for all repos or a specific repo.
 */
async function handleGetStatus(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const providerError = requireRepoImages(env);
  if (providerError) return providerError;

  if (!env.DB) {
    return error("Database not configured", 503);
  }

  const url = new URL(request.url);
  const repoOwner = url.searchParams.get("repo_owner");
  const repoName = url.searchParams.get("repo_name");

  const store = new RepoImageStore(env.DB);

  try {
    if (repoOwner && repoName) {
      const images = await store.getStatus(repoOwner, repoName);
      return json({ images });
    }

    const images = await store.getAllStatus();
    return json({ images });
  } catch (e) {
    logger.error("repo_image.status_error", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to get image status", 500);
  }
}

/**
 * POST /repo-images/mark-stale
 * Mark old building rows as failed. Called by scheduler.
 */
async function handleMarkStale(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const providerError = requireRepoImages(env);
  if (providerError) return providerError;

  if (!env.DB) {
    return error("Database not configured", 503);
  }

  let body: { max_age_seconds?: number };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  const maxAgeSeconds = body.max_age_seconds ?? 2100;
  const maxAgeMs = maxAgeSeconds * 1000;
  const store = new RepoImageStore(env.DB);

  try {
    const count = await store.markStaleBuildsAsFailed(maxAgeMs);

    logger.info("repo_image.stale_marked", {
      count,
      max_age_seconds: maxAgeSeconds,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ ok: true, markedFailed: count });
  } catch (e) {
    logger.error("repo_image.mark_stale_error", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to mark stale builds", 500);
  }
}

/**
 * POST /repo-images/cleanup
 * Delete old failed builds. Called by scheduler.
 */
async function handleCleanup(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const providerError = requireRepoImages(env);
  if (providerError) return providerError;

  if (!env.DB) {
    return error("Database not configured", 503);
  }

  let body: { max_age_seconds?: number };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  const maxAgeSeconds = body.max_age_seconds ?? 86400;
  const maxAgeMs = maxAgeSeconds * 1000;
  const store = new RepoImageStore(env.DB);

  try {
    const count = await store.deleteOldFailedBuilds(maxAgeMs);

    logger.info("repo_image.cleanup", {
      deleted: count,
      max_age_seconds: maxAgeSeconds,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ ok: true, deleted: count });
  } catch (e) {
    logger.error("repo_image.cleanup_error", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to clean up old builds", 500);
  }
}

/**
 * PUT /repo-images/toggle/:owner/:name
 * Toggle image building for a repo.
 */
async function handleToggleImageBuild(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const providerError = requireRepoImages(env);
  if (providerError) return providerError;

  if (!env.DB) {
    return error("Database not configured", 503);
  }

  const params = extractRepoParams(match);
  if (params instanceof Response) return params;
  const { owner, name } = params;

  const body = await parseJsonBody<{ enabled?: unknown }>(request);
  if (body instanceof Response) return body;

  if (typeof body.enabled !== "boolean") {
    return error("enabled must be a boolean", 400);
  }

  const metadataStore = new RepoMetadataStore(env.DB);

  try {
    await metadataStore.setImageBuildEnabled(owner, name, body.enabled);

    logger.info("repo_image.toggle", {
      repo_owner: owner,
      repo_name: name,
      enabled: body.enabled,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });

    return json({ ok: true, enabled: body.enabled });
  } catch (e) {
    logger.error("repo_image.toggle_error", {
      error: e instanceof Error ? e.message : String(e),
      repo_owner: owner,
      repo_name: name,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to toggle image build", 500);
  }
}

/**
 * GET /repo-images/enabled-repos
 * Returns repos with image building enabled. Called by scheduler.
 */
async function handleGetEnabledRepos(
  _request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const providerError = requireRepoImages(env);
  if (providerError) return providerError;

  if (!env.DB) {
    return error("Database not configured", 503);
  }

  const metadataStore = new RepoMetadataStore(env.DB);

  try {
    const repos = await metadataStore.getImageBuildEnabledRepos();
    return json({ repos });
  } catch (e) {
    logger.error("repo_image.enabled_repos_error", {
      error: e instanceof Error ? e.message : String(e),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Failed to get enabled repos", 500);
  }
}

export const repoImageRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/repo-images/build-complete"),
    handler: handleBuildComplete,
  },
  {
    method: "POST",
    pattern: parsePattern("/repo-images/build-failed"),
    handler: handleBuildFailed,
  },
  {
    method: "POST",
    pattern: parsePattern("/repo-images/trigger/:owner/:name"),
    handler: handleTriggerBuild,
  },
  {
    method: "GET",
    pattern: parsePattern("/repo-images/status"),
    handler: handleGetStatus,
  },
  {
    method: "PUT",
    pattern: parsePattern("/repo-images/toggle/:owner/:name"),
    handler: handleToggleImageBuild,
  },
  {
    method: "GET",
    pattern: parsePattern("/repo-images/enabled-repos"),
    handler: handleGetEnabledRepos,
  },
  {
    method: "POST",
    pattern: parsePattern("/repo-images/mark-stale"),
    handler: handleMarkStale,
  },
  {
    method: "POST",
    pattern: parsePattern("/repo-images/cleanup"),
    handler: handleCleanup,
  },
];

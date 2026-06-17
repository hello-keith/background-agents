import { createKvCacheStore, resolveAppName } from "@open-inspect/shared";
import { getGitHubAppConfig } from "../auth/github-app";
import type { Env } from "../types";
import { createSourceControlProvider } from "./providers";
import type { SourceControlProvider } from "./types";

export function createSourceControlProviderFromEnv(env: Env): SourceControlProvider {
  const appConfig = getGitHubAppConfig(env);
  const userAgent = resolveAppName(env);

  return createSourceControlProvider({
    provider: "github",
    github: {
      appConfig: appConfig ?? undefined,
      cacheStore: createKvCacheStore(env.REPOS_CACHE),
      userAgent,
    },
  });
}

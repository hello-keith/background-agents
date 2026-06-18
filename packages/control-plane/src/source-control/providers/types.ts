/**
 * Provider-specific types.
 */

import type { GitHubAppConfig } from "../../auth/github-app";
import type { CacheStore } from "@open-inspect/shared";

/**
 * Configuration for GitHubSourceControlProvider.
 */
export interface GitHubProviderConfig {
  /** GitHub App configuration (required for push auth) */
  appConfig?: GitHubAppConfig;
  /** Cache store for caching installation tokens */
  cacheStore?: CacheStore;
  /** User-Agent value sent on outbound GitHub API requests */
  userAgent?: string;
}

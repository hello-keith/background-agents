import { describe, expect, it } from "vitest";
import type { Env } from "../types";
import { createSourceControlProviderFromEnv } from "./provider-from-env";
import { GitHubSourceControlProvider } from "./providers/github-provider";

function createEnv(overrides?: Partial<Env>): Env {
  return {
    DEPLOYMENT_NAME: "test",
    ...overrides,
  } as Env;
}

describe("createSourceControlProviderFromEnv", () => {
  it("creates a GitHub provider by default", () => {
    const provider = createSourceControlProviderFromEnv(createEnv());

    expect(provider).toBeInstanceOf(GitHubSourceControlProvider);
  });
});

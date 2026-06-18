import { describe, expect, it } from "vitest";
import { createSourceControlProvider } from "./index";
import { GitHubSourceControlProvider } from "./github-provider";

describe("createSourceControlProvider", () => {
  it("creates github provider", () => {
    const provider = createSourceControlProvider({ provider: "github" });
    expect(provider).toBeInstanceOf(GitHubSourceControlProvider);
  });

  it("throws for unknown provider values at runtime", () => {
    expect(() =>
      createSourceControlProvider({
        provider: "unknown" as unknown as "github",
      })
    ).toThrow("Unsupported source control provider: unknown");
  });
});

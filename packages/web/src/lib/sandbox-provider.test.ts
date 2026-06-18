import { afterEach, describe, expect, it, vi } from "vitest";

describe("sandbox-provider", () => {
  const originalPublicProvider = process.env.NEXT_PUBLIC_SANDBOX_PROVIDER;
  const originalProvider = process.env.SANDBOX_PROVIDER;

  afterEach(() => {
    vi.resetModules();
    if (originalPublicProvider === undefined) {
      delete process.env.NEXT_PUBLIC_SANDBOX_PROVIDER;
    } else {
      process.env.NEXT_PUBLIC_SANDBOX_PROVIDER = originalPublicProvider;
    }
    if (originalProvider === undefined) {
      delete process.env.SANDBOX_PROVIDER;
    } else {
      process.env.SANDBOX_PROVIDER = originalProvider;
    }
  });

  async function loadProvider() {
    vi.resetModules();
    return import("./sandbox-provider");
  }

  it("defaults to modal when no provider is configured", async () => {
    delete process.env.NEXT_PUBLIC_SANDBOX_PROVIDER;
    delete process.env.SANDBOX_PROVIDER;

    const { getPublicSandboxProvider, supportsRepoImages } = await loadProvider();

    expect(getPublicSandboxProvider()).toBe("modal");
    expect(supportsRepoImages()).toBe(true);
  });

  it("accepts modal from the public provider value when present", async () => {
    process.env.NEXT_PUBLIC_SANDBOX_PROVIDER = " modal ";
    process.env.SANDBOX_PROVIDER = "modal";

    const { getPublicSandboxProvider, supportsRepoImages } = await loadProvider();

    expect(getPublicSandboxProvider()).toBe("modal");
    expect(supportsRepoImages()).toBe(true);
  });

  it("throws for old sandbox provider values", async () => {
    process.env.NEXT_PUBLIC_SANDBOX_PROVIDER = "unsupported-a";

    const { getPublicSandboxProvider } = await loadProvider();

    expect(() => getPublicSandboxProvider()).toThrow("Invalid sandbox provider: unsupported-a");
  });

  it("throws for unsupported providers", async () => {
    process.env.NEXT_PUBLIC_SANDBOX_PROVIDER = "fly";

    const { getPublicSandboxProvider } = await loadProvider();

    expect(() => getPublicSandboxProvider()).toThrow("Invalid sandbox provider: fly");
  });
});

import { describe, it, expect } from "vitest";
import {
  resolveSandboxBackendName,
  isModalSandboxBackend,
  supportsRepoImageBackend,
} from "./provider-name";

describe("resolveSandboxBackendName", () => {
  it("defaults to modal when undefined", () => {
    expect(resolveSandboxBackendName(undefined)).toBe("modal");
  });

  it("defaults to modal when empty string", () => {
    expect(resolveSandboxBackendName("")).toBe("modal");
  });

  it("defaults to modal when whitespace-only", () => {
    expect(resolveSandboxBackendName("   ")).toBe("modal");
  });

  it('returns "modal" for "modal"', () => {
    expect(resolveSandboxBackendName("modal")).toBe("modal");
  });

  it("is case-insensitive", () => {
    expect(resolveSandboxBackendName("MODAL")).toBe("modal");
  });

  it("trims whitespace", () => {
    expect(resolveSandboxBackendName("  modal  ")).toBe("modal");
  });

  it("throws for unsupported provider", () => {
    expect(() => resolveSandboxBackendName("unsupported-a")).toThrow(
      "Unsupported SANDBOX_PROVIDER: unsupported-a"
    );
    expect(() => resolveSandboxBackendName("unsupported-b")).toThrow(
      "Unsupported SANDBOX_PROVIDER: unsupported-b"
    );
    expect(() => resolveSandboxBackendName("k8s")).toThrow("Unsupported SANDBOX_PROVIDER: k8s");
    expect(() => resolveSandboxBackendName("fly")).toThrow("Unsupported SANDBOX_PROVIDER: fly");
  });
});

describe("isModalSandboxBackend", () => {
  it("returns true for modal", () => {
    expect(isModalSandboxBackend("modal")).toBe(true);
  });

  it("returns true for undefined (default)", () => {
    expect(isModalSandboxBackend(undefined)).toBe(true);
  });

  it("throws for unsupported providers", () => {
    expect(() => isModalSandboxBackend("unsupported-a")).toThrow(
      "Unsupported SANDBOX_PROVIDER: unsupported-a"
    );
    expect(() => isModalSandboxBackend("unsupported-b")).toThrow(
      "Unsupported SANDBOX_PROVIDER: unsupported-b"
    );
  });
});

describe("supportsRepoImageBackend", () => {
  it("returns true for modal", () => {
    expect(supportsRepoImageBackend("modal")).toBe(true);
    expect(supportsRepoImageBackend(undefined)).toBe(true);
  });

  it("throws for unsupported providers", () => {
    expect(() => supportsRepoImageBackend("unsupported-a")).toThrow(
      "Unsupported SANDBOX_PROVIDER: unsupported-a"
    );
    expect(() => supportsRepoImageBackend("unsupported-b")).toThrow(
      "Unsupported SANDBOX_PROVIDER: unsupported-b"
    );
  });
});

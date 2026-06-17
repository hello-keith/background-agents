import { describe, it, expect } from "vitest";
import { getScmRepoUrl, getScmBranchUrl } from "./scm";

describe("scm", () => {
  describe("getScmRepoUrl", () => {
    it("returns github URL", () => {
      expect(getScmRepoUrl("acme", "app")).toBe("https://github.com/acme/app");
    });

    it("encodes owner and name", () => {
      expect(getScmRepoUrl("my org", "my repo")).toBe("https://github.com/my%20org/my%20repo");
    });
  });

  describe("getScmBranchUrl", () => {
    it("returns github branch URL by default", () => {
      expect(getScmBranchUrl("acme", "app", "main")).toBe("https://github.com/acme/app/tree/main");
    });

    it("encodes branch names with special characters", () => {
      expect(getScmBranchUrl("acme", "app", "feat/my branch")).toBe(
        "https://github.com/acme/app/tree/feat%2Fmy%20branch"
      );
    });

    it("encodes owner and name", () => {
      expect(getScmBranchUrl("my org", "my repo", "main")).toBe(
        "https://github.com/my%20org/my%20repo/tree/main"
      );
    });
  });
});

import { describe, expect, it } from "vitest";
import { blockedAuthPaths } from "./index.js";

describe("auth policy", () => {
  it("blocks invitation and org-creation paths in version 1", () => {
    expect(blockedAuthPaths.some((p) => p.includes("invite"))).toBe(true);
    expect(blockedAuthPaths.some((p) => p.includes("create"))).toBe(true);
  });

  it("blocks local sign-up so user ids can only come from CDP", () => {
    expect(blockedAuthPaths).toContain("/sign-up/email");
    expect(blockedAuthPaths.some((path) => path.includes("sign-up"))).toBe(true);
  });
});

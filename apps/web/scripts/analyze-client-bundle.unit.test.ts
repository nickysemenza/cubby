import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertNoServerCodeInClient } from "./analyze-client-bundle";

const fixturePath = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe("client bundle analyzer", () => {
  it("rejects server-only markers in every client asset", () => {
    expect(() =>
      assertNoServerCodeInClient(fixturePath("clean-assets")),
    ).not.toThrow();
    expect(() =>
      assertNoServerCodeInClient(fixturePath("leaky-assets")),
    ).toThrow(/drizzle-orm/);
  });
});

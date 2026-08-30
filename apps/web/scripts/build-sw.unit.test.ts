import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertNoServerCodeInClient } from "./build-sw";

const fixturePath = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe("client bundle boundary", () => {
  it("rejects server-only markers in every client asset", async () => {
    await expect(
      assertNoServerCodeInClient(fixturePath("clean-assets")),
    ).resolves.toBeUndefined();
    await expect(
      assertNoServerCodeInClient(fixturePath("leaky-assets")),
    ).rejects.toThrow(/drizzle-orm/);
  });
});

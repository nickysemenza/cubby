import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertNoServerCodeInClient,
  assertNoDevLoginInWorker,
} from "./check-client-bundle";

const fixturePath = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe("client bundle boundary", () => {
  it("rejects local storage and readiness handlers in production output", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cubby-worker-boundary-"),
    );
    try {
      for (const route of ["/__dev/ready", "/__local-storage/s3/"]) {
        await writeFile(
          path.join(directory, "worker.js"),
          `const route = '${route}';`,
        );
        await expect(assertNoDevLoginInWorker(directory)).rejects.toThrow(
          /local/i,
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("rejects server-only markers in every client asset", async () => {
    await expect(
      assertNoServerCodeInClient(fixturePath("clean-assets")),
    ).resolves.toBeUndefined();
    await expect(
      assertNoServerCodeInClient(fixturePath("leaky-assets")),
    ).rejects.toThrow(/drizzle-orm/);
  });
});

import { describe, expect, it } from "vitest";
import type { Database } from "~/server/db";
import { importImageFromUrl } from "./image-storage.service";

describe("image storage URL validation", () => {
  const db = undefined as unknown as Database;

  it.each([
    "ftp://example.com/image.jpg",
    "https://user:pass@example.com/image.jpg",
    "http://localhost/image.jpg",
    "http://127.0.0.1/image.jpg",
    "http://10.0.0.4/image.jpg",
    "http://192.168.1.2/image.jpg",
    "http://[::1]/image.jpg",
  ])("rejects unsafe image import URL %s", async (sourceUrl) => {
    await expect(
      importImageFromUrl(db, { sourceUrl, filenamePrefix: "test" }),
    ).rejects.toThrow();
  });
});

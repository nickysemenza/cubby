import { describe, expect, it } from "vitest";
import { createE2EObjectStorage } from "./local-object-storage";

// HTTP success alone can hide a fake storage seam. Inspect the local R2 binding
// independently, including escaped paths, MIME metadata, HEAD and deletion.
describe("E2E local R2 storage", () => {
  it("stores streamed PUT bytes in R2 and serves public/S3 paths with CORS", async () => {
    const storage = await createE2EObjectStorage();
    try {
      const key = "e2e/synthetic space.png";
      const publicPath = key.split("/").map(encodeURIComponent).join("/");
      const put = await fetch(
        `${storage.url}/e2e-bucket/${encodeURIComponent(key)}`,
        {
          method: "PUT",
          headers: { "content-type": "image/png" },
          body: "synthetic bytes",
        },
      );
      expect(put.status).toBe(200);
      const object = await storage.bucket.get(key);
      expect(await object?.text()).toBe("synthetic bytes");
      expect(object?.httpMetadata?.contentType).toBe("image/png");
      const get = await fetch(`${storage.url}/${publicPath}`);
      expect(get.headers.get("access-control-allow-origin")).toBe("*");
      expect(get.headers.get("content-type")).toBe("image/png");
      expect(await get.text()).toBe("synthetic bytes");
      const head = await fetch(`${storage.url}/${publicPath}`, {
        method: "HEAD",
      });
      expect(head.headers.get("content-length")).toBe("15");
      expect(await head.text()).toBe("");
      expect(
        (
          await fetch(`${storage.url}/e2e-bucket/${encodeURIComponent(key)}`, {
            method: "DELETE",
          })
        ).status,
      ).toBe(204);
      expect(await storage.bucket.get(key)).toBeNull();
      expect((await fetch(`${storage.url}/${publicPath}`)).status).toBe(404);
    } finally {
      await storage.close();
    }
  }, 30000);
});

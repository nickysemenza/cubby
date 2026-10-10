import { describe, expect, it } from "vitest";
import {
  createE2EObjectStorage,
  type E2EObjectStorage,
} from "./local-object-storage";

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

  // Browser workers each start their own storage concurrently; one worker's
  // upload or close must never reach another's bucket.
  it("keeps simultaneous instances isolated through delete and close", async () => {
    const opened = await Promise.allSettled([
      createE2EObjectStorage(),
      createE2EObjectStorage(),
    ]);
    const storage = opened.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    try {
      for (const result of opened)
        if (result.status === "rejected") throw result.reason;
      const [first, second] = storage;
      if (!first || !second) throw new Error("Both instances must start");
      expect(first.url).not.toBe(second.url);
      const key = "e2e/synthetic shared key.bin";
      const s3 = (instance: E2EObjectStorage) =>
        `${instance.url}/e2e-bucket/${encodeURIComponent(key)}`;
      const bytes = [
        new Uint8Array([0, 1, 2, 3, 254, 255]),
        new Uint8Array([255, 254, 3, 2, 1, 0, 9]),
      ] as const;
      await Promise.all(
        [first, second].map(async (instance, index) =>
          expect(
            (await fetch(s3(instance), { method: "PUT", body: bytes[index] }))
              .status,
          ).toBe(200),
        ),
      );
      const stored = async (instance: E2EObjectStorage) => {
        const object = await instance.bucket.get(key);
        return object && new Uint8Array(await object.arrayBuffer());
      };
      expect(await stored(first)).toEqual(bytes[0]);
      expect(await stored(second)).toEqual(bytes[1]);
      expect((await fetch(s3(first), { method: "DELETE" })).status).toBe(204);
      expect(await stored(first)).toBeNull();
      expect(await stored(second)).toEqual(bytes[1]);
      await first.close();
      expect(await stored(second)).toEqual(bytes[1]);
    } finally {
      await Promise.allSettled(storage.map((instance) => instance.close()));
    }
  }, 30000);
});

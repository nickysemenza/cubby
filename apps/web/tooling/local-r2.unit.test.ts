import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";

// Failure modes: signed paths and public URLs disagree on escaped keys; expiry
// blocks local uploads; metadata/HEAD drift from bytes; invalid ranges download
// the whole object; transform paths miss originals; deletion leaves stale data.
// A real R2 binding catches stream, metadata, and range behavior node mocks miss.
describe("local R2 HTTP contract", () => {
  let directory: string;
  let harness: ReturnType<typeof createTestHarness>;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "cubby-local-r2-test-"));
    await writeFile(
      join(directory, "worker.ts"),
      `import { handleLocalStorageRequest } from ${JSON.stringify(join(import.meta.dirname, "local-r2.ts"))};
       export default { async fetch(request, env) {
         return await handleLocalStorageRequest(request, env) ?? new Response("App route", {status: 418});
       }};`,
    );
    harness = createTestHarness({
      root: directory,
      workers: [
        {
          config: {
            name: "cubby-local-r2-contract",
            main: "worker.ts",
            compatibility_date: "2026-09-01",
            r2_buckets: [
              { binding: "LOCAL_DEV_STORAGE", bucket_name: "local-contract" },
            ],
            vars: {
              R2_BUCKET_NAME: "local-contract",
              R2_KEY_PREFIX: "local-fixtures",
            },
          },
        },
      ],
    });
    await harness.listen();
  }, 60_000);

  afterAll(async () => {
    await harness?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("shares uploaded bytes and HTTP metadata across signed, public, and transform URLs", async () => {
    const key = "local-fixtures/images/fixture%20%25.txt";
    const signed = `/__local-storage/s3/local-contract/${key}?X-Amz-Expires=0&X-Amz-Signature=expired`;
    const uploaded = await harness.fetch(signed, {
      method: "PUT",
      body: "synthetic-bytes",
      headers: {
        "Content-Type": "text/plain",
        "Content-Disposition": "inline; filename=fixture.txt",
      },
    });
    expect(uploaded.status).toBe(200);
    expect(uploaded.headers.get("etag")).toBeTruthy();
    for (const url of [
      signed,
      `/${key}`,
      `/cdn-cgi/image/width=32,format=auto/${key}`,
    ]) {
      const read = await harness.fetch(url, {
        headers: { "Accept-Encoding": "identity" },
      });
      expect(read.status).toBe(200);
      expect(read.headers.get("content-type")).toBe("text/plain");
      expect(read.headers.get("content-disposition")).toBe(
        "inline; filename=fixture.txt",
      );
      expect(read.headers.get("content-length")).toBe("15");
      expect(await read.text()).toBe("synthetic-bytes");
    }
    const head = await harness.fetch(`/${key}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("15");
    expect(await head.text()).toBe("");
    expect((await harness.fetch(signed, { method: "DELETE" })).status).toBe(
      204,
    );
    expect((await harness.fetch(`/${key}`)).status).toBe(404);
    expect((await harness.fetch(signed, { method: "DELETE" })).status).toBe(
      204,
    );
  });

  it("returns precise bounded, open, and suffix ranges and rejects unsatisfiable ranges", async () => {
    const path =
      "/__local-storage/s3/local-contract/local-fixtures/document.txt";
    await harness.fetch(path, { method: "PUT", body: "0123456789" });
    for (const [range, bytes, contentRange] of [
      ["bytes=2-4", "234", "bytes 2-4/10"],
      ["bytes=7-", "789", "bytes 7-9/10"],
      ["bytes=-3", "789", "bytes 7-9/10"],
      ["bytes=7-99", "789", "bytes 7-9/10"],
    ]) {
      const response = await harness.fetch(path, {
        headers: { Range: range! },
      });
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(contentRange);
      expect(response.headers.get("content-length")).toBe(
        String(bytes!.length),
      );
      expect(await response.text()).toBe(bytes);
    }
    for (const range of [
      "bytes=10-",
      "bytes=6-2",
      "bytes=-0",
      "bytes=0-1,4-5",
      "bytes=wat",
    ]) {
      const response = await harness.fetch(path, { headers: { Range: range } });
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe("bytes */10");
    }
    await harness.fetch(path, { method: "DELETE" });
  });

  it("answers browser preflights, isolates the bucket, and delegates app paths", async () => {
    const path =
      "/__local-storage/s3/local-contract/local-fixtures/missing.txt";
    const preflight = await harness.fetch(path, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:8080",
        "Access-Control-Request-Headers": "content-type,x-amz-content-sha256",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-methods")).toContain(
      "HEAD",
    );
    expect(preflight.headers.get("access-control-allow-headers")).toBe(
      "*, Authorization",
    );
    const missing = await harness.fetch(path);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("access-control-allow-origin")).toBe("*");
    expect(
      (
        await harness.fetch(path.replace("local-contract", "other-bucket"), {
          method: "PUT",
          body: "wrong bucket",
        })
      ).status,
    ).toBe(404);
    expect((await harness.fetch("/products")).status).toBe(418);
    expect(
      (
        await harness.fetch("/local-fixtures/document.txt", {
          method: "PUT",
          body: "public write",
        })
      ).status,
    ).toBe(405);
  });
});

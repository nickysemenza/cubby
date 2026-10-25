import { readFileSync } from "node:fs";

import { expect, it, vi } from "vitest";

import { readImageIdentificationRendition } from "./image-identification.service";

const SOURCE_URL = "https://images.example.com/cubby/images/portrait.heic";
const JPEG = new Uint8Array(
  readFileSync(
    new URL(
      "../../purchase-import/service/gmail/fixtures/synthetic-photographic-receipt.jpg",
      import.meta.url,
    ),
  ),
);

it("bounds a tall portrait's identification rendition on both axes", async () => {
  // A width-only 2048 JPEG of a 4284×5712 photo measured 2,209,358 bytes at
  // the edge, over the 2 MiB identification budget, so every retry failed.
  const edge = vi.fn(async (url: string | URL | Request) =>
    String(url).includes("height=")
      ? new Response(JPEG)
      : new Response(new Uint8Array(2_209_358)),
  );
  const { media } = await readImageIdentificationRendition(
    SOURCE_URL,
    edge as typeof fetch,
  );
  expect(media.content_type).toBe("image/jpeg");
  expect(edge.mock.calls.map(([url]) => String(url))).toEqual([
    "https://images.example.com/cdn-cgi/image/width=1024,height=1024,fit=scale-down,format=jpeg/cubby/images/portrait.heic",
  ]);
});

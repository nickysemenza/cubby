import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { hasMeaningfulPngTransparency } from "./image-transparency";

const u32 = (value: number) =>
  Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );

function chunk(type: string, data: Uint8Array) {
  const result = new Uint8Array(12 + data.length);
  result.set(u32(data.length));
  result.set(new TextEncoder().encode(type), 4);
  result.set(data, 8);
  return result;
}

function rgbaPng(pixels: number[][]) {
  const header = new Uint8Array(13);
  header.set(u32(pixels.length), 0);
  header.set(u32(1), 4);
  header.set([8, 6, 0, 0, 0], 8);
  const compressed = new Uint8Array(
    deflateSync(Uint8Array.from([0, ...pixels.flat()])),
  );
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk("IHDR", header),
    ...chunk("IDAT", compressed),
    ...chunk("IEND", new Uint8Array()),
  ]);
}

describe("transparent PNG validation", () => {
  it("rejects an opaque RGBA PNG", async () => {
    await expect(
      hasMeaningfulPngTransparency(rgbaPng([[10, 20, 30, 255]])),
    ).resolves.toBe(false);
  });
  it("accepts a PNG with visible and non-opaque pixels", async () => {
    await expect(
      hasMeaningfulPngTransparency(
        rgbaPng([
          [10, 20, 30, 128],
          [20, 30, 40, 255],
        ]),
      ),
    ).resolves.toBe(true);
  });
});

/** Failure: the local codecs are unavailable in workerd, or crop the receipt. */
import { describe, expect, it } from "vitest";

import {
  ModelImageInputError,
  prepareModelImage,
} from "~/server/domains/image-processing/service/model-image";

import { INLINE_EMAIL_PNG_BASE64 } from "./email-html.fixtures";
import animatedWebp from "./fixtures/synthetic-animated.webp?inline";
import nearLimitPortrait from "./fixtures/synthetic-near-limit.png?inline";
import photographicReceipt from "./fixtures/synthetic-photographic-receipt.jpg?inline";
import gifReceipt from "./fixtures/synthetic-seller-payout.gif?inline";
import webpReceipt from "./fixtures/synthetic-seller-payout.webp?inline";
import tallReceipt from "./fixtures/synthetic-tall-receipt.png?inline";

// Read JPEG SOF dimensions without a second image decoder or service binding.
function dimensions(bytes: Uint8Array) {
  for (let offset = 2; offset < bytes.length;) {
    const marker = bytes[offset + 1];
    const size = bytes[offset + 2]! * 256 + bytes[offset + 3]!;
    if (marker === 0xc0 || marker === 0xc2)
      return {
        width: bytes[offset + 7]! * 256 + bytes[offset + 8]!,
        height: bytes[offset + 5]! * 256 + bytes[offset + 6]!,
      };
    offset += size + 2;
  }
  throw new Error("No JPEG dimensions");
}

const inlineBytes = (uri: string) => Buffer.from(uri.split(",")[1]!, "base64");

describe("private local image transformation in workerd", () => {
  it("keeps the full tall receipt frame at both detail levels", async () => {
    const bytes = inlineBytes(tallReceipt);
    for (const detail of ["standard", "detail"] as const) {
      const result = await prepareModelImage(bytes, detail);
      expect(result!.bytes.byteLength).toBeLessThanOrEqual(128 * 1024);
      const size = dimensions(result!.bytes);
      expect(size.height).toBeGreaterThanOrEqual(
        detail === "standard" ? 1536 : 3072,
      );
      expect(size.height).toBeLessThanOrEqual(
        detail === "standard" ? 2048 : 3800,
      );
      expect(Math.abs(size.width - (size.height * 1400) / 3800)).toBeLessThan(
        1,
      );
    }
  });

  it("resizes a near-limit portrait without a float scratch frame", async () => {
    const result = await prepareModelImage(
      inlineBytes(nearLimitPortrait),
      "detail",
    );
    expect(result!.bytes.byteLength).toBeLessThanOrEqual(128 * 1024);
    expect(dimensions(result!.bytes).height).toBeGreaterThan(2000);
  });

  it("keeps a bounded WebP receipt without decoding or losing pixels", async () => {
    const bytes = inlineBytes(webpReceipt);
    const result = await prepareModelImage(bytes, "standard");
    expect(result?.mimeType).toBe("image/webp");
    expect(result?.bytes).toEqual(bytes);
    expect(await prepareModelImage(bytes, "detail")).toBeNull();
  });

  it("keeps animated or oversized WebP missing instead of supplying incomplete pixels", async () => {
    const oversized = Buffer.concat([
      inlineBytes(webpReceipt),
      Buffer.alloc(128 * 1024),
    ]);
    for (const bytes of [inlineBytes(animatedWebp), oversized])
      await expect(prepareModelImage(bytes, "standard")).rejects.toBeInstanceOf(
        ModelImageInputError,
      );
  });

  it("normalizes a static GIF receipt into a bounded JPEG", async () => {
    const result = await prepareModelImage(inlineBytes(gifReceipt), "standard");
    expect(result?.bytes.byteLength).toBeLessThanOrEqual(128 * 1024);
    expect(result?.mimeType).toBe("image/jpeg");
    expect(dimensions(result!.bytes).height).toBeGreaterThan(1000);
  });

  it.each(["standard", "detail"] as const)(
    "encodes photographic evidence at %s detail within the output budget",
    async (detail) => {
      const result = await prepareModelImage(
        inlineBytes(photographicReceipt),
        detail,
      );
      expect(result!.bytes.byteLength).toBeLessThanOrEqual(128 * 1024);
      expect(dimensions(result!.bytes).height).toBeGreaterThan(1500);
    },
  );

  it("turns private PNG bytes into JPEG without an Images binding", async () => {
    const result = await prepareModelImage(
      Buffer.from(INLINE_EMAIL_PNG_BASE64, "base64"),
      "standard",
    );
    expect(result!.mimeType).toBe("image/jpeg");
    expect(result!.bytes.slice(0, 3)).toEqual(new Uint8Array([255, 216, 255]));
  });
});

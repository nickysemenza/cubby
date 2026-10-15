/** Failure: a declared Images binding does not actually transform private streams
 * in the Worker runtime, or loses the complete frame through cropping. */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { prepareModelImage } from "~/server/image-processing/model-image";

import { INLINE_EMAIL_PNG_BASE64 } from "./email-html.fixtures";
import tallReceipt from "./fixtures/synthetic-tall-receipt.png?inline";

describe("private model image transformation in workerd", () => {
  it("keeps the full tall receipt frame at both detail levels", async () => {
    const bytes = Buffer.from(tallReceipt.split(",")[1]!, "base64");
    for (const detail of ["standard", "detail"] as const) {
      const result = await prepareModelImage(bytes, detail, env.IMAGES);
      expect(result).not.toBeNull();
      const info = await env.IMAGES.info(
        new Response(new Uint8Array(result!.bytes)).body!,
      );
      expect(info).toMatchObject(
        detail === "standard"
          ? { width: 755, height: 2048 }
          : { width: 1400, height: 3800 },
      );
    }
  });

  it("transforms a private PNG byte stream into a bounded JPEG", async () => {
    const result = await prepareModelImage(
      Buffer.from(INLINE_EMAIL_PNG_BASE64, "base64"),
      "standard",
      env.IMAGES,
    );
    expect(result?.mimeType).toBe("image/jpeg");
    expect(result?.bytes.byteLength).toBeLessThanOrEqual(128 * 1024);
    expect(result!.bytes.slice(0, 3)).toEqual(new Uint8Array([255, 216, 255]));
  });
});

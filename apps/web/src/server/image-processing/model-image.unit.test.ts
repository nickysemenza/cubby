/** Failure: source decoding refusal aborts an otherwise readable message, or
 * an infrastructure failure is silently mistaken for unusable source pixels. */
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";

import { prepareModelImage } from "./model-image";

const binding = (error: Error & { code: number }): ImagesBinding =>
  fromPartial<ImagesBinding>({
    input() {
      throw error;
    },
  });

describe("image preparation refusal", () => {
  it("tries a smaller rendition when encoded bytes would consume the request budget", async () => {
    const output = vi
      .fn()
      .mockResolvedValueOnce({
        response: () => new Response(new Uint8Array(200 * 1024)),
        contentType: () => "image/jpeg",
      })
      .mockResolvedValueOnce({
        response: () => new Response(new Uint8Array([255, 216, 255])),
        contentType: () => "image/jpeg",
      });
    const images = fromPartial<ImagesBinding>({
      input: () =>
        fromPartial<ImageTransformer>({
          transform: () => fromPartial<ImageTransformer>({ output }),
        }),
    });
    const result = await prepareModelImage(
      new Uint8Array([1]),
      "standard",
      images,
    );
    expect(result?.bytes.byteLength).toBe(3);
    expect(output).toHaveBeenCalledTimes(2);
  });

  it("refuses invalid image input without hiding service failures", async () => {
    await expect(
      prepareModelImage(
        new Uint8Array([1]),
        "standard",
        binding(
          Object.assign(new Error("Synthetic invalid image"), { code: 9412 }),
        ),
      ),
    ).resolves.toBeNull();
    await expect(
      prepareModelImage(
        new Uint8Array([1]),
        "standard",
        binding(
          Object.assign(new Error("Synthetic service outage"), { code: 9523 }),
        ),
      ),
    ).rejects.toThrow("Synthetic service outage");
  });
});

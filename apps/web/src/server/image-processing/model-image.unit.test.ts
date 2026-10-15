/** Failure: an oversized rendition is discarded without trying a compact encoding
 * that would fit the model request. */
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";

import { prepareModelImage } from "./model-image";

type Images = NonNullable<Parameters<typeof prepareModelImage>[2]>;
type Transformer = ReturnType<Images["input"]>;

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
    const images = fromPartial<Images>({
      input: () =>
        fromPartial<Transformer>({
          transform: () => fromPartial<Transformer>({ output }),
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
});

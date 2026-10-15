import {
  ExternalFetchError,
  readResponseWithLimit,
} from "@cubby/shared/external-fetch";

import { getImages } from "~/server/cf-env";

/** Keep the full frame: cropping a receipt can remove its transaction evidence. */
export async function prepareModelImage(
  bytes: Uint8Array,
  detail: "standard" | "detail",
  images = getImages(),
) {
  if (!images) return null;
  const renditions =
    detail === "detail"
      ? [
          { width: 2048, height: 4096, quality: 85 },
          { width: 2048, height: 4096, quality: 45 },
          { width: 1536, height: 3072, quality: 45 },
        ]
      : [
          { width: 1280, height: 2048, quality: 75 },
          { width: 1280, height: 2048, quality: 50 },
          { width: 960, height: 1536, quality: 50 },
        ];
  for (const { width, height, quality } of renditions) {
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    try {
      const rendition = await images
        .input(input)
        .transform({ width, height, fit: "scale-down" })
        .output({ format: "image/jpeg", quality, anim: false });
      return {
        bytes: await readResponseWithLimit(rendition.response(), 128 * 1024),
        mimeType: rendition.contentType(),
      };
    } catch (error) {
      if (
        error instanceof ExternalFetchError &&
        error.code === "body-too-large"
      )
        continue;
      throw error;
    }
  }
  return null;
}

import { wasm } from "~/lib/wasm";

/** An unsupported, invalid or oversized input leaves purchase evidence missing. */
export class ModelImageInputError extends Error {}

/** Keep private bytes in-process and the full frame: cropping can lose an order. */
export async function prepareModelImage(
  bytes: Uint8Array,
  detail: "standard" | "detail",
) {
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp =
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString() === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString() === "WEBP";
  if (webp) {
    // The model accepts WebP directly; keep bounded bytes without decoding them.
    const extended = Buffer.from(bytes.subarray(12, 16)).toString() === "VP8X";
    if (extended && (bytes[20] ?? 0) & 2)
      throw new ModelImageInputError(
        "Animated WebP leaves image evidence incomplete",
      );
    if (bytes.byteLength > 128 * 1024)
      throw new ModelImageInputError("WebP exceeds model image byte budget");
    return detail === "detail" ? null : { bytes, mimeType: "image/webp" };
  }
  if (jpeg && bytes.byteLength <= 128 * 1024)
    return detail === "detail" ? null : { bytes, mimeType: "image/jpeg" };
  try {
    return {
      bytes: wasm.prepare_model_image(bytes, detail === "detail"),
      mimeType: "image/jpeg",
    };
  } catch (error) {
    // Rust Result::Err(String) is a JS string. Traps and host failures propagate.
    if (typeof error === "string") throw new ModelImageInputError(error);
    throw error;
  }
}

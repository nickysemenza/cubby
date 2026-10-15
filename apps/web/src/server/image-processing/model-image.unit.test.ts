/** Invalid or unsupported pixels are missing evidence; WASM execution faults
 * must remain visible rather than masquerading as an input refusal. */
import { expect, it } from "vitest";

import { ModelImageInputError, prepareModelImage } from "./model-image";

it("reports invalid image input as a typed refusal", async () => {
  await expect(
    prepareModelImage(new Uint8Array([1, 2, 3]), "standard"),
  ).rejects.toBeInstanceOf(ModelImageInputError);
});

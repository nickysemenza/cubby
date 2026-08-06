import { describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import { cleanupImageVariants, deleteImageVariants } from "./images";

const upc = "012345678905";
const imageKeys = [
  `images/${upc}.jpg`,
  `images/${upc}.png`,
  `images/${upc}.gif`,
  `images/${upc}.webp`,
  `images/${upc}.heic`,
  `images/${upc}.heif`,
];

function envWithImagesDelete() {
  const deleteImageObjects = vi.fn().mockResolvedValue(undefined);
  return {
    env: { IMAGES: { delete: deleteImageObjects } } as unknown as Env,
    deleteImageObjects,
  };
}

describe("image variant cleanup", () => {
  it("removes obsolete MIME variants after a PNG pointer replaces a JPEG", async () => {
    const { env, deleteImageObjects } = envWithImagesDelete();

    await cleanupImageVariants(env, upc, `images/${upc}.png`);

    expect(deleteImageObjects).toHaveBeenCalledWith(
      imageKeys.filter((key) => key !== `images/${upc}.png`),
    );
  });

  it("removes every MIME variant when deleting a product", async () => {
    const { env, deleteImageObjects } = envWithImagesDelete();

    await deleteImageVariants(env, upc);

    expect(deleteImageObjects).toHaveBeenCalledWith(imageKeys);
  });
});

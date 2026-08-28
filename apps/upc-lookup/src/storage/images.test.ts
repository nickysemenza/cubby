import { describe, expect, it } from "vitest";
import {
  cleanupImageVariants,
  deleteImageVariants,
  type ImageCleanupEnv,
} from "./images";

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
  let deletedKeys: string[] = [];
  const deleteImageObjects = async (keys: string | string[]) => {
    deletedKeys = Array.isArray(keys) ? keys : [keys];
  };
  const env: ImageCleanupEnv = { IMAGES: { delete: deleteImageObjects } };
  return {
    env,
    getDeletedKeys: () => deletedKeys,
  };
}

describe("image variant cleanup", () => {
  it("removes obsolete MIME variants after a PNG pointer replaces a JPEG", async () => {
    const { env, getDeletedKeys } = envWithImagesDelete();

    await cleanupImageVariants(env, upc, `images/${upc}.png`);

    expect(getDeletedKeys()).toEqual(
      imageKeys.filter((key) => key !== `images/${upc}.png`),
    );
  });

  it("removes every MIME variant when deleting a product", async () => {
    const { env, getDeletedKeys } = envWithImagesDelete();

    await deleteImageVariants(env, upc);

    expect(getDeletedKeys()).toEqual(imageKeys);
  });
});

import { cookbookBundleMetadataSchema } from "@cubby/schemas/import-recipe";
import { z } from "zod";

export const bundleRequestSchema = z.discriminatedUnion("op", [
  z.object({ id: z.int(), op: z.literal("open"), file: z.instanceof(Blob) }),
  z.object({ id: z.int(), op: z.literal("image"), path: z.string() }),
]);
export type BundleRequest = z.infer<typeof bundleRequestSchema>;
export const bundleResponseSchema = z.union([
  z.object({ id: z.int(), error: z.string() }),
  z.object({ id: z.int(), metadata: cookbookBundleMetadataSchema }),
  z.object({ id: z.int(), bytes: z.instanceof(Uint8Array) }),
]);

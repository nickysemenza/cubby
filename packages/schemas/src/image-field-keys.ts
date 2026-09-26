// Leaf module: the generator reads this list, so it must not import anything
// that reaches generated output (`pnpm generate` runs before that output
// exists on a fresh checkout). `updateInputImages` in ./image.ts is built from
// it, so the wire schema and the generated Swift set cannot drift.
export const IMAGE_FIELD_KEYS = [
  "pendingImageIds",
  "removeImageIds",
  "imageOrder",
] as const;

import { importRunPublicId } from "@cubby/schemas/purchase-import";

export function mintImportRunPublicId() {
  return importRunPublicId.parse(
    `PIR-${crypto.randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`,
  );
}

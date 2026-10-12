import { z } from "zod";

/** Stored source identities are shared by retained-mail reads and import writers. */
export const importSourceKind = z.enum([
  "browser_order",
  "mail_message",
  "mail_attachment",
  "receipt_photo",
  "vendor_export",
]);

export const importSourceIdentity = z.object({
  kind: importSourceKind,
  externalKey: z.string().trim().min(1).max(512),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
});

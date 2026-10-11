import { deleteS3Object, getS3Object, uploadToS3 } from "~/server/utils/s3";

/**
 * Object-storage seam for pending order-mail attachment bytes (the PDF a mail
 * carried, waiting for its Purchase). The bytes never live in Postgres: the row
 * holds only `pendingObjectKey`.
 */
export interface OrderMailAttachmentStorage {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Throws when the object is missing or unreadable. */
  get(key: string): Promise<Uint8Array>;
  /** A missing object is not an error. */
  delete(key: string): Promise<void>;
}

/**
 * Legacy migration key and prefix for new attempt-specific uploads. Stored keys
 * are read verbatim; an upload appends its own UUID so delayed cleanup cannot
 * delete a replacement's bytes. Keep this prefix outside R2_KEY_PREFIX for
 * compatibility with migrated originals.
 */
export const orderMailAttachmentKey = (id: string): string =>
  `order-mail-attachment/${id}`;

export const productionOrderMailAttachmentStorage: OrderMailAttachmentStorage =
  {
    put: (key, bytes, contentType) =>
      uploadToS3({ key, body: Buffer.from(bytes), contentType }),
    get: async (key) => {
      const response = await getS3Object(key);
      if (!response.ok) {
        throw new Error(
          `Failed to read ${key}: ${response.status} ${response.statusText}`,
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    },
    delete: deleteS3Object,
  };

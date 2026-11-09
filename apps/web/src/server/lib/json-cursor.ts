import { decodeBase64UrlText, encodeBase64Url } from "@cubby/shared/base64";
import type { z } from "zod";

/**
 * An opaque keyset cursor: `prefix` plus base64url JSON checked by `schema`.
 * Any malformed cursor throws `invalid`, so callers never see a parse error.
 */
export const jsonCursor = <Schema extends z.ZodType>(
  schema: Schema,
  options: { prefix?: string; invalid: string },
) => {
  const prefix = options.prefix ?? "";
  return {
    encode: (value: z.input<Schema>) =>
      `${prefix}${encodeBase64Url(JSON.stringify(value))}`,
    decode: (cursor: string): z.output<Schema> => {
      try {
        if (!cursor.startsWith(prefix)) throw new Error("prefix");
        return schema.parse(
          JSON.parse(decodeBase64UrlText(cursor.slice(prefix.length))),
        );
      } catch {
        throw new Error(options.invalid);
      }
    },
  };
};

import type { ImageRepresentations } from "@cubby/schemas/image-summary";
import { and, asc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { z } from "zod";

import { getR2PublicUrl } from "~/server/clients/r2-public-url";
import { notDeleted } from "~/server/db/helpers/predicates";
import {
  entityAttachment,
  image,
  imageDerivative,
} from "~/server/db/retained-tables";

export const imageRepresentationRow = z.object({
  shortcode: z.string(),
  key: z.string(),
  useOriginal: z.boolean(),
  derivativeKey: z.string().nullable(),
});

/** The same ready/current-hash policy serves standalone and embedded media reads. */
export function imageRepresentationRowsSql(
  source: readonly string[] | { attachedTo: SQL },
  revisions: readonly number[],
): SQL {
  const matching =
    "attachedTo" in source
      ? sql`${image.id} IN (
        SELECT ${entityAttachment.imageId} FROM ${entityAttachment}
        WHERE ${entityAttachment.entityId} = ${source.attachedTo}
          AND ${notDeleted(entityAttachment)})`
      : inArray(image.shortcode, [...new Set(source)]);
  return sql`
    SELECT ${image.shortcode} AS shortcode, ${image.key} AS key,
      ${image.useOriginal} AS "useOriginal", ${imageDerivative.key} AS "derivativeKey"
    FROM ${image}
    LEFT JOIN ${imageDerivative} ON ${and(
      eq(imageDerivative.imageId, image.id),
      eq(imageDerivative.purpose, "transparent"),
      eq(imageDerivative.sourceContentHash, image.sha256),
      inArray(imageDerivative.processorRevision, [...revisions]),
      eq(imageDerivative.status, "ready"),
      notDeleted(imageDerivative),
    )}
    WHERE ${and(matching, notDeleted(image))}
    ORDER BY ${asc(imageDerivative.processorRevision)}, ${asc(imageDerivative.createdAt)}`;
}

export function imageRepresentationsFromRows(
  rows: readonly z.infer<typeof imageRepresentationRow>[],
): Map<string, ImageRepresentations> {
  return new Map(
    rows.map((row) => {
      const original = getR2PublicUrl(row.key);
      const transparent = row.derivativeKey
        ? getR2PublicUrl(row.derivativeKey)
        : null;
      const representations: ImageRepresentations = {
        original,
        transparent,
        preferred: !row.useOriginal && transparent ? transparent : original,
        preferredKind:
          !row.useOriginal && transparent ? "transparent" : "original",
      };
      return [row.shortcode, representations] as const;
    }),
  );
}

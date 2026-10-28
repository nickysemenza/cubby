import type { EntityId } from "@cubby/schemas/identifiers";
import { inArray, type SQL } from "drizzle-orm";

import { image } from "~/server/db/retained-tables";

/** Embedded media has public codes; list prefetch already has internal IDs. */
export type ImageReadScope =
  | readonly string[]
  | { imageIds: readonly EntityId<"image">[] };

export const imageScopeEmpty = (scope: ImageReadScope): boolean =>
  ("imageIds" in scope ? scope.imageIds : scope).length === 0;

export const imageScopeSql = (scope: ImageReadScope): SQL =>
  "imageIds" in scope
    ? inArray(image.id, [...scope.imageIds])
    : inArray(image.shortcode, [...scope]);

import type { ImageWithEntity } from "@cubby/schemas/image";
import type { ImportRunOut } from "@cubby/schemas/import-run";
import type { CookbookSummary } from "@cubby/schemas/recipe";

import type {
  DetailEntity,
  EntityDetailByEntity,
} from "~/entities/generated/entity-details.gen";

/**
 * The entities the generic detail page renders: every kernel detail entity
 * plus those whose detail route reads its own query (`route.detail:
 * { query }`) — image and cookbook have no kernel `get`, and a read-only
 * Run has no create/update contract.
 */
export type GenericDetailEntity =
  | DetailEntity
  | "image"
  | "cookbook"
  | "importRun";

/** The loaded record a generic detail page (and its slots) receives. */
export type DetailRecordOf<E extends GenericDetailEntity> =
  E extends DetailEntity
    ? EntityDetailByEntity[E]
    : E extends "image"
      ? ImageWithEntity
      : E extends "importRun"
        ? ImportRunOut
        : CookbookSummary;

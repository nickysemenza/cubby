import type {
  DetailEntity,
  EntityDetailByEntity,
} from "~/entity/generated/entity-details.gen";

/** The entities the generic detail page renders: every kernel detail entity. */
export type GenericDetailEntity = DetailEntity;

/** The loaded record a generic detail page (and its slots) receives. */
export type DetailRecordOf<E extends GenericDetailEntity> =
  EntityDetailByEntity[E];

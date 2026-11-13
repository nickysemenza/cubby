/**
 * The machinery capability of one entity (ADR 0025 item 11, ADR 0029
 * section 10): which scopes a record belongs to, in owning, fields, quality
 * order. A record's owning scope comes from `RecordKey`; its `fields` and
 * `quality` scopes are keyed by `fieldsScopeKey`.
 */
export type MachineryCapability = {
  readonly entity: string;
  /** The scope kind that owns the record through `RecordKey`; null for an authored entity. */
  readonly owning: string | null;
  /** Whether the entity declares AI fill-in (`fields` scope). */
  readonly fields: boolean;
  /** Whether the entity declares checks (`quality` scope). */
  readonly quality: boolean;
};

export const FIELDS_SCOPE = "fields";
export const QUALITY_SCOPE = "quality";

/** The key of a record's `fields` and `quality` scopes. */
export const recordScopeKey = (entity: string, id: string) => `${entity}:${id}`;

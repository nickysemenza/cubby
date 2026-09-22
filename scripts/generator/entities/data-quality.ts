import { z } from "zod";

import {
  EntityDeclarationError,
  type CompiledEntity,
  type EntityField,
  type EntityFieldModel,
  type FilterDescriptor,
} from "./declarations.ts";

type CompiledDataQualityCheck = Readonly<{
  id: string;
  facet: string;
  kind: "missing" | "defect";
  weight: number;
  label: string;
  message: string;
}>;

type CompiledDataQuality = Readonly<{
  checks: readonly CompiledDataQualityCheck[];
  exceptions: boolean;
  related: readonly string[];
}>;

/** What one declaration's block compiles to, beside the field model it extends. */
export interface CompiledDataQualityResult {
  dataQuality: CompiledDataQuality | null;
  fieldModel: EntityFieldModel;
  descriptors: readonly FilterDescriptor[];
}

const DATA_QUALITY_FIELD = "dataQuality";
const DATA_GAPS_FIELD = "dataGaps";
/**
 * The sort shares the column's id: a list column sorts by its own id, so the
 * one "Data quality" column is what sorts by score (asc = weakest first).
 */
const DATA_QUALITY_SORT = "dataQuality";
const DATA_QUALITY_LIST_RENDERER = "data-quality";

const STATUS_OPTIONS = [
  { value: "complete", label: "Complete", color: "var(--slate)" },
  { value: "needs_data", label: "Needs data", color: "var(--warning)" },
  { value: "defect", label: "Defect", color: "var(--destructive)" },
] as const;

/**
 * One `capabilities.dataQuality` block expands into the two derived model
 * fields, the two filter descriptors and the score sort that Product and
 * Purchase used to spell by hand. A declaration that also spells any of them
 * is rejected: the block is the single source, the same way `filters.audit`
 * owns `createdAt`/`updatedAt`.
 */
export const compileDataQuality = (
  raw: {
    checks: readonly {
      id: string;
      facet: string;
      kind: "missing" | "defect";
      weight: number;
      label: string;
      message: string;
    }[];
    exceptions: boolean;
    related: readonly string[];
    listOrder?: number;
  } | null,
  entityKey: string,
  fieldModel: EntityFieldModel,
  descriptors: readonly FilterDescriptor[],
  hasContract: boolean,
  hasFilterSchema: boolean,
  context: string,
): CompiledDataQualityResult => {
  const reserved = [DATA_QUALITY_FIELD, DATA_GAPS_FIELD];
  const declaredReserved = fieldModel.fields.find((field) =>
    reserved.includes(field.key),
  );
  const reservedDescriptor = descriptors.find((descriptor) =>
    reserved.includes(descriptor.columnId),
  );
  const declaredSort = fieldModel.sort?.fields.includes(DATA_QUALITY_SORT);
  if (raw === null) {
    if (declaredReserved || reservedDescriptor || declaredSort)
      throw new EntityDeclarationError(
        `${context} spells ${DATA_QUALITY_FIELD}/${DATA_GAPS_FIELD}/${DATA_QUALITY_SORT} by hand; declare capabilities.dataQuality instead.`,
      );
    return { dataQuality: null, fieldModel, descriptors };
  }
  if (declaredReserved || reservedDescriptor || declaredSort)
    throw new EntityDeclarationError(
      `${context}.capabilities.dataQuality owns ${DATA_QUALITY_FIELD}, ${DATA_GAPS_FIELD} and ${DATA_QUALITY_SORT}; remove the hand-declared copy.`,
    );
  if (!hasContract)
    throw new EntityDeclarationError(
      `${context}.capabilities.dataQuality needs a contract (the score is an output field).`,
    );
  if (fieldModel.sort === null)
    throw new EntityDeclarationError(
      `${context}.capabilities.dataQuality needs model.sort (the score is a sort).`,
    );
  const ids = raw.checks.map((check) => check.id);
  if (new Set(ids).size !== ids.length)
    throw new EntityDeclarationError(
      `${context}.capabilities.dataQuality.checks contains duplicate ids.`,
    );
  if (raw.related.includes(entityKey))
    throw new EntityDeclarationError(
      `${context}.capabilities.dataQuality.related cannot name the entity itself.`,
    );
  const provenance = {
    kind: "derived" as const,
    sources: [{ entity: entityKey, relation: null, label: null }],
  };
  const dataQualityField: EntityField = {
    key: DATA_QUALITY_FIELD,
    kind: "json",
    nullable: false,
    label: "Data quality",
    description: null,
    readKey: DATA_QUALITY_FIELD,
    reference: null,
    provenance,
    explanation: {
      ruleId: `${entityKey}.data-quality`,
      version: 1,
      description:
        "Data-quality gaps and the 0–100 completeness score are evaluated from the checks this entity declares.",
      resolver: "field",
      projections: {
        list: "dataQuality.status",
        summary: "dataQuality.status",
      },
      sourceDependencies: [
        { path: "dataQuality.gaps", label: "Detected gaps" },
      ],
    },
    resolution: null,
    control: null,
    display: {
      list: true,
      detail: false,
      columnId: DATA_QUALITY_FIELD,
      standard: null,
      detailOrder: null,
      listOrder: raw.listOrder ?? null,
      width: null,
      format: null,
      renderer: { list: DATA_QUALITY_LIST_RENDERER, detail: null },
      mobile: null,
      listHidden: true,
    },
    // The real read schema is `dataQuality` from `@cubby/schemas/data-quality`,
    // spliced in by the field-schema renderer: the compiler cannot import it
    // without importing the check registry it is about to generate.
    validation: { read: z.unknown(), create: null, update: null },
  };
  const dataGapsField: EntityField = {
    key: DATA_GAPS_FIELD,
    kind: "json",
    nullable: false,
    label: "Data gaps",
    description: null,
    readKey: null,
    reference: null,
    provenance,
    explanation: {
      ruleId: `${entityKey}.data-gaps`,
      version: 1,
      description:
        "Data gaps are the current checks reported by this entity's data-quality evaluation.",
      resolver: "field",
      projections: { list: "dataQuality.gaps", summary: "dataQuality.gaps" },
      sourceDependencies: [
        { path: "dataQuality.gaps", label: "Detected gaps" },
      ],
    },
    resolution: null,
    control: null,
    display: {
      list: false,
      detail: false,
      columnId: null,
      standard: null,
      detailOrder: null,
      listOrder: null,
      width: null,
      format: null,
      renderer: null,
      mobile: null,
      listHidden: false,
    },
    validation: { read: null, create: null, update: null },
  };
  const descriptorBase = {
    optionsRef: null,
    optionsKey: null,
    label: null,
    schemaDescription: null,
    deriveSchema: true,
    schemaFromRead: false,
    brandRef: null,
    expandRef: null,
    schemaRef: null,
    stored: null,
    range: null,
    urlOnly: false,
    nullable: null,
  } as const;
  const statusDescriptor: FilterDescriptor = {
    ...descriptorBase,
    columnId: DATA_QUALITY_FIELD,
    field: "dataStatus",
    urlKey: DATA_QUALITY_FIELD,
    kind: "select",
    placeholder: "Filter data quality...",
    options: [...STATUS_OPTIONS],
    wire: { kind: "param", name: "dataStatus" },
  };
  const gapDescriptor: FilterDescriptor = {
    ...descriptorBase,
    columnId: DATA_GAPS_FIELD,
    field: "dataGap",
    urlKey: DATA_GAPS_FIELD,
    kind: "multiselect",
    placeholder: "Filter data gaps...",
    // Own checks only here; related checks are appended once every entity is
    // compiled (`validateDataQualityDeclarations`), because a related
    // entity's ids are not known while compiling this one.
    options: raw.checks.map((check) => ({
      value: check.id,
      label: check.label,
    })),
    wire: { kind: "param", name: "dataGap" },
  };
  const sort = fieldModel.sort;
  // `dataQuality` is a declared (synthesized) field, so it need not be in
  // `computed`; it is listed there anyway because no stored column backs it
  // and `buildOrderBy` must never fall through to a column lookup.
  return {
    dataQuality: {
      checks: raw.checks.map((check) => ({ ...check })),
      exceptions: raw.exceptions,
      related: [...raw.related],
    },
    fieldModel: {
      ...fieldModel,
      fields: [...fieldModel.fields, dataQualityField, dataGapsField],
      output: [...fieldModel.output, DATA_QUALITY_FIELD],
      sort: {
        ...sort,
        fields: [sort.fields[0], ...sort.fields.slice(1), DATA_QUALITY_SORT],
        computed: [...sort.computed, DATA_QUALITY_SORT],
        // An empty `groupable` means "every sortable field groups"; a json
        // score column cannot group, so pin the declared roster instead.
        groupable:
          sort.groupable.length === 0 ? [...sort.fields] : sort.groupable,
      },
    },
    // An entity with no `filters.schema` has no list-filter surface to bind
    // the descriptors to (cookbook's browser is not a kernel list), so it
    // gets the score and column without the two filters.
    descriptors: hasFilterSchema
      ? [...descriptors, statusDescriptor, gapDescriptor]
      : descriptors,
  };
};

/**
 * Cross-entity pass: check ids are one global enum (the `dataGap` filter and
 * `DataCheck` union), `related` names scored entities, and a related entity's
 * check ids become filterable on the rolling-up entity (a Purchase filters by
 * a linked Product's gap).
 */
export const validateDataQualityDeclarations = (
  entities: readonly CompiledEntity[],
): CompiledEntity[] => {
  const owners = new Map<string, string>();
  for (const entity of entities) {
    for (const check of entity.dataQuality?.checks ?? []) {
      const owner = owners.get(check.id);
      if (owner !== undefined)
        throw new EntityDeclarationError(
          `Data-quality check ${check.id} is declared by both ${owner} and ${entity.key}.`,
        );
      owners.set(check.id, entity.key);
    }
  }
  const byKey = new Map(entities.map((entity) => [entity.key, entity]));
  return entities.map((entity) => {
    if (entity.dataQuality === null) return entity;
    const relatedChecks = entity.dataQuality.related.flatMap((related) => {
      const target = byKey.get(related)?.dataQuality;
      if (!target)
        throw new EntityDeclarationError(
          `${entity.key}.capabilities.dataQuality.related names ${related}, which declares no data-quality checks.`,
        );
      return target.checks.map((check) => ({
        value: check.id,
        label: check.label,
      }));
    });
    if (relatedChecks.length === 0) return entity;
    return {
      ...entity,
      filterDescriptors: entity.filterDescriptors.map((descriptor) =>
        descriptor.columnId === DATA_GAPS_FIELD
          ? {
              ...descriptor,
              options: [...(descriptor.options ?? []), ...relatedChecks],
            }
          : descriptor,
      ),
    };
  });
};

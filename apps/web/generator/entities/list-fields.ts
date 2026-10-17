import { z } from "zod";
import { humanize } from "../../../../packages/shared/src/text-case.ts";

import {
  type CompiledEntity,
  EntityDeclarationError,
  type FilterDescriptor,
} from "./declarations.ts";

// A local view, like `derive.ts`: the runtime provenance schema imports
// generated modules, which do not exist yet when the generator runs.
const relationshipPathStep = z.object({
  edge: z.string(),
  direction: z.enum(["incoming", "outgoing"]),
});
type RelationshipPathStep = z.infer<typeof relationshipPathStep>;
const relationshipProvenanceSchema = z.object({
  kind: z.string(),
  steps: z.array(relationshipPathStep).optional(),
});

type Terminal =
  | Readonly<{ kind: "record"; titleColumn: string | null }>
  | Readonly<{ kind: "field"; column: string; fieldKind: string }>;

/**
 * A compiled `model.derived` entry. `sort`/`group` hold the reason the list
 * compiler rejects that use, derived from the declaration, or null.
 */
type CompiledListField =
  | Readonly<{
      shape: "via";
      path: string;
      steps: readonly RelationshipPathStep[];
      target: string;
      terminal: Terminal;
      /** The path passes through a to-many step, so a row has several values. */
      many: boolean;
      sort: string | null;
      group: string | null;
    }>
  | Readonly<{
      shape: "value";
      type: "text" | "number" | "date" | "boolean" | "enum";
      options: readonly string[] | null;
      sort: null;
      group: null;
    }>
  | Readonly<{
      shape: "predicate";
      predicate:
        | "text"
        | "multiselect"
        | "idMulti"
        | "boolean"
        | "presence"
        | "range";
      options: readonly string[] | null;
      reason: string;
      sort: string;
      group: string;
      /** Why a value filter over it cannot exclude, or null when `negatable`. */
      exclude: string | null;
    }>;

type GroupOption = Readonly<{ value: string; label: string }>;

/**
 * What a section key reads: an own column, a to-one related record (keyed by
 * its public id, labelled by its title), a related record's field, or a
 * derived value the repository supplies. `options` orders and labels enum
 * sections in declared order; text sections order by value.
 */
type GroupValue =
  | Readonly<{
      kind: "column";
      column: string;
      options: readonly GroupOption[] | null;
    }>
  | Readonly<{
      kind: "record";
      steps: readonly RelationshipPathStep[];
      target: string;
      titleColumn: string;
    }>
  | Readonly<{
      kind: "field";
      steps: readonly RelationshipPathStep[];
      target: string;
      column: string;
      options: readonly GroupOption[] | null;
    }>
  | Readonly<{ kind: "derived"; options: readonly GroupOption[] | null }>;

/**
 * One `model.grouping` choice. `value` is null exactly when `reason` says why
 * the field cannot group. `filter` is the column filter a section header
 * applies (the same path), whether it can select the no-value section, and
 * its generated "Include sub-…" toggle. `levels` counts the hierarchy levels
 * (1 = top) the choice can group at; 0 exactly when `levelReason` says why.
 */
type CompiledGroupChoice = Readonly<{
  key: string;
  label: string;
  noValueLabel: string;
  reason: string | null;
  value: GroupValue | null;
  filter: Readonly<{
    columnId: string;
    noValue: boolean;
    subtree: string | null;
  }> | null;
  levels: number;
  levelReason: string | null;
}>;

/**
 * Group by menus offer this many hierarchy levels at most. Deeper levels hold
 * few enough records that grouping by the exact value reads the same.
 */
const GROUP_LEVEL_CHOICES = 3;

export type CompiledEntityListFields = Readonly<{
  derived: Readonly<Record<string, CompiledListField>>;
  hierarchy: Readonly<{
    parentField: string;
    column: string;
    maxDepth: number;
  }> | null;
  /** Filter key → its generated "Include sub-…" toggle's filter key. */
  subtree: Readonly<Record<string, string>>;
  /** `model.grouping`, in menu order. */
  grouping: readonly CompiledGroupChoice[];
}>;

const pascal = (text: string) =>
  text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join("");

const pluralOf = (entity: CompiledEntity) =>
  entity.inspector.plural ?? `${entity.inspector.singular}s`;

const titleColumn = (entity: CompiledEntity): string | null =>
  entity.fieldModel.storage.find(
    (stored) => stored.key === entity.inspector.titleField,
  )?.column ?? null;

const compileVia = (
  owner: CompiledEntity,
  path: string,
  byKey: ReadonlyMap<string, CompiledEntity>,
  context: string,
): Extract<CompiledListField, { shape: "via" }> => {
  const segments = path.split(".");
  let current = owner;
  const steps: RelationshipPathStep[] = [];
  let toMany: CompiledEntity | null = null;
  let terminal: Terminal | null = null;
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;
    const relation = current.relations.find(({ key }) => key === segment);
    if (relation === undefined) {
      const stored = current.fieldModel.storage.find(
        ({ key }) => key === segment,
      );
      if (stored === undefined || !last || index === 0)
        throw new EntityDeclarationError(
          `${context} via ${path}: ${segment} is not a relation of ${current.key}${last && index > 0 ? " or one of its stored fields" : ""}.`,
        );
      terminal = {
        kind: "field",
        column: stored.column,
        fieldKind: stored.kind,
      };
      break;
    }
    const provenance = relationshipProvenanceSchema.parse(relation.provenance);
    if (provenance.kind !== "local-path" || !provenance.steps?.length)
      throw new EntityDeclarationError(
        `${context} via ${path}: ${current.key}.${segment} is ${provenance.kind}, not a stored path.`,
      );
    const target = byKey.get(relation.target);
    if (target === undefined)
      throw new EntityDeclarationError(
        `${context} via ${path}: unknown entity ${relation.target}.`,
      );
    steps.push(...provenance.steps);
    const single =
      relation.cardinality === "one" &&
      provenance.steps.every(({ direction }) => direction === "outgoing");
    if (!single && toMany === null) toMany = target;
    current = target;
  }
  const resolved = terminal ?? {
    kind: "record" as const,
    titleColumn: titleColumn(current),
  };
  const many = toMany;
  const reason = (verb: "sort" | "group") =>
    many !== null
      ? `Goes through a list of ${pluralOf(many)}. Only paths that lead to a single record can ${verb}.`
      : resolved.kind === "record" && resolved.titleColumn === null
        ? `${current.inspector.singular} has no stored title to ${verb} by.`
        : null;
  return {
    shape: "via",
    path,
    steps,
    target: current.key,
    terminal: resolved,
    many: many !== null,
    sort: reason("sort"),
    group: reason("group"),
  };
};

const compatibleKinds = (
  field: CompiledListField,
): readonly FilterDescriptor["kind"][] => {
  switch (field.shape) {
    case "predicate":
      return [field.predicate];
    // Any value reads presence: a boolean as true, any other as non-NULL.
    case "value":
      return field.type === "number" || field.type === "date"
        ? ["range", "presence"]
        : field.type === "boolean"
          ? ["boolean", "presence"]
          : ["text", "multiselect", "presence"];
    case "via":
      return field.terminal.kind === "record"
        ? ["idMulti", "text", "presence"]
        : ["text", "multiselect", "boolean", "presence"];
  }
};

const toggleDescriptor = (
  target: CompiledEntity,
  parent: FilterDescriptor,
): FilterDescriptor => {
  const key = `includeSub${pascal(pluralOf(target))}`;
  const label = `Include sub-${pluralOf(target).toLowerCase()}`;
  return {
    columnId: key,
    field: null,
    urlKey: key,
    kind: "boolean",
    placeholder: label,
    options: null,
    optionsRef: null,
    optionsKey: null,
    label,
    schemaDescription: `Include records under each selected ${target.inspector.singular.toLowerCase()} (default true).`,
    deriveSchema: true,
    schemaFromRead: false,
    brandRef: null,
    expandRef: null,
    schemaRef: null,
    stored: null,
    derived: null,
    range: null,
    urlOnly: parent.urlOnly,
    nullable: null,
    sentinels: null,
    match: null,
    exclude: null,
    subtree: null,
    currentMember: false,
    singleValue: null,
    wire: { kind: "param", name: key },
  };
};

/**
 * A value filter over a `via` path gets the generated keys a stored filter
 * gets in `compile.ts`: Any value / No value (a related record exists or not),
 * and Match all when the path holds several records per row.
 */
const withViaKeys = (
  descriptor: FilterDescriptor,
  derived: Readonly<Record<string, CompiledListField>>,
  byKey: ReadonlyMap<string, CompiledEntity>,
  context: string,
): FilterDescriptor => {
  const bound =
    descriptor.derived === null ? undefined : derived[descriptor.derived];
  if (
    bound?.shape !== "via" ||
    (descriptor.kind !== "multiselect" && descriptor.kind !== "idMulti") ||
    descriptor.urlOnly
  )
    return descriptor;
  if (descriptor.nullable !== null)
    throw new EntityDeclarationError(
      `${context}.filters ${descriptor.columnId} is compiled, so its Any value / No value key is generated; remove nullable.`,
    );
  return {
    ...descriptor,
    nullable: {
      field: `${descriptor.columnId}PresenceFilter`,
      label: (
        descriptor.label ??
        byKey.get(bound.target)?.inspector.singular ??
        descriptor.columnId
      ).toLowerCase(),
    },
    match: bound.many ? { field: `${descriptor.columnId}Match` } : null,
  };
};

/**
 * Every compiled value filter gets a generated Exclude key: the negation of
 * the predicate its include builds, so rows with no value stay. A declared
 * predicate that is not `negatable` keeps the key with the reason it cannot
 * exclude. A URL-only scope is not a filter a person edits, so it has none.
 */
const withExcludeKey = (
  descriptor: FilterDescriptor,
  bound: CompiledListField | undefined,
): FilterDescriptor => {
  if (
    (descriptor.kind !== "multiselect" && descriptor.kind !== "idMulti") ||
    descriptor.urlOnly ||
    descriptor.singleValue !== null ||
    (descriptor.stored === null && bound === undefined)
  )
    return descriptor;
  return {
    ...descriptor,
    exclude: {
      field: `${descriptor.columnId}Exclude`,
      reason: bound?.shape === "predicate" ? bound.exclude : null,
    },
  };
};

const enumOptions = (
  field: CompiledEntity["fieldModel"]["fields"][number] | undefined,
): readonly GroupOption[] | null =>
  field?.kind !== "enum"
    ? null
    : (field.display.valueOptions ?? field.control?.options ?? []).map(
        ({ value, label }) => ({ value, label }),
      );

/**
 * Compiles one `model.grouping` key. A model field groups by its own column,
 * or by its referenced record; a `model.derived` key groups through its
 * `via` path or the repository's value. A field that holds several values
 * per row, a to-many path, or a filter-only predicate stays a choice with
 * the reason derived from the declaration.
 */
const compileGroupChoice = (
  entity: CompiledEntity,
  key: string,
  derived: Readonly<Record<string, CompiledListField>>,
  descriptors: readonly FilterDescriptor[],
  byKey: ReadonlyMap<string, CompiledEntity>,
  context: string,
): CompiledGroupChoice => {
  const where = `${context}.model.grouping ${key}`;
  const field = entity.fieldModel.fields.find(
    (candidate) => candidate.key === key,
  );
  const stored = entity.fieldModel.storage.find(
    (candidate) => candidate.key === key,
  );
  const bound = derived[key];
  /**
   * The value filter on the same path: the field's own filter, or for a
   * one-step reference, the filter on that foreign key.
   */
  const filterOn = (value: GroupValue | null) => {
    const edge =
      value !== null && value.kind !== "column" && value.kind !== "derived"
        ? value.steps.length === 1 && value.steps[0]?.direction === "outgoing"
          ? value.steps[0].edge.split(".").at(-1)
          : undefined
        : undefined;
    const keys = [
      key,
      ...entity.fieldModel.storage
        .filter((column) => edge !== undefined && column.column === edge)
        .map((column) => column.key),
    ];
    return descriptors.find(
      (candidate) =>
        !candidate.urlOnly &&
        (candidate.kind === "multiselect" || candidate.kind === "idMulti") &&
        (keys.includes(candidate.columnId) ||
          (candidate.field !== null && keys.includes(candidate.field)) ||
          (candidate.stored?.columns.length === 1 &&
            keys.includes(candidate.stored.columns[0]!))),
    );
  };
  if (field === undefined && bound === undefined)
    throw new EntityDeclarationError(
      `${where} names no model.fields or model.derived key.`,
    );
  const label =
    field?.label ??
    filterOn(null)?.label ??
    entity.relations.find((relation) => relation.key === key)?.label ??
    (bound?.shape === "via"
      ? byKey.get(bound.target)?.inspector.singular
      : undefined) ??
    humanize(key);
  /**
   * The levels a section key can group at: a related record whose entity
   * declares `model.hierarchy` groups under its ancestor at a level.
   */
  const levelsOf = (
    value: GroupValue | null,
    reason: string | null,
  ): Pick<CompiledGroupChoice, "levels" | "levelReason"> => {
    if (value === null)
      return { levels: 0, levelReason: reason ?? `${label} cannot group.` };
    if (value.kind !== "record")
      return {
        levels: 0,
        levelReason: `${label} is a value, not a record with parents, so it has no levels.`,
      };
    const target = byKey.get(value.target);
    const hierarchy = target?.fieldModel.hierarchy ?? null;
    if (target === undefined || hierarchy === null)
      return {
        levels: 0,
        levelReason: `${target === undefined ? humanize(value.target) : pluralOf(target)} don't nest, so ${label} has no levels.`,
      };
    return {
      levels: Math.min(hierarchy.maxDepth + 1, GROUP_LEVEL_CHOICES),
      levelReason: null,
    };
  };
  const choice = (
    value: GroupValue | null,
    reason: string | null,
  ): CompiledGroupChoice => {
    const descriptor = reason === null ? filterOn(value) : undefined;
    return {
      key,
      label,
      noValueLabel: `No ${label.toLowerCase()}`,
      reason,
      value,
      filter:
        descriptor === undefined
          ? null
          : {
              columnId: descriptor.columnId,
              noValue: Boolean(descriptor.nullable),
              subtree: descriptor.subtree,
            },
      ...levelsOf(value, reason),
    };
  };
  const viaValue = (via: Extract<CompiledListField, { shape: "via" }>) => {
    if (via.group !== null) return choice(null, via.group);
    if (via.terminal.kind === "field") {
      const target = byKey.get(via.target);
      const terminalColumn = via.terminal.column;
      return choice(
        {
          kind: "field",
          steps: via.steps,
          target: via.target,
          column: terminalColumn,
          options: enumOptions(
            target?.fieldModel.fields.find(
              (candidate) =>
                target.fieldModel.storage.find(
                  (column) => column.key === candidate.key,
                )?.column === terminalColumn,
            ),
          ),
        },
        null,
      );
    }
    if (via.terminal.titleColumn === null)
      throw new EntityDeclarationError(
        `${where}: ${via.target} has no stored title.`,
      );
    return choice(
      {
        kind: "record",
        steps: via.steps,
        target: via.target,
        titleColumn: via.terminal.titleColumn,
      },
      null,
    );
  };
  if (field?.kind === "text-array" || field?.reference?.multiple)
    return choice(
      null,
      `A record can have several ${field.label}, so it would appear in more than one group.`,
    );
  if (bound?.shape === "via") return viaValue(bound);
  if (bound?.shape === "predicate") return choice(null, bound.group);
  if (stored !== undefined && field !== undefined) {
    if (field.reference !== null) {
      const relation = entity.relations.find((candidate) => {
        const provenance = relationshipProvenanceSchema.safeParse(
          candidate.provenance,
        );
        const steps = provenance.success ? provenance.data.steps : undefined;
        return (
          candidate.cardinality === "one" &&
          steps?.length === 1 &&
          steps[0]?.direction === "outgoing" &&
          steps[0].edge.endsWith(`.${stored.column}`)
        );
      });
      if (relation === undefined)
        throw new EntityDeclarationError(
          `${where}: no to-one relation follows ${stored.column}.`,
        );
      return viaValue(compileVia(entity, relation.key, byKey, where));
    }
    if (field.kind === "enum" || field.kind === "text")
      return choice(
        { kind: "column", column: stored.column, options: enumOptions(field) },
        null,
      );
  }
  if (
    bound?.shape === "value" &&
    (bound.type === "enum" || bound.type === "text")
  ) {
    // A section reads the label its value filter shows for the same value.
    const labels = descriptors.find(
      (candidate) => candidate.derived === key,
    )?.options;
    return choice(
      {
        kind: "derived",
        options:
          bound.options?.map((value) => ({
            value,
            label:
              labels?.find((option) => option.value === value)?.label ??
              value[0]!.toUpperCase() + value.slice(1),
          })) ?? null,
      },
      null,
    );
  }
  throw new EntityDeclarationError(
    `${where} is not an enum, text, reference or to-one related field.`,
  );
};

/**
 * Every saved view's `groupBy` names a choice the list can group by, and its
 * `groupLevel` a level that choice offers.
 */
const validateSavedViewGrouping = (
  entity: CompiledEntity,
  grouping: readonly CompiledGroupChoice[],
  context: string,
) => {
  for (const view of entity.inspector.list.savedViews) {
    if (view.groupBy === null) {
      if (view.groupLevel !== null)
        throw new EntityDeclarationError(
          `${context}.presentation.list.savedViews[${view.id}].groupLevel needs a groupBy.`,
        );
      continue;
    }
    const choice = grouping.find(({ key }) => key === view.groupBy);
    if (choice === undefined || choice.reason !== null)
      throw new EntityDeclarationError(
        `${context}.presentation.list.savedViews[${view.id}].groupBy ${view.groupBy} is not a model.grouping choice this list can group by${choice?.reason ? `: ${choice.reason}` : ""}.`,
      );
    if (view.groupLevel !== null && view.groupLevel > choice.levels)
      throw new EntityDeclarationError(
        `${context}.presentation.list.savedViews[${view.id}].groupLevel ${view.groupLevel}: ${choice.levelReason ?? `${choice.label} offers levels 1–${choice.levels}`}.`,
      );
  }
};

/**
 * The cross-entity half of the list-field compiler: resolves `via` paths
 * through declared relations, derives each sort/group rejection reason,
 * binds filter descriptors to derived fields, and generates the
 * "Include sub-…" toggle for every compiled filter over a reference to an
 * entity with `model.hierarchy`.
 */
export const compileListFields = (
  entities: readonly CompiledEntity[],
): CompiledEntity[] => {
  const byKey = new Map(entities.map((entity) => [entity.key, entity]));
  return entities.map((entity) => {
    const context = entity.key;
    const derived: Record<string, CompiledListField> = {};
    for (const [key, entry] of Object.entries(entity.fieldModel.derived)) {
      const derivedContext = `${context}.model.derived.${key}`;
      derived[key] =
        "via" in entry
          ? compileVia(entity, entry.via, byKey, derivedContext)
          : "type" in entry
            ? {
                shape: "value",
                type: entry.type,
                options: entry.options ?? null,
                sort: null,
                group: null,
              }
            : {
                shape: "predicate",
                predicate: entry.predicate,
                options: entry.options ?? null,
                reason: entry.reason,
                sort: `Filter only: ${entry.reason.replace(/\.$/, "")}.`,
                group: `Filter only: ${entry.reason.replace(/\.$/, "")}.`,
                exclude:
                  entry.negatable === true
                    ? null
                    : `Include only: ${entry.reason.replace(/\.$/, "")}.`,
              };
    }
    const sort = entity.fieldModel.sort;
    for (const key of sort?.fields ?? []) {
      const reason = derived[key]?.sort;
      if (reason)
        throw new EntityDeclarationError(
          `${context}.model.sort.fields ${key}: ${reason}`,
        );
    }
    const subtree: Record<string, string> = {};
    const toggles: FilterDescriptor[] = [];
    const compiled: FilterDescriptor[] = [];
    for (const declared of entity.filterDescriptors) {
      const bound =
        declared.derived === null ? undefined : derived[declared.derived];
      if (declared.derived !== null && bound === undefined)
        throw new EntityDeclarationError(
          `${context}.filters ${declared.columnId} is derived but names no model.derived entry ${declared.derived}.`,
        );
      const descriptor = withExcludeKey(
        withViaKeys(declared, derived, byKey, context),
        bound,
      );
      compiled.push(descriptor);
      if (
        bound !== undefined &&
        !compatibleKinds(bound).includes(descriptor.kind)
      )
        throw new EntityDeclarationError(
          `${context}.filters ${descriptor.columnId} is a ${descriptor.kind} filter over derived ${bound.shape} field; expected ${compatibleKinds(bound).join(" | ")}.`,
        );
      if (descriptor.kind !== "idMulti") continue;
      // A declared idMulti predicate (an inherited reference) targets its
      // brand's entity.
      const referenced =
        bound?.shape === "via" && bound.terminal.kind === "record"
          ? bound.target
          : bound?.shape === "predicate"
            ? (descriptor.brandRef?.entity ?? null)
            : descriptor.stored === null
              ? null
              : (entity.fieldModel.storage.find(
                  ({ key }) => key === descriptor.stored?.columns[0],
                )?.reference ?? null);
      const target = referenced === null ? undefined : byKey.get(referenced);
      if (target?.fieldModel.hierarchy == null) continue;
      const toggle = toggleDescriptor(target, descriptor);
      subtree[descriptor.field ?? descriptor.columnId] = toggle.columnId;
      compiled[compiled.length - 1] = {
        ...descriptor,
        subtree: toggle.columnId,
      };
      if (!toggles.some(({ columnId }) => columnId === toggle.columnId))
        toggles.push(toggle);
    }
    const filterDescriptors = [...compiled, ...toggles];
    const urlKeys = filterDescriptors.flatMap(({ urlKey, exclude }) =>
      exclude === null ? [urlKey] : [urlKey, exclude.field],
    );
    if (new Set(urlKeys).size !== urlKeys.length)
      throw new EntityDeclarationError(
        `${context}.filters: a generated hierarchy toggle or Exclude key repeats a declared URL key.`,
      );
    const hierarchy = entity.fieldModel.hierarchy;
    const parentColumn =
      hierarchy === null
        ? undefined
        : entity.fieldModel.storage.find(
            ({ key }) => key === hierarchy.parentField,
          )?.column;
    if (hierarchy !== null && parentColumn === undefined)
      throw new EntityDeclarationError(
        `${context}.model.hierarchy.parentField ${hierarchy.parentField} is not stored.`,
      );
    if (
      new Set(entity.fieldModel.grouping).size !==
      entity.fieldModel.grouping.length
    )
      throw new EntityDeclarationError(
        `${context}.model.grouping repeats a field.`,
      );
    const grouping = entity.fieldModel.grouping.map((key) =>
      compileGroupChoice(
        entity,
        key,
        derived,
        filterDescriptors,
        byKey,
        context,
      ),
    );
    validateSavedViewGrouping(entity, grouping, context);
    const listFields: CompiledEntityListFields = {
      derived,
      hierarchy:
        hierarchy === null || parentColumn === undefined
          ? null
          : { ...hierarchy, column: parentColumn },
      subtree,
      grouping,
    };
    return {
      ...entity,
      filterDescriptors,
      filterUrlKeys: urlKeys,
      listFields,
    };
  });
};

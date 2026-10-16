import { z } from "zod";

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
      predicate: "text" | "multiselect" | "boolean";
      options: readonly string[] | null;
      reason: string;
      sort: string;
      group: string;
    }>;

export type CompiledEntityListFields = Readonly<{
  derived: Readonly<Record<string, CompiledListField>>;
  hierarchy: Readonly<{
    parentField: string;
    column: string;
    maxDepth: number;
  }> | null;
  /** Filter key → its generated "Include sub-…" toggle's filter key. */
  subtree: Readonly<Record<string, string>>;
  /** Group rejections for model fields (multi-valued fields). */
  fieldGroup: Readonly<Record<string, string>>;
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
    case "value":
      return field.type === "number" || field.type === "date"
        ? ["range"]
        : field.type === "boolean"
          ? ["boolean"]
          : ["text", "multiselect"];
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
    derived: false,
    range: null,
    urlOnly: parent.urlOnly,
    nullable: null,
    sentinels: null,
    match: null,
    subtree: null,
    currentMember: false,
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
  context: string,
): FilterDescriptor => {
  const bound = descriptor.derived ? derived[descriptor.columnId] : undefined;
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
      label: (descriptor.label ?? descriptor.columnId).toLowerCase(),
    },
    match: bound.many ? { field: `${descriptor.columnId}Match` } : null,
  };
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
                sort: `Filter only: ${entry.reason}.`,
                group: `Filter only: ${entry.reason}.`,
              };
    }
    const fieldGroup: Record<string, string> = {};
    for (const field of entity.fieldModel.fields) {
      if (field.kind === "text-array" || field.reference?.multiple)
        fieldGroup[field.key] =
          `A record can have several ${field.label}, so it would appear in more than one group.`;
    }
    const sort = entity.fieldModel.sort;
    for (const key of sort?.fields ?? []) {
      const reason = derived[key]?.sort;
      if (reason)
        throw new EntityDeclarationError(
          `${context}.model.sort.fields ${key}: ${reason}`,
        );
    }
    for (const key of sort?.groupable ?? []) {
      const reason = derived[key]?.group ?? fieldGroup[key];
      if (reason)
        throw new EntityDeclarationError(
          `${context}.model.sort.groupable ${key}: ${reason}`,
        );
    }
    const subtree: Record<string, string> = {};
    const toggles: FilterDescriptor[] = [];
    const compiled: FilterDescriptor[] = [];
    for (const declared of entity.filterDescriptors) {
      const descriptor = withViaKeys(declared, derived, context);
      compiled.push(descriptor);
      const bound = descriptor.derived
        ? derived[descriptor.columnId]
        : undefined;
      if (descriptor.derived && bound === undefined)
        throw new EntityDeclarationError(
          `${context}.filters ${descriptor.columnId} is derived but names no model.derived entry.`,
        );
      if (
        bound !== undefined &&
        !compatibleKinds(bound).includes(descriptor.kind)
      )
        throw new EntityDeclarationError(
          `${context}.filters ${descriptor.columnId} is a ${descriptor.kind} filter over derived ${bound.shape} field; expected ${compatibleKinds(bound).join(" | ")}.`,
        );
      if (descriptor.kind !== "idMulti") continue;
      const referenced =
        bound?.shape === "via" && bound.terminal.kind === "record"
          ? bound.target
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
    const urlKeys = filterDescriptors.map(({ urlKey }) => urlKey);
    if (new Set(urlKeys).size !== urlKeys.length)
      throw new EntityDeclarationError(
        `${context}.filters: a generated hierarchy toggle repeats a declared URL key.`,
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
    const listFields: CompiledEntityListFields = {
      derived,
      hierarchy:
        hierarchy === null || parentColumn === undefined
          ? null
          : { ...hierarchy, column: parentColumn },
      subtree,
      fieldGroup,
    };
    return {
      ...entity,
      filterDescriptors,
      filterUrlKeys: urlKeys,
      listFields,
    };
  });
};

import type {
  GeneratedListField,
  GeneratedRowSet,
  GeneratedGroupChoice,
  GeneratedInherit,
  GeneratedListScope,
} from "@cubby/schemas/entity-projection-types";
import { z } from "zod";
import { humanize } from "@cubby/shared/text-case";

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
export const relationshipProvenanceSchema = z.object({
  kind: z.string(),
  steps: z.array(relationshipPathStep).optional(),
});

type Terminal = Extract<
  GeneratedListField<string>,
  { shape: "via" }
>["terminal"];

/**
 * A compiled `model.derived` entry. `sort`/`group` hold the reason the list
 * compiler rejects that use, derived from the declaration, or null.
 */
type CompiledListField = GeneratedListField<string>;

type GroupOption = Readonly<{ value: string; label: string }>;

/**
 * A compiled `model.rows` entry. A path's row table and its `where` columns
 * are checked when the server loads (`rowSetSql`); a JSON row set's `keys`
 * come from its field's item schema.
 */
type CompiledRowSet = GeneratedRowSet<string>;

/**
 * What a section key reads: an own column, a to-one related record (keyed by
 * its public id, labelled by its title), a related record's field, or a
 * derived value the repository supplies. `options` orders and labels enum
 * sections in declared order; text sections order by value.
 */
type GroupValue = NonNullable<GeneratedGroupChoice<string>["value"]>;

/**
 * One `model.grouping` choice. `value` is null exactly when `reason` says why
 * the field cannot group. `filter` is the column filter a section header
 * applies (the same path), whether it can select the no-value section, and
 * its generated "Include sub-…" toggle. `levels` counts the hierarchy levels
 * (1 = top) the choice can group at; 0 exactly when `levelReason` says why.
 */
type CompiledGroupChoice = GeneratedGroupChoice<string>;

/**
 * Group by menus offer this many hierarchy levels at most. Deeper levels hold
 * few enough records that grouping by the exact value reads the same.
 */
const GROUP_LEVEL_CHOICES = 3;

/**
 * One step of an inheritance path: the foreign key on the current entity
 * (by field key and column) and the entity it leads to.
 */
type InheritHop = Extract<
  GeneratedInherit<string>["from"][number],
  { kind: "effective" }
>["hops"][number];

/** A compiled `resolution.inherit` source, in declared order. */
type InheritSource = GeneratedInherit<string>["from"][number];

/**
 * A field's compiled fallback chain: its column, the mode that decides
 * whether the row's own value wins, and its sources. `empty` is the value a
 * non-nullable list reads when nothing decides.
 */
type CompiledInherit = GeneratedInherit<string>;

export type CompiledEntityListFields = Readonly<{
  derived: Readonly<Record<string, CompiledListField>>;
  /** `model.rows`, the row sets a `via` may start at. */
  rows: Readonly<Record<string, CompiledRowSet>>;
  /** Text filter key → its declared `listTermExpanders` entry. */
  terms: Readonly<Record<string, string>>;
  /** Field key → its compiled `resolution.inherit`. */
  inherit: Readonly<Record<string, CompiledInherit>>;
  hierarchy: Readonly<{
    parentField: string;
    column: string;
    maxDepth: number;
  }> | null;
  /** Filter key → its generated "Include sub-…" toggle's filter key. */
  subtree: Readonly<Record<string, string>>;
  /** `model.grouping`, in menu order. */
  grouping: readonly CompiledGroupChoice[];
  metrics: readonly { key: string; label: string; format: string | null }[];
  /** `presentation.list.scope`: columns pinned to NULL on every list read. */
  scope: readonly string[];
  /** `presentation.list.scopes`, by request key. */
  scopes: Readonly<Record<string, CompiledListScope>>;
}>;

/**
 * A related scope: the entity whose list filter record the request key
 * holds, and the compiled path (to-one, to-many or a row-set terminal) that
 * leads to its records.
 */
type CompiledListScope = GeneratedListScope<string>;

/**
 * Compiles `presentation.list.scope` to columns and each related scope's
 * `via` to the path the list compiler walks. A path that does not end at
 * the scope's `filters` entity, or a key a filter already uses, would
 * scope by nothing or shadow a filter, so the generator rejects it.
 */
const compileListScopes = (
  entity: CompiledEntity,
  byKey: ReadonlyMap<string, CompiledEntity>,
  rows: Readonly<Record<string, CompiledRowSet>>,
  urlKeys: readonly string[],
): Pick<CompiledEntityListFields, "scope" | "scopes"> => {
  const context = `${entity.key}.presentation.list`;
  const scope = entity.listScopes.scope.map((key) => {
    const stored = entity.fieldModel.storage.find(
      (candidate) => candidate.key === key,
    );
    if (stored === undefined)
      throw new EntityDeclarationError(
        `${context}.scope names ${key}, which is not a stored field.`,
      );
    return stored.column;
  });
  const scopes: Record<string, CompiledListScope> = {};
  for (const [key, declared] of Object.entries(entity.listScopes.scopes)) {
    const scopeContext = `${context}.scopes.${key}`;
    if (urlKeys.includes(key))
      throw new EntityDeclarationError(
        `${scopeContext} shares its key with a filter.`,
      );
    const target = byKey.get(declared.filters);
    if (target === undefined)
      throw new EntityDeclarationError(
        `${scopeContext}.filters names unknown entity ${declared.filters}.`,
      );
    const via = compileVia(entity, declared.via, byKey, scopeContext, rows);
    const reaches =
      via.shape === "via"
        ? via.terminal.kind === "record" && via.target === target.key
        : via.shape === "rows" &&
          via.terminal.kind === "record" &&
          via.terminal.target === target.key;
    if (!reaches || (via.shape !== "via" && via.shape !== "rows"))
      throw new EntityDeclarationError(
        `${scopeContext} via ${declared.via} does not lead to a ${target.key} record.`,
      );
    scopes[key] = { filters: target.key, via };
  }
  return { scope, scopes };
};

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

/**
 * The record keys of a JSON field's item schema (`z.array(z.object(…))`),
 * through any default, optional, nullable or refinement wrapper.
 */
const jsonItemKeys = (schema: unknown): readonly string[] | null => {
  let current = schema instanceof z.ZodType ? schema : null;
  for (let depth = 0; current !== null && depth < 8; depth += 1) {
    if (current instanceof z.ZodArray) {
      const element: unknown = current.element;
      return element instanceof z.ZodObject ? Object.keys(element.shape) : null;
    }
    const inner: unknown =
      "innerType" in current.def ? current.def.innerType : undefined;
    current = inner instanceof z.ZodType ? inner : null;
  }
  return null;
};

/** Compiles `model.rows`, rejecting a row set no `via` could read. */
const compileRowSets = (
  entity: CompiledEntity,
  byKey: ReadonlyMap<string, CompiledEntity>,
) => {
  const compiled: Record<string, CompiledRowSet> = {};
  for (const [key, declared] of Object.entries(entity.fieldModel.rows)) {
    const context = `${entity.key}.model.rows.${key}`;
    if (
      entity.relations.some((relation) => relation.key === key) ||
      Object.hasOwn(entity.fieldModel.derived, key)
    )
      throw new EntityDeclarationError(
        `${context} shares its key with a relation or model.derived entry; a via's first segment must name one.`,
      );
    if ("relation" in declared) {
      const relation = entity.relations.find(
        (candidate) => candidate.key === declared.relation,
      );
      const provenance =
        relation === undefined
          ? undefined
          : relationshipProvenanceSchema.parse(relation.provenance);
      if (
        relation === undefined ||
        provenance?.kind !== "local-path" ||
        !provenance.steps?.length ||
        !byKey.has(relation.target)
      )
        throw new EntityDeclarationError(
          `${context}.relation ${declared.relation} is not a stored-path relation of ${entity.key}.`,
        );
      compiled[key] = {
        label: declared.label,
        storage: {
          kind: "relation",
          steps: provenance.steps,
          target: relation.target,
        },
      };
      continue;
    }
    if ("repository" in declared) {
      const columns: Record<string, string | null> = {};
      const types: Record<string, string> = {};
      const connections: string[] = [];
      for (const [column, type] of Object.entries(declared.repository)) {
        const reference = typeof type === "string" ? null : type.reference;
        if (typeof type === "string") types[column] = type;
        if (reference !== null && !byKey.has(reference))
          throw new EntityDeclarationError(
            `${context}.repository.${column} references unknown entity ${reference}.`,
          );
        columns[column] = reference;
        if (typeof type !== "string" && type.connection)
          connections.push(column);
      }
      compiled[key] = {
        label: declared.label,
        storage: { kind: "repository", columns, connections, types },
      };
      continue;
    }
    if ("json" in declared) {
      const stored = entity.fieldModel.storage.find(
        (candidate) => candidate.key === declared.json,
      );
      const keys = jsonItemKeys(
        entity.fieldModel.fields.find(
          (candidate) => candidate.key === declared.json,
        )?.validation.read,
      );
      if (stored?.kind !== "json" || keys === null)
        throw new EntityDeclarationError(
          `${context}.json ${declared.json} is not a stored JSON field whose read schema is an array of records.`,
        );
      compiled[key] = {
        label: declared.label,
        storage: { kind: "json", column: stored.column, keys },
      };
      continue;
    }
    const where = declared.where ?? {};
    if (Object.keys(where).some((column) => !sqlWord.test(column)))
      throw new EntityDeclarationError(
        `${context}.where columns must be plain words.`,
      );
    compiled[key] = {
      label: declared.label,
      storage: { kind: "path", steps: declared.path, where },
    };
  }
  return compiled;
};

/**
 * A `via` that starts at a row set: one terminal after it, a column of the
 * row (a JSON item key) or an entity the row references.
 */
const compileRowsVia = (
  path: string,
  key: string,
  rowSet: CompiledRowSet,
  terminal: string | undefined,
  more: number,
  byKey: ReadonlyMap<string, CompiledEntity>,
  context: string,
): Extract<CompiledListField, { shape: "rows" }> => {
  if (terminal === undefined || more > 0)
    throw new EntityDeclarationError(
      `${context} via ${path}: row set ${key} takes exactly one terminal (a column or a referenced entity).`,
    );
  const { storage } = rowSet;
  const declared =
    storage.kind === "json"
      ? storage.keys
      : storage.kind === "repository"
        ? Object.keys(storage.columns)
        : null;
  if (declared !== null && !declared.includes(terminal))
    throw new EntityDeclarationError(
      `${context} via ${path}: ${terminal} is not a column of ${key} (${declared.join(", ")}).`,
    );
  const related =
    storage.kind === "relation" ? byKey.get(storage.target) : undefined;
  const field = related?.fieldModel.fields.find(
    (candidate) => candidate.key === terminal,
  );
  const stored = related?.fieldModel.storage.find(
    (candidate) => candidate.key === terminal,
  );
  if (related !== undefined && stored === undefined)
    throw new EntityDeclarationError(
      `${context} via ${path}: ${terminal} is not a stored field of ${related.key}.`,
    );
  const reference =
    storage.kind === "repository"
      ? storage.columns[terminal]
      : (stored?.reference ?? undefined);
  const target =
    storage.kind === "path"
      ? byKey.get(terminal)
      : reference == null
        ? undefined
        : byKey.get(reference);
  const repositoryType =
    storage.kind === "repository" ? (storage.types[terminal] ?? null) : null;
  const reason = (verb: "sort" | "group") =>
    `Goes through a list of ${rowSet.label}. Only paths that lead to a single record can ${verb}.`;
  return {
    shape: "rows",
    path,
    rows: key,
    terminal:
      target === undefined
        ? {
            kind: "column",
            column: stored?.column ?? terminal,
            fieldKind: stored?.kind ?? repositoryType,
            options: enumOptions(field),
          }
        : {
            kind: "record",
            target: target.key,
            titleColumn: titleColumn(target),
            column: stored?.column ?? null,
          },
    sort: reason("sort"),
    group: reason("group"),
  };
};

const compileVia = (
  owner: CompiledEntity,
  path: string,
  byKey: ReadonlyMap<string, CompiledEntity>,
  context: string,
  rows: Readonly<Record<string, CompiledRowSet>> = {},
): CompiledListField => {
  const segments = path.split(".");
  const [first, rowTerminal, ...more] = segments;
  const rowSet = first === undefined ? undefined : rows[first];
  if (first !== undefined && rowSet !== undefined)
    return compileRowsVia(
      path,
      first,
      rowSet,
      rowTerminal,
      more.length,
      byKey,
      context,
    );
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
    group:
      resolved.kind === "record" && resolved.titleColumn === null
        ? `${current.inspector.singular} has no stored title to group by.`
        : null,
  };
};

// Mode values reach SQL as literals, so they must stay plain words.
const sqlWord = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** A path of to-one foreign keys, each one outgoing step from a stored column. */
const compileInheritHops = (
  owner: CompiledEntity,
  segments: readonly string[],
  byKey: ReadonlyMap<string, CompiledEntity>,
  context: string,
) => {
  let current = owner;
  const hops: InheritHop[] = [];
  for (const segment of segments) {
    const relation = current.relations.find(({ key }) => key === segment);
    const steps =
      relation === undefined
        ? undefined
        : relationshipProvenanceSchema.parse(relation.provenance).steps;
    const [step, ...more] = steps ?? [];
    const column = step?.edge.split(".").at(-1);
    const stored = current.fieldModel.storage.find(
      (candidate) => candidate.column === column,
    );
    const target =
      relation === undefined ? undefined : byKey.get(relation.target);
    if (
      relation?.cardinality !== "one" ||
      step?.direction !== "outgoing" ||
      more.length > 0 ||
      stored === undefined ||
      target === undefined
    )
      throw new EntityDeclarationError(
        `${context}: ${current.key}.${segment} is not a to-one reference through one stored foreign key.`,
      );
    hops.push({ field: stored.key, column: stored.column, target: target.key });
    current = target;
  }
  return { hops, target: current };
};

/**
 * Compiles every field's `resolution.inherit` into the chain the runtime
 * renders (`effectiveFieldSql`), rejecting a chain it cannot render.
 */
const compileInherit = (
  entity: CompiledEntity,
  byKey: ReadonlyMap<string, CompiledEntity>,
) => {
  const compiled: Record<string, CompiledInherit> = {};
  for (const field of entity.fieldModel.fields) {
    const inherit = field.resolution?.inherit;
    if (inherit === undefined) continue;
    const context = `${entity.key}.${field.key}.resolution.inherit`;
    const stored = entity.fieldModel.storage.find(
      ({ key }) => key === field.key,
    );
    if (stored === undefined)
      throw new EntityDeclarationError(`${context} needs a stored field.`);
    if (!stored.nullable && stored.kind !== "text-array")
      throw new EntityDeclarationError(
        `${context}: ${field.key} is not nullable, so a chain that decides nothing has no value.`,
      );
    let mode: CompiledInherit["mode"] = null;
    if (inherit.mode !== undefined) {
      const declared = inherit.mode;
      const modeColumn = entity.fieldModel.storage.find(
        ({ key }) => key === declared.field,
      );
      if (modeColumn === undefined)
        throw new EntityDeclarationError(
          `${context}.mode.field ${declared.field} is not stored.`,
        );
      const values = [declared.inherit, ...(declared.none ?? [])];
      if (values.some((value) => !sqlWord.test(value)))
        throw new EntityDeclarationError(
          `${context}.mode values must be plain words.`,
        );
      mode = {
        column: modeColumn.column,
        inherit: declared.inherit,
        none: declared.none ?? [],
        explicitIfSet: declared.explicitIfSet === true,
      };
    }
    const from = inherit.from.map((source): InheritSource => {
      if (source === "hierarchy" || "hierarchy" in source) {
        const hierarchy = entity.fieldModel.hierarchy;
        const parent =
          hierarchy === null
            ? undefined
            : entity.fieldModel.storage.find(
                ({ key }) => key === hierarchy.parentField,
              );
        if (hierarchy === null || parent === undefined)
          throw new EntityDeclarationError(
            `${context}.from hierarchy: ${entity.key} declares no model.hierarchy.`,
          );
        let whileSame: Readonly<{ field: string; column: string }> | null =
          null;
        if (source !== "hierarchy") {
          const same = source.hierarchy.whileSame;
          const column = entity.fieldModel.storage.find(
            ({ key }) => key === same,
          )?.column;
          if (same === field.key || column === undefined)
            throw new EntityDeclarationError(
              `${context}.from hierarchy.whileSame ${same} must be another stored field of ${entity.key}.`,
            );
          whileSame = { field: same, column };
        }
        return {
          kind: "hierarchy",
          parentColumn: parent.column,
          maxDepth: hierarchy.maxDepth,
          whileSame,
        };
      }
      const segments = source.path.split(".");
      const terminal = segments.at(-1)!;
      const { hops, target } = compileInheritHops(
        entity,
        segments.slice(0, -1),
        byKey,
        `${context}.from ${source.path}`,
      );
      const column = target.fieldModel.storage.find(
        ({ key }) => key === terminal,
      )?.column;
      if (hops.length === 0 || column === undefined)
        throw new EntityDeclarationError(
          `${context}.from ${source.path} must end at a stored field of a related record.`,
        );
      let when: { column: string; value: string } | null = null;
      if (source.when) {
        const predicate = source.when;
        const condition = target.fieldModel.storage.find(
          (field) => field.key === predicate.field,
        );
        if (!condition || !sqlWord.test(source.when.value))
          throw new EntityDeclarationError(
            `${context}.from ${source.path} requires a stored condition field and a plain-word value.`,
          );
        when = { column: condition.column, value: source.when.value };
      }
      return {
        kind: "effective",
        hops,
        field: terminal,
        column,
        ...(when ? { when } : {}),
      };
    });
    compiled[field.key] = {
      column: stored.column,
      reference: stored.reference,
      empty: stored.nullable ? null : "array",
      mode,
      from,
    };
  }
  return compiled;
};

/**
 * Rejects a chain that reads itself: an effective value whose sources lead
 * back to it would render without end.
 */
const assertAcyclicInherit = (
  entities: readonly CompiledEntity[],
  inherit: ReadonlyMap<string, Readonly<Record<string, CompiledInherit>>>,
) => {
  const depends = (entity: string, field: string): string[] => {
    const chain = inherit.get(entity)?.[field];
    if (chain === undefined) return [];
    return chain.from.flatMap((source) => {
      if (source.kind === "hierarchy")
        return source.whileSame === null
          ? []
          : [`${entity}.${source.whileSame.field}`];
      const reads: string[] = [];
      let current = entity;
      for (const hop of source.hops) {
        if (inherit.get(current)?.[hop.field] !== undefined)
          reads.push(`${current}.${hop.field}`);
        current = hop.target;
      }
      reads.push(`${current}.${source.field}`);
      return reads;
    });
  };
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (node: string, trail: readonly string[]) => {
    if (done.has(node)) return;
    if (visiting.has(node))
      throw new EntityDeclarationError(
        `resolution.inherit reads itself: ${[...trail, node].join(" → ")}.`,
      );
    visiting.add(node);
    const dot = node.indexOf(".");
    const [entity, field] = [node.slice(0, dot), node.slice(dot + 1)];
    for (const next of depends(entity, field)) visit(next, [...trail, node]);
    visiting.delete(node);
    done.add(node);
  };
  for (const entity of entities)
    for (const field of Object.keys(inherit.get(entity.key) ?? {}))
      visit(`${entity.key}.${field}`, []);
};

const compatibleKinds = (
  field: CompiledListField,
): readonly FilterDescriptor["kind"][] => {
  switch (field.shape) {
    case "predicate":
      return [field.predicate];
    // Any value reads presence: a boolean as true, any other as non-NULL.
    // A text value may hold a record's shortcode (Purchase's effective
    // purchaser), which a branded idMulti matches by code.
    case "value":
      return field.type === "number" ||
        field.type === "date" ||
        field.type === "dateInterval"
        ? ["range", "presence"]
        : field.type === "boolean"
          ? ["boolean", "presence"]
          : field.type === "text"
            ? ["text", "multiselect", "idMulti", "presence"]
            : ["text", "multiselect", "presence"];
    case "via":
      return field.terminal.kind === "record"
        ? ["idMulti", "text", "presence"]
        : ["text", "multiselect", "boolean", "presence"];
    // A row-set column of a date or number field also takes bounds.
    case "rows":
      return field.terminal.kind === "record"
        ? ["idMulti", "text", "presence"]
        : field.terminal.fieldKind === "date" ||
            field.terminal.fieldKind === "number"
          ? ["text", "multiselect", "boolean", "presence", "range"]
          : ["text", "multiselect", "boolean", "presence"];
  }
};

const toggleDescriptor = (target: CompiledEntity): FilterDescriptor => {
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
    anyOf: null,
    derived: null,
    range: null,
    nullable: null,
    sentinels: null,
    match: null,
    exclude: null,
    subtree: null,
    currentMember: false,
    singleValue: null,
    exclusiveGroup: null,
    aliasOf: null,
    wire: { kind: "param", name: key },
  };
};

/**
 * An unbound value filter binds to the derived list field of its name,
 * including entries synthesized after the declaration compiles.
 */
const withInferredDerived = (
  descriptor: FilterDescriptor,
  derived: Readonly<Record<string, CompiledListField>>,
): FilterDescriptor =>
  descriptor.derived === null &&
  descriptor.stored === null &&
  descriptor.anyOf === null &&
  descriptor.kind !== "text" &&
  descriptor.kind !== "range" &&
  derived[descriptor.columnId] !== undefined
    ? { ...descriptor, derived: descriptor.columnId }
    : descriptor;

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
    (bound?.shape !== "via" && bound?.shape !== "rows") ||
    (descriptor.kind !== "multiselect" && descriptor.kind !== "idMulti")
  )
    return descriptor;
  const target =
    bound.shape === "via"
      ? bound.target
      : bound.terminal.kind === "record"
        ? bound.terminal.target
        : null;
  // A row-set filter may keep the presence key it was published under.
  if (descriptor.nullable !== null && bound.shape !== "rows")
    throw new EntityDeclarationError(
      `${context}.filters ${descriptor.columnId} is compiled, so its Any value / No value key is generated; remove nullable.`,
    );
  return {
    ...descriptor,
    nullable: descriptor.nullable ?? {
      field: `${descriptor.columnId}PresenceFilter`,
      label: (
        descriptor.label ??
        (target === null ? undefined : byKey.get(target)?.inspector.singular) ??
        humanize(descriptor.columnId)
      ).toLowerCase(),
    },
    // A row set always holds several rows per record.
    match:
      bound.shape === "rows" || bound.many
        ? { field: `${descriptor.columnId}Match` }
        : null,
  };
};

/**
 * A range over a row set filters by its bounds alone. Only a related view's
 * column may also carry a presence key, which the view applies ("has any
 * related record", product tasks), not the row set.
 */
const assertRowSetRange = (
  descriptor: FilterDescriptor,
  bound: CompiledListField | undefined,
  context: string,
) => {
  if (
    bound?.shape === "rows" &&
    descriptor.wire.kind === "range" &&
    descriptor.wire.presence !== undefined &&
    !descriptor.columnId.startsWith("related:")
  )
    throw new EntityDeclarationError(
      `${context}.filters ${descriptor.columnId} is a range over row set ${bound.rows}; only a related view's column may carry a presence key, which the view applies.`,
    );
};

/**
 * Every compiled value filter gets a generated Exclude key: the negation of
 * the predicate its include builds, so rows with no value stay. A declared
 * predicate that is not `negatable` keeps the key with the reason it cannot
 * exclude. A single-value scope has none.
 */
const withExcludeKey = (
  descriptor: FilterDescriptor,
  bound: CompiledListField | undefined,
): FilterDescriptor => {
  if (
    (descriptor.kind !== "multiselect" && descriptor.kind !== "idMulti") ||
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

/**
 * The noun a descriptor's menu entry reads by: a related view's relation
 * label (its column header), else its placeholder's noun. `singular` names
 * one of the relation's records ("Expense search").
 */
const menuNoun = (
  descriptor: FilterDescriptor,
  entity: CompiledEntity,
  byKey: ReadonlyMap<string, CompiledEntity>,
  singular = false,
): string => {
  const relation = relationOf(descriptor, entity);
  if (relation !== undefined) {
    const target = byKey.get(relation.target);
    return singular && target && relation.label === pluralOf(target)
      ? target.inspector.singular
      : relation.label;
  }
  return placeholderNoun(descriptor);
};

const relationOf = (descriptor: FilterDescriptor, entity: CompiledEntity) => {
  const key = /^related:[^.]+\.(.+)$/u.exec(descriptor.columnId)?.[1];
  return entity.relations.find((candidate) => candidate.key === key);
};

/** The noun a placeholder names ("Filter by related expenses id..."). */
const placeholderNoun = (descriptor: FilterDescriptor): string => {
  // Mirrors `filterSpecLabel`: only "related … id" drops its "id".
  const related = /^(Filter|Search)( by)? related\b/iu.test(
    descriptor.placeholder,
  );
  const noun = descriptor.placeholder
    .replace(/^(Filter|Search)( by)?( related)?\s*/iu, "")
    .replace(
      related ? /\s*(id|presence)?\.\.\.$/iu : /\s*(presence)?\.\.\.$/iu,
      "",
    )
    .trim();
  return noun.slice(0, 1).toUpperCase() + noun.slice(1);
};

/**
 * A text search or a count range that names the same noun as another of the
 * entity's filters (a relation's record picker reads "Expenses") is labelled
 * for what it is — "Expense search", "Expenses count" — so no two Filters-menu
 * entries read alike. A declared label is kept.
 */
const withDistinctMenuLabels = (
  descriptors: readonly FilterDescriptor[],
  entity: CompiledEntity,
  byKey: ReadonlyMap<string, CompiledEntity>,
): FilterDescriptor[] => {
  const wire = (descriptor: FilterDescriptor) =>
    descriptor.field ?? descriptor.columnId;
  // A related column reads its relation label as a header, and its
  // placeholder's noun where no column hosts it; either can collide.
  const nouns = descriptors.map(
    (descriptor) =>
      new Set(
        (descriptor.label === null
          ? [menuNoun(descriptor, entity, byKey), placeholderNoun(descriptor)]
          : [descriptor.label]
        ).map((noun) => noun.toLowerCase()),
      ),
  );
  return descriptors.map((descriptor, index) => {
    if (
      descriptor.label !== null ||
      (descriptor.kind !== "text" && descriptor.kind !== "range")
    )
      return descriptor;
    const collides = descriptors.some(
      (other, otherIndex) =>
        otherIndex !== index &&
        [...nouns[otherIndex]!].some((noun) => nouns[index]!.has(noun)) &&
        wire(other) !== wire(descriptor),
    );
    if (!collides) return descriptor;
    const noun = menuNoun(descriptor, entity, byKey, true);
    return {
      ...descriptor,
      label: `${noun} ${descriptor.kind === "text" ? "search" : "count"}`,
    };
  });
};

/**
 * A multiselect over a derived enum value offers that value's options when it
 * declares none, labelled as its group sections are; one over a row set's
 * enum field offers that field's options.
 */
const withDerivedOptions = (
  descriptor: FilterDescriptor,
  bound: CompiledListField | undefined,
): FilterDescriptor =>
  descriptor.kind === "multiselect" &&
  descriptor.options === null &&
  descriptor.optionsRef === null &&
  descriptor.optionsKey === null &&
  bound?.shape === "rows" &&
  bound.terminal.kind === "column" &&
  bound.terminal.options !== null
    ? { ...descriptor, options: bound.terminal.options }
    : descriptor.kind !== "multiselect" ||
        descriptor.options !== null ||
        descriptor.optionsRef !== null ||
        descriptor.optionsKey !== null ||
        bound?.shape !== "value" ||
        bound.options === null
      ? descriptor
      : {
          ...descriptor,
          options: bound.options.map((value) => ({
            value,
            label: value[0]!.toUpperCase() + value.slice(1),
          })),
        };

/**
 * Two declarations of one request field — a list column's filter and an
 * older deep-link key for it (task `relatedParentTaskId` beside
 * `parentTaskId`) — hold one state: the non-column one becomes the column
 * filter's alias, which the URL codec reads into that state and never writes.
 */
const withAliases = (
  descriptors: readonly FilterDescriptor[],
  entity: CompiledEntity,
): FilterDescriptor[] => {
  const listColumns = new Set(
    entity.fieldModel.fields
      .filter((field) => field.display.list)
      .map((field) => field.display.columnId ?? field.key),
  );
  const hosted = (descriptor: FilterDescriptor) =>
    listColumns.has(descriptor.columnId) ||
    descriptor.columnId.startsWith("related:");
  const wire = (descriptor: FilterDescriptor) =>
    descriptor.field ?? descriptor.columnId;
  return descriptors.map((descriptor) => {
    if (hosted(descriptor)) return descriptor;
    const canonical = descriptors.filter(
      (peer) =>
        peer !== descriptor &&
        hosted(peer) &&
        peer.kind === descriptor.kind &&
        wire(peer) === wire(descriptor),
    );
    return canonical.length === 1
      ? { ...descriptor, aliasOf: canonical[0]!.columnId }
      : descriptor;
  });
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
 * declared SQL path or repository value. Stored arrays and related paths
 * expand memberships; unsupported row sets and predicates retain their reason.
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
      noValueLabel: "Unassigned",
      multiple:
        field?.kind === "text-array" ||
        field?.reference?.multiple === true ||
        (bound?.shape === "via" &&
          (bound.many ||
            (bound.terminal.kind === "field" &&
              bound.terminal.fieldKind === "text-array"))),
      dateKind:
        field?.kind === "timestamp" ||
        (bound?.shape === "via" &&
          bound.terminal.kind === "field" &&
          bound.terminal.fieldKind === "timestamp")
          ? "timestamp"
          : field?.kind === "date" ||
              (bound?.shape === "value" && bound.type === "date") ||
              (bound?.shape === "via" &&
                bound.terminal.kind === "field" &&
                bound.terminal.fieldKind === "date")
            ? "date"
            : null,
      buckets:
        field?.kind === "date" ||
        field?.kind === "timestamp" ||
        (bound?.shape === "value" && bound.type === "date") ||
        (bound?.shape === "via" &&
          bound.terminal.kind === "field" &&
          ["date", "timestamp"].includes(bound.terminal.fieldKind))
          ? ["day", "week", "month", "quarter", "year"]
          : [],
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
  if (bound?.shape === "via") return viaValue(bound);
  // A predicate, or a value with no single section key (a date span).
  if (bound !== undefined && bound.group !== null)
    return choice(null, bound.group);
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
        return choice(
          null,
          `${label} has no declared relation that SQL can expand.`,
        );
      const via = compileVia(entity, relation.key, byKey, where);
      if (via.shape !== "via")
        throw new EntityDeclarationError(
          `${where}: ${relation.key} is not a related path.`,
        );
      return viaValue(via);
    }
    if (
      ["enum", "text", "text-array", "boolean", "date", "timestamp"].includes(
        field.kind,
      )
    )
      return choice(
        { kind: "column", column: stored.column, options: enumOptions(field) },
        null,
      );
  }
  if (
    bound?.shape === "value" &&
    ["enum", "text", "boolean", "date"].includes(bound.type)
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

/** Supplied views use the same dimensions and applicability as list requests. */
const validateSavedViewGrouping = (
  entity: CompiledEntity,
  grouping: readonly CompiledGroupChoice[],
  context: string,
) => {
  for (const view of entity.inspector.list.savedViews) {
    for (const dimension of view.groupBy) {
      const choice = grouping.find(({ key }) => key === dimension.key);
      const where = `${context}.presentation.list.savedViews[${view.id}].groupBy ${dimension.key}`;
      if (choice === undefined || choice.reason !== null)
        throw new EntityDeclarationError(
          `${where} cannot group: ${choice?.reason ?? "unknown field"}.`,
        );
      if (
        dimension.level !== undefined &&
        (choice.levelReason !== null || dimension.level > choice.levels)
      )
        throw new EntityDeclarationError(
          `${where}: ${choice.levelReason ?? `offers levels 1–${choice.levels}`}.`,
        );
      if (
        dimension.bucket !== undefined &&
        !choice.buckets.includes(dimension.bucket)
      )
        throw new EntityDeclarationError(
          `${where} does not support date buckets.`,
        );
    }
  }
};

/**
 * Each `model.derived` member of a text filter's `anyOf` must read text: a
 * `via` path to a text field or a titled record, or a `type: "text"` value.
 */
const validateAnyOfMembers = (
  descriptor: FilterDescriptor,
  derived: Readonly<Record<string, CompiledListField>>,
  context: string,
): void => {
  for (const member of descriptor.anyOf ?? []) {
    const entry = member.source === "derived" ? derived[member.key] : null;
    if (entry === null || entry === undefined) continue;
    const text =
      entry.shape === "via"
        ? entry.terminal.kind === "record"
          ? entry.terminal.titleColumn !== null
          : entry.terminal.fieldKind === "text"
        : entry.shape === "value" && entry.type === "text";
    if (!text)
      throw new EntityDeclarationError(
        `${context}.filters ${descriptor.columnId} anyOf ${member.key} is not text: name a via path to a text field or a titled record, or a type "text" value.`,
      );
  }
};

const validateDerivedReference = (
  entity: CompiledEntity,
  key: string,
  projection: CompiledListField,
  context: string,
): void => {
  const field = entity.fieldModel.fields.find((field) => field.key === key);
  if (
    projection.shape === "via" &&
    !projection.many &&
    projection.terminal.kind === "record" &&
    field?.reference &&
    field.readKey !== null &&
    !entity.fieldModel.storage.some((stored) => stored.key === key) &&
    field.reference.entity !== projection.target
  )
    throw new EntityDeclarationError(
      `${context} targets ${projection.target}, but the read field references ${field.reference.entity}.`,
    );
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
  const inherit = new Map(
    entities.map((entity) => [entity.key, compileInherit(entity, byKey)]),
  );
  assertAcyclicInherit(entities, inherit);
  return entities.map((entity) => {
    const context = entity.key;
    const rows = compileRowSets(entity, byKey);
    const derived: Record<string, CompiledListField> = {};
    for (const [key, entry] of Object.entries(entity.fieldModel.derived)) {
      const derivedContext = `${context}.model.derived.${key}`;
      derived[key] =
        "via" in entry
          ? compileVia(entity, entry.via, byKey, derivedContext, rows)
          : "type" in entry
            ? {
                shape: "value",
                type: entry.type,
                options: entry.options ?? null,
                sort: null,
                group:
                  entry.type === "dateInterval"
                    ? `${humanize(key)} is a date span, so a record has no single date to group under.`
                    : null,
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
      validateDerivedReference(entity, key, derived[key], derivedContext);
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
    for (const unbound of entity.filterDescriptors) {
      const declared = withInferredDerived(unbound, derived);
      const bound =
        declared.derived === null ? undefined : derived[declared.derived];
      if (declared.derived !== null && bound === undefined)
        throw new EntityDeclarationError(
          `${context}.filters ${declared.columnId} is derived but names no model.derived entry ${declared.derived}.`,
        );
      validateAnyOfMembers(declared, derived, context);
      const descriptor = withDerivedOptions(
        withExcludeKey(withViaKeys(declared, derived, byKey, context), bound),
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
      assertRowSetRange(descriptor, bound, context);
      if (descriptor.kind !== "idMulti") continue;
      // A declared idMulti predicate (an inherited reference) targets its
      // brand's entity.
      const referenced =
        bound?.shape === "via" && bound.terminal.kind === "record"
          ? bound.target
          : bound?.shape === "rows" && bound.terminal.kind === "record"
            ? bound.terminal.target
            : bound?.shape === "predicate"
              ? (descriptor.brandRef?.entity ?? null)
              : descriptor.stored === null
                ? null
                : (entity.fieldModel.storage.find(
                    ({ key }) => key === descriptor.stored?.columns[0],
                  )?.reference ?? null);
      const target = referenced === null ? undefined : byKey.get(referenced);
      if (target?.fieldModel.hierarchy == null) continue;
      const toggle = toggleDescriptor(target);
      subtree[descriptor.field ?? descriptor.columnId] = toggle.columnId;
      compiled[compiled.length - 1] = {
        ...descriptor,
        subtree: toggle.columnId,
      };
      if (!toggles.some(({ columnId }) => columnId === toggle.columnId))
        toggles.push(toggle);
    }
    // A term expander is server-only: it leaves the client descriptor.
    const terms: Record<string, string> = {};
    const withoutTerms = compiled.map(({ terms: expander, ...descriptor }) => {
      if (expander === undefined) return descriptor;
      if (descriptor.kind !== "text" || descriptor.derived === null)
        throw new EntityDeclarationError(
          `${context}.filters ${descriptor.columnId} declares terms, which only a derived text filter reads.`,
        );
      terms[descriptor.field ?? descriptor.columnId] = expander;
      return descriptor;
    });
    const filterDescriptors = [
      ...withAliases(
        withDistinctMenuLabels(withoutTerms, entity, byKey),
        entity,
      ),
      ...toggles,
    ];
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
    const inferred = entity.fieldModel.fields
      .filter(
        (field) =>
          field.reference !== null ||
          ["enum", "boolean", "date", "timestamp"].includes(field.kind),
      )
      .filter((field) =>
        entity.fieldModel.storage.some(({ key }) => key === field.key),
      )
      .map(({ key }) => key);
    const inferredDerived = Object.entries(derived)
      .filter(([, field]) =>
        field.shape === "value"
          ? ["enum", "boolean", "date"].includes(field.type)
          : field.shape === "via" &&
            (field.terminal.kind === "record" ||
              ["enum", "boolean", "date", "timestamp"].includes(
                field.terminal.fieldKind,
              )),
      )
      .map(([key]) => key);
    const grouping = [
      ...new Set([
        ...entity.fieldModel.grouping,
        ...inferred,
        ...inferredDerived,
      ]),
    ]
      .filter((key) => !entity.fieldModel.groupingOmit?.includes(key))
      .map((key) =>
        compileGroupChoice(
          entity,
          key,
          derived,
          filterDescriptors,
          byKey,
          context,
        ),
      );
    if (
      new Set(entity.inspector.list.metrics).size !==
      entity.inspector.list.metrics.length
    )
      throw new EntityDeclarationError(
        `${context}.presentation.list.metrics repeats a field.`,
      );
    const metrics = entity.inspector.list.metrics.map((key) => {
      const field = entity.fieldModel.fields.find((field) => field.key === key);
      const value = derived[key];
      const stored = entity.fieldModel.storage.find(
        (field) => field.key === key,
      );
      if (
        !(value?.shape === "value" && value.type === "number") &&
        !(stored && field?.kind === "number")
      )
        throw new EntityDeclarationError(
          `${context}.presentation.list.metrics ${key} needs a scalar numeric SQL field.`,
        );
      const format = field?.display.format ?? null;
      if (format === "amount")
        throw new EntityDeclarationError(
          `${context}.presentation.list.metrics ${key} cannot sum quantities with record-specific units.`,
        );
      if (
        (format === "currency" || format === "signedCurrency") &&
        !(entity.key === "expense" && stored?.column === "cost") &&
        !(
          field?.provenance?.kind === "derived" &&
          field.provenance.sources.some((source) => source.entity === "expense")
        )
      )
        throw new EntityDeclarationError(
          `${context}.presentation.list.metrics ${key} must use Expense.cost or an Expense-derived SQL value for money.`,
        );
      return { key, label: field?.label ?? humanize(key), format };
    });
    validateSavedViewGrouping(entity, grouping, context);
    const listFields: CompiledEntityListFields = {
      derived,
      rows,
      terms,
      inherit: inherit.get(entity.key) ?? {},
      hierarchy:
        hierarchy === null || parentColumn === undefined
          ? null
          : { ...hierarchy, column: parentColumn },
      subtree,
      grouping,
      metrics,
      ...compileListScopes(entity, byKey, rows, urlKeys),
    };
    return {
      ...entity,
      filterDescriptors,
      filterUrlKeys: urlKeys,
      listFields,
    };
  });
};

import { dataQuality, scoredEntities } from "@cubby/schemas/data-quality";
import type { Entity } from "@cubby/schemas/entity";
import { entityFieldEnvelopeNested } from "@cubby/schemas/entity-field-envelopes";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { storedProjectionVersionsSchema } from "@cubby/schemas/field-envelope";
import { fieldResolutionsSchema } from "@cubby/schemas/field-resolution";
import { parseShortcode } from "@cubby/shared";
import { z } from "zod";

import type { RepositoryQueryInput } from "~/server/db/repository-access.boundary";
import { repositoryReadPorts } from "~/server/entity-kernel/repo/read-ports";
import { entityFieldEnvelopeProjectors } from "~/server/generated/entity-field-envelope-projectors.gen";
import { presentPublishedQuality } from "~/server/generic/data-quality/repo/presentation";
import { buildFieldEnvelopeRow } from "~/server/generic/derived/repo/envelope";
import {
  projectStoredResult,
  projectStoredValue,
} from "~/server/generic/derived/repo/read";
import type {
  FieldReadContext,
  PageFieldReadContexts,
} from "~/server/generic/derived/repo/read-context";
const rowRecord = z.record(z.string(), z.unknown());
const rowArray = z.array(z.unknown());
type ReadRow = z.output<typeof rowRecord>;
type ReadContainer = ReadRow | z.output<typeof rowArray>;
const publicIdentity = z.object({ id: z.string() });
const canonicalCode = (code: string) => parseShortcode(code)?.shortcode ?? code;

type EmbeddedBinding =
  (typeof entityFieldEnvelopeNested)[keyof typeof entityFieldEnvelopeNested][number];
const embeddedBindings = (
  entity: ShortcodeEntity,
): readonly EmbeddedBinding[] =>
  Object.entries(entityFieldEnvelopeNested).find(
    ([key]) => key === entity,
  )?.[1] ?? [];

/** A projection tree retains duplicate snapshots; only its fact reads deduplicate. */
type ReadNode = {
  entity: ShortcodeEntity;
  schema: z.ZodObject;
  row: ReadRow;
  children: { path: readonly (string | number)[]; node: ReadNode }[];
};

/** Overlapping declared paths must validate deepest descendants before their parent projection. */
function nestedReadChildren(
  children: ReadNode["children"],
): ReadNode["children"] {
  const direct: ReadNode["children"] = [];
  for (const child of [...children].sort(
    (a, b) => a.path.length - b.path.length,
  )) {
    const parent = direct.find((candidate) =>
      candidate.path.every((part, index) => child.path[index] === part),
    );
    if (!parent) {
      direct.push(child);
      continue;
    }
    if (parent.path.length === child.path.length) {
      if (parent.node.entity !== child.node.entity)
        throw new Error(
          "Nested field bindings disagree on an entity at the same path",
        );
      parent.node.children = nestedReadChildren([
        ...parent.node.children,
        ...child.node.children,
      ]);
    } else {
      parent.node.children = nestedReadChildren([
        ...parent.node.children,
        { path: child.path.slice(parent.path.length), node: child.node },
      ]);
    }
  }
  return direct;
}

/** Explicit embedded paths address raw producer slots, including governed containers. */
function nestedReadSchema(
  schema: z.ZodObject,
  key: string,
): z.core.$ZodType | undefined {
  if (schema.shape[key]) return schema.shape[key];
  const fields = schema.shape.fields;
  const envelope =
    fields instanceof z.ZodObject ? fields.shape[key] : undefined;
  if (!envelope) return undefined;
  const result =
    envelope instanceof z.ZodObject ? envelope.shape.result : undefined;
  if (!(result instanceof z.ZodDiscriminatedUnion))
    throw new Error(`Nested ${key} requires a field result schema`);
  const live = result.options.find(
    (option) =>
      option instanceof z.ZodObject &&
      option.shape.kind.safeParse("live").success,
  );
  const decision =
    live instanceof z.ZodObject ? live.shape.decision : undefined;
  const outcome =
    decision instanceof z.ZodObject ? decision.shape.outcome : undefined;
  if (!(outcome instanceof z.ZodDiscriminatedUnion))
    throw new Error(`Nested ${key} requires a field outcome schema`);
  const value = outcome.options.find(
    (option) =>
      option instanceof z.ZodObject &&
      option.shape.kind.safeParse("value").success,
  );
  if (
    !(value instanceof z.ZodObject) ||
    !(value.shape.value instanceof z.ZodType)
  )
    throw new Error(`Nested ${key} requires an effective value schema`);
  return value.shape.value;
}

function prepareReadNode(
  entity: ShortcodeEntity,
  schema: z.ZodObject,
  value: unknown,
): ReadNode {
  const row = rowRecord.parse(value);
  const children: ReadNode["children"] = [];
  const visit = (
    target: ShortcodeEntity,
    childSchema: z.core.$ZodType,
    child: unknown,
    remaining: readonly string[],
    path: readonly (string | number)[],
  ): void => {
    if (child == null) return;
    if (
      childSchema instanceof z.ZodNullable ||
      childSchema instanceof z.ZodOptional ||
      childSchema instanceof z.ZodLazy
    ) {
      visit(target, childSchema.unwrap(), child, remaining, path);
      return;
    }
    if (childSchema instanceof z.ZodArray) {
      for (const [index, item] of z.array(z.unknown()).parse(child).entries())
        visit(target, childSchema.element, item, remaining, [...path, index]);
      return;
    }
    if (childSchema instanceof z.ZodDiscriminatedUnion) {
      const discriminator = childSchema.def.discriminator;
      const record = rowRecord.parse(child);
      const option = childSchema.options.find(
        (candidate) =>
          candidate instanceof z.ZodObject &&
          candidate.shape[discriminator]?.safeParse(record[discriminator])
            .success,
      );
      if (!option)
        throw new Error(
          `Invalid nested union variant: ${entity}.${path.join(".")}`,
        );
      visit(target, option, child, remaining, path);
      return;
    }
    if (!(childSchema instanceof z.ZodObject))
      throw new Error(
        `Unsupported nested field projection: ${entity}.${path.join(".")}`,
      );
    const [key, ...rest] = remaining;
    if (key === undefined) {
      children.push({
        path,
        node: prepareReadNode(target, childSchema, child),
      });
      return;
    }
    const next = nestedReadSchema(childSchema, key);
    // Selected projections need not expose every declared embedded path.
    if (!next) return;
    const record = rowRecord.parse(child);
    visit(target, next, record[key], rest, [...path, key]);
  };
  for (const binding of embeddedBindings(entity))
    visit(binding.entity, schema, row, binding.path, []);
  return { entity, schema, row, children: nestedReadChildren(children) };
}

function replaceNestedRead(
  value: unknown,
  path: readonly (string | number)[],
  replacement: ReadRow,
): ReadContainer {
  const [key, ...rest] = path;
  if (key === undefined) return replacement;
  if (typeof key === "number") {
    const values = z.array(z.unknown()).parse(value);
    values[key] = replaceNestedRead(values[key], rest, replacement);
    return values;
  }
  const record = rowRecord.parse(value);
  return {
    ...record,
    [key]: replaceNestedRead(record[key], rest, replacement),
  };
}

/** Stored reference ids and modes are retained; outward ids use existing hydration. */
function currentAssignments(
  entity: Entity,
  row: Readonly<ReadRow>,
  raw: Readonly<ReadRow>,
) {
  const values = { ...raw };
  for (const field of entityFieldModels[entity].fields) {
    const key = field.readKey ?? field.key;
    if (Object.hasOwn(raw, field.key)) values[key] = raw[field.key];
  }
  const resolutions = fieldResolutionsSchema.parse(row.fieldResolutions ?? {});
  for (const [key, resolution] of Object.entries(resolutions)) {
    const readKey =
      entityFieldModels[entity].fields.find((field) => field.key === key)
        ?.readKey ?? key;
    if (!Object.hasOwn(values, readKey))
      values[readKey] = resolution.storedValue;
  }
  return values;
}

/** The one outward value is constructed only after raw repository hydration. */
export function publicFieldEnvelopeRow<S extends z.ZodType>(
  schema: S,
  entity: Entity,
  value: ReadRow,
  context?: FieldReadContext,
): z.output<S>;
export function publicFieldEnvelopeRow(
  schema: z.ZodType,
  entity: Entity,
  value: ReadRow,
  context?: FieldReadContext,
) {
  if (!(schema instanceof z.ZodObject))
    throw new Error("An entity field read requires an object schema");
  const row = rowRecord.parse(value);
  const stored = new Map(context?.stored);
  const versions = storedProjectionVersionsSchema.parse(
    row.storedProjectionVersions,
  );
  for (const field of entityFieldModels[entity].fields) {
    const readKey = field.readKey ?? field.key;
    if (!field.storedKey) continue;
    const read = stored.get(field.storedKey);
    if (read)
      stored.set(
        readKey,
        "storedProjection" in field && field.storedProjection
          ? projectStoredValue(read, row[readKey], versions?.[readKey])
          : "storedPath" in field && field.storedPath
            ? projectStoredResult(read, field.storedPath)
            : read,
      );
  }
  const quality = stored.get("dataQuality");
  const scored = z.enum(scoredEntities).safeParse(entity);
  const fields = schema.shape.fields;
  if (
    quality?.resultExists &&
    scored.success &&
    fields instanceof z.ZodObject &&
    Object.hasOwn(fields.shape, "dataQuality")
  ) {
    const presented = presentPublishedQuality(
      scored.data,
      publicIdentity.parse(row).id,
      quality.value,
      dataQuality.parse(row.dataQuality),
    );
    stored.set("dataQuality", {
      ...quality,
      value: presented,
      ...(quality.decision?.outcome.kind === "value"
        ? {
            decision: {
              ...quality.decision,
              outcome: { kind: "value", value: presented },
            },
          }
        : {}),
    });
  }
  const input = {
    schema,
    entity,
    row,
    stored,
    ownership: context?.ownership,
    assignments: currentAssignments(entity, row, context?.raw ?? {}),
  } satisfies Parameters<typeof buildFieldEnvelopeRow>[0];
  const built = buildFieldEnvelopeRow(input);
  const project = entityFieldEnvelopeProjectors[entity];
  return project ? schema.parse(project({ ...input, built })) : built;
}

/** Selected reads retain only the requested semantic fields, nested when governed. */
export function selectedFieldEnvelopeSchema(
  schema: z.ZodType,
  requested: readonly string[],
) {
  if (!(schema instanceof z.ZodObject))
    throw new Error("A selected entity read requires an object schema");
  const fields = schema.shape.fields;
  if (!(fields instanceof z.ZodObject))
    throw new Error("A selected entity read requires field envelopes");
  const wanted = new Set(requested);
  return z.object({
    ...Object.fromEntries(
      Object.entries(schema.shape).filter(
        ([key]) => key !== "fields" && wanted.has(key),
      ),
    ),
    id: z.string(),
    fields: z.object(
      Object.fromEntries(
        Object.entries(fields.shape).filter(([key]) => wanted.has(key)),
      ),
    ),
  });
}

/** One response may contain several selected projections of the same entity. */
export async function publicFieldEnvelopeBatch({
  db,
  reads,
  contexts,
}: {
  db: RepositoryQueryInput;
  reads: readonly {
    entity: ShortcodeEntity;
    schema: z.ZodObject;
    row: ReadRow;
  }[];
  contexts?: ReadonlyMap<ShortcodeEntity, PageFieldReadContexts>;
}): Promise<ReadRow[]> {
  const roots = reads.map(({ entity, schema, row }) =>
    prepareReadNode(entity, schema, row),
  );
  const requested = new Map<ShortcodeEntity, Set<string>>();
  const collect = (node: ReadNode) => {
    const fields = node.schema.shape.fields;
    if (fields instanceof z.ZodObject && Object.keys(fields.shape).length > 0) {
      const codes = requested.get(node.entity) ?? new Set<string>();
      codes.add(canonicalCode(publicIdentity.parse(node.row).id));
      requested.set(node.entity, codes);
    }
    for (const child of node.children) collect(child.node);
  };
  for (const root of roots) collect(root);
  const facts = new Map<ShortcodeEntity, PageFieldReadContexts>();
  // Each kind can fan out into several fact reads. Keep one kind in flight
  // so embedded projections cannot exhaust the invocation's socket reserve.
  for (const [kind, codes] of requested) {
    const existing = new Map(
      [...(contexts?.get(kind) ?? [])].map(([code, context]) => [
        canonicalCode(code),
        context,
      ]),
    );
    const missing = [...codes].filter((code) => !existing.has(code));
    let loaded: PageFieldReadContexts | undefined;
    if (missing.length) {
      const read = repositoryReadPorts(kind);
      if (!read) throw new Error(`No repository read ports for ${kind}`);
      loaded = await read.fieldReads(db, missing);
    }
    facts.set(kind, new Map([...existing, ...(loaded ?? [])]));
  }
  const serialize = (node: ReadNode): ReadRow => {
    let row = node.row;
    for (const child of node.children)
      row = rowRecord.parse(
        replaceNestedRead(row, child.path, serialize(child.node)),
      );
    const current = facts
      .get(node.entity)
      ?.get(canonicalCode(publicIdentity.parse(row).id));
    const fields = node.schema.shape.fields;
    // An explicitly compact identity projection has no governed values or action facts.
    // Validate that leaf as declared rather than inventing an empty field envelope.
    if (!(fields instanceof z.ZodObject))
      return rowRecord.parse(node.schema.parse(row));
    if (
      fields instanceof z.ZodObject &&
      Object.keys(fields.shape).length > 0 &&
      !current
    )
      throw new Error(
        `Current field facts unavailable for ${node.entity} projection`,
      );
    return rowRecord.parse(
      publicFieldEnvelopeRow(node.schema, node.entity, row, current),
    );
  };
  return roots.map(serialize);
}

export async function publicFieldEnvelopeRows<S extends z.ZodType>({
  db,
  entity,
  schema,
  rows,
  contexts,
}: {
  db: RepositoryQueryInput;
  entity: ShortcodeEntity;
  schema: S;
  rows: readonly unknown[];
  contexts?: PageFieldReadContexts;
}): Promise<Array<z.output<S>>> {
  if (!(schema instanceof z.ZodObject))
    throw new Error("An entity field read requires an object schema");
  const serialized = await publicFieldEnvelopeBatch({
    db,
    reads: rows.map((row) => ({ entity, schema, row: rowRecord.parse(row) })),
    contexts: contexts ? new Map([[entity, contexts]]) : undefined,
  });
  return serialized.map((row) => schema.parse(row));
}

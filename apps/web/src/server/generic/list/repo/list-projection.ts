import {
  type DataQuality,
  type ScoredEntity,
  scoredEntities,
} from "@cubby/schemas/data-quality";
import { dateRangeFromDates } from "@cubby/schemas/date-range";
import type { DisplayImageSummary } from "@cubby/schemas/display-images";
import { entityRefKey } from "@cubby/schemas/entity";
import {
  entityFieldModels,
  type EntityFieldModel,
} from "@cubby/schemas/entity-fields";
import { shortcodeEntities } from "@cubby/schemas/entity-manifest";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { z } from "zod";

import type { ListEntity } from "~/entity/generated/entity-lists.gen";
import type { ListReadRow } from "~/entity/model/list-read-fields";
import {
  listReadSchema,
  projectListRows,
} from "~/entity/model/list-read-schema";
import type { Database, DrizzleTransaction } from "~/server/db";
import { inheritedFieldOfColumn } from "~/server/db/computed/effective-field";
import {
  resolveEntityDisplayImageLists,
  withDisplayImages,
} from "~/server/entity-kernel/repo/entity-display-image";
import { loadDataQualities } from "~/server/generic/data-quality/repo/hydrate";
import type { ListProjection } from "~/server/generic/list/repo/list-contracts";
import { lookupEntityReferences } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { traceListGroup } from "~/server/observability/list-read-tracing";

import { ListContext, derivedFieldsOf } from "./field-compiler";
import { loadRelationProjection } from "./relation-projection";

/** Repository batch bindings retain their local preparation names. They are never deferred reads. */
export type ListBindingGroup = "media" | "quality" | "relations" | "derived";
export const wantsListGroup = (
  projection: ListProjection,
  group: ListBindingGroup,
): boolean => {
  if (projection.kind === "base") return false;
  if (projection.kind === "full") return true;
  if (group === "media")
    return projection.fields.some(
      (key) => key === "displayImages" || key === "images",
    );
  if (group === "quality") return projection.fields.includes("dataQuality");
  return true;
};

/** Validate explicit field demand before reading even an empty page. */
export function selectedListProjection(
  entity: ListEntity,
  requested: readonly string[],
): Extract<ListProjection, { kind: "selected" }> {
  const schema = listReadSchema(entity);
  for (const field of requested)
    if (!(field in schema.shape))
      throw new Error(`Unknown list field: ${entity}.${field}`);
  return { kind: "selected", fields: [...new Set(requested)] };
}

/** Selected reads can gate a shared loader by all its consumer fields,
 * including transitive consumers;
 * full/group reads still load every dependency belonging to their groups. */
export const loadListGroup = async <T>(
  projection: ListProjection,
  groups: ListBindingGroup | readonly ListBindingGroup[],
  load: () => Promise<T>,
  consumerFields?: readonly string[],
): Promise<T | undefined> =>
  [groups].flat().some((group) => wantsListGroup(projection, group)) &&
  (projection.kind !== "selected" ||
    consumerFields === undefined ||
    consumerFields.some((field) => projection.fields.includes(field)))
    ? traceListGroup(groups, load)
    : undefined;

/** Build only the selected group's columns or canonical fields; omitted groups stay absent. */
export const listGroupFields = <T extends object>(
  projection: ListProjection,
  groups: ListBindingGroup | readonly ListBindingGroup[],
  build: () => T,
): Partial<T> => {
  if ([groups].flat().some((group) => wantsListGroup(projection, group)))
    return build();
  return {};
};

const scored = new Set<string>(scoredEntities);
const isScored = (entity: string): entity is ScoredEntity => scored.has(entity);

/** Id-only page loads started before the rows arrive; see `prefetch`. */
export type ListPagePrefetch = {
  qualities?: ReturnType<typeof loadDataQualities>;
  images?: Promise<Map<string, DisplayImageSummary[]>>;
};

export type ListReadValueContext = {
  projection: ListProjection;
  context: ListContext;
  quality: DataQuality | undefined;
  displayImages: DisplayImageSummary[] | undefined;
  references: ReadonlyMap<
    string,
    { id: string; name: string | null; emoji?: string | null } | undefined
  >;
};
type ListReadPage<Row> = {
  db: Database | DrizzleTransaction;
  rows: Row[];
  projection: ListProjection;
  context: ListContext;
};
type ListReadBinding<Row> = {
  schema: z.ZodObject;
  prepare?: (page: ListReadPage<Row>) => Promise<void>;
  value: (
    row: Row,
    page: ListReadPage<Row>,
    context: ListReadValueContext,
  ) => Promise<object> | object;
};
type BindListFields<Row> = {
  <Fields extends z.ZodRawShape>(
    schema: z.ZodObject<Fields>,
    value: (
      row: Row,
      context: ListReadValueContext,
    ) => z.output<z.ZodObject<Fields>>,
  ): ListReadBinding<Row>;
  batch: <Loaded>(load: (page: ListReadPage<Row>) => Promise<Loaded>) => {
    load: (page: ListReadPage<Row>) => Promise<Loaded>;
    fields: <Fields extends z.ZodRawShape>(
      schema: z.ZodObject<Fields>,
      value: (
        row: Row,
        loaded: Loaded,
        context: ListReadValueContext,
      ) => z.output<z.ZodObject<Fields>>,
    ) => ListReadBinding<Row>;
  };
};
export type ListReadOptions<Row> = {
  media?: boolean;
  references?: Record<
    string,
    | { kind: "public" }
    | {
        kind: "lookup";
        name?: string;
        emoji?: string;
        missing: "null" | "error";
        includeDeleted?: boolean;
        consumers?: readonly string[];
      }
  >;
  bindings?: (bind: BindListFields<Row>) => readonly ListReadBinding<Row>[];
};

const sourceRecord = z.record(z.string(), z.unknown());

type DateRangeProjection = NonNullable<
  EntityFieldModel["fields"][number]["dateRange"]
> &
  Pick<EntityFieldModel["fields"][number], "key">;

function projectDateRanges(
  source: z.infer<typeof sourceRecord>,
  fields: readonly DateRangeProjection[],
): z.infer<typeof sourceRecord> {
  const output: z.infer<typeof sourceRecord> = {};
  for (const { key, start, end } of fields) {
    if (!Object.hasOwn(source, start) || !Object.hasOwn(source, end))
      throw new Error(`Requested date columns were not loaded: ${key}`);
    output[key] = dateRangeFromDates(
      z.string().nullable().parse(source[start]),
      z.string().nullable().parse(source[end]),
    );
  }
  return output;
}

const sourceIdentity = z.object({ id: z.string(), shortcode: z.string() });

/** Canonical fields own admission; batches retain their inferred result in a page-local closure. */
export function listReadPlan<Row>(
  entity: ListEntity,
  options: ListReadOptions<Row> = {},
) {
  const schema = listReadSchema(entity);
  const bind: BindListFields<Row> = Object.assign(
    <Fields extends z.ZodRawShape>(
      picked: z.ZodObject<Fields>,
      value: (
        row: Row,
        context: ListReadValueContext,
      ) => z.output<z.ZodObject<Fields>>,
    ): ListReadBinding<Row> => ({
      schema: picked,
      value: (row, _page, context) => value(row, context),
    }),
    {
      batch: <Loaded>(load: (page: ListReadPage<Row>) => Promise<Loaded>) => {
        const memo = new WeakMap<ListReadPage<Row>, Promise<Loaded>>();
        const get = (page: ListReadPage<Row>): Promise<Loaded> => {
          let loaded = memo.get(page);
          if (loaded === undefined) {
            loaded = load(page);
            memo.set(page, loaded);
          }
          return loaded;
        };
        return {
          load: get,
          fields: <Fields extends z.ZodRawShape>(
            picked: z.ZodObject<Fields>,
            value: (
              row: Row,
              loaded: Loaded,
              context: ListReadValueContext,
            ) => z.output<z.ZodObject<Fields>>,
          ): ListReadBinding<Row> => ({
            schema: picked,
            prepare: async (page) => {
              await get(page);
            },
            value: async (row, page, context) => {
              return value(row, await get(page), context);
            },
          }),
        };
      },
    },
  );
  const bindings = options.bindings?.(bind) ?? [];
  const written = new Set<string>(["id", "dataQuality", "displayImages"]);
  const claim = (key: string) => {
    if (!Object.hasOwn(schema.shape, key))
      throw new Error(`Unknown list binding field: ${entity}.${key}`);
    if (written.has(key))
      throw new Error(`Multiple list binding writers: ${entity}.${key}`);
    written.add(key);
  };
  for (const binding of bindings)
    for (const key of Object.keys(binding.schema.shape)) claim(key);
  const model = Object.entries(entityFieldModels).find(
    ([key]) => key === entity,
  )?.[1];
  const storage = model?.storage ?? [];
  const privateKeys = new Set<string>(
    storage
      .filter((field) => field.reference !== null)
      .flatMap((field) => [field.key, field.column]),
  );
  const inferred: NonNullable<ListReadOptions<Row>["references"]> = {};
  const derived = derivedFieldsOf(entity);
  for (const field of model?.fields ?? []) {
    const key = field.readKey ?? field.key;
    const stored = storage.find((candidate) => candidate.key === field.key);
    const via = derived[field.key];
    // Inherited references require explicit admission, then share label defaults.
    if (
      !field.reference ||
      field.reference.multiple ||
      written.has(key) ||
      (stored &&
        inheritedFieldOfColumn(entity, stored.column) !== null &&
        options.references?.[key]?.kind !== "lookup") ||
      !Object.hasOwn(schema.shape, key) ||
      !(
        stored?.reference ||
        (via?.shape === "via" && !via.many && via.terminal.kind === "record")
      )
    )
      continue;
    const label = field.display.labelPath;
    inferred[key] = {
      kind: "lookup",
      missing: field.nullable ? "null" : "error",
      ...(label && Object.hasOwn(schema.shape, label) && !written.has(label)
        ? { name: label }
        : {}),
    };
  }
  for (const [key, instruction] of Object.entries(options.references ?? {}))
    inferred[key] =
      instruction.kind === "public"
        ? instruction
        : { ...inferred[key], ...instruction };
  const references = Object.entries(inferred).map(([key, instruction]) => {
    claim(key);
    if (instruction.kind === "public")
      return { key, instruction, target: null };
    const declared = model?.fields.find(
      (field) => field.key === key || field.readKey === key,
    );
    const stored = storage.find(
      (field) => field.key === (declared?.key ?? key) || field.column === key,
    );
    const target = shortcodeEntities.find(
      (candidate) =>
        candidate === (stored?.reference ?? declared?.reference?.entity),
    );
    if (!target)
      throw new Error(
        `List reference has no declared target: ${entity}.${key}`,
      );
    if (instruction.name) claim(instruction.name);
    if (instruction.emoji) claim(instruction.emoji);
    for (const consumer of instruction.consumers ?? [])
      if (!Object.hasOwn(schema.shape, consumer))
        throw new Error(
          `Unknown list reference consumer: ${entity}.${consumer}`,
        );
    return {
      key,
      instruction,
      target,
      column: stored?.column ?? key,
      via: derived[declared?.key ?? key],
    };
  });
  const wanted = (projection: ListProjection, key: string): boolean => {
    switch (projection.kind) {
      case "full":
        return true;
      case "selected":
        return projection.fields.includes(key);
      case "base":
        return false;
    }
  };
  const validate = (projection: ListProjection) => {
    if (projection.kind === "selected")
      selectedListProjection(entity, projection.fields);
  };
  /**
   * The page loads that need only row ids. The scaffold starts them as soon
   * as the page's ids are known, so they share a round trip with the row
   * load instead of waiting for it.
   */
  // Entities without bespoke media still publish `displayImages`; resolving
  // them here from internal ids spares the kernel's shortcode-then-images
  // pass two sequential round trips per page.
  const resolvesDisplayImages = (projection: ListProjection) =>
    wantsListGroup(projection, "media") &&
    (options.media === true ||
      (Object.hasOwn(schema.shape, "displayImages") &&
        wanted(projection, "displayImages")));
  /** Non-media entities take the plan-resolved images; media bindings own theirs. */
  const attachDisplayImages = (
    result: ListReadRow,
    images: Map<string, DisplayImageSummary[]> | undefined,
    id: string,
    projection: ListProjection,
  ) => {
    if (
      options.media ||
      !images ||
      !wanted(projection, "displayImages") ||
      result.displayImages !== undefined
    )
      return;
    result.displayImages = schema.shape.displayImages.parse(
      images.get(entityRefKey(entity, id)) ?? [],
    );
  };
  const prefetch = (
    db: Database | DrizzleTransaction,
    ids: readonly string[],
    projection: ListProjection,
    qualitySource: "stored" | "live" = "stored",
  ): ListPagePrefetch => {
    const settled = <V>(promise: Promise<V>) => {
      promise.catch(() => {
        // SILENT: `read` awaits and surfaces this rejection; only a page
        // abandoned before hydration (its row load failed) drops it.
      });
      return promise;
    };
    return {
      qualities:
        isScored(entity) && wantsListGroup(projection, "quality") && ids.length
          ? settled(
              loadDataQualities(
                db,
                entity,
                ids.map((id) => parseEntityId(entity, id)),
                qualitySource,
              ),
            )
          : undefined,
      images:
        resolvesDisplayImages(projection) && ids.length
          ? settled(
              resolveEntityDisplayImageLists(
                db,
                ids.map((id) => ({ entityKind: entity, entityId: id })),
              ),
            )
          : undefined,
    };
  };
  return {
    validate,
    prefetch,
    async read(
      db: Database | DrizzleTransaction,
      rows: readonly Row[],
      projection: ListProjection,
      context = ListContext.empty,
      qualitySource: "stored" | "live" = "stored",
      prefetched?: ListPagePrefetch,
    ): Promise<ListReadRow[]> {
      validate(projection);
      if (!rows.length) return [];
      const page: ListReadPage<Row> = {
        db,
        rows: [...rows],
        projection,
        context,
      };
      const admitted = bindings.filter((binding) =>
        Object.keys(binding.schema.shape).some((key) =>
          wanted(projection, key),
        ),
      );
      const sources = rows.map((row) => ({
        row,
        source: sourceRecord.parse(row),
        identity: sourceIdentity.parse(row),
      }));
      const lookups = new Map<
        string,
        ReturnType<typeof lookupEntityReferences>
      >();
      const referenceWanted = (
        key: string,
        instruction: NonNullable<ListReadOptions<Row>["references"]>[string],
      ) =>
        instruction.kind === "lookup" &&
        [
          key,
          instruction.name,
          instruction.emoji,
          ...(instruction.consumers ?? []),
        ].some((output) => output !== undefined && wanted(projection, output));
      // Materialize only demanded to-one relation UUIDs; public values still go
      // through the same canonical resolver as stored foreign keys.
      await Promise.all(
        references.map(async (reference) => {
          if (!referenceWanted(reference.key, reference.instruction)) return;
          if (
            "via" in reference &&
            reference.via?.shape === "via" &&
            !reference.via.many &&
            reference.via.terminal.kind === "record" &&
            reference.target !== null
          ) {
            const related = await loadRelationProjection(
              db,
              entity,
              reference.via,
              reference.target,
              sources.map(({ identity }) => identity.id),
            );
            for (const { source, identity } of sources)
              source[reference.key] = related.get(identity.id) ?? null;
          } else if ("column" in reference && reference.column !== undefined) {
            for (const { source } of sources)
              if (!Object.hasOwn(source, reference.key))
                source[reference.key] = source[reference.column];
          }
        }),
      );
      const early =
        prefetched ??
        prefetch(
          db,
          sources.map(({ identity }) => identity.id),
          projection,
          qualitySource,
        );
      const [qualities, images, links] = await Promise.all([
        early.qualities,
        early.images,
        Promise.all(
          references.map(async (reference) => {
            const { instruction, key, target } = reference;
            if (
              instruction.kind !== "lookup" ||
              target === null ||
              ![
                key,
                instruction.name,
                instruction.emoji,
                ...(instruction.consumers ?? []),
              ].some(
                (output) => output !== undefined && wanted(projection, output),
              )
            )
              return undefined;
            const lookupKey = `${target}:${instruction.includeDeleted === true}`;
            let pending = lookups.get(lookupKey);
            if (!pending) {
              const keys = references
                .filter(
                  (candidate) =>
                    candidate.target === target &&
                    candidate.instruction.kind === "lookup" &&
                    (candidate.instruction.includeDeleted === true) ===
                      (instruction.includeDeleted === true) &&
                    referenceWanted(candidate.key, candidate.instruction),
                )
                .map((candidate) => candidate.key);
              pending = lookupEntityReferences(
                db,
                target,
                sources.flatMap(({ source }) =>
                  keys.map((key) => z.string().nullable().parse(source[key])),
                ),
                { includeDeleted: instruction.includeDeleted },
              );
              lookups.set(lookupKey, pending);
            }
            return pending;
          }),
        ),
        Promise.all(admitted.map((binding) => binding.prepare?.(page))),
      ]);
      const dateRanges = (model?.fields ?? []).flatMap((field) =>
        "dateRange" in field &&
        field.dateRange &&
        Object.hasOwn(schema.shape, field.key) &&
        !written.has(field.key) &&
        wanted(projection, field.key)
          ? [{ key: field.key, ...field.dateRange }]
          : [],
      );
      const mapped = await Promise.all(
        sources.map(async ({ row, source, identity }) => {
          const result: ListReadRow = {
            id: parseShortcodeFor(entity, identity.shortcode),
          };
          Object.assign(result, projectDateRanges(source, dateRanges));
          for (const [key, validator] of Object.entries(schema.shape)) {
            if (
              !wanted(projection, key) ||
              written.has(key) ||
              privateKeys.has(key) ||
              !Object.hasOwn(source, key)
            )
              continue;
            if (
              source[key] === undefined &&
              !(validator instanceof z.ZodOptional)
            )
              throw new Error(`Requested record field was not loaded: ${key}`);
            result[key] = validator.parse(source[key]);
          }
          for (const [index, { key, instruction }] of references.entries()) {
            if (instruction.kind === "public") {
              if (wanted(projection, key) && Object.hasOwn(source, key))
                result[key] = schema.shape[key].parse(source[key]);
              continue;
            }
            if (
              ![
                key,
                instruction.name,
                instruction.emoji,
                ...(instruction.consumers ?? []),
              ].some(
                (output) => output !== undefined && wanted(projection, output),
              )
            )
              continue;
            const raw = z.string().nullable().parse(source[key]);
            const linked = raw === null ? undefined : links[index]?.get(raw);
            if (!linked && raw !== null && instruction.missing === "error")
              throw new Error(
                `Missing required list reference: ${entity}.${key}`,
              );
            for (const [output, value] of [
              [key, linked?.id ?? null],
              [instruction.name, linked?.name ?? null],
              [instruction.emoji, linked?.emoji ?? null],
            ]) {
              if (typeof output === "string" && wanted(projection, output))
                result[output] = schema.shape[output].parse(value);
            }
          }
          const quality = isScored(entity)
            ? qualities?.get(parseEntityId(entity, identity.id))
            : undefined;
          if (qualities) result.dataQuality = quality;
          const referenceValues = new Map(
            references.map(({ key, instruction }, index) => [
              key,
              instruction.kind === "lookup" && typeof source[key] === "string"
                ? links[index]?.get(source[key])
                : undefined,
            ]),
          );
          const valueContext: ListReadValueContext = {
            projection,
            context,
            quality,
            displayImages: images
              ? (images.get(entityRefKey(entity, identity.id)) ?? [])
              : undefined,
            references: referenceValues,
          };
          for (const binding of admitted) {
            const value = sourceRecord.parse(
              await binding.value(row, page, valueContext),
            );
            for (const key of Object.keys(binding.schema.shape)) {
              if (
                !Object.hasOwn(value, key) ||
                (value[key] === undefined &&
                  !(binding.schema.shape[key] instanceof z.ZodOptional))
              )
                throw new Error(
                  `Requested record field was not loaded: ${key}`,
                );
            }
            const parsed = sourceRecord.parse(
              binding.schema.strict().parse(value),
            );
            for (const [key, field] of Object.entries(parsed))
              if (wanted(projection, key))
                result[key] = schema.shape[key].parse(field);
          }
          attachDisplayImages(result, images, identity.id, projection);
          // Required requested outputs must exist before any schema defaults run.
          const requested =
            projection.kind === "selected"
              ? projection.fields
              : projection.kind === "base"
                ? []
                : Object.keys(schema.shape);
          for (const key of requested)
            if (
              key !== "displayImages" &&
              (!Object.hasOwn(result, key) || result[key] === undefined) &&
              !(schema.shape[key] instanceof z.ZodOptional)
            )
              throw new Error(`Requested record field was not loaded: ${key}`);
          return { id: identity.id, value: result };
        }),
      );
      const completed = images
        ? await withDisplayImages(
            db,
            entity,
            mapped,
            (row) => row.value,
            images,
          )
        : mapped.map((row) => row.value);
      return projectListRows(entity, completed, projection);
    },
  };
}

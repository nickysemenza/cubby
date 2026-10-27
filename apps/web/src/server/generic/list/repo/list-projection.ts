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
import {
  entityManifest,
  entityMembership,
  shortcodeEntities,
} from "@cubby/schemas/entity-manifest";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { z } from "zod";

import type { ListEntity } from "~/entity/generated/entity-lists.gen";
import type { ListReadRow } from "~/entity/model/list-read-fields";
import type { Database, DrizzleTransaction } from "~/server/db";
import { inheritedFieldOfColumn } from "~/server/db/computed/effective-field";
import {
  resolveEntityDisplayMedia,
  type EntityDisplayMedia,
  withDisplayImages,
} from "~/server/entity-kernel/repo/entity-display-image";
import { loadDataQualities } from "~/server/generic/data-quality/repo/hydrate";
import { loadStoredFieldProjections } from "~/server/generic/derived/repo/read";
import type { PageStoredMeta } from "~/server/generic/derived/repo/read-context";
import type { ListProjection } from "~/server/generic/list/repo/list-contracts";
import {
  listReadSchema,
  projectListRows,
} from "~/server/generic/list/repo/list-read-schema";
import { lookupEntityReferences } from "~/server/generic/shortcode/repo/shortcode-resolver";

import { ListContext, derivedFieldsOf } from "./field-compiler";
import { loadRelationProjection } from "./relation-projection";

/** Validate explicit field demand before reading even an empty page. */
export function selectedListProjection(
  entity: ListEntity,
  requested: readonly string[],
): ListProjection {
  const schema = listReadSchema(entity);
  for (const field of requested)
    if (!(field in schema.shape))
      throw new Error(`Unknown list field: ${entity}.${field}`);
  return [...new Set(requested)];
}

const scored = entityMembership(scoredEntities);
const isScored = (entity: string): entity is ScoredEntity => scored.has(entity);

type ListIdPage = {
  db: Database | DrizzleTransaction;
  ids: readonly string[];
  projection: ListProjection;
  /** The request's context: its reader (actor, clients) and prepares. */
  context: ListContext;
  stored?: Promise<PageStoredMeta>;
};

/** Id-only page loads started before the rows arrive; see `prefetch`. */
export type ListPagePrefetch = {
  page: ListIdPage;
  qualities?: ReturnType<typeof loadDataQualities>;
  media?: Promise<EntityDisplayMedia>;
};

export type ListReadValueContext = {
  projection: ListProjection;
  context: ListContext;
  quality: DataQuality | undefined;
  displayImages: DisplayImageSummary[] | undefined;
};
type ListReadPage<Row> = {
  idPage: ListIdPage;
  db: Database | DrizzleTransaction;
  rows: Row[];
  projection: ListProjection;
  context: ListContext;
};
type ListReadBinding<Row> = {
  schema: z.ZodObject;
  scope?: "detail";
  prefetch?: (page: ListIdPage) => Promise<void>;
  prepare?: (page: ListReadPage<Row>) => Promise<void>;
  value: (
    row: Row,
    page: ListReadPage<Row>,
    context: ListReadValueContext,
  ) => Promise<object> | object;
};
type ListBatch<Row, Page, Loaded> = {
  load: (page: Page) => Promise<Loaded>;
  fields: <Fields extends z.ZodRawShape>(
    schema: z.ZodObject<Fields>,
    value: (
      row: Row,
      loaded: Loaded,
      context: ListReadValueContext,
    ) => z.output<z.ZodObject<Fields>>,
    options?: BindingOptions,
  ) => ListReadBinding<Row>;
};
/** `scope: "detail"`: a page omits these keys unless a projection names them. */
type BindingOptions = { scope?: "detail" };
type BindListFields<Row> = {
  <Fields extends z.ZodRawShape>(
    schema: z.ZodObject<Fields>,
    value: (
      row: Row,
      context: ListReadValueContext,
    ) => z.output<z.ZodObject<Fields>>,
    options?: BindingOptions,
  ): ListReadBinding<Row>;
  batch: <Loaded>(
    load: (page: ListReadPage<Row>) => Promise<Loaded>,
  ) => ListBatch<Row, ListReadPage<Row>, Loaded>;
  ids: <Loaded>(
    load: (page: ListIdPage) => Promise<Loaded>,
  ) => ListBatch<Row, ListIdPage, Loaded>;
};
export type ListReadOptions<Row> = {
  media?: boolean;
  /** A page's media may belong to a polymorphic subject rather than its row. */
  displayImages?: (
    db: Database | DrizzleTransaction,
    ids: readonly string[],
  ) => Promise<Map<string, DisplayImageSummary[]>>;
  references?: Record<
    string,
    | { kind: "public" }
    | {
        kind: "lookup";
        name?: string;
        emoji?: string;
        missing: "null" | "error";
        includeDeleted?: boolean;
      }
  >;
  bindings?: (bind: BindListFields<Row>) => readonly ListReadBinding<Row>[];
};

const sourceRecord = z.record(z.string(), z.unknown());

/** The read keys the plan resolves through the canonical display-media query. */
const displayMediaFields = ["displayImages", "images", "labelImages"];

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
  const batch = <Page extends object, Loaded>(
    load: (page: Page) => Promise<Loaded>,
    pageOf: (page: ListReadPage<Row>) => Page,
    prefetchPage?: (page: ListIdPage) => Page,
  ): ListBatch<Row, Page, Loaded> => {
    const memo = new WeakMap<Page, Promise<Loaded>>();
    const get = (page: Page): Promise<Loaded> => {
      let loaded = memo.get(page);
      if (loaded === undefined) {
        loaded = load(page);
        memo.set(page, loaded);
      }
      return loaded;
    };
    return {
      load: get,
      fields: (picked, value, bindingOptions) => ({
        schema: picked,
        scope: bindingOptions?.scope,
        prefetch: prefetchPage
          ? async (page) => {
              await get(prefetchPage(page));
            }
          : undefined,
        prepare: async (page) => {
          await get(pageOf(page));
        },
        value: async (row, page, context) =>
          value(row, await get(pageOf(page)), context),
      }),
    };
  };
  const bind: BindListFields<Row> = Object.assign(
    <Fields extends z.ZodRawShape>(
      picked: z.ZodObject<Fields>,
      value: (
        row: Row,
        context: ListReadValueContext,
      ) => z.output<z.ZodObject<Fields>>,
      bindingOptions?: BindingOptions,
    ): ListReadBinding<Row> => ({
      schema: picked,
      scope: bindingOptions?.scope,
      value: (row, _page, context) => value(row, context),
    }),
    {
      batch: <Loaded>(load: (page: ListReadPage<Row>) => Promise<Loaded>) =>
        batch(load, (page) => page),
      ids: <Loaded>(load: (page: ListIdPage) => Promise<Loaded>) =>
        batch(
          load,
          (page) => page.idPage,
          (page) => page,
        ),
    },
  );
  const modelFields: EntityFieldModel["fields"] =
    entityFieldModels[entity].fields;
  const projections = modelFields.filter(
    (field) =>
      field.storedPath &&
      !field.storedProjection &&
      Object.hasOwn(schema.shape, field.readKey ?? field.key),
  );
  const resultBindings = projections.length
    ? [
        bind
          .batch(({ db, idPage }) =>
            loadStoredFieldProjections(db, entity, idPage.ids, idPage.stored),
          )
          .fields(
            z.object(
              Object.fromEntries(
                projections.map((field) => [
                  field.readKey ?? field.key,
                  schema.shape[field.readKey ?? field.key],
                ]),
              ),
            ),
            (row, loaded) =>
              Object.fromEntries(
                projections.map((field) => {
                  const key = field.readKey ?? field.key;
                  return [
                    key,
                    loaded.get(sourceIdentity.parse(row).id)?.[key] ?? null,
                  ];
                }),
              ),
          ),
      ]
    : [];
  const bindings = [...resultBindings, ...(options.bindings?.(bind) ?? [])];
  const written = new Set<string>(["id", "dataQuality", "displayImages"]);
  // A key may have one page writer and one detail-scoped writer: the record
  // read takes the richer detail value, a page keeps its own.
  const overridden = new Set<string>();
  const claim = (key: string, scope?: "detail") => {
    if (!Object.hasOwn(schema.shape, key))
      throw new Error(`Unknown list binding field: ${entity}.${key}`);
    if (written.has(key)) {
      const writers = bindings.filter((binding) =>
        Object.hasOwn(binding.schema.shape, key),
      );
      if (
        scope === "detail" &&
        !overridden.has(key) &&
        writers.length === 2 &&
        writers.filter((binding) => binding.scope === "detail").length === 1
      ) {
        overridden.add(key);
        return;
      }
      throw new Error(`Multiple list binding writers: ${entity}.${key}`);
    }
    written.add(key);
  };
  // Page writers claim and run first, so a detail writer of the same key
  // overrides.
  const ordered = [...bindings].sort(
    (left, right) =>
      Number(left.scope === "detail") - Number(right.scope === "detail"),
  );
  for (const binding of ordered)
    for (const key of Object.keys(binding.schema.shape))
      claim(key, binding.scope);
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
    return {
      key,
      instruction,
      target,
      column: stored?.column ?? key,
      via: derived[declared?.key ?? key],
    };
  });
  const wanted = (projection: ListProjection, key: string): boolean =>
    projection.includes(key) ||
    (key === "storedProjectionVersions" &&
      modelFields.some(
        (field) =>
          field.storedProjection &&
          projection.includes(field.readKey ?? field.key),
      ));
  const validate = (projection: ListProjection) => {
    selectedListProjection(entity, projection);
  };
  // A detail-scoped binding is expensive per row: a single-record read loads
  // it, a page loads it only when a projection names its keys.
  const detailOnly = new Set(
    bindings.flatMap((binding) =>
      binding.scope === "detail"
        ? Object.keys(binding.schema.shape).filter(
            (key) => !overridden.has(key),
          )
        : [],
    ),
  );
  /** The bindings a read runs: a page skips detail overrides of its keys. */
  const scoped = (scope: "list" | "detail") =>
    scope === "detail"
      ? ordered
      : ordered.filter(
          (binding) =>
            binding.scope !== "detail" ||
            !Object.keys(binding.schema.shape).some((key) =>
              overridden.has(key),
            ),
        );
  const fields = {
    detail: Object.keys(schema.shape),
    list: Object.keys(schema.shape).filter((key) => !detailOnly.has(key)),
  } as const;
  /**
   * The page loads that need only row ids. The scaffold starts them as soon
   * as the page's ids are known, so they share a round trip with the row
   * load instead of waiting for it.
   */
  // Entities without bespoke media still publish `displayImages`; resolving
  // them here from internal ids spares the kernel's shortcode-then-images
  // pass two sequential round trips per page.
  const resolvesDisplayImages = (projection: ListProjection) =>
    displayMediaFields.some(
      (key) => Object.hasOwn(schema.shape, key) && wanted(projection, key),
    );
  /** Non-media entities take the plan-resolved images; media bindings own theirs. */
  const attachDisplayImages = (
    result: ListReadRow,
    images: ReadonlyMap<string, DisplayImageSummary[]> | undefined,
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
    scope: "list" | "detail" = "list",
    context = ListContext.empty,
  ): ListPagePrefetch => {
    const page = { db, ids, projection, context };
    const settled = <V>(promise: Promise<V>) => {
      promise.catch(() => {
        // SILENT: `read` awaits and surfaces this rejection; only a page
        // abandoned before hydration (its row load failed) drops it.
      });
      return promise;
    };
    if (ids.length)
      for (const binding of scoped(scope))
        if (
          binding.prefetch &&
          Object.keys(binding.schema.shape).some((key) =>
            wanted(projection, key),
          )
        )
          settled(binding.prefetch(page));
    return {
      page,
      qualities:
        isScored(entity) && wanted(projection, "dataQuality") && ids.length
          ? settled(
              loadDataQualities(
                db,
                entity,
                ids.map((id) => parseEntityId(entity, id)),
                qualitySource,
              ),
            )
          : undefined,
      media:
        resolvesDisplayImages(projection) && ids.length
          ? settled(
              options.displayImages
                ? options.displayImages(db, ids).then((displayImages) => ({
                    displayImages,
                    representations: new Map(),
                  }))
                : resolveEntityDisplayMedia(
                    db,
                    ids.map((id) => ({ entityKind: entity, entityId: id })),
                    {
                      attachments:
                        entityManifest[entity].imageStorage !== false &&
                        ["images", "labelImages"].some(
                          (key) =>
                            Object.hasOwn(schema.shape, key) &&
                            wanted(projection, key),
                        ),
                    },
                  ),
            )
          : undefined,
    };
  };
  /**
   * Read-schema keys that nothing in this plan, nor a row key in `rowKeys`,
   * loads. `rowKeys` is undefined when the rows come from a custom `load`
   * whose keys the plan cannot see; then the check is skipped.
   */
  const unloaded = (rowKeys: ReadonlySet<string> | undefined): string[] => {
    if (rowKeys === undefined) return [];
    const loaded = new Set<string>([
      ...written,
      // The page envelope and the tree scope attach these after the plan;
      // stored-projection versions are optional metadata the envelope reads
      // only when an entity's binding supplies them.
      "fieldResolutions",
      "childCount",
      "storedProjectionVersions",
      ...references.flatMap(({ key, column }) => [key, column ?? key]),
      ...(model?.fields ?? []).flatMap((field) =>
        "dateRange" in field && field.dateRange ? [field.key] : [],
      ),
    ]);
    return Object.keys(schema.shape).filter(
      (key) => !loaded.has(key) && !rowKeys.has(key),
    );
  };
  return {
    fields,
    unloaded,
    validate,
    prefetch,
    async read(
      db: Database | DrizzleTransaction,
      rows: readonly Row[],
      projection: ListProjection,
      context = ListContext.empty,
      qualitySource: "stored" | "live" = "stored",
      prefetched?: ListPagePrefetch,
      scope: "list" | "detail" = "list",
    ): Promise<ListReadRow[]> {
      validate(projection);
      if (!rows.length) return [];
      const sources = rows.map((row) => ({
        row,
        source: sourceRecord.parse(row),
        identity: sourceIdentity.parse(row),
      }));
      const early =
        prefetched ??
        prefetch(
          db,
          sources.map(({ identity }) => identity.id),
          projection,
          qualitySource,
          scope,
          context,
        );
      const page: ListReadPage<Row> = {
        idPage: early.page,
        db,
        rows: [...rows],
        projection,
        context,
      };
      // Detail overrides run after page writers, so their value wins.
      const admitted = scoped(scope).filter((binding) =>
        Object.keys(binding.schema.shape).some((key) =>
          wanted(projection, key),
        ),
      );
      const lookups = new Map<
        string,
        ReturnType<typeof lookupEntityReferences>
      >();
      const referenceWanted = (
        key: string,
        instruction: NonNullable<ListReadOptions<Row>["references"]>[string],
      ) =>
        instruction.kind === "lookup" &&
        [key, instruction.name, instruction.emoji].some(
          (output) => output !== undefined && wanted(projection, output),
        );
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
      const [qualities, media, links] = await Promise.all([
        early.qualities,
        early.media,
        Promise.all(
          references.map(async (reference) => {
            const { instruction, key, target } = reference;
            if (
              instruction.kind !== "lookup" ||
              target === null ||
              ![key, instruction.name, instruction.emoji].some(
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
      const images = media?.displayImages;
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
              ![key, instruction.name, instruction.emoji].some(
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
          const valueContext: ListReadValueContext = {
            projection,
            context,
            quality,
            displayImages: images
              ? (images.get(entityRefKey(entity, identity.id)) ?? [])
              : undefined,
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
          for (const key of projection)
            if (
              key !== "displayImages" &&
              (!Object.hasOwn(result, key) || result[key] === undefined) &&
              !(schema.shape[key] instanceof z.ZodOptional)
            )
              throw new Error(`Requested record field was not loaded: ${key}`);
          return { id: identity.id, value: result };
        }),
      );
      const completed = media
        ? await withDisplayImages(db, entity, mapped, (row) => row.value, media)
        : mapped.map((row) => row.value);
      return projectListRows(entity, completed, projection);
    },
  };
}

import { z } from "zod";
import {
  dataQualityCheckKind,
  dataQualityFacetName,
} from "../data-quality-facets";
import { photoCategoryKeys } from "../photo-categories";

/** The scalar shapes the entity compiler can persist and project. */
export const entityFieldKinds = [
  "text",
  "text-array",
  "number",
  "boolean",
  "date",
  "timestamp",
  "enum",
  "json",
  "identifier",
] as const;
export type EntityFieldKind = (typeof entityFieldKinds)[number];

/** Controls that a declaration may expose to generic entity editing. */
export const entityFieldControlKinds = [
  "text",
  "textarea",
  "checkbox",
  "select",
  "date",
  "number",
  "specialized",
] as const;
export type EntityFieldControlKind = (typeof entityFieldControlKinds)[number];

/** Database-default strategies supported by declared storage columns. */
const entityStorageDefaultKinds = [
  "none",
  "generated",
  "now",
  "literal",
] as const;
export type EntityStorageDefaultKind =
  (typeof entityStorageDefaultKinds)[number];

/**
 * The five wayfinding lines. Declared here so `presentation.domain` is a
 * closed vocabulary the browser shell and the native app both derive from.
 */
export const WAYFINDING_DOMAINS = [
  "cook",
  "pantry",
  "plan",
  "house",
  "finance",
] as const;
export type WayfindingDomain = (typeof WAYFINDING_DOMAINS)[number];

/**
 * The closed vocabulary of table-filter shapes. Schema-free (unlike most of
 * this file) so `compile.ts`, the web `FilterKind` type, and the Swift
 * catalog generator can all read the same list without importing each other.
 */
export const FILTER_KINDS = [
  "text",
  "select",
  "multiselect",
  "presence",
  "boolean",
  "id",
  "idMulti",
  "range",
] as const;
export type FilterKind = (typeof FILTER_KINDS)[number];
export type EntityPresentation = z.output<
  ReturnType<typeof metadataSchemas>["presentation"]
>;
type EntityListTimeline = NonNullable<EntityPresentation["list"]["timeline"]>;
type EntityTimelineLifecycle = NonNullable<EntityListTimeline["lifecycle"]>;

/**
 * `presentation` as the compiler emits it: the two hero defaults that depend
 * on other declaration facts (`images` on the gallery capability, `actions`
 * on the update contract) are resolved, so both renderers read one shape.
 * `list.timeline.lifecycle.start` is normalised to an ordered array — a
 * declared single key becomes a one-element array — so every consumer reads
 * one shape regardless of how the declaration spelled it.
 */
export type CompiledEntityPresentation = Omit<
  EntityPresentation,
  "detail" | "list"
> & {
  detail: Omit<EntityPresentation["detail"], "hero" | "sections"> & {
    sections: NonNullable<EntityPresentation["detail"]["sections"]>;
    hero: Omit<EntityPresentation["detail"]["hero"], "images" | "actions"> & {
      images: boolean;
      actions: readonly string[];
    };
  };
  list: Omit<EntityPresentation["list"], "timeline" | "shelf" | "actions"> & {
    actions: readonly string[];
    /**
     * Every compiled list has a card presentation. Declarations may refine its
     * caption, while the compiler supplies a mobile-subtitle fallback.
     */
    shelf: { subtitle: readonly string[] };
    timeline:
      | (Omit<EntityListTimeline, "lifecycle"> & {
          lifecycle:
            | (Omit<EntityTimelineLifecycle, "start"> & {
                /** Ordered fallback: the first key with a non-null value starts the interval. */
                start: readonly string[];
              })
            | null;
        })
      | null;
  };
};
export type EntityDetailSection = NonNullable<
  EntityPresentation["detail"]["sections"]
>[number];
export type EntityListView = EntityPresentation["list"]["views"][number];
export type EntitySlotListView = Exclude<EntityListView, string>;

/** Shared labels for the list presentation control on every platform. */
export const LIST_PRESENTATION_CHOICES = [
  { id: "table", view: "table", label: "List" },
  { id: "shelf", view: "shelf", label: "Cards" },
  // Compact is a local density of Cards, not a URL view.
  { id: "compact", view: "shelf", label: "Compact" },
] as const;

export const listPresentationLabel = (id: string): string | null =>
  LIST_PRESENTATION_CHOICES.find((choice) => choice.id === id)?.label ?? null;

/** The three built-in renderers; every other view is a slot. */
export const BUILT_IN_LIST_VIEWS = ["table", "shelf", "timeline"] as const;
export const isSlotListView = (
  view: EntityListView,
): view is EntitySlotListView =>
  !BUILT_IN_LIST_VIEWS.some((builtIn) => builtIn === view);
/** The id a view is addressed by in `?view=`. */
export const listViewId = (view: EntityListView): string =>
  isSlotListView(view) ? view.id : view;

/**
 * Executable entity declarations deliberately carry Zod instances.  This
 * schema validates the surrounding serializable metadata without parsing,
 * cloning, or reconstructing those instances, so defaults and refinements
 * continue to belong to their declaration modules.
 */
const metadataSchemas = () => {
  const declaredZodSchema = z.instanceof(z.ZodType, {
    error: "must be a Zod schema",
  });

  const nonEmptyString = (message = "must be a non-empty string") =>
    z.string({ error: message }).min(1, { error: message });

  const entityFieldValidationMetadataSchema = z
    .object({
      read: declaredZodSchema.nullable().optional().default(null),
      create: declaredZodSchema.nullable().optional().default(null),
      update: declaredZodSchema.nullable().optional().default(null),
    })
    .strict();

  const entityFieldReferenceMetadataSchema = z
    .object({
      entity: nonEmptyString(),
      multiple: z
        .boolean({ error: "must be a boolean" })
        .optional()
        .default(false),
      /**
       * Values from the owning record that constrain a dependent reference
       * picker.  `sourceField` is read from the editor form and `targetField`
       * is the corresponding field/filter on the referenced entity.
       */
      scope: z
        .array(
          z
            .object({
              sourceField: nonEmptyString(),
              targetField: nonEmptyString(),
            })
            .strict(),
        )
        .optional()
        .default([]),
      filters: z
        .array(
          z.strictObject({
            field: nonEmptyString(),
            values: z.array(nonEmptyString()).min(1),
          }),
        )
        .optional()
        .default([]),
    })
    .strict();

  const entityFieldControlMetadataSchema = z
    .object({
      kind: z.enum(entityFieldControlKinds),
      renderer: nonEmptyString().nullable().optional().default(null),
      options: z
        .array(
          z
            .object({
              value: nonEmptyString(),
              label: nonEmptyString(),
              /** What choosing this option means, shown where it is displayed. */
              description: nonEmptyString().optional(),
            })
            .strict(),
        )
        .nullable()
        .optional()
        .default(null),
      sectionOverride: nonEmptyString().optional().default("main"),
      /** A short field the generic editor pairs with the next consecutive
       * `"half"` field on one row (`SideBySideFields`), instead of the
       * default full-width control. */
      width: z.literal("half").nullable().optional().default(null),
      /** Editor placeholder text, generic-editor only. */
      placeholder: nonEmptyString().nullable().optional().default(null),
      /**
       * A create-only initial value the generic editor derives at draft time
       * instead of from the field's record/schema default. `"today"` is the
       * only member today (the household's local calendar date).
       */
      initial: z.literal("today").nullable().optional().default(null),
      /**
       * A field whose value the decision tier (Jev) infers from the named
       * sibling fields (`basis`, model field keys of the same entity). The
       * browser editor auto-fills it while untouched and offers a one-tap
       * apply once a value already exists.
       *
       * `mode: "fill"` (default) proposes a value for an enum, singular
       * reference, or nullable text target. `mode: "prune"` targets a
       * text-array and proposes *removals* — entries that restate sibling
       * fields; the target itself is then an implicit basis (its current
       * entries are the thing being judged), which the compiler allows only
       * for prune.
       */
      suggest: z
        .object({
          basis: z.array(nonEmptyString()).min(1),
          mode: z.enum(["fill", "prune"]).optional().default("fill"),
        })
        .strict()
        .nullable()
        .optional()
        .default(null),
    })
    .strict()
    .transform(
      ({
        kind,
        renderer,
        options,
        sectionOverride,
        width,
        placeholder,
        initial,
        suggest,
      }) => ({
        kind,
        renderer,
        options,
        section: sectionOverride,
        width,
        placeholder,
        initial,
        suggest,
      }),
    );

  const entityFieldDisplayMetadataSchema = z
    .object({
      list: z.boolean({ error: "must be a boolean" }).optional().default(false),
      detail: z
        .boolean({ error: "must be a boolean" })
        .optional()
        .default(false),
      columnIdOverride: nonEmptyString().nullable().optional().default(null),
      standard: z.enum(["name", "image"]).nullable().optional().default(null),
      detailOrderOverride: z
        .number()
        .int()
        .nonnegative()
        .nullable()
        .optional()
        .default(null),
      /**
       * Orders generated list columns independently of model order (which
       * also drives form field order, so it cannot be re-sequenced). Ordered
       * columns come first, ascending; the rest keep model order.
       */
      listOrderOverride: z
        .number()
        .int()
        .nonnegative()
        .nullable()
        .optional()
        .default(null),
      /** List column width bucket; the shared table maps it to a class. */
      width: z
        .enum(["xs", "sm", "md", "lg"])
        .nullable()
        .optional()
        .default(null),
      /** List cell formatter chosen by the shared column compiler. */
      format: z
        .enum([
          "currency",
          "signedCurrency",
          "plainDate",
          "timestamp",
          "external-link",
          "amount",
        ])
        .nullable()
        .optional()
        .default(null),
      /**
       * Semantic renderer ids for values whose presentation cannot be derived
       * from kind/reference/format alone. The manifest chooses the renderer;
       * each platform keeps the executable component in its typed registry.
       */
      renderer: z
        .object({
          list: nonEmptyString().nullable().optional().default(null),
          detail: nonEmptyString().nullable().optional().default(null),
        })
        .strict()
        .nullable()
        .optional()
        .default(null),
      /** Mobile card placement for the list column. */
      mobile: z
        .object({
          slot: nonEmptyString(),
          priority: z.number().int().nonnegative(),
          interactive: z.boolean({ error: "must be a boolean" }).optional(),
        })
        .strict()
        .nullable()
        .optional()
        .default(null),
      /**
       * Hidden by default in the generated column's initial visibility, but
       * still toggleable via the View menu — the one per-field fact the old
       * per-page `initialColumnVisibility` literal actually carried; everything
       * else in those objects was a plain columnId echo of `display.list`.
       */
      listHidden: z
        .boolean({ error: "must be a boolean" })
        .optional()
        .default(false),
    })
    .strict()
    .transform(
      ({
        list,
        detail,
        columnIdOverride,
        standard,
        detailOrderOverride,
        listOrderOverride,
        width,
        format,
        renderer,
        mobile,
        listHidden,
      }) => ({
        list,
        detail,
        columnId: columnIdOverride,
        standard,
        detailOrder: detailOrderOverride,
        listOrder: listOrderOverride,
        width,
        format,
        renderer,
        mobile,
        listHidden,
      }),
    );

  const entityFieldProvenanceSourceMetadataSchema = z.union([
    z
      .object({
        entity: nonEmptyString(),
        relation: nonEmptyString().nullable().optional().default(null),
      })
      .strict(),
    z.object({ label: nonEmptyString() }).strict(),
  ]);

  const entityFieldProvenanceMetadataSchema = z
    .object({
      kind: z.enum(["relation", "derived"]),
      sources: z.array(entityFieldProvenanceSourceMetadataSchema).min(1),
    })
    .strict();

  const entityFieldMetadataSchema = z
    .object({
      key: nonEmptyString(),
      kind: z.enum(entityFieldKinds),
      nullable: z
        .boolean({ error: "must be a boolean" })
        .optional()
        .default(false),
      labelOverride: nonEmptyString().optional(),
      description: nonEmptyString().nullable().optional().default(null),
      readKeyOverride: nonEmptyString().nullable().optional(),
      reference: entityFieldReferenceMetadataSchema
        .nullable()
        .optional()
        .default(null),
      provenance: entityFieldProvenanceMetadataSchema
        .nullable()
        .optional()
        .default(null),
      explanation: z
        .strictObject({
          ruleId: nonEmptyString(),
          version: z.number().int().positive().default(1),
          description: nonEmptyString(),
          readPath: nonEmptyString().optional(),
          resolver: z
            .enum([
              "field",
              "inventoryOwnership",
              "productValuation",
              "imageRepresentation",
              "imageCapture",
              "productQuantity",
              "recipeTotals",
              "locationValuation",
              "merchantVendorInference",
              "expenseAttribution",
            ])
            .default("field"),
          projections: z
            .strictObject({
              list: nonEmptyString().optional(),
              detail: nonEmptyString().optional(),
              summary: nonEmptyString().optional(),
            })
            .optional(),
          sourceDependencies: z
            .array(
              z.strictObject({
                path: nonEmptyString(),
                label: nonEmptyString(),
              }),
            )
            .optional(),
          actions: z
            .array(z.enum(["confirmOwner", "inheritOwner", "editSource"]))
            .optional(),
        })
        .nullable()
        .optional()
        .default(null),
      /** Declarative assignment semantics for fields whose effective read value
       * may differ from stored intent. UI cleanup actions execute these exact
       * ordinary update patches; repositories remain the authority that
       * computes `fieldResolutions`. */
      resolution: z
        .strictObject({
          reset: z.record(z.string(), z.json()),
          none: z
            .record(z.string(), z.json())
            .nullable()
            .optional()
            .default(null),
          redundancy: z.enum(["eligible", "intentional"]).default("eligible"),
        })
        .nullable()
        .optional()
        .default(null),
      control: entityFieldControlMetadataSchema
        .nullable()
        .optional()
        .default(null),
      display: entityFieldDisplayMetadataSchema.prefault({}),
      validation: entityFieldValidationMetadataSchema.prefault({}),
    })
    .strict()
    .transform(
      ({
        key,
        kind,
        nullable,
        labelOverride,
        description,
        readKeyOverride,
        ...field
      }) => ({
        key,
        kind,
        nullable,
        label: labelOverride,
        description,
        readKey: readKeyOverride,
        ...field,
      }),
    );

  const entityStorageMetadataSchema = z.union([
    nonEmptyString().transform((key) => ({
      key,
      column: undefined,
      kind: undefined,
      nullable: undefined,
      default: undefined,
      defaultValue: undefined,
      reference: undefined,
      specialized: undefined,
    })),
    z
      .object({
        key: nonEmptyString(),
        columnOverride: nonEmptyString().optional(),
        kindOverride: z.enum(entityFieldKinds).optional(),
        nullableOverride: z.boolean({ error: "must be a boolean" }).optional(),
        defaultOverride: z.enum(entityStorageDefaultKinds).optional(),
        defaultValue: z
          .union([z.string(), z.number(), z.boolean(), z.null()])
          .optional(),
        reference: nonEmptyString().nullable().optional(),
        specialized: nonEmptyString().nullable().optional(),
      })
      .strict()
      .transform(
        ({
          key,
          columnOverride,
          kindOverride,
          nullableOverride,
          defaultOverride,
          defaultValue,
          reference,
          specialized,
        }) => ({
          key,
          column: columnOverride,
          kind: kindOverride,
          nullable: nullableOverride,
          default: defaultOverride,
          defaultValue,
          reference,
          specialized,
        }),
      ),
  ]);

  const entityFieldModelSortMetadataSchema = z
    .object({
      fields: z.array(nonEmptyString()).min(1),
      /** Defaults to `createdAt` when sortable, otherwise the first field. */
      defaultOverride: nonEmptyString().optional(),
      computed: z.array(nonEmptyString()).optional().default([]),
      groupable: z.array(nonEmptyString()).optional().default([]),
      /** Text and enum defaults open ascending; other fields open descending. */
      directionOverride: z.enum(["asc", "desc"]).optional(),
    })
    .strict()
    .transform(({ defaultOverride, directionOverride, ...sort }) => ({
      ...sort,
      default: defaultOverride,
      direction: directionOverride,
    }));

  /**
   * Editing intents: named field fragments the browser editor exposes, plus
   * the ordered intent names each operation accepts (the first is the
   * default). `editorFields` lists editor-only pseudo fields (for example a
   * flattened discriminated identity) that intents may name without a model
   * field.
   */
  const entityFieldModelIntentsMetadataSchema = z
    .object({
      fields: z.record(nonEmptyString(), z.array(nonEmptyString()).min(1)),
      create: z.array(nonEmptyString()).min(1),
      update: z.array(nonEmptyString()).min(1),
      editorFields: z.array(nonEmptyString()).optional().default([]),
    })
    .strict();

  const entityFieldModelMetadataSchema = z
    .object({
      fields: z.array(entityFieldMetadataSchema),
      storage: z.array(entityStorageMetadataSchema),
      create: z.array(nonEmptyString()),
      update: z.array(nonEmptyString()),
      output: z.array(nonEmptyString()),
      bulk: z.array(nonEmptyString()),
      audit: z.array(nonEmptyString()),
      sort: entityFieldModelSortMetadataSchema.optional(),
      intents: entityFieldModelIntentsMetadataSchema.optional(),
    })
    .strict();

  const sourceRefMetadataSchema = z
    .object({ module: nonEmptyString(), export: nonEmptyString() })
    .strict();

  /**
   * Browser route ownership. `list` / `detail` `true` generates the page
   * module (`routes/_authenticated/<basePath>.index.tsx` / `.$<detailParam>.tsx`)
   * over the generic list/detail renderers; `null` keeps that file
   * hand-written. `detail.query` is `(shortcode: string) => queryOptions` for
   * an entity outside the kernel detail roster (image). `create` is how a
   * record is made from the list: a create contract and capture intent infer
   * `"dialog"`, putting `?create=true` in the list's search schema.
   * `createOverride: "page"` links a hand-written `<basePath>.new.tsx` as
   * `routes.new`; `createOverride: null` omits the generic entry point.
   */
  const entityRouteMetadataSchema = z
    .object({
      basePath: nonEmptyString(),
      detailParamOverride: nonEmptyString().optional(),
      /** Replaces the capture-dialog default; null opts out. */
      createOverride: z.enum(["dialog", "page"]).nullable().optional(),
      /** A routed entity gets the generated list unless explicitly replaced. */
      listOverride: z.literal(true).nullable().optional(),
      /** A routed entity gets the generated detail unless explicitly replaced. */
      detailOverride: z
        .union([
          z.literal(true),
          z.object({ query: sourceRefMetadataSchema }).strict(),
        ])
        .nullable()
        .optional(),
    })
    .strict()
    .transform(
      ({
        basePath,
        detailParamOverride,
        createOverride,
        listOverride,
        detailOverride,
      }) => ({
        basePath,
        detailParam: detailParamOverride,
        create: createOverride,
        list: listOverride === undefined ? true : listOverride,
        detail: detailOverride === undefined ? true : detailOverride,
      }),
    );

  const entityIdentifiersMetadataSchema = z
    .object({
      brand: nonEmptyString().nullable(),
      shortcode: nonEmptyString().nullable(),
    })
    .strict();

  const fieldKey = nonEmptyString("must name a declared field");
  const actionKey = nonEmptyString("must name an action verb");
  const sectionId = z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/u, { error: "must be a kebab-case id" });
  const sectionPlacement = z
    .enum(["primary", "supporting", "full"])
    .optional()
    .default("primary");
  const sectionBase = {
    id: sectionId,
    title: nonEmptyString(),
    placement: sectionPlacement,
    collapsed: z
      .boolean({ error: "must be a boolean" })
      .optional()
      .default(false),
  };
  /**
   * One detail section. `fields` names every `display.detail` field exactly
   * once across the sections; `relation` renders the target entity's list
   * filtered by the named descriptor against this record; `timeline` mounts
   * the entity's timeline capability; `slot` is the one per-platform
   * hand-written fill, rendered only where a registry provides it.
   */
  const detailSectionSchema = z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("fields"),
        ...sectionBase,
        fields: z.array(fieldKey).min(1),
      })
      .strict(),
    z
      .object({
        kind: z.literal("relation"),
        ...sectionBase,
        relation: nonEmptyString("must name a declared relation"),
        filter: z.object({ descriptor: nonEmptyString() }).strict(),
        columns: z
          .array(nonEmptyString())
          .min(1)
          .nullable()
          .optional()
          .default(null),
        /** Explicit create-field prefill for relation sections whose target
         * reference is not named by the target filter descriptor (including
         * multiple-reference fields such as `plantingIds`). */
        prefill: z
          .object({
            field: fieldKey,
          })
          .strict()
          .nullable()
          .optional()
          .default(null),
        sort: z
          .object({
            field: nonEmptyString(),
            direction: z.enum(["asc", "desc"]),
          })
          .strict()
          .nullable()
          .optional()
          .default(null),
        limit: z.number().int().positive().nullable().optional().default(null),
        /** Skip the whole section, on both platforms, when its first page is empty. */
        hideWhenEmpty: z
          .boolean({ error: "must be a boolean" })
          .optional()
          .default(false),
        /** Keep the header (title, count, create) but fold the body away
         * when the first page is empty — what a derived section defaults to. */
        collapseWhenEmpty: z
          .boolean({ error: "must be a boolean" })
          .optional()
          .default(false),
        /** Set by the compiler on a section it derived from a `many`
         * relation nobody declared or omitted; never declared by hand. */
        derived: z
          .boolean({ error: "must be a boolean" })
          .optional()
          .default(false),
      })
      .strict(),
    z
      .object({
        kind: z.literal("timeline"),
        ...sectionBase,
        mode: z.enum(["events", "lifecycles"]).optional().default("events"),
      })
      .strict(),
    z
      .object({
        kind: z.literal("slot"),
        id: sectionId,
        title: nonEmptyString().nullable().optional().default(null),
        /** Declared computed field whose explanation applies to this slot. */
        explanationField: fieldKey.nullable().optional().default(null),
        placement: sectionPlacement,
        collapsed: z
          .boolean({ error: "must be a boolean" })
          .optional()
          .default(false),
      })
      .strict(),
  ]);

  const listViewSchema = z.union([
    z.enum(["table", "shelf", "timeline"]),
    z
      .object({
        kind: z.literal("slot"),
        id: sectionId,
        label: nonEmptyString(),
        /** Route-only search keys the slot view reads (`urlStringParam`). */
        searchKeys: z.array(nonEmptyString()).optional().default([]),
      })
      .strict(),
  ]);

  // Everything a generic surface needs to present an entity — and nothing a
  // surface computes. Kept data-only (strings and enums) so the eager client
  // roster and the Swift catalog can carry it verbatim; one declaration, two
  // renderers.
  const entityPresentationMetadataSchema = z
    .object({
      titleField: nonEmptyString(),
      /**
       * The wayfinding line an entity's records live on, or `null` for one
       * that belongs to no line (image). Drives nav grouping, domain colours
       * and the native shell's sections.
       */
      domain: z.enum(WAYFINDING_DOMAINS).nullable(),
      /** One sentence for the records catalog and nav. */
      description: nonEmptyString(),
      emptyState: z
        .object({
          title: nonEmptyString(),
          description: nonEmptyString(),
          actionLabel: nonEmptyString().optional(),
        })
        .strict(),
      icons: z
        .object({
          /** A `@phosphor-icons/react` export name; the browser registry resolves it. */
          phosphor: nonEmptyString(),
          /** An SF Symbol name for the native app. */
          sfSymbol: nonEmptyString(),
          /** Text fallback where an SF Symbol can't render: CLI output, notifications, share text. */
          emoji: nonEmptyString(),
        })
        .strict(),
      detail: z
        .object({
          /**
           * `journal`: the first (relation) section renders before the
           * supporting fields, with a "Log entry" create button prefilled
           * from its filter.
           */
          variantOverride: z
            .enum(["standard", "journal"])
            .optional()
            .default("standard"),
          hero: z
            .object({
              /** An enum or boolean field rendered as the title chip. */
              chip: fieldKey.nullable().optional().default(null),
              stats: z.array(fieldKey).optional().default([]),
              /** A reference field rendered as the ancestry breadcrumb. */
              breadcrumb: fieldKey.nullable().optional().default(null),
              /** Defaults to whether the entity stores a gallery. */
              imagesOverride: z
                .boolean({ error: "must be a boolean" })
                .optional(),
              /** Defaults to `["edit"]` when the entity has an update contract. */
              actionOverrides: z.array(actionKey).optional(),
            })
            .strict()
            .prefault({})
            .transform(
              ({
                chip,
                stats,
                breadcrumb,
                imagesOverride,
                actionOverrides,
              }) => ({
                chip,
                stats,
                breadcrumb,
                images: imagesOverride,
                actions: actionOverrides,
              }),
            ),
          /** Omitted: one Overview section for all detail fields; [] opts out. */
          sectionOverrides: z.array(detailSectionSchema).optional(),
          /**
           * `many` relations this page deliberately renders no table for,
           * each with the reason. Every other `many` relation onto a list
           * entity gets a derived relation section; a relation whose target
           * has no list is recorded here by the compiler.
           */
          omitRelations: z
            .record(nonEmptyString(), nonEmptyString("must give a reason"))
            .optional()
            .default({}),
        })
        .strict()
        .prefault({})
        .transform(
          ({ sectionOverrides, variantOverride, hero, omitRelations }) => ({
            variant: variantOverride,
            hero,
            sections: sectionOverrides,
            omitRelations,
          }),
        ),
      list: z
        .object({
          /** The first view is the default; `table` when omitted. */
          viewOverrides: z
            .array(listViewSchema)
            .min(1)
            .optional()
            .default(["table"]),
          /** URL-compatible aliases for retired view ids, mapped before rendering. */
          viewAliases: z
            .record(nonEmptyString(), nonEmptyString())
            .optional()
            .default({}),
          /** Replaces the subtitle inferred from mobile card placement. */
          shelfSubtitleOverride: z.array(fieldKey).optional(),
          /** A custom list transport's search parameter (for example USDA's nameFilter). */
          primarySearch: z
            .object({ key: nonEmptyString(), placeholder: nonEmptyString() })
            .strict()
            .nullable()
            .optional()
            .default(null),
          /**
           * Nest the table under a self-reference: each row sits under the
           * row its `parentField` names. A row whose parent is not loaded (a
           * search match) stays at the top, so filtering never hides it.
           */
          tree: z
            .object({ parentField: fieldKey })
            .strict()
            .nullable()
            .optional()
            .default(null),
          /** Bulk/row verbs from `action-verbs.ts`; [] opts out of the default. */
          actionOverrides: z.array(actionKey).optional(),
          links: z
            .array(
              z
                .object({ label: nonEmptyString(), path: nonEmptyString() })
                .strict(),
            )
            .optional()
            .default([]),
          timeline: z
            .object({
              /** Date fields the default timeline emits `field:<key>` events for. */
              fields: z.array(fieldKey).optional().default([]),
              lifecycle: z
                .object({
                  /**
                   * An ordered fallback: the first key with a non-null value
                   * on a record starts its interval (e.g. a nursery-bought
                   * planting starts at `transplantedOn`, not `sowedOn`).
                   */
                  start: z.union([
                    fieldKey.transform((key) => [key]),
                    z.array(fieldKey).min(1),
                  ]),
                  milestones: z.array(fieldKey).optional().default([]),
                  end: fieldKey.nullable().optional().default(null),
                })
                .strict()
                .nullable()
                .optional()
                .default(null),
            })
            .strict()
            .nullable()
            .optional()
            .default(null),
        })
        .strict()
        .prefault({})
        .transform(
          ({
            actionOverrides,
            viewOverrides,
            viewAliases,
            shelfSubtitleOverride,
            primarySearch,
            tree,
            links,
            timeline,
          }) => ({
            views: viewOverrides,
            viewAliases,
            shelf:
              shelfSubtitleOverride === undefined
                ? null
                : { subtitle: shelfSubtitleOverride },
            primarySearch,
            tree,
            actions: actionOverrides,
            links,
            timeline,
          }),
        ),
      edit: z
        .object({
          /** Editor sections; derived from `control.section` when omitted. */
          sectionOverrides: z
            .array(
              z
                .object({
                  id: sectionId,
                  title: nonEmptyString(),
                  fields: z.array(fieldKey).min(1),
                  /** Render the section's body behind a disclosure that
                   * starts closed (a rarely-used section, e.g. Nutrition). */
                  collapsed: z.boolean().optional().default(false),
                })
                .strict(),
            )
            .nullable()
            .optional()
            .default(null),
          /** Fields the update editor shows read-only, unconditionally. */
          readOnlyOnUpdate: z.array(fieldKey).optional().default([]),
          /** Fields locked when `field` equals `equals` on the record. */
          readOnlyWhen: z
            .array(
              z
                .object({
                  field: fieldKey,
                  equals: z.union([z.string(), z.boolean()]),
                  fields: z.array(fieldKey).min(1),
                })
                .strict(),
            )
            .optional()
            .default([]),
          /**
           * Fields hidden from the generic editor while `field` is
           * present/absent in the **live form** (not the record) — unlike
           * `readOnlyWhen`, which is record-side and update-only, this is
           * evaluated reactively in create mode too (e.g. hide `lineKind`
           * once `productId` is picked). "Present" means a non-empty
           * trimmed string / non-null id, mirroring `control.suggest`'s
           * basis-presence rule.
           */
          hiddenWhen: z
            .array(
              z
                .object({
                  field: fieldKey,
                  present: z.boolean({ error: "must be a boolean" }),
                  fields: z.array(fieldKey).min(1),
                })
                .strict(),
            )
            .optional()
            .default([]),
        })
        .strict()
        .prefault({})
        .transform(
          ({
            sectionOverrides,
            readOnlyOnUpdate,
            readOnlyWhen,
            hiddenWhen,
          }) => ({
            sections: sectionOverrides,
            readOnlyOnUpdate,
            readOnlyWhen,
            hiddenWhen,
          }),
        ),
    })
    .strict();

  const entityDeleteMetadataSchema = z
    .object({
      mode: z.enum(["soft", "hard"]),
      bulk: z.boolean({ error: "must be a boolean" }),
    })
    .strict();

  const entityBulkUpdateMetadataSchema = z
    .object({ fields: z.array(nonEmptyString()).min(1) })
    .strict();

  /**
   * Image policy deliberately lives beside the entity declaration.  Storage,
   * display fallbacks and import routes are separate facts: a displayed image
   * must never become an implicit attachment or identity assertion.
   */
  const imageStorageMetadataSchema = z.union(
    [z.literal(false), z.enum(["gallery", "cover", "logo"])],
    { error: 'must be false, "gallery", "cover" or "logo"' },
  );
  const imageRelationPathSchema = z.array(nonEmptyString()).min(1);
  const imageDisplaySourceMetadataSchema = z
    .object({
      relationPath: imageRelationPathSchema,
      priority: z.number().int().nonnegative(),
      ordering: z.enum(["declared", "newest", "oldest"]),
      /** Display fallbacks are borrowed; they are never identity evidence. */
      identityEvidence: z.boolean({ error: "must be a boolean" }),
    })
    .strict();
  const imageVisualEvidenceMetadataSchema = z
    .object({
      relationPath: imageRelationPathSchema,
      priority: z.number().int().nonnegative(),
      ordering: z.enum(["declared", "newest", "oldest"]),
    })
    .strict();
  const imageIngressBindingValueSchema = z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
  ]);
  const imageIngressBindingMetadataSchema = z.discriminatedUnion("from", [
    z
      .object({ field: nonEmptyString(), from: z.literal("source-id") })
      .strict(),
    z
      .object({ field: nonEmptyString(), from: z.literal("source-id-list") })
      .strict(),
    z
      .object({
        field: nonEmptyString(),
        from: z.literal("source-field"),
        sourceField: nonEmptyString(),
      })
      .strict(),
    z
      .object({ field: nonEmptyString(), from: z.literal("capture-date") })
      .strict(),
    z
      .object({
        field: nonEmptyString(),
        from: z.literal("constant"),
        value: imageIngressBindingValueSchema,
      })
      .strict(),
    z
      .object({
        field: nonEmptyString(),
        from: z.literal("relation-items"),
        item: z
          .object({
            field: nonEmptyString(),
            from: z.enum(["source-id", "source-field", "constant"]),
            sourceField: nonEmptyString().optional(),
            value: imageIngressBindingValueSchema.optional(),
          })
          .strict(),
      })
      .strict(),
  ]);
  /** `createSelf` has no source record, so its bindings may only draw from the photo itself. */
  const imageIngressSelfBindingMetadataSchema = z.discriminatedUnion("from", [
    z
      .object({ field: nonEmptyString(), from: z.literal("capture-date") })
      .strict(),
    z
      .object({
        field: nonEmptyString(),
        from: z.literal("constant"),
        value: imageIngressBindingValueSchema,
      })
      .strict(),
  ]);
  /**
   * A route's resolved order is normally a fixed enum. A conditional-primary route instead
   * promotes itself to primary only when a declared source-entity field matches one of a set
   * of values (e.g. a Location's `type`), falling back to `otherwise` when it does not. The
   * compiler enforces `field` is an enum field on the source entity and every value is a member
   * of it (`validateImageIngress` in `scripts/generator/entities/compile.ts`).
   */
  const imageIngressConditionalChoiceMetadataSchema = z
    .object({
      primary: z
        .object({
          when: z
            .object({
              field: nonEmptyString(),
              oneOf: z.array(nonEmptyString()).min(1),
            })
            .strict(),
        })
        .strict(),
      otherwise: z.enum(["alternate", "prompt"]),
    })
    .strict();
  const imageIngressChoiceMetadataSchema = z.union([
    z.enum(["primary", "alternate", "prompt"]),
    imageIngressConditionalChoiceMetadataSchema,
  ]);
  const imageIngressMetadataSchema = z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("self"),
        routeId: nonEmptyString(),
        /** How this storage route is resolved after the natural source record. */
        choice: imageIngressChoiceMetadataSchema.default("primary"),
      })
      .strict(),
    z
      .object({
        kind: z.literal("existingRelated"),
        routeId: nonEmptyString(),
        relationPath: imageRelationPathSchema,
        choice: imageIngressChoiceMetadataSchema.default("alternate"),
      })
      .strict(),
    z
      .object({
        kind: z.literal("createRelated"),
        routeId: nonEmptyString(),
        relationPath: imageRelationPathSchema,
        bindings: z.array(imageIngressBindingMetadataSchema).min(1),
        choice: imageIngressChoiceMetadataSchema.default("alternate"),
      })
      .strict(),
    z
      .object({
        kind: z.literal("createSelf"),
        routeId: nonEmptyString(),
        /** Overrides the created record's own `imagePolicy.storage` for this route only; omit
         * to use the entity's declared storage (the common case — target === source here). */
        storage: imageStorageMetadataSchema.optional(),
        bindings: z.array(imageIngressSelfBindingMetadataSchema).default([]),
        enabled: z.boolean({ error: "must be a boolean" }),
        /** Required exactly when `enabled` is false (`validateImageIngress` enforces this). */
        disabledReason: nonEmptyString().optional(),
        choice: imageIngressChoiceMetadataSchema.default("alternate"),
      })
      .strict(),
  ]);
  const imageRoutingMetadataSchema = z
    .object({
      candidateFields: z.array(nonEmptyString()).default([]),
      temporalFields: z.array(nonEmptyString()).default([]),
      lifecycleFilters: z
        .array(
          z.union([
            z
              .object({
                field: nonEmptyString(),
                equals: z.union([z.string(), z.boolean()]),
              })
              .strict(),
            z
              .object({
                field: nonEmptyString(),
                oneOf: z.array(z.union([z.string(), z.boolean()])).min(1),
              })
              .strict(),
          ]),
        )
        .default([]),
      signals: z
        .object({
          ocrFields: z.array(nonEmptyString()).default([]),
          classifierLabels: z.array(nonEmptyString()).default([]),
        })
        .strict()
        .default({ ocrFields: [], classifierLabels: [] }),
      /**
       * The photo category (`packages/schemas/src/photo-categories.ts`) this entity's
       * routing belongs to. Optional here — not because a routing entity may omit it, but
       * so a missing value reaches `validateImageRouting` (scripts/generator/entities/compile.ts)
       * with the entity's key still in hand, for a message that names the entity instead of
       * a bare declaration index. An unrecognized value still fails here, at the enum.
       */
      category: z.enum(photoCategoryKeys).optional(),
      /**
       * Authoritative visual evidence for photo routing. This is deliberately
       * separate from borrowed display imagery, which can never become an
       * identity assertion by being displayed.
       */
      visualEvidence: z
        .array(imageVisualEvidenceMetadataSchema)
        .optional()
        .default([]),
      abstention: z
        .object({
          minimumScore: z.number().min(0).max(1),
          minimumMargin: z.number().min(0).max(1),
        })
        .strict(),
    })
    .strict();
  const imagePolicyMetadataSchema = z
    .object({
      storage: imageStorageMetadataSchema,
      displaySourceOverrides: z
        .array(imageDisplaySourceMetadataSchema)
        .optional(),
      ingress: z.array(imageIngressMetadataSchema).optional().default([]),
      routing: imageRoutingMetadataSchema.nullable().optional().default(null),
    })
    .strict()
    .transform(({ storage, displaySourceOverrides, ingress, routing }) => ({
      storage,
      displaySources: displaySourceOverrides ?? [],
      ingress,
      routing,
    }));

  const entityDataQualityCheckMetadataSchema = z
    .object({
      /** Globally unique across entities; also the `dataGap` filter value. */
      id: z.string().regex(/^[a-z][a-z0-9_]*$/, "must be snake_case"),
      facet: dataQualityFacetName,
      kind: dataQualityCheckKind.optional().default("missing"),
      weight: z.number().int().positive().optional().default(1),
      /** Filter-option label. */
      label: nonEmptyString(),
      /** `gap.message` shown beside the check. */
      message: nonEmptyString(),
    })
    .strict();

  const entityDataQualityMetadataSchema = z
    .object({
      checks: z.array(entityDataQualityCheckMetadataSchema).min(1),
      /**
       * True where the entity may record `DataException` rows; every check
       * then declares fingerprint inputs so an exception can go stale.
       */
      exceptions: z
        .boolean({ error: "must be a boolean" })
        .optional()
        .default(false),
      /** Scored entities whose gaps roll up into this one (`relatedGaps`). */
      related: z.array(nonEmptyString()).optional().default([]),
      /** Where the synthesized `dataQuality` list column sits; unordered = last. */
      listOrder: z.number().int().nonnegative().optional(),
    })
    .strict();

  const entityCapabilitiesMetadataSchema = z
    .object({
      auditable: z.boolean({ error: "must be a boolean" }),
      /**
       * Direct image storage only. Display imagery is universal and resolved
       * independently from this storage declaration.
       */
      images: imagePolicyMetadataSchema,
      countable: z.boolean({ error: "must be a boolean" }),
      softDelete: z.boolean({ error: "must be a boolean" }),
      delete: entityDeleteMetadataSchema.nullable(),
      bulkUpdate: entityBulkUpdateMetadataSchema.nullable(),
      merge: z.boolean({ error: "must be a boolean" }),
      operationOwners: z
        .object({
          delete: z.enum(["kernel", "workflow"]).nullable(),
          merge: z.enum(["kernel", "workflow"]).nullable(),
        })
        .strict(),
      mcp: z.array(nonEmptyString()),
      /**
       * `resources.<entity>.timeline`: `default` is the audit log plus the
       * declared date fields; `custom` binds `extensions.ports.timeline`.
       */
      timeline: z
        .enum(["default", "custom"])
        .nullable()
        .optional()
        .default(null),
      /**
       * Data-quality checks: the compiler synthesizes the `dataQuality` and
       * `dataGaps` model fields, the `dataStatus`/`dataGap` filter descriptors
       * and the `dataQualityScore` sort from this one block; the web repo binds
       * each check id to SQL in `server/repo/data-quality/checks`.
       */
      dataQuality: entityDataQualityMetadataSchema
        .nullable()
        .optional()
        .default(null),
    })
    .strict();

  const entityContractMetadataSchema = z
    .object({
      create: sourceRefMetadataSchema.nullable(),
      update: sourceRefMetadataSchema.nullable(),
      output: sourceRefMetadataSchema,
      list: sourceRefMetadataSchema.optional(),
      detail: sourceRefMetadataSchema.optional(),
      mcpOutput: sourceRefMetadataSchema.optional(),
      mcpList: sourceRefMetadataSchema.optional(),
      mcpDetail: sourceRefMetadataSchema.optional(),
    })
    .strict();

  const entityFilterDescriptorMetadataSchema = z
    .object({
      columnId: nonEmptyString(),
      field: nonEmptyString().nullable().optional(),
      urlKey: nonEmptyString().nullable().optional(),
      kind: nonEmptyString(),
      placeholder: nonEmptyString(),
      options: z
        .array(
          z
            .object({
              value: nonEmptyString(),
              label: nonEmptyString(),
              meta: z.boolean({ error: "must be a boolean" }).optional(),
              color: nonEmptyString().optional(),
            })
            .strict(),
        )
        .nullable()
        .optional(),
      optionsRef: sourceRefMetadataSchema.nullable().optional(),
      optionsKey: nonEmptyString().nullable().optional(),
      label: nonEmptyString().nullable().optional(),
      schemaDescription: nonEmptyString().nullable().optional(),
      deriveSchema: z.boolean({ error: "must be a boolean" }).optional(),
      schemaFromRead: z.boolean({ error: "must be a boolean" }).optional(),
      brandRef: z
        .object({ entity: nonEmptyString() })
        .strict()
        .nullable()
        .optional(),
      expandRef: sourceRefMetadataSchema.nullable().optional(),
      /** A named schema for select/multiselect values (an enum export). */
      schemaRef: sourceRefMetadataSchema.nullable().optional(),
      /**
       * The filter is the standard predicate over stored columns, so the
       * repository composes it from the declaration. `true` reads the column
       * named by `columnId`; `columns` names one or more stored fields when
       * the descriptor id is virtual (`search`) or the match spans columns;
       * `array` marks a multiselect over a `text-array` column (overlap, not
       * membership).
       */
      stored: z
        .union([
          z.boolean({ error: "must be a boolean" }),
          z
            .object({
              columns: z.array(nonEmptyString()).min(1).optional(),
              array: z.boolean({ error: "must be a boolean" }).optional(),
            })
            .strict(),
        ])
        .optional(),
      /** Range bounds; `kind` is inferred from the model field when omitted. */
      range: z
        .object({
          kind: z.enum(["number", "date"]).optional(),
          int: z.boolean({ error: "must be a boolean" }).optional(),
          nonnegative: z.boolean({ error: "must be a boolean" }).optional(),
          finite: z.boolean({ error: "must be a boolean" }).optional(),
          /** MCP prose for the two bounds the range derives. */
          describe: z
            .object({ lower: nonEmptyString(), upper: nonEmptyString() })
            .strict()
            .optional(),
        })
        .strict()
        .nullable()
        .optional(),
      urlOnly: z.boolean({ error: "must be a boolean" }).optional(),
      nullable: z
        .object({ field: nonEmptyString(), label: nonEmptyString() })
        .strict()
        .nullable()
        .optional(),
      /**
       * The list-route query parameter(s) the filter binds to. Compiled as
       * `field ?? columnId` (a range as `<columnId>From/To`); declared only
       * where the hand-written filter schema diverges from that rule.
       */
      wire: z
        .union([
          z
            .object({ kind: z.literal("param"), name: nonEmptyString() })
            .strict(),
          z
            .object({
              kind: z.literal("range"),
              from: nonEmptyString(),
              to: nonEmptyString(),
              presence: nonEmptyString().optional(),
            })
            .strict(),
        ])
        .nullable()
        .optional(),
    })
    .strict();

  const entityRelationSourceMetadataSchema = z
    .object({
      key: nonEmptyString(),
      label: nonEmptyString(),
      provenance: z.unknown(),
      inverse: z.unknown().optional(),
    })
    .strict();

  const entityRelationMetadataSchema = z
    .object({
      key: nonEmptyString(),
      label: nonEmptyString(),
      target: nonEmptyString(),
      cardinality: z.enum(["one", "many"]),
      sourceKey: nonEmptyString().optional(),
      provenance: z.unknown(),
      inverse: z.unknown().optional(),
      sources: z.array(entityRelationSourceMetadataSchema).optional(),
      /** Set by the compiler on the `many` inverse it derived from another
       * entity's `one` foreign-key relation; never declared by hand. */
      derived: z.literal(true).optional(),
      /** On a single-FK `one` relation: why its target gets no derived
       * `many` inverse. */
      inverseOmit: nonEmptyString("must give a reason").optional(),
      mutation: z
        .object({
          source: nonEmptyString(),
          itemSchema: sourceRefMetadataSchema,
          adapter: sourceRefMetadataSchema,
          audiences: z.array(z.enum(["browser", "mcp"])).min(1),
        })
        .strict()
        .optional(),
    })
    .strict();

  const documentSearchPorts = {
    projection: {
      module: "~/server/repo/search-document",
      export: "refreshSearchDocument",
    },
    semanticText: {
      module: "~/server/repo/search-document",
      export: "getSearchDocumentEmbeddingText",
    },
    dependentRefresh: {
      module: "~/server/services/mutation-side-effects",
      export: "runMutationSideEffects",
    },
  };

  const entityExtensionsMetadataSchema = z
    .object({
      countFilter: nonEmptyString().nullable().optional().default(null),
      relatednessSignals: z
        .array(
          z.union([
            z
              .object({
                kind: z.literal("semantic"),
                label: nonEmptyString(),
                pair: nonEmptyString(),
                weight: z.number(),
                limit: z.number().int().positive(),
              })
              .strict(),
            z
              .object({
                kind: z.literal("scalarOverlap"),
                label: nonEmptyString(),
                pair: nonEmptyString(),
                column: nonEmptyString(),
                popularityCap: z.number().int().positive(),
                scoring: z.literal("displayOnly"),
              })
              .strict(),
          ]),
        )
        .nullable()
        .optional()
        .default(null),
      mcpNames: z
        .object({
          singular: nonEmptyString().optional(),
          plural: nonEmptyString().optional(),
          overrides: z.record(nonEmptyString(), nonEmptyString()).optional(),
        })
        .strict()
        .nullable()
        .optional()
        .default(null),
      ports: z
        .object({
          repository: sourceRefMetadataSchema.nullable(),
          references: z
            .object({
              label: sourceRefMetadataSchema.nullable(),
              resolver: sourceRefMetadataSchema.nullable(),
            })
            .strict()
            .optional()
            .default({
              label: { module: "~/entities/entities", export: "entityLabel" },
              resolver: {
                module: "~/server/repo/shortcode-resolver",
                export: "resolveLiveShortcode",
              },
            }),
          filters: sourceRefMetadataSchema.nullable().optional().default({
            module: "~/entities/filter-manifest",
            export: "getEntityFilters",
          }),
          search: z
            .union([
              z.literal("document").transform(() => documentSearchPorts),
              z
                .object({
                  projection: sourceRefMetadataSchema.nullable(),
                  semanticText: sourceRefMetadataSchema.nullable(),
                  dependentRefresh: sourceRefMetadataSchema.nullable(),
                })
                .strict(),
            ])
            .optional()
            .default({
              projection: null,
              semanticText: null,
              dependentRefresh: null,
            }),
          /** `(context, input) => EntityTimelineOut` for `capabilities.timeline: "custom"`. */
          timeline: sourceRefMetadataSchema.nullable().optional().default(null),
        })
        .strict(),
    })
    .strict();

  /**
   * The compiler imports executable literals, so this schema covers every
   * stable declaration section before semantic cross-entity validation. The
   * relation, filter, and contract contents stay opaque here because their
   * diagnostic-rich semantic validation depends on the whole catalog.
   */
  const entityDeclarationMetadataSchema = z
    .object({
      key: nonEmptyString(),
      names: z
        .object({
          singular: nonEmptyString(),
          plural: nonEmptyString().nullable(),
        })
        .strict(),
      route: entityRouteMetadataSchema.nullable(),
      table: nonEmptyString().nullable(),
      identifiers: entityIdentifiersMetadataSchema,
      presentation: entityPresentationMetadataSchema,
      fields: entityContractMetadataSchema.nullable(),
      model: entityFieldModelMetadataSchema.optional(),
      filters: z
        .object({
          audit: z.boolean({ error: "must be a boolean" }).optional(),
          schema: sourceRefMetadataSchema.nullable().optional(),
          descriptors: z.array(entityFilterDescriptorMetadataSchema),
        })
        .strict(),
      relations: z.array(entityRelationMetadataSchema),
      search: z
        .object({
          enabled: z.boolean({ error: "must be a boolean" }),
          /**
           * Whether this searchable entity also gets an `EntityEmbedding`
           * vector. Defaults to `true` when `enabled`; the three financial
           * entities set `false` to stay lexically searchable without a
           * vector (see `entity-manifest.ts` `embeddableEntities`).
           */
          embeddingOverride: z
            .boolean({ error: "must be a boolean" })
            .optional(),
        })
        .strict()
        .transform(({ enabled, embeddingOverride }) => ({
          enabled,
          embedding: embeddingOverride,
        })),
      capabilities: entityCapabilitiesMetadataSchema,
      extensions: entityExtensionsMetadataSchema,
    })
    .strict()
    .transform((declaration) => ({
      ...declaration,
      route:
        declaration.route === null
          ? null
          : {
              ...declaration.route,
              create:
                declaration.route.create === undefined
                  ? declaration.fields?.create !== null &&
                    declaration.fields !== null &&
                    declaration.model?.intents?.create.includes("capture")
                    ? ("dialog" as const)
                    : undefined
                  : (declaration.route.create ?? undefined),
            },
    }));

  return {
    declaration: entityDeclarationMetadataSchema,
    field: entityFieldMetadataSchema,
    fieldModel: entityFieldModelMetadataSchema,
    storage: entityStorageMetadataSchema,
    presentation: entityPresentationMetadataSchema,
  };
};

type EntityMetadataSchemas = ReturnType<typeof metadataSchemas>;
export type EntityStorageMetadata = z.output<EntityMetadataSchemas["storage"]>;
export type EntityFieldModelMetadata = z.output<
  EntityMetadataSchemas["fieldModel"]
>;
export type EntityDeclaration = z.input<EntityMetadataSchemas["declaration"]>;
export type EntityDeclarationMetadata = z.output<
  EntityMetadataSchemas["declaration"]
>;

const pathAt = (context: string, path: readonly PropertyKey[]) =>
  path.length === 0 ? context : `${context}.${path.join(".")}`;

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- This parser-boundary walker only distinguishes omitted input from an explicit invalid value so Zod errors retain their declaration path. */
const valueIsMissingAt = (value: unknown, path: readonly PropertyKey[]) => {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return true;
    const property = Object.getOwnPropertyDescriptor(current, key);
    if (property === undefined) return true;
    current = property.value;
  }
  return current === undefined;
};
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters */

/**
 * Preserve declaration-local diagnostic paths while centralizing strict shape
 * validation and metadata defaults. Semantic roster and storage checks remain
 * in the compiler because they require the complete entity declaration.
 */
export function parseEntityFieldModelMetadata(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- compiler parser boundary
  value: unknown,
  context: string,
): EntityFieldModelMetadata | null {
  if (value === undefined) return null;
  const parsed = metadataSchemas().fieldModel.safeParse(value);
  if (parsed.success) return parsed.data;

  const issue = parsed.error.issues[0];
  if (issue === undefined) throw new Error(`${context} metadata is invalid.`);
  if (issue.code === "unrecognized_keys") {
    const key = issue.keys[0];
    throw new Error(`${pathAt(context, issue.path)}.${key} is not allowed.`);
  }
  const path = pathAt(context, issue.path);
  if (issue.code === "invalid_type" && valueIsMissingAt(value, issue.path)) {
    throw new Error(`${path} is required.`);
  }
  const field = issue.path.at(-1);
  if (
    field === "nullable" ||
    field === "nullableOverride" ||
    field === "multiple" ||
    field === "list" ||
    field === "detail"
  )
    throw new Error(`${path} must be a boolean.`);
  if (field === "read" || field === "create" || field === "update")
    throw new Error(`${path} must be a Zod schema.`);
  if (
    field === "labelOverride" ||
    field === "key" ||
    field === "entity" ||
    field === "columnIdOverride" ||
    field === "sectionOverride"
  )
    throw new Error(`${path} must be a non-empty string.`);
  throw new Error(`${path} ${issue.message}.`);
}

/** Parse an executable declaration once before compiler-only semantic checks. */
export function parseEntityDeclarationMetadata(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- compiler parser boundary
  value: unknown,
  context: string,
): EntityDeclarationMetadata {
  const parsed = metadataSchemas().declaration.safeParse(value);
  if (parsed.success) return parsed.data;

  const issue = parsed.error.issues[0];
  if (issue === undefined) throw new Error(`${context} metadata is invalid.`);
  if (issue.code === "unrecognized_keys") {
    const key = issue.keys[0];
    throw new Error(`${pathAt(context, issue.path)}.${key} is not allowed.`);
  }
  const path = pathAt(context, issue.path);
  if (issue.code === "invalid_type" && valueIsMissingAt(value, issue.path))
    throw new Error(`${path} is required.`);
  throw new Error(`${path} ${issue.message}.`);
}

/** Preserve literal field keys and schema types without inspecting Zod internals. */
export const defineEntity = <const T extends EntityDeclaration>(
  declaration: T,
): T => declaration;

type ReadableDeclaration = {
  model: {
    fields: readonly {
      key: string;
      readKeyOverride?: string | null;
      validation?: { read: z.ZodType | null };
    }[];
    output: readonly string[];
  };
};
type ReadFieldSchemas<D extends ReadableDeclaration> = {
  [
    F in D["model"]["fields"][number] as F["key"] extends D["model"]["output"][number]
      ? F extends { readKeyOverride: infer R extends string }
        ? R
        : F["key"]
      : never
  ]: F extends { validation: { read: infer S extends z.ZodType } } ? S : never;
};

type MutableDeclaration = {
  model: {
    fields: readonly {
      key: string;
      validation?: {
        create: z.ZodType | null;
        update: z.ZodType | null;
      };
    }[];
    create: readonly string[];
    update: readonly string[];
  };
};
type ModeFieldSchemas<
  D extends MutableDeclaration,
  M extends "create" | "update",
> = {
  [
    F in D["model"]["fields"][number] as F["key"] extends D["model"][M][number]
      ? F["key"]
      : never
  ]: F extends { validation: { [K in M]: infer S extends z.ZodType } }
    ? S
    : never;
};

const modeFieldSchemas = <
  const D extends MutableDeclaration,
  M extends "create" | "update",
>(
  definition: D,
  mode: M,
): ModeFieldSchemas<D, M> => {
  const entries = definition.model[mode].map((key) => {
    const field = definition.model.fields.find((field) => field.key === key);
    const schema = field?.validation?.[mode];
    if (!schema) throw new Error(`Missing declared ${mode} schema for ${key}`);
    return [key, schema];
  });
  // SAFETY: the explicit roster selects exact declared keys, each paired with
  // that field's own `validation[mode]` instance; a missing schema fails above.
  return Object.fromEntries(entries) as ModeFieldSchemas<D, M>;
};

/**
 * The create/update/read field-schema maps a canonical module composes from.
 * Keyed by the roster rather than by field index, so inserting a field
 * mid-declaration cannot shift another field's schema, and the map hands
 * back the declaration's own Zod instances (the field-map-drift test relies
 * on that identity).
 */
export type FieldSchemas<D extends MutableDeclaration & ReadableDeclaration> = {
  create: ModeFieldSchemas<D, "create">;
  update: ModeFieldSchemas<D, "update">;
  read: ReadFieldSchemas<D>;
};

export function fieldSchemasOf<
  const D extends MutableDeclaration & ReadableDeclaration,
>(definition: D): FieldSchemas<D> {
  return {
    create: modeFieldSchemas(definition, "create"),
    update: modeFieldSchemas(definition, "update"),
    read: readFieldSchemas(definition),
  };
}

/** Compose domain projections from the same declared fields without importing generated code. */
export function readFieldSchemas<const D extends ReadableDeclaration>(
  definition: D,
): ReadFieldSchemas<D> {
  const entries = definition.model.output.map((key) => {
    const field = definition.model.fields.find((field) => field.key === key);
    if (!field?.validation?.read)
      throw new Error(`Missing declared read schema for ${key}`);
    return [field.readKeyOverride ?? key, field.validation.read];
  });
  // SAFETY: the explicit output roster selects exact declared keys; missing schemas fail above.
  return Object.fromEntries(entries) as ReadFieldSchemas<D>;
}

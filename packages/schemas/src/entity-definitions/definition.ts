import { z } from "zod";
import {
  dataQualityCheckKind,
  dataQualityFacetName,
} from "../data-quality-facets";
import { fieldPolicyValue } from "../field-policy-fields";
import { photoCategoryKeys } from "../photo-categories";
import { childTableMetadataSchema } from "./child-definition";

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
 * What each line is called and drawn as. The web shell reads `label`; the
 * Swift `WayfindingDomain.title`/`.sfSymbol` are generated from this table
 * (`Generated/SharedConstants.swift`). The group glyph is used where a domain
 * itself is the subject (a Browse header, a Mac sidebar row), not one entity
 * within it.
 */
export const WAYFINDING_DOMAIN_PRESENTATION = {
  cook: { label: "Cook", sfSymbol: "fork.knife" },
  pantry: { label: "Pantry", sfSymbol: "shippingbox" },
  plan: { label: "Plan", sfSymbol: "hammer" },
  house: { label: "House", sfSymbol: "house" },
  finance: { label: "Finance", sfSymbol: "creditcard" },
} as const satisfies Record<
  WayfindingDomain,
  { label: string; sfSymbol: string }
>;

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
  ReturnType<typeof buildMetadataSchemas>["presentation"]
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
/** One compiled editor section; the untitled `main` section has `title: null`. */
export type CompiledEditSection = {
  id: string;
  title: string | null;
  fields: readonly string[];
  collapsed: boolean;
};

export type CompiledEntityPresentation = Omit<
  EntityPresentation,
  "detail" | "list" | "edit"
> & {
  edit: Omit<EntityPresentation["edit"], "sections"> & {
    /** Every controlled roster field, each in exactly one section. */
    sections: readonly CompiledEditSection[];
  };
  detail: Omit<EntityPresentation["detail"], "hero" | "sections"> & {
    sections: Array<
      NonNullable<EntityPresentation["detail"]["sections"]>[number] & {
        overview: boolean;
      }
    >;
    /** Field keys declaring `display.preview`, in model order. */
    preview: readonly string[];
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

/**
 * List/detail cell formatters a field may declare (`display.format`). Each
 * platform's renderer switches on the same names:
 *
 * - `currency`, `signedCurrency`, `plainDate`, `timestamp`, `external-link`,
 *   `amount`: one value, formatted.
 * - `presence`: whether a value (a boolean, or anything non-empty) is there,
 *   as a labelled pill (`display.valueOptions` `yes`/`no` rosters the labels).
 * - `bytes`: a byte count as a human size.
 * - `join`: a string array, comma-joined (an empty list reads as none).
 * - `count`: a known non-negative count; `0` renders as `0`, never a dash.
 * - `arrayCount`: the length of an array value, rendered as a `count`.
 */
export const displayFormats = [
  "currency",
  "signedCurrency",
  "plainDate",
  "timestamp",
  "external-link",
  "amount",
  "presence",
  "bytes",
  "join",
  "arrayCount",
  "count",
] as const;
export type DisplayFormat = (typeof displayFormats)[number];

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
const buildMetadataSchemas = () => {
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
              /** Web swatch (a CSS custom property) the value's pill uses. */
              color: nonEmptyString().optional(),
            })
            .strict(),
        )
        .nullable()
        .optional()
        .default(null),
      /** A short field the generic editor pairs with the next consecutive
       * `"half"` field on one row (`SideBySideFields`), instead of the
       * default full-width control. */
      width: z.literal("half").nullable().optional().default(null),
      /** Editor placeholder text, generic-editor only. */
      placeholder: nonEmptyString().nullable().optional().default(null),
      /**
       * A create-only initial value the generic editor uses at draft time
       * instead of the field's record/schema default: `"today"` (the
       * household's local calendar date) or a literal `{ value }`.
       */
      initial: z
        .union([
          z.literal("today"),
          z
            .object({
              value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
            })
            .strict(),
        ])
        .nullable()
        .optional()
        .default(null),
      /**
       * Whether the editor refuses a blank value. `null` derives it from the
       * create schema (required there means required here); `true` requires
       * a value the schema merely allows (a manufacturer); `false` exempts a
       * value the schema requires but a more specific validator reports.
       */
      required: z
        .boolean({ error: "must be a boolean" })
        .nullable()
        .optional()
        .default(null),
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
          reviewRequired: z.boolean().optional().default(false),
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
        width,
        placeholder,
        initial,
        required,
        suggest,
      }) => ({
        kind,
        renderer,
        options,
        width,
        placeholder,
        initial,
        required,
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
      /**
       * Where a field with no flat read key (`readKeyOverride: null`) is read
       * from on a list or detail row: a dotted path with `[n]` indexing and
       * an optional `[]` projection over an array (`quantityLedger.locationCount`,
       * `sourceRefs[].source`, `category.path[0].name`).
       */
      readPath: nonEmptyString().nullable().optional().default(null),
      /**
       * Where a list row carries the human-readable text of this field's
       * value, in `readPath`'s grammar (a `[]` projection joins its strings
       * with ", "). A server-composed figure (`quantityLedger.expectedLabel`)
       * or the display name of a reference (`recipes[].recipe.name`): clients
       * print it instead of re-deriving the figure, so a computed cell has one
       * rule. The field's own value stays the sort and filter value.
       */
      labelPath: nonEmptyString().nullable().optional().default(null),
      /**
       * Where the detail record carries this field's human-readable text, in
       * `readPath`'s grammar: the detail-surface twin of `labelPath` for a
       * structured value whose list cell stays a count or a chip (the text may
       * span lines). Clients print it instead of re-deriving the sentence from
       * the structure.
       */
      detailLabelPath: nonEmptyString().nullable().optional().default(null),
      /**
       * Where the detail record carries a list of display items
       * (`displayItems`: a record each, or plain text) the field shows as rows,
       * each linking to its record when it names one. The server composes the
       * titles and figures, so a client draws a reference list without
       * restating the structure.
       */
      itemsPath: nonEmptyString().nullable().optional().default(null),
      /** List cell formatter chosen by the shared column compiler. */
      format: z.enum(displayFormats).nullable().optional().default(null),
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
      referencePreviewLimit: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .default(null),
      listHidden: z
        .boolean({ error: "must be a boolean" })
        .optional()
        .default(false),
      /**
       * Roster (label, tone) for the enum-like value this field renders when
       * it has no select control of its own: a derived status, or the
       * `kind`/`status` member of a JSON field. Enum fields with a select
       * control keep declaring `control.options`.
       */
      valueOptions: z
        .array(
          z
            .object({
              value: nonEmptyString(),
              label: nonEmptyString(),
              color: nonEmptyString().optional(),
            })
            .strict(),
        )
        .nullable()
        .optional()
        .default(null),
      /**
       * A fact on the entity's hover preview card. An entity that declares
       * any shows exactly those, in model order; one that declares none falls
       * back to its hero stats and first detail section.
       */
      preview: z
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
        listOrderOverride,
        width,
        readPath,
        labelPath,
        detailLabelPath,
        itemsPath,
        format,
        renderer,
        mobile,
        listHidden,
        referencePreviewLimit,
        valueOptions,
        preview,
      }) => ({
        list,
        detail,
        columnId: columnIdOverride,
        standard,
        listOrder: listOrderOverride,
        width,
        readPath,
        labelPath,
        detailLabelPath,
        itemsPath,
        format,
        renderer,
        mobile,
        listHidden,
        referencePreviewLimit,
        valueOptions,
        preview,
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
      nullable: undefined,
      default: undefined,
      defaultValue: undefined,
      reference: undefined,
      specialized: undefined,
    })),
    z
      .object({
        key: nonEmptyString(),
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
          nullableOverride,
          defaultOverride,
          defaultValue,
          reference,
          specialized,
        }) => ({
          key,
          nullable: nullableOverride,
          default: defaultOverride,
          defaultValue,
          reference,
          specialized,
        }),
      ),
  ]);

  /**
   * The generic list-grouping contract for an entity whose web list groups
   * rows into sections (currently product and location). `field` is the
   * `groupable` entry the row is grouped by; the server's `parseGroupBy`
   * rejects any other value, and the compiler below rejects a declaration
   * whose `field` is not in `groupable`. `nullGroupKey` is the sentinel used
   * when a row's field is null (kept as a literal here, not re-derived,
   * so the web and repository read the exact same value the manifest
   * declares — see `PRODUCT_UNCLASSIFIED_GROUP_KEY` /
   * `LOCATION_UNSPECIFIED_GROUP_KEY` in `../pagination`). `labelField` names
   * the row key the group's display label is read from when it differs from
   * `field` itself (product groups by `categoryId` but labels from the
   * `category` relation); omitted, the label is the field's own value.
   */
  const entityFieldModelGroupingMetadataSchema = z
    .object({
      field: nonEmptyString(),
      nullGroupKey: nonEmptyString(),
      labelField: nonEmptyString().optional(),
    })
    .strict();

  const entityFieldModelSortMetadataSchema = z
    .object({
      fields: z.array(nonEmptyString()).min(1),
      /** Defaults to `createdAt` when sortable, otherwise the first field. */
      defaultOverride: nonEmptyString().optional(),
      computed: z.array(nonEmptyString()).optional().default([]),
      groupable: z.array(nonEmptyString()).optional().default([]),
      grouping: entityFieldModelGroupingMetadataSchema.optional(),
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
      /**
       * Fields an intent's editor refuses to leave blank although the
       * canonical contract allows it (`schedule` needs its `dueDate`).
       */
      required: z
        .record(nonEmptyString(), z.array(nonEmptyString()).min(1))
        .optional()
        .default({}),
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
      /**
       * Which list page renders: `true` the generated one (the default),
       * `null` a hand-written index route.
       */
      list: z.literal(true).nullable().optional().default(true),
      /** Specialist columns are imported only by this route component. */
      listColumns: sourceRefMetadataSchema.optional(),
      /**
       * Where a read-only entity's generated index gets its rows: the kernel
       * list (the default), or `custom` — its `listColumns` module supplies
       * them. An entity the browser creates and edits always reads the kernel.
       */
      listRows: z.enum(["kernel", "custom"]).optional().default("kernel"),
      /**
       * Which detail page renders: `true` the generic page over the kernel
       * `get` (the default), or `null` a hand-written detail route.
       */
      detail: z.literal(true).nullable().optional().default(true),
    })
    .strict()
    .transform(
      ({
        basePath,
        detailParamOverride,
        createOverride,
        list,
        listColumns,
        listRows,
        detail,
      }) => ({
        basePath,
        detailParam: detailParamOverride,
        create: createOverride,
        list,
        listColumns,
        listRows,
        detail,
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
        /** Section-specific empty-state copy, replacing the generic
         * "No <plural> yet." sentence both platforms otherwise render — for
         * a section whose target's plural name reads awkwardly or
         * uninformatively on its own (e.g. "No products yet." under "Kit
         * components"). */
        empty: nonEmptyString().nullable().optional().default(null),
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
      recordEmojiField: fieldKey.nullable().optional().default(null),
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
      /**
       * Date pairs that read as one span: `start` (usually one day) and an
       * optional `end`. Detail and list surfaces render one row labelled
       * `label` ("Sep 22 – 25") in the start field's place and hide the end
       * field; both stay editable, and the editor rejects an end before its
       * start. The one declaration for the span — `edit` validation, the
       * native catalog's `editDateRanges` and the calendar read it.
       */
      spans: z
        .array(
          z
            .object({
              start: fieldKey,
              end: fieldKey,
              label: nonEmptyString(),
            })
            .strict(),
        )
        .optional()
        .default([]),
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
              /** Workflow verbs after the derived `edit` (present with an update contract). */
              extraActions: z.array(actionKey).optional().default([]),
            })
            .strict()
            .prefault({})
            .transform(({ chip, stats, breadcrumb, extraActions }) => ({
              chip,
              stats,
              breadcrumb,
              actions: extraActions,
            })),
          /** Null includes every declared section in Overview. A whitelist keeps
           * supporting detail reachable through its existing section id. */
          overviewSections: z
            .array(sectionId)
            .nullable()
            .optional()
            .default(null),
          /** Omitted: one Overview section for all detail fields; [] opts out. */
          sectionOverrides: z.array(detailSectionSchema).optional(),
          /** Extra field groups, slots and timelines appended to inferred sections. */
          additionalSections: z
            .array(detailSectionSchema)
            .optional()
            .default([]),
          /** Ambiguous relation back-filters, keyed by relation name. */
          relationFilterOverrides: z
            .record(
              nonEmptyString(),
              z
                .object({
                  descriptor: nonEmptyString(),
                  prefill: z
                    .object({ field: nonEmptyString() })
                    .strict()
                    .nullable()
                    .optional(),
                })
                .strict(),
            )
            .optional()
            .default({}),
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
          ({
            sectionOverrides,
            overviewSections,
            additionalSections,
            relationFilterOverrides,
            variantOverride,
            hero,
            omitRelations,
          }) => ({
            variant: variantOverride,
            hero,
            sections: sectionOverrides,
            overviewSections,
            additionalSections,
            relationFilterOverrides,
            omitRelations,
          }),
        ),
      list: z
        .object({
          /** Deferred ownership; remaining canonical list fields are core. */
          read: z
            .object({
              media: z.array(nonEmptyString()).default([]),
              quality: z.array(nonEmptyString()).default([]),
              relations: z.array(nonEmptyString()).default([]),
              derived: z.array(nonEmptyString()).default([]),
              dependencies: z
                .partialRecord(
                  z.enum(["media", "quality", "relations", "derived"]),
                  z.array(z.enum(["media", "quality", "relations", "derived"])),
                )
                .default({}),
            })
            .strict()
            .optional()
            .default({
              media: [],
              quality: [],
              relations: [],
              derived: [],
              dependencies: {},
            }),
          /** The first view is the default; `table` when omitted. */
          views: z.array(listViewSchema).min(1).optional().default(["table"]),
          /** URL-compatible aliases for retired view ids, mapped before rendering. */
          viewAliases: z
            .record(nonEmptyString(), nonEmptyString())
            .optional()
            .default({}),
          /** Full-filter server aggregates to present on every list client. */
          totals: z
            .array(
              z
                .object({
                  id: nonEmptyString(),
                  label: nonEmptyString(),
                  keys: z.union([
                    z.tuple([nonEmptyString()]),
                    z.tuple([nonEmptyString(), nonEmptyString()]),
                  ]),
                  format: z.enum(["currency", "currencyRange", "integer"]),
                })
                .strict()
                .refine(
                  (total) =>
                    (total.format === "currencyRange") ===
                    (total.keys.length === 2),
                  "currencyRange requires two sum keys; other totals require one",
                ),
            )
            .optional()
            .default([]),
          /** Replaces the subtitle inferred from mobile card placement. */
          shelfSubtitleOverride: z.array(fieldKey).optional(),
          /**
           * The filter a fresh list opens with, as column filters (`id` is a
           * field key, the value what its filter control would hold). Applies
           * only while the URL names no filter of its own; clearing it writes
           * `filters=none`, so the person's choice to see everything survives a
           * reload. Positive on purpose: to hide ephemeral runs, select the
           * triggers people start.
           */
          initialFilter: z
            .array(
              z
                .object({
                  id: fieldKey,
                  value: z.union([z.string(), z.array(z.string()).min(1)]),
                })
                .strict(),
            )
            .optional()
            .default([]),
          /**
           * Named starting points for the list: pinned filters plus an
           * optional sort and curated column visibility. Applying one sets
           * real column-filter state, so a view and a shared link are the
           * same thing. The compiler checks every filter id and value against
           * `filters.descriptors` and every layout column against the
           * declared list columns. `problem` additionally publishes the view
           * as a Problems section.
           */
          savedViews: z
            .array(
              z
                .object({
                  id: nonEmptyString(),
                  label: nonEmptyString(),
                  description: nonEmptyString(),
                  filters: z
                    .array(
                      z
                        .object({
                          id: nonEmptyString(),
                          value: z.union([
                            z.string(),
                            z.array(z.string()).min(1),
                          ]),
                        })
                        .strict(),
                    )
                    .min(1),
                  /** A guided pass the view leads into. */
                  flow: z
                    .object({
                      kind: z.literal("shelf-triage"),
                      label: nonEmptyString(),
                    })
                    .strict()
                    .nullable()
                    .optional()
                    .default(null),
                  sort: z
                    .array(
                      z
                        .object({
                          id: nonEmptyString(),
                          desc: z.boolean({ error: "must be a boolean" }),
                        })
                        .strict(),
                    )
                    .nullable()
                    .optional()
                    .default(null),
                  /** Columns the view reveals (or hides) when applied. */
                  layout: z
                    .object({
                      columnVisibility: z.record(
                        nonEmptyString(),
                        z.boolean({ error: "must be a boolean" }),
                      ),
                    })
                    .strict()
                    .nullable()
                    .optional()
                    .default(null),
                  problem: z
                    .object({
                      key: nonEmptyString(),
                      title: nonEmptyString(),
                      description: nonEmptyString(),
                      emptyMessage: nonEmptyString(),
                    })
                    .strict()
                    .nullable()
                    .optional()
                    .default(null),
                })
                .strict(),
            )
            .optional()
            .default([]),
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
          /**
           * Workflow verbs from `action-verbs.ts`, ahead of the verbs derived
           * from capabilities (`bulkEdit`, kernel `merge`, kernel `delete`).
           */
          extraActions: z.array(actionKey).optional().default([]),
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
            extraActions,
            views,
            viewAliases,
            totals,
            read,
            shelfSubtitleOverride,
            initialFilter,
            savedViews,
            primarySearch,
            tree,
            links,
            timeline,
          }) => ({
            savedViews,
            views,
            viewAliases,
            totals,
            read,
            shelf:
              shelfSubtitleOverride === undefined
                ? null
                : { subtitle: shelfSubtitleOverride },
            initialFilter,
            primarySearch,
            tree,
            actions: extraActions,
            links,
            timeline,
          }),
        ),
      edit: z
        .object({
          /**
           * Titled editor sections, in order. Every controlled field no
           * section names joins the untitled `main` section, which leads
           * unless a bare `{ id: "main" }` entry places it.
           */
          sections: z
            .array(
              z
                .object({
                  id: sectionId,
                  title: nonEmptyString().optional(),
                  fields: z.array(fieldKey).min(1).optional(),
                  /** Render the section's body behind a disclosure that
                   * starts closed (a rarely-used section, e.g. Nutrition). */
                  collapsed: z.boolean().optional().default(false),
                })
                .strict()
                .superRefine((section, context) => {
                  const named =
                    section.title !== undefined || section.fields !== undefined;
                  if (section.id === "main" && named)
                    context.addIssue({
                      code: "custom",
                      message:
                        'main is reserved for the untitled remainder; place it with a bare { id: "main" }',
                    });
                  if (
                    section.id !== "main" &&
                    (section.title === undefined ||
                      section.fields === undefined)
                  )
                    context.addIssue({
                      code: "custom",
                      message: "needs a title and fields",
                    });
                })
                .transform(({ id, title, fields, collapsed }) =>
                  title === undefined || fields === undefined
                    ? { id, title: null, fields: null, collapsed }
                    : { id, title, fields, collapsed },
                ),
            )
            .optional()
            .default([]),
          /**
           * Fields hidden from the generic editor while `field` is
           * present/absent in the **live form** (not the record), evaluated
           * reactively in create and update mode (e.g. hide `lineKind`
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
        .transform(({ sections, hiddenWhen }) => ({
          sections,
          hiddenWhen,
        })),
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
   * The kernel `resolve` action: names → live rows, matched case-insensitively
   * on the declared stored text columns (`text-array` columns by element).
   * `createMissing: false` refuses `create: true`; `candidates` is how many
   * contains-matches a miss offers; `scope` pins stored columns to NULL (an
   * ingredient resolves among standalone rows, never a recipe's own).
   */
  const entityResolveMetadataSchema = z
    .object({
      match: z.array(nonEmptyString()).min(1),
      createMissing: z.boolean({ error: "must be a boolean" }),
      candidates: z.number().int().positive().optional(),
      scope: z.array(nonEmptyString()).optional().default([]),
    })
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
      // An empty path is the record's own gallery images (no relation hop).
      relationPath: z.array(nonEmptyString()),
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
      /**
       * Related records whose images stand in when this entity's own storage
       * holds none. Only an entity with image storage declares these; it has
       * no derived default to replace.
       */
      displaySources: z.array(imageDisplaySourceMetadataSchema).optional(),
      /**
       * Replaces the ranking derived for an entity without image storage
       * (its singular outgoing relations to image-bearing entities).
       */
      displaySourceOverrides: z
        .array(imageDisplaySourceMetadataSchema)
        .optional(),
      ingress: z.array(imageIngressMetadataSchema).optional().default([]),
      routing: imageRoutingMetadataSchema.nullable().optional().default(null),
    })
    .strict()
    .superRefine((policy, context) => {
      if (policy.storage === false && policy.displaySources !== undefined)
        context.addIssue({
          code: "custom",
          path: ["displaySources"],
          message:
            "replaces a derived ranking without image storage; declare displaySourceOverrides",
        });
      if (
        policy.storage !== false &&
        policy.displaySourceOverrides !== undefined
      )
        context.addIssue({
          code: "custom",
          path: ["displaySourceOverrides"],
          message:
            "has no derived default with image storage; declare displaySources",
        });
    })
    .transform(
      ({
        storage,
        displaySources,
        displaySourceOverrides,
        ingress,
        routing,
      }) => ({
        storage,
        displaySources: displaySourceOverrides ?? displaySources ?? [],
        ingress,
        routing,
      }),
    );

  const entityDataQualityCheckMetadataSchema = z
    .object({
      /** Globally unique across entities; also the `dataGap` filter value. */
      id: z.string().regex(/^[a-z][a-z0-9_]*$/, "must be snake_case"),
      facet: dataQualityFacetName,
      kind: dataQualityCheckKind.optional().default("missing"),
      weight: z.number().int().positive().optional().default(1),
      scoring: z.enum(["weighted", "unscored"]).optional().default("weighted"),
      /**
       * The highest score a record may show while this check is an
       * unresolved gap, weighted or unscored. Undeclared, every unresolved
       * check still caps the score at 99, so a gap never displays as 100.
       */
      scoreCap: z.number().int().min(0).max(99).optional(),
      exceptions: z
        .enum(["inherit", "forbidden"])
        .optional()
        .default("inherit"),
      /** Filter-option label. */
      label: nonEmptyString(),
      /** `gap.message` shown beside the check. */
      message: nonEmptyString(),
      /**
       * The Problems coverage meter (`coverageTotalsSchema` key) whose
       * denominator is this check's `expected` population; the generator
       * counts it instead of a hand-written query.
       */
      coverage: nonEmptyString().optional(),
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

  const classificationFieldPolicyMetadataSchema = z
    .object({
      /** A field of the classified (target) entity. */
      field: nonEmptyString(),
      /** The policy where the effective classifier value is a listed key. */
      byValue: z.record(z.string().min(1), fieldPolicyValue),
      /** The policy for every other value, and for no value at all. */
      otherwise: fieldPolicyValue,
    })
    .strict();

  /**
   * A fixed classification (an enum field on this entity) declares, per field
   * of the entity it classifies, whether a value is expected and whether it is
   * allowed. `fields` order is precedence: when evidence in two fields implies
   * different classifications, the earlier field wins.
   */
  const classificationPolicyMetadataSchema = z
    .object({
      /** This entity's enum field whose (effective) value classifies. */
      classifier: nonEmptyString(),
      /** The classified entity and its reference field to this entity. */
      target: z
        .object({ entity: nonEmptyString(), reference: nonEmptyString() })
        .strict(),
      fields: z.array(classificationFieldPolicyMetadataSchema).min(1),
    })
    .strict();

  const entityCapabilitiesMetadataSchema = z
    .object({
      /** Writes land in the audit log; opt out with `false`. */
      auditable: z
        .boolean({ error: "must be a boolean" })
        .optional()
        .default(true),
      /**
       * Direct image storage only. Display imagery is universal and resolved
       * independently from this storage declaration.
       */
      images: imagePolicyMetadataSchema,
      /** Contributes a live row count; opt out with `false`. */
      countable: z
        .boolean({ error: "must be a boolean" })
        .optional()
        .default(true),
      /** Rows carry `deletedAt`; opt out with `false`. */
      softDelete: z
        .boolean({ error: "must be a boolean" })
        .optional()
        .default(true),
      delete: entityDeleteMetadataSchema.nullable(),
      bulkUpdate: entityBulkUpdateMetadataSchema.nullable(),
      merge: z.boolean({ error: "must be a boolean" }),
      /**
       * Who serves delete and merge. Derived as `kernel` for each declared
       * capability; declare it only when a workflow owns one (cookbook).
       */
      operationOwners: z
        .object({
          delete: z.enum(["kernel", "workflow"]).nullable(),
          merge: z.enum(["kernel", "workflow"]).nullable(),
        })
        .strict()
        .optional(),
      /**
       * MCP operations, only for an entity without a kernel repository (USDA).
       * A kernel entity exposes every kernel action except `mcpExclude`.
       */
      mcp: z.array(nonEmptyString()).optional(),
      /** Kernel actions kept off MCP, each with the reason. */
      mcpExclude: z
        .record(nonEmptyString(), nonEmptyString("must give a reason"))
        .optional()
        .default({}),
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
       * `readOnly`: the kernel serves get/list/search only, whatever the
       * other capabilities say; writes stay with the entity's own workflows.
       */
      lifecycle: z.enum(["mutable", "readOnly"]).optional().default("mutable"),
      resolve: entityResolveMetadataSchema.nullable().optional().default(null),
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
      /**
       * Field policies keyed by this entity's classifier values; compiled to
       * `classification-field-policies.gen.ts` and read by one evaluator
       * (`@cubby/schemas/classification-field-policy`).
       */
      classificationPolicies: z
        .array(classificationPolicyMetadataSchema)
        .optional()
        .default([]),
    })
    .strict()
    .transform(({ operationOwners, ...capabilities }) => ({
      ...capabilities,
      operationOwners: operationOwners ?? {
        delete: capabilities.delete === null ? null : ("kernel" as const),
        merge: capabilities.merge ? ("kernel" as const) : null,
      },
    }));

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
              /**
               * The filter fields this preset sets on a `range` descriptor
               * (`{ costMin: 500 }`); the generator turns the roster into the
               * descriptor's expander. Dynamic presets (today-relative dates,
               * open-ended counts) keep an `expandRef`.
               */
              expand: z
                .record(
                  nonEmptyString(),
                  z.union([z.string(), z.number(), z.boolean()]),
                )
                .optional(),
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
      /** Empty-state copy for this `many` relation's derived detail table,
       * replacing the generic "No <plural> yet." sentence. */
      empty: nonEmptyString().optional(),
      mutation: z
        .object({
          source: nonEmptyString(),
          itemSchema: sourceRefMetadataSchema,
          /** One listed row; the relation `listRelation` action returns an array of it. */
          rowSchema: sourceRefMetadataSchema,
          adapter: sourceRefMetadataSchema,
          audiences: z.array(z.enum(["browser", "mcp"])).min(1),
        })
        .strict()
        .optional(),
    })
    .strict();

  /**
   * Everything about an entity's own table beyond its model columns, so the
   * generator emits the complete Drizzle `pgTable` and its `relations()`
   * (`apps/web/src/server/db/generated/entity-tables.gen.ts`). SQL strings
   * name columns as `{columnKey}`; the generator binds each to the table's
   * column (`${table.columnKey}`), so Drizzle renders them exactly as a
   * hand-written `sql` template would.
   *
   * Derived, never declared: the whole-table shortcode unique index, the
   * identity FK to `Entity(id, shortcode)`, and a `<Table>_<column>_idx` index
   * on every reference column that no declared full (non-partial) index
   * leads with (opt out with `unindexedReferences`).
   */
  const entityTableColumnMetadataSchema = z
    .object({
      key: nonEmptyString(),
      kind: z.enum(["text", "identifier", "timestamp", "json"]),
      notNull: z.literal(true).optional(),
      defaultValue: nonEmptyString().optional(),
      /** An entity key, or `user` for the Better-Auth user table. */
      reference: nonEmptyString().optional(),
      /** The TypeScript type the column is narrowed to (`$type<T>()`). */
      type: sourceRefMetadataSchema.optional(),
    })
    .strict();

  const entityTableIndexMetadataSchema = z.union([
    /** `<Table>_<column>_gin_idx`: a trigram GIN index for ILIKE search. */
    z.object({ trigram: nonEmptyString() }).strict(),
    z
      .object({
        /** Defaults to `<Table>_<columns>_key` (unique) or `_idx`. */
        name: nonEmptyString().optional(),
        on: z
          .array(
            z.union([
              nonEmptyString().transform((column) => ({ column, desc: false })),
              z
                .object({ column: nonEmptyString(), desc: z.literal(true) })
                .strict(),
              z.object({ sql: nonEmptyString() }).strict(),
            ]),
          )
          .min(1),
        unique: z.literal(true).optional(),
        using: z.literal("gin").optional(),
        where: nonEmptyString().optional(),
      })
      .strict(),
  ]);

  const entityTableCheckMetadataSchema = z.union([
    z.object({ name: nonEmptyString(), sql: nonEmptyString() }).strict(),
    /**
     * `<Table>_<column>_check`: the column stays inside a closed value set.
     * Values default to the field's declared read enum. A CHECK already
     * admits NULL, so `nullClause` (a leading `col IS NULL OR`) and `bare`
     * (unqualified `"col"` rather than `"Table"."col"`) change only the
     * constraint's text — which Drizzle's snapshot compares, so existing
     * constraints keep the spelling they were created with.
     */
    z
      .object({
        name: nonEmptyString().optional(),
        column: nonEmptyString(),
        values: z.array(nonEmptyString()).min(1).optional(),
        nullClause: z.literal(true).optional(),
        bare: z.literal(true).optional(),
      })
      .strict(),
  ]);

  /**
   * Drizzle relational-query relations, keyed by the name `with: {}` uses.
   * A string is a reference column: `one()` to the entity it references.
   * Targets name Drizzle table exports (`recipeSection`, `inventoryEntry`).
   */
  const entityTableRelationMetadataSchema = z.union([
    nonEmptyString().transform((field) => ({
      field,
      relationName: undefined,
    })),
    z
      .object({ field: nonEmptyString(), relationName: nonEmptyString() })
      .strict(),
    z
      .object({
        one: nonEmptyString(),
        field: nonEmptyString().optional(),
        references: nonEmptyString().optional(),
      })
      .strict(),
    z
      .object({
        many: nonEmptyString(),
        relationName: nonEmptyString().optional(),
      })
      .strict(),
  ]);

  const entityTableStorageMetadataSchema = z
    .object({
      /** Operational columns no model field declares. */
      columns: z.array(entityTableColumnMetadataSchema).optional().default([]),
      indexes: z.array(entityTableIndexMetadataSchema).optional().default([]),
      checks: z.array(entityTableCheckMetadataSchema).optional().default([]),
      /** Reference column key → why it has no index of its own. */
      unindexedReferences: z
        .record(nonEmptyString(), nonEmptyString())
        .optional()
        .default({}),
      relations: z
        .record(nonEmptyString(), entityTableRelationMetadataSchema)
        .optional()
        .default({}),
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
              label: { module: "~/entity/entities", export: "entityLabel" },
              resolver: {
                module: "~/server/repo/shortcode-resolver",
                export: "resolveLiveShortcode",
              },
            }),
          filters: sourceRefMetadataSchema.nullable().optional().default({
            module: "~/entity/filter-manifest",
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
      storage: entityTableStorageMetadataSchema.optional(),
      children: z.array(childTableMetadataSchema).optional().default([]),
      filters: z
        .object({
          audit: z.boolean({ error: "must be a boolean" }).optional(),
          schema: sourceRefMetadataSchema.nullable().optional(),
          descriptors: z.array(entityFilterDescriptorMetadataSchema),
        })
        .strict(),
      relations: z.array(entityRelationMetadataSchema),
      /**
       * `semantic`: lexical search plus an `EntityEmbedding` vector.
       * `lexical`: search without a vector (the financial entities, whose
       * money and settlement text carries no useful meaning to embed).
       * `false`: not searchable.
       */
      search: z
        .union([z.enum(["semantic", "lexical"]), z.literal(false)])
        .transform((search) => ({
          enabled: search !== false,
          embedding: search === "semantic",
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

// Built lazily (the schemas are large) and once: rebuilding them per parse
// made Zod re-JIT every object schema on each declaration.
let metadataSchemaCache: ReturnType<typeof buildMetadataSchemas> | undefined;
const metadataSchemas = () => (metadataSchemaCache ??= buildMetadataSchemas());

type EntityMetadataSchemas = ReturnType<typeof buildMetadataSchemas>;
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

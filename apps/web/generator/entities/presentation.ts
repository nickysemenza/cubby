import { displayItems } from "@cubby/schemas/entity-definitions/label-field";
import { z } from "zod";
import {
  requireNativeCoverage,
  rendererReadInputs,
} from "@cubby/schemas/compiler/native-coverage";
import type { RawReadSchemas } from "@cubby/schemas/entity-definitions/definition";
import { relationshipProvenanceSchema } from "./list-fields.ts";
import { curatedConnectionViews } from "@cubby/schemas/compiler/connected-view-definitions";
import { listViewId } from "@cubby/schemas/entity-definitions/definition";
import { relationSectionPlanSchema } from "@cubby/schemas/entity-definitions/relation-plan";
import type {
  CompiledEditSection,
  EntityDeclarationMetadata,
  EntityPresentation,
} from "@cubby/schemas/entity-definitions/definition";
import { EntityDeclarationError } from "./declarations.ts";
import type {
  CompiledEntity,
  CompiledPresentation,
  EntityField,
  EntityFieldModel,
} from "./declarations.ts";

/** Section ids the renderers derive from capabilities, never declared. */
const RESERVED_SECTION_IDS = new Set(["history", "relationships", "images"]);

export const detailSectionInOverview = (
  overviewSections: readonly string[] | null,
  id: string,
): boolean => overviewSections === null || overviewSections.includes(id);

type PresentationFacts = Readonly<{
  fieldModel: EntityFieldModel;
  relations: EntityDeclarationMetadata["relations"];
  capabilities: EntityDeclarationMetadata["capabilities"];
  ports: CompiledEntity["ports"];
  hasUpdate: boolean;
  readSchemas: RawReadSchemas;
}>;

type Surface = "list" | "detail";
const PATH =
  /^[A-Za-z_]\w*(?:\[(?:\d*)\])*(?:\.[A-Za-z_]\w*(?:\[(?:\d*)\])*)*$/u;

/** Resolve only the existing read-path grammar; never execute schemas to invent sample data. */
export function schemaAtReadPath(
  schema: z.ZodType,
  path: string,
): z.ZodType | null {
  if (!PATH.test(path)) return null;
  const steps = [...path.matchAll(/([A-Za-z_]\w*)|\[(\d*)\]/gu)].map(
    (match) => match[1] ?? (match[2] === "" ? null : Number(match[2])),
  );
  const active = new WeakMap<z.ZodType, Set<number>>();
  const walk = (current: z.ZodType, position: number): z.ZodType | null => {
    const seen = active.get(current) ?? new Set<number>();
    if (seen.has(position)) return null;
    seen.add(position);
    active.set(current, seen);
    try {
      if (
        current instanceof z.ZodOptional ||
        current instanceof z.ZodNullable ||
        current instanceof z.ZodDefault ||
        current instanceof z.ZodPrefault ||
        current instanceof z.ZodCatch ||
        current instanceof z.ZodReadonly ||
        current instanceof z.ZodNonOptional
      ) {
        const inner = current.unwrap();
        return inner instanceof z.ZodType ? walk(inner, position) : null;
      }
      if (current instanceof z.ZodLazy) {
        const inner = current.unwrap();
        return inner instanceof z.ZodType ? walk(inner, position) : null;
      }
      if (
        current instanceof z.ZodPipe &&
        current.out instanceof z.ZodType &&
        !(current.out instanceof z.ZodTransform)
      )
        return walk(current.out, position);
      if (current instanceof z.ZodUnion) {
        const branches = current.options.filter(
          (branch) =>
            !(branch instanceof z.ZodNull) &&
            !(branch instanceof z.ZodUndefined),
        );
        const leaves = branches.map((branch) =>
          branch instanceof z.ZodType ? walk(branch, position) : null,
        );
        if (leaves.length === 0 || leaves.some((leaf) => leaf === null))
          return null;
        const inhabited = leaves.filter(
          (leaf) => !(leaf instanceof z.ZodNever),
        );
        const first = inhabited[0];
        if (!first) return null;
        return inhabited.every(
          (leaf) => leaf?._zod.def.type === first._zod.def.type,
        )
          ? first
          : null;
      }
      if (position === steps.length) return current;
      const step = steps[position];
      if (step === null || typeof step === "number") {
        if (
          current instanceof z.ZodArray &&
          current.element instanceof z.ZodType
        )
          return walk(current.element, position + 1);
        if (current instanceof z.ZodTuple) {
          const children =
            typeof step === "number"
              ? [current._zod.def.items[step] ?? current._zod.def.rest]
              : [
                  ...current._zod.def.items,
                  ...(current._zod.def.rest ? [current._zod.def.rest] : []),
                ];
          if (children.length === 0) return z.never();
          const leaves = children.map((child) =>
            child instanceof z.ZodType ? walk(child, position + 1) : null,
          );
          const first = leaves[0];
          return first &&
            leaves.every((leaf) => leaf?._zod.def.type === first._zod.def.type)
            ? first
            : null;
        }
        return null;
      }
      if (step === undefined || !(current instanceof z.ZodObject)) return null;
      const child: unknown = current.shape[step];
      return child instanceof z.ZodType ? walk(child, position + 1) : null;
    } finally {
      seen.delete(position);
    }
  };
  return walk(schema, 0);
}

const valuePath = (
  field: EntityField,
  schema: z.ZodType,
  surface: Surface,
): string | null => {
  if (
    surface === "list" &&
    field.display.standard === "image" &&
    schemaAtReadPath(schema, "displayImages")
  )
    return "displayImages";
  const rendered =
    surface === "list"
      ? field.display.labelPath
      : (field.display.itemsPath ?? field.display.detailLabelPath);
  if (rendered && field.reference === null)
    return schemaAtReadPath(schema, rendered) ? rendered : null;
  const readable = (path: string) => {
    const leaf = schemaAtReadPath(schema, path);
    if (leaf === null) return false;
    if (field.reference === null || field.kind === "number") return true;
    if (
      field.reference.multiple &&
      !(leaf instanceof z.ZodArray || leaf instanceof z.ZodTuple) &&
      !path.includes("[]")
    )
      return false;
    const itemPath =
      field.reference.multiple &&
      (leaf instanceof z.ZodArray || leaf instanceof z.ZodTuple)
        ? `${path}[]`
        : path;
    const item = schemaAtReadPath(schema, itemPath);
    return (
      item?._zod.def.type === "string" ||
      schemaAtReadPath(schema, `${itemPath}.id`)?._zod.def.type === "string"
    );
  };
  if (field.display.readPath !== null)
    return readable(field.display.readPath) ? field.display.readPath : null;
  if (field.readKey !== null && readable(field.readKey)) return field.readKey;
  if (field.reference !== null) {
    const nested = field.key.replace(/Ids?$/u, "");
    if (
      schemaAtReadPath(
        schema,
        `${nested}${field.reference.multiple ? "[]" : ""}.id`,
      )?._zod.def.type === "string"
    )
      return nested;
  }
  return null;
};

const labelPathAvailable = (root: z.ZodType, path: string): boolean => {
  const leaf = schemaAtReadPath(root, path);
  return (
    leaf?._zod.def.type === "string" ||
    (leaf instanceof z.ZodArray &&
      schemaAtReadPath(root, `${path}[]`)?._zod.def.type === "string")
  );
};

/** A renderer's minimum input projection must exist with compatible output types on every branch. */
function rendererInputAvailable(
  root: z.ZodType,
  path: string,
  expected: z.ZodType,
): boolean {
  const actual = schemaAtReadPath(root, path);
  const wanted = schemaAtReadPath(z.object({ value: expected }), "value");
  if (actual === null || wanted === null) return false;
  if (actual instanceof z.ZodNever || actual === wanted) return true;
  if (wanted instanceof z.ZodObject)
    return (
      actual instanceof z.ZodObject &&
      Object.entries(wanted.shape).every(
        ([key, schema]) =>
          schema instanceof z.ZodType &&
          rendererInputAvailable(root, `${path}.${key}`, schema),
      )
    );
  if (wanted instanceof z.ZodArray && wanted.element instanceof z.ZodType)
    return (
      (actual instanceof z.ZodArray || actual instanceof z.ZodTuple) &&
      rendererInputAvailable(root, `${path}[]`, wanted.element)
    );
  if (wanted instanceof z.ZodString && actual instanceof z.ZodEnum)
    return actual.options.every((value) => typeof value === "string");
  return actual._zod.def.type === wanted._zod.def.type;
}

const genericValueAvailable = (
  field: EntityField,
  schema: z.ZodType,
  path: string,
  surface: Surface,
): boolean => {
  const leaf = schemaAtReadPath(schema, path);
  if (leaf === null) return false;
  const label =
    surface === "list"
      ? field.display.labelPath
      : field.display.detailLabelPath;
  if (label) return labelPathAvailable(schema, label);
  if (surface === "detail" && field.display.itemsPath)
    return rendererInputAvailable(
      schema,
      field.display.itemsPath,
      displayItems,
    );
  if (field.reference !== null && field.kind !== "number") return true;
  if (surface === "list" && field.display.standard === "image")
    return leaf instanceof z.ZodArray;
  const type = leaf._zod.def.type;
  if (field.display.readPath !== null)
    return [
      "string",
      "number",
      "boolean",
      "date",
      "object",
      "array",
      "tuple",
      "union",
      "record",
      "enum",
      "literal",
    ].includes(type);
  switch (field.kind) {
    case "number":
      return type === "number";
    case "boolean":
      return type === "boolean";
    case "date":
    case "timestamp":
      return type === "string" || type === "date";
    case "identifier":
      return type === "string" || type === "number";
    case "text":
    case "enum":
      return (
        type === "string" ||
        type === "enum" ||
        (leaf instanceof z.ZodLiteral &&
          [...leaf.values].every((value) => typeof value === "string"))
      );
    case "text-array":
      return leaf instanceof z.ZodArray;
    case "dateRange":
      return type === "object";
    case "json":
      return [
        "object",
        "array",
        "tuple",
        "union",
        "record",
        "string",
        "number",
        "boolean",
        "enum",
        "literal",
      ].includes(type);
    default: {
      const exhaustive: never = field.kind;
      return exhaustive;
    }
  }
};

const coverage = (
  surface: Surface | "control",
  id: string,
  context: string,
) => {
  try {
    requireNativeCoverage(surface, id);
  } catch (error) {
    throw new EntityDeclarationError(
      `${context}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export function resolveFieldDisplay(
  field: EntityField,
  raw: { list?: boolean; detail?: boolean },
  schemas: RawReadSchemas,
  context: string,
  companion = false,
): EntityField {
  if (field.control?.renderer)
    coverage("control", field.control.renderer, context);
  const resolve = (surface: Surface) => {
    const schema = schemas[surface];
    const renderer = field.display.renderer?.[surface];
    if (renderer) coverage(surface, renderer, context);
    const inputs = renderer ? rendererReadInputs(surface, renderer) : null;
    const path = valuePath(field, schema, surface);
    const labels =
      surface === "detail"
        ? field.display.itemsPath
          ? null
          : (field.display.detailLabelPath ??
            (field.reference !== null ? field.display.labelPath : null))
        : field.display.labelPath;
    const items = surface === "detail" ? field.display.itemsPath : null;
    const missingInput = inputs?.find(
      (input) => !rendererInputAvailable(schema, input.path, input.schema),
    )?.path;
    const generic =
      path !== null && genericValueAvailable(field, schema, path, surface);
    const available = inputs ? missingInput === undefined : generic;
    const explicit = raw[surface];
    if (explicit !== false) {
      for (const [name, target] of [
        ["labelPath", labels],
        ["itemsPath", items],
      ] as const) {
        if (
          target &&
          (name === "itemsPath"
            ? !rendererInputAvailable(schema, target, displayItems)
            : !labelPathAvailable(schema, target))
        )
          throw new EntityDeclarationError(
            `${context}.${field.key}.${surface}.${name} ${JSON.stringify(target)} is unavailable in the actual ${surface} schema.`,
          );
      }
    }

    if ((explicit === true || (renderer && explicit !== false)) && !available)
      throw new EntityDeclarationError(
        `${context}.${field.key}.${surface} unavailable: path ${JSON.stringify(field.display.readPath ?? field.readKey ?? field.key)} or renderer input ${JSON.stringify(missingInput)} is absent or unsupported in the actual ${surface} schema.`,
      );
    const defaultEnabled = available && !companion;
    if (explicit !== undefined && explicit === defaultEnabled)
      throw new EntityDeclarationError(
        `${context}.${field.key}.${surface} override is redundant with schema eligibility (${defaultEnabled}).`,
      );
    const enabled = explicit ?? defaultEnabled;
    if (
      enabled &&
      field.reference !== null &&
      !field.reference.multiple &&
      !field.display.detailLabelPath &&
      !items
    ) {
      const stem = field.key.replace(/Ids?$/u, "");
      const alias = [`${stem}Label`, `${stem}DisplayLabel`].find((path) =>
        labelPathAvailable(schema, path),
      );
      if (
        alias &&
        !labelPathAvailable(schema, `${stem}Name`) &&
        !labelPathAvailable(schema, `${stem}.name`) &&
        field.display.labelPath === null
      )
        throw new EntityDeclarationError(
          `${context}.${field.key}.${surface} must declare display.labelPath for custom reference label ${alias}.`,
        );
    }
    return enabled;
  };
  return {
    ...field,
    display: {
      ...field.display,
      list: resolve("list"),
      detail: resolve("detail"),
    },
  };
}

const readableFields = (
  fieldModel: EntityFieldModel,
  schema: z.ZodType,
  surface: Surface,
) =>
  new Map(
    fieldModel.fields
      .filter((field) => {
        const inputs = rendererReadInputs(
          surface,
          field.display.renderer?.[surface] ?? "",
        );
        const path = valuePath(field, schema, surface);
        return inputs
          ? inputs.every((input) =>
              rendererInputAvailable(schema, input.path, input.schema),
            )
          : path !== null &&
              genericValueAvailable(field, schema, path, surface);
      })
      .map((field) => [field.key, field]),
  );

/**
 * Resolve the presentation defaults that depend on other declaration facts
 * and check every key it names against the field model, the relations and
 * the capabilities. Cross-entity facts (a relation section's descriptor on
 * the target) are checked by `validateRelationSections` once every entity is
 * compiled.
 */
type FieldLookup = Readonly<{
  read: (key: string, where: string) => EntityField;
  edit: (key: string, where: string) => EntityField;
  context: string;
}>;

const fieldLookup = (
  fieldModel: EntityFieldModel,
  context: string,
  schema: z.ZodType,
  surface: Surface = "detail",
): FieldLookup => {
  const byKey = readableFields(fieldModel, schema, surface);
  return {
    context,
    read: (key, where) => {
      const field = byKey.get(key);
      if (field === undefined)
        throw new EntityDeclarationError(
          `${context}.${where} names ${key}, which is not a readable field.`,
        );
      return field;
    },
    edit: (key, where) => {
      const field = fieldModel.fields.find(
        (candidate) => candidate.key === key,
      );
      if (
        field === undefined ||
        (field.validation.create === null && field.validation.update === null)
      )
        throw new EntityDeclarationError(
          `${context}.${where} names ${key}, which is not an editable field.`,
        );
      return field;
    },
  };
};

/** A json read shaped `{ locationId, … }` (Product's primary placement). */
const isPlacementField = (field: EntityFieldModel["fields"][number]) => {
  if (field.kind !== "json") return false;
  let read: unknown = field.validation.read;
  while (read instanceof z.ZodNullable || read instanceof z.ZodOptional)
    read = read.unwrap();
  return read instanceof z.ZodObject && "locationId" in read.shape;
};

const checkHero = (
  hero: EntityPresentation["detail"]["hero"],
  lookup: FieldLookup,
  quick: Readonly<{
    detail: readonly string[];
    list: readonly string[];
    listActions: readonly string[];
  }>,
) => {
  // A quick action promotes a declared verb to a leading button; it never adds one.
  for (const [where, verbs, declared] of [
    ["detail.quickActions", quick.detail, hero.actions],
    ["list.quickActions", quick.list, quick.listActions],
  ] as const) {
    if (new Set(verbs).size !== verbs.length)
      throw new EntityDeclarationError(
        `${lookup.context}.${where} repeats a verb.`,
      );
    for (const verb of verbs)
      if (!declared.includes(verb))
        throw new EntityDeclarationError(
          `${lookup.context}.${where} names ${verb}, which is not in ${where === "detail.quickActions" ? "detail.hero.extraActions" : "list.extraActions"}.`,
        );
  }
  if (hero.chip !== null) {
    const field = lookup.read(hero.chip, "detail.hero.chip");
    if (field.kind !== "enum" && field.kind !== "boolean")
      throw new EntityDeclarationError(
        `${lookup.context}.detail.hero.chip ${hero.chip} must be an enum or boolean field.`,
      );
  }
  if (hero.breadcrumb !== null) {
    const field = lookup.read(hero.breadcrumb, "detail.hero.breadcrumb");
    if (field.reference === null && !isPlacementField(field))
      throw new EntityDeclarationError(
        `${lookup.context}.detail.hero.breadcrumb ${hero.breadcrumb} must be a reference field or a placement object with a locationId.`,
      );
  }
  if (hero.when !== null) {
    const field = lookup.read(hero.when.field, "detail.hero.when");
    if (field.kind !== "date" && field.kind !== "timestamp")
      throw new EntityDeclarationError(
        `${lookup.context}.detail.hero.when ${hero.when.field} must be a date or timestamp field.`,
      );
  }
};

/** Returns whether a timeline section is declared. */
const checkSections = (
  sections: EntityPresentation["detail"]["sections"],
  summary: EntityPresentation["detail"]["summary"],
  fieldModel: EntityFieldModel,
  relations: EntityDeclarationMetadata["relations"],
  lookup: FieldLookup,
): boolean => {
  const { context } = lookup;
  const detailFieldKeys = new Set(
    fieldModel.fields
      .filter((field) => field.display.detail)
      .map((field) => field.key),
  );
  const sectionIds = new Set<string>();
  const namedDetailFields = new Map<string, string>();
  const manyRelations = new Set(
    relations
      .filter((relation) => relation.cardinality === "many")
      .map((relation) => relation.key),
  );
  let timelineSection = false;
  for (const section of sections) {
    const where = `detail.sections[${section.id}]`;
    if (RESERVED_SECTION_IDS.has(section.id))
      throw new EntityDeclarationError(
        `${context}.${where} uses a reserved id (history, relationships and images are derived).`,
      );
    if (sectionIds.has(section.id))
      throw new EntityDeclarationError(
        `${context}.detail.sections repeats the id ${section.id}.`,
      );
    sectionIds.add(section.id);
    switch (section.kind) {
      case "fields":
        for (const key of section.fields) {
          lookup.read(key, where);
          if (!detailFieldKeys.has(key))
            throw new EntityDeclarationError(
              `${context}.${where} names ${key}, which is not a display.detail field.`,
            );
          const owner = namedDetailFields.get(key);
          if (owner !== undefined)
            throw new EntityDeclarationError(
              `${context}.${where} names ${key}, already placed in ${owner}.`,
            );
          namedDetailFields.set(key, section.id);
        }
        break;
      case "relation":
        for (const key of section.contextFields) {
          lookup.read(key, where);
          if (!detailFieldKeys.has(key) || namedDetailFields.has(key))
            throw new EntityDeclarationError(
              `${context}.${where} context field ${key} must be a unique display.detail field.`,
            );
          namedDetailFields.set(key, section.id);
        }
        if (!manyRelations.has(section.relation))
          throw new EntityDeclarationError(
            `${context}.${where} relation ${section.relation} is not a many-cardinality relation.`,
          );
        break;
      case "timeline":
        timelineSection = true;
        break;
      case "slot":
        if (section.explanationField !== null) {
          const field = lookup.read(section.explanationField, where);
          if (field.explanation === null)
            throw new EntityDeclarationError(
              `${context}.${where} explanationField ${section.explanationField} has no declared explanation.`,
            );
        }
        break;
    }
  }
  // A summary slot is a placement too: both clients omit its fields from
  // later field sections. A listHidden field may stay off the page.
  const summarized = new Set(
    summary.flatMap((slot) => (slot.kind === "fields" ? slot.fields : [])),
  );
  const orphans = fieldModel.fields
    .filter(
      (field) =>
        field.display.detail &&
        !field.display.listHidden &&
        !namedDetailFields.has(field.key) &&
        !summarized.has(field.key),
    )
    .map((field) => field.key);
  if (orphans.length > 0)
    throw new EntityDeclarationError(
      `${context}.detail.sections leave display.detail fields unplaced: ${orphans.join(", ")}.`,
    );
  return timelineSection;
};

/**
 * The generic list verbs an entity's capabilities imply. Workflow-owned
 * deletes and merges and read-only kernels get none: their verbs live with the
 * workflow that owns them.
 */
const derivedListActions = (
  capabilities: EntityDeclarationMetadata["capabilities"],
  hasBulkUpdate: boolean,
): string[] => {
  if (capabilities.lifecycle === "readOnly") return [];
  return [
    ...(hasBulkUpdate ? ["bulkEdit"] : []),
    ...(capabilities.merge && capabilities.operationOwners.merge === "kernel"
      ? ["merge"]
      : []),
    ...(capabilities.delete !== null &&
    capabilities.operationOwners.delete === "kernel"
      ? ["delete"]
      : []),
  ];
};

const checkList = (
  list: EntityPresentation["list"],
  capabilities: EntityDeclarationMetadata["capabilities"],
  timelineSection: boolean,
  lookup: FieldLookup,
  hierarchy: EntityFieldModel["hierarchy"],
) => {
  const { context } = lookup;
  const viewIds = new Set<string>();
  for (const view of list.views) {
    const id = listViewId(view);
    if (viewIds.has(id))
      throw new EntityDeclarationError(
        `${context}.list.views repeats the view ${id}.`,
      );
    viewIds.add(id);
  }
  for (const key of list.shelf?.subtitle ?? [])
    lookup.read(key, "list.shelf.subtitle");
  for (const filter of list.initialFilter)
    lookup.read(filter.id, "list.initialFilter");
  if (list.tree !== null) {
    if (hierarchy === null)
      throw new EntityDeclarationError(
        `${lookup.context}.list.tree requires model.hierarchy.`,
      );
    const parent = lookup.read(hierarchy.parentField, "model.hierarchy");
    if (parent.readKey === null)
      throw new EntityDeclarationError(
        `${lookup.context}.list.tree nests by model.hierarchy.parentField ${hierarchy.parentField}, which must be readable.`,
      );
    if (!list.tree.toggle && !list.tree.defaultNested)
      throw new EntityDeclarationError(
        `${lookup.context}.list.tree.defaultNested false without toggle never nests.`,
      );
  }
  if (
    (timelineSection || viewIds.has("timeline")) &&
    capabilities.timeline === null
  )
    throw new EntityDeclarationError(
      `${context} declares a timeline section or view without capabilities.timeline.`,
    );
  if (list.timeline !== null) {
    if (capabilities.timeline === null)
      throw new EntityDeclarationError(
        `${context}.list.timeline needs capabilities.timeline.`,
      );
    checkListTimeline(list.timeline, lookup);
  }
};

const checkListTimeline = (
  timeline: NonNullable<EntityPresentation["list"]["timeline"]>,
  lookup: FieldLookup,
) => {
  const dateKey = (key: string, where: string) => {
    const [root, endpoint] = key.split(".");
    const field = lookup.read(root ?? key, where);
    if (
      field.kind === "dateRange" &&
      (endpoint === "start" || endpoint === "end")
    )
      return;
    if (field.kind !== "date" && field.kind !== "timestamp")
      throw new EntityDeclarationError(
        `${lookup.context}.${where} ${key} must be a date or timestamp field.`,
      );
  };
  for (const key of timeline.fields) dateKey(key, "list.timeline.fields");
  const lifecycle = timeline.lifecycle;
  if (lifecycle === null) return;
  for (const key of lifecycle.start)
    dateKey(key, "list.timeline.lifecycle.start");
  for (const key of lifecycle.milestones)
    dateKey(key, "list.timeline.lifecycle.milestones");
  if (lifecycle.end !== null)
    dateKey(lifecycle.end, "list.timeline.lifecycle.end");
};

/**
 * Field keys the editors' image block owns on both platforms (web
 * `entity-edit-dialog-content.tsx`, native `EntityEditorSheet.imageKeys` +
 * `GenericEntityEditModel`): never drawn as field controls, so never placed
 * in a declared edit section.
 */
const IMAGE_BLOCK_FIELD_KEYS = new Set([
  "pendingImageIds",
  "pendingImagePurposes",
  "removeImageIds",
  "imageOrder",
]);

/**
 * The editor's sections, complete: each controlled field of the payload
 * rosters and edit intents appears exactly once, so the web and native
 * editors render the same groups without a fallback of their own. Fields no
 * declared section names form the untitled `main` section, which leads unless
 * a bare `{ id: "main" }` entry places it.
 */
const compileEditSections = (
  sections: EntityPresentation["edit"]["sections"],
  fieldModel: EntityFieldModel,
  lookup: FieldLookup,
): CompiledEditSection[] => {
  const ids = sections.map((section) => section.id);
  const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
  if (repeated !== undefined)
    throw new EntityDeclarationError(
      `${lookup.context}.edit.sections declare ${repeated} twice.`,
    );
  const placed = new Map<string, string>();
  for (const section of sections) {
    if (section.fields === null) continue;
    for (const key of section.fields) {
      lookup.edit(key, `edit.sections[${section.id}]`);
      const previous = placed.get(key);
      if (previous !== undefined)
        throw new EntityDeclarationError(
          `${lookup.context}.edit.sections place ${key} twice (${previous}, ${section.id}).`,
        );
      placed.set(key, section.id);
    }
  }
  const rostered = new Set([
    ...fieldModel.create,
    ...fieldModel.update,
    ...Object.values(fieldModel.intents?.fields ?? {}).flat(),
  ]);
  const main: CompiledEditSection = {
    id: "main",
    title: null,
    collapsed: false,
    fields: fieldModel.fields
      .filter(
        (field) =>
          field.control !== null &&
          rostered.has(field.key) &&
          !IMAGE_BLOCK_FIELD_KEYS.has(field.key) &&
          !placed.has(field.key),
      )
      .map((field) => field.key),
  };
  const declared = sections.some((section) => section.id === "main")
    ? sections
    : [
        { id: "main", title: null, fields: null, collapsed: false },
        ...sections,
      ];
  return declared
    .map((section) =>
      section.fields === null
        ? main
        : {
            id: section.id,
            title: section.title,
            fields: section.fields,
            collapsed: section.collapsed,
          },
    )
    .filter((section) => section.fields.length > 0);
};

const checkEdit = (edit: EntityPresentation["edit"], lookup: FieldLookup) => {
  for (const [index, rule] of edit.hiddenWhen.entries()) {
    const where = `edit.hiddenWhen[${index}]`;
    lookup.read(rule.field, where);
    for (const key of rule.fields) lookup.edit(key, where);
  }
};

/**
 * Resolve the presentation defaults that depend on other declaration facts
 * and check every key it names against the field model, the relations and
 * the capabilities. Cross-entity facts (a relation section's descriptor on
 * the target) are checked by `validateRelationSections` once every entity is
 * compiled.
 */
function checkRecordEmoji(
  presentation: EntityPresentation,
  facts: PresentationFacts,
  context: string,
) {
  const lookup = fieldLookup(
    facts.fieldModel,
    context,
    facts.readSchemas.detail,
  );
  const emojiField = presentation.recordEmojiField;
  if (emojiField) {
    const field = lookup.edit(emojiField, "recordEmojiField");
    if (
      !facts.hasUpdate ||
      field.kind !== "text" ||
      !field.nullable ||
      field.validation.update === null
    )
      throw new EntityDeclarationError(
        `${context}.recordEmojiField requires a nullable, editable text field on a mutable entity.`,
      );
    lookup.read(emojiField, "recordEmojiField");
  }
}

export const compilePresentation = (
  presentation: EntityPresentation,
  facts: PresentationFacts,
  context: string,
): CompiledPresentation => {
  const { fieldModel, relations, capabilities, ports } = facts;
  const lookup = fieldLookup(fieldModel, context, facts.readSchemas.detail);
  const listLookup = fieldLookup(
    fieldModel,
    context,
    facts.readSchemas.list,
    "list",
  );
  const { detail, list } = presentation;
  const emojiField = presentation.recordEmojiField;
  checkRecordEmoji(presentation, facts, context);
  if (presentation.recordIconEntityField) {
    const field = lookup.read(
      presentation.recordIconEntityField,
      "recordIconEntityField",
    );
    if (field.kind !== "text")
      throw new EntityDeclarationError(
        `${context}.recordIconEntityField requires a readable text field.`,
      );
  }
  const edit = {
    ...presentation.edit,
    sections: compileEditSections(
      presentation.edit.sections,
      fieldModel,
      lookup,
    ),
  };
  const declaredSections = detail.sections;
  const sections =
    emojiField &&
    !declaredSections.some(
      (section) =>
        section.kind === "fields" && section.fields.includes(emojiField),
    )
      ? [
          ...declaredSections,
          {
            kind: "fields" as const,
            id: "record-identity",
            title: "Identity",
            placement: "primary" as const,
            fields: [emojiField],
          },
        ]
      : declaredSections;
  checkHero(detail.hero, lookup, {
    detail: detail.quickActions,
    list: list.quickActions,
    listActions: list.actions,
  });
  const summaryIds = new Set<string>();
  for (const slot of detail.summary) {
    if (summaryIds.has(slot.id))
      throw new EntityDeclarationError(
        `${lookup.context}.detail.summary repeats ${slot.id}`,
      );
    summaryIds.add(slot.id);
    if (slot.kind === "fields")
      for (const key of slot.fields) lookup.read(key, "detail.summary.fields");
  }
  const readable = readableFields(
    fieldModel,
    facts.readSchemas.detail,
    "detail",
  );
  const listReadable = readableFields(
    fieldModel,
    facts.readSchemas.list,
    "list",
  );
  const preview = fieldModel.fields
    .filter((field) => field.display.preview)
    .map((field) => {
      // The card renders one compact value per fact; a json blob has none.
      if (
        (!readable.has(field.key) && !listReadable.has(field.key)) ||
        field.kind === "json"
      )
        throw new EntityDeclarationError(
          `${context}: display.preview field "${field.key}" must be a readable, non-json field.`,
        );
      return field.key;
    });
  const timelineSection = checkSections(
    sections,
    detail.summary,
    fieldModel,
    relations,
    lookup,
  );
  checkList(
    list,
    capabilities,
    timelineSection,
    listLookup,
    fieldModel.hierarchy,
  );
  if ((capabilities.timeline === "custom") !== (ports.timeline !== null))
    throw new EntityDeclarationError(
      `${context}.capabilities.timeline "custom" and extensions.ports.timeline must be declared together.`,
    );
  checkEdit(presentation.edit, lookup);
  const mobileSubtitle = fieldModel.fields
    .filter(
      (field) =>
        field.display.mobile?.slot === "subtitle" && field.readKey !== null,
    )
    .sort(
      (left, right) =>
        (left.display.mobile?.priority ?? Number.MAX_SAFE_INTEGER) -
        (right.display.mobile?.priority ?? Number.MAX_SAFE_INTEGER),
    )
    .map((field) => field.key);
  const shelfSubtitle = list.shelf?.subtitle ?? mobileSubtitle;
  return {
    ...presentation,
    edit,
    detail: {
      summary: detail.summary,
      variant: detail.variant,
      hero: {
        ...detail.hero,
        images: capabilities.images.storage === "gallery",
        actions: [
          ...new Set([
            ...(facts.hasUpdate ? ["edit"] : []),
            ...(capabilities.lifecycle !== "readOnly" &&
            capabilities.delete !== null &&
            capabilities.operationOwners.delete === "kernel"
              ? ["delete"]
              : []),
            ...detail.hero.actions,
          ]),
        ],
      },
      quickActions: detail.quickActions,
      sections: sections.map((section) => ({
        ...section,
        overview: detailSectionInOverview(detail.overviewSections, section.id),
      })),
      activityRelations: detail.activityRelations,
      overviewSections: detail.overviewSections,
      preview,
      omitRelations: detail.omitRelations,
      relationFilterOverrides: detail.relationFilterOverrides,
    },
    list: {
      // Cards are a universal alternate renderer. Stored images improve the
      // card, but their absence resolves through the entity icon fallback.
      views: [
        ...(list.views.includes("shelf")
          ? list.views
          : [...list.views, "shelf" as const]),
        ...(capabilities.timeline !== null && !list.views.includes("timeline")
          ? ["timeline" as const]
          : []),
      ],
      viewAliases: list.viewAliases,
      totals: list.totals,
      metrics: list.metrics,
      shelf: { subtitle: shelfSubtitle },
      titleSubtitle: list.titleSubtitle,
      initialFilter: list.initialFilter,
      savedViews: list.savedViews,
      primarySearch: list.primarySearch,
      tree:
        list.tree === null || fieldModel.hierarchy === null
          ? null
          : { parentField: fieldModel.hierarchy.parentField, ...list.tree },
      actions: [
        ...list.actions,
        ...derivedListActions(
          capabilities,
          facts.hasUpdate && fieldModel.bulk.length > 0,
        ),
      ],
      quickActions: list.quickActions,
      links: list.links,
      timeline:
        list.timeline === null
          ? null
          : {
              ...list.timeline,
              lifecycle:
                list.timeline.lifecycle === null
                  ? null
                  : list.timeline.lifecycle,
            },
    },
  };
};

type RelationSection = Extract<
  CompiledEntity["inspector"]["detail"]["sections"][number],
  { kind: "relation" }
>;

const validateRelationPrefill = (
  entity: CompiledEntity,
  target: CompiledEntity,
  section: RelationSection,
  context: string,
) => {
  if (section.prefill === null) return;
  const prefillContext = `${context}.prefill`;
  const prefillField = target.fieldModel.fields.find(
    (candidate) => candidate.key === section.prefill?.field,
  );
  if (prefillField === undefined)
    throw new EntityDeclarationError(
      `${prefillContext}.field ${section.prefill.field} is not declared on ${target.key}.`,
    );
  if (prefillField.reference?.entity !== entity.key)
    throw new EntityDeclarationError(
      `${prefillContext}.field ${section.prefill.field} must reference ${entity.key}.`,
    );
  if (prefillField.validation.create === null)
    throw new EntityDeclarationError(
      `${prefillContext}.field ${section.prefill.field} is not writable on create.`,
    );
};

const validateRelationFilter = (
  entity: CompiledEntity,
  target: CompiledEntity,
  section: RelationSection,
  context: string,
) => {
  const descriptor = target.filterDescriptors.find(
    (candidate) => candidate.columnId === section.filter.descriptor,
  );
  if (descriptor === undefined)
    throw new EntityDeclarationError(
      `${context} filter descriptor ${section.filter.descriptor} does not exist on ${target.key}.`,
    );
  if (descriptor.kind !== "idMulti")
    throw new EntityDeclarationError(
      `${context} filter descriptor ${section.filter.descriptor} on ${target.key} must be an idMulti filter.`,
    );
  if (descriptor.brandRef?.entity !== entity.key)
    throw new EntityDeclarationError(
      `${context} filter descriptor ${section.filter.descriptor} on ${target.key} must reference ${entity.key} (brandRef).`,
    );
};

const validateRelationPresentation = (
  target: CompiledEntity,
  section: RelationSection,
  context: string,
) => {
  const listColumns = new Set(
    target.fieldModel.fields
      .filter((field) => field.display.list)
      .map((field) => field.display.columnId ?? field.key),
  );
  for (const column of section.columns ?? []) {
    if (!listColumns.has(column))
      throw new EntityDeclarationError(
        `${context} column ${column} is not a list column of ${target.key}.`,
      );
  }
  if (section.sort !== null) {
    const sortable = new Set(target.fieldModel.sort?.fields ?? []);
    if (!sortable.has(section.sort.field))
      throw new EntityDeclarationError(
        `${context} sort field ${section.sort.field} is not in ${target.key}'s sort roster.`,
      );
  }
  if (
    section.groupBy != null &&
    !target.fieldModel.grouping.includes(section.groupBy)
  )
    throw new EntityDeclarationError(
      `${context} groupBy ${section.groupBy} is not one of ${target.key}'s model.grouping choices.`,
    );
};

/**
 * A relation section renders the target's list filtered against this record,
 * so the named descriptor must be an id filter on the target that points
 * back at this entity, and its columns must be target list columns.
 */
export const validateRelationSections = (
  entities: readonly CompiledEntity[],
) => {
  const byKey = new Map(entities.map((entity) => [entity.key, entity]));
  for (const entity of entities) {
    for (const chart of entity.inspector.detail.summary) {
      if (chart.kind !== "chart" && chart.kind !== "records") continue;
      const routes = chart.viewKey.startsWith("relation:")
        ? [[chart.viewKey.slice(9)]]
        : Object.entries(curatedConnectionViews)
            .find(([key]) => key === entity.key)?.[1]
            .find((view) => view.key === chart.viewKey)?.routes;
      if (!routes?.length)
        throw new EntityDeclarationError(
          `${entity.key}.detail.summary names an unknown connection view ${chart.viewKey}`,
        );
      for (const route of routes) {
        let target: CompiledEntity | undefined = entity;
        for (const key of route) {
          const relation: CompiledEntity["relations"][number] | undefined =
            target?.relations.find((candidate) => candidate.key === key);
          target =
            relation &&
            relationshipProvenanceSchema.parse(relation.provenance).kind ===
              "local-path"
              ? byKey.get(relation.target)
              : undefined;
        }
        if (!target || (chart.kind === "chart" && target.key !== "expense"))
          throw new EntityDeclarationError(
            `${entity.key}.detail.summary ${chart.id} must traverse local relations${chart.kind === "chart" ? " to Expense" : ""}`,
          );
      }
    }
    for (const entry of entity.inspector.detail.activityRelations) {
      const relation = entity.relations.find(
        (candidate) => candidate.key === entry.relation,
      );
      const target = relation && byKey.get(relation.target);
      const field = target?.fieldModel.fields.find(
        (candidate) => candidate.key === entry.dateField,
      );
      if (
        !relation ||
        relation.cardinality !== "many" ||
        relationshipProvenanceSchema.parse(relation.provenance).kind ===
          "derived" ||
        !field ||
        !["date", "timestamp"].includes(field.kind) ||
        !target?.fieldModel.storage.some(
          (candidate) => candidate.key === entry.dateField,
        )
      ) {
        throw new EntityDeclarationError(
          `${entity.key}.detail.activityRelations requires a stored date on a traversable many relation: ${entry.relation}.${entry.dateField}`,
        );
      }
    }
    for (const section of entity.inspector.detail.sections) {
      if (section.kind !== "relation") continue;
      const context = `${entity.key}.presentation.detail.sections[${section.id}]`;
      const relation = entity.relations.find(
        (candidate) => candidate.key === section.relation,
      );
      if (relation === undefined)
        throw new EntityDeclarationError(
          `${context} names an undeclared relation ${section.relation}.`,
        );
      const target = byKey.get(relation.target);
      if (target === undefined)
        throw new EntityDeclarationError(
          `${context} relation target ${relation.target} is not a declared entity.`,
        );
      validateRelationPrefill(entity, target, section, context);
      validateRelationFilter(entity, target, section, context);
      validateRelationPresentation(target, section, context);
    }
  }
};

/** Resolve relation sections only after inverse relations, filters and sections exist. */
export function resolveRelationSectionPlans(
  entities: readonly CompiledEntity[],
): CompiledEntity[] {
  const byKey = new Map(entities.map((entity) => [entity.key, entity]));
  return entities.map((entity) => ({
    ...entity,
    inspector: {
      ...entity.inspector,
      detail: {
        ...entity.inspector.detail,
        sections: entity.inspector.detail.sections.map((section) => {
          if (section.kind !== "relation") return section;
          const context = `${entity.key}.detail.sections.${section.id}`;
          const relation = entity.relations.find(
            (candidate) => candidate.key === section.relation,
          );
          const target = relation && byKey.get(relation.target);
          if (!target || !relation)
            throw new EntityDeclarationError(
              `${context}: missing relation target.`,
            );
          const descriptor = target.filterDescriptors.find(
            (candidate) => candidate.columnId === section.filter.descriptor,
          );
          if (!descriptor || descriptor.wire.kind !== "param")
            throw new EntityDeclarationError(
              `${context}: relation requires a scalar filter binding.`,
            );
          const intents = target.fieldModel.intents;
          const compatible = (field: EntityField) =>
            intents?.create.filter((intent) =>
              intents.fields[intent]?.includes(field.key),
            ) ?? [];
          // Aliases are compared with actual declared fields; naming conventions stay out of clients.
          const direct = target.fieldModel.fields.find(
            (field) =>
              field.key === descriptor.field ||
              field.key === descriptor.columnId ||
              `${field.key}Filter` === descriptor.field,
          );
          let seedField = section.prefill
            ? target.fieldModel.fields.find(
                (field) => field.key === section.prefill?.field,
              )
            : direct && compatible(direct).length > 0
              ? direct
              : undefined;
          if (!seedField && !section.prefill) {
            const candidates = target.fieldModel.fields.filter(
              (field) =>
                descriptor.brandRef !== null &&
                field.reference?.entity === descriptor.brandRef.entity &&
                compatible(field).length > 0,
            );
            if (candidates.length > 1)
              throw new EntityDeclarationError(
                `${context}: ambiguous create reference; declare prefill.field.`,
              );
            seedField = candidates[0];
          }
          const choices = seedField ? compatible(seedField) : [];
          const explicitIntent = section.prefill?.intent;
          const defaultIntent = intents?.create[0];
          const intent =
            explicitIntent ??
            (defaultIntent && choices.includes(defaultIntent)
              ? defaultIntent
              : choices.length === 1
                ? choices[0]
                : undefined);
          if (explicitIntent && !choices.includes(explicitIntent))
            throw new EntityDeclarationError(
              `${context}: prefill.intent does not create prefill.field.`,
            );
          if (!intent && choices.length > 1)
            throw new EntityDeclarationError(
              `${context}: ambiguous create intent; declare prefill.intent.`,
            );
          if (section.prefill && (!seedField || !intent))
            throw new EntityDeclarationError(
              `${context}: prefill has no compatible create intent.`,
            );
          const backReference =
            direct?.reference?.entity === entity.key ? direct : undefined;
          return {
            ...section,
            plan: relationSectionPlanSchema.parse({
              target: target.key,
              descriptorId: descriptor.columnId,
              filterKey: descriptor.wire.name,
              urlKey: descriptor.urlKey,
              subtree: descriptor.subtree,
              seed:
                seedField && intent
                  ? {
                      field: seedField.key,
                      intent,
                      fields: [...(intents?.fields[intent] ?? [])],
                    }
                  : null,
              seedMultiple: seedField?.reference?.multiple === true,
              columns: section.columns,
              sort: section.sort ?? {
                field: target.fieldModel.sort?.default ?? "createdAt",
                direction: target.fieldModel.sort?.direction ?? "desc",
              },
              limit: section.limit,
              pageSize: section.limit ?? 50,
              groupBy: section.groupBy,
              backReferenceColumn: backReference
                ? (backReference.display.columnId ?? backReference.key)
                : null,
              derived: relation.provenance.kind === "derived",
            }),
          };
        }),
      },
    },
  }));
}

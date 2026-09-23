import { listViewId } from "../../../packages/schemas/src/entity-definitions/definition.ts";
import type {
  EntityDeclarationMetadata,
  EntityPresentation,
} from "../../../packages/schemas/src/entity-definitions/definition.ts";
import { EntityDeclarationError } from "./declarations.ts";
import type {
  CompiledEntity,
  CompiledPresentation,
  EntityField,
  EntityFieldModel,
} from "./declarations.ts";

/** Section ids the renderers derive from capabilities, never declared. */
const RESERVED_SECTION_IDS = new Set(["history", "relationships", "images"]);

type PresentationFacts = Readonly<{
  fieldModel: EntityFieldModel;
  relations: EntityDeclarationMetadata["relations"];
  capabilities: EntityDeclarationMetadata["capabilities"];
  ports: CompiledEntity["ports"];
  hasUpdate: boolean;
  entityKey: string;
}>;

/**
 * A FieldKey is a model field key that the read projection can render: it
 * reads out under its `readKey`, or it is a reference whose target the
 * projection nests under the key minus `Id` (location `parentId` → `parent`).
 */
const readableFields = (fieldModel: EntityFieldModel) =>
  new Map(
    fieldModel.fields
      .filter((field) => field.readKey !== null || field.reference !== null)
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
): FieldLookup => {
  const byKey = readableFields(fieldModel);
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

const checkHero = (
  hero: EntityPresentation["detail"]["hero"],
  lookup: FieldLookup,
) => {
  if (hero.chip !== null) {
    const field = lookup.read(hero.chip, "detail.hero.chip");
    if (field.kind !== "enum" && field.kind !== "boolean")
      throw new EntityDeclarationError(
        `${lookup.context}.detail.hero.chip ${hero.chip} must be an enum or boolean field.`,
      );
  }
  for (const key of hero.stats) lookup.read(key, "detail.hero.stats");
  if (hero.breadcrumb !== null) {
    const field = lookup.read(hero.breadcrumb, "detail.hero.breadcrumb");
    if (field.reference === null)
      throw new EntityDeclarationError(
        `${lookup.context}.detail.hero.breadcrumb ${hero.breadcrumb} must be a reference field.`,
      );
  }
};

/** Returns whether a timeline section is declared. */
const checkSections = (
  sections: EntityPresentation["detail"]["sections"],
  fieldModel: EntityFieldModel,
  relations: EntityDeclarationMetadata["relations"],
  lookup: FieldLookup,
): boolean => {
  const { context } = lookup;
  const detailFieldKeys = new Set(
    [...readableFields(fieldModel).values()]
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
  if (sections.some((section) => section.kind === "fields")) {
    const orphans = [...detailFieldKeys].filter(
      (key) => !namedDetailFields.has(key),
    );
    if (orphans.length > 0)
      throw new EntityDeclarationError(
        `${context}.detail.sections leave display.detail fields unplaced: ${orphans.join(", ")}.`,
      );
  }
  return timelineSection;
};

const checkList = (
  list: EntityPresentation["list"],
  capabilities: EntityDeclarationMetadata["capabilities"],
  timelineSection: boolean,
  lookup: FieldLookup,
  entityKey: string,
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
  if (list.tree !== null) {
    const parent = lookup.read(list.tree.parentField, "list.tree.parentField");
    if (
      parent.reference?.entity !== entityKey ||
      parent.reference.multiple ||
      parent.readKey === null
    )
      throw new EntityDeclarationError(
        `${lookup.context}.list.tree.parentField ${list.tree.parentField} must be a readable single reference to ${entityKey}.`,
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
    const field = lookup.read(key, where);
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
 * Declared `edit.sections` are the whole editor: the native editor renders
 * only the fields a declared section lists (`GenericEntityEditModel.sections`
 * filters by them), so a controlled field in any create/update roster that no
 * section names would silently vanish there. Every controlled field of the
 * payload rosters and of every edit intent must be placed exactly once.
 */
const checkEditSectionCoverage = (
  sections: NonNullable<EntityPresentation["edit"]["sections"]>,
  fieldModel: EntityFieldModel,
  context: string,
) => {
  const placed = new Map<string, string>();
  for (const section of sections) {
    for (const key of section.fields) {
      const previous = placed.get(key);
      if (previous !== undefined)
        throw new EntityDeclarationError(
          `${context}.edit.sections place ${key} twice (${previous}, ${section.id}).`,
        );
      placed.set(key, section.id);
    }
  }
  const controlled = new Set(
    fieldModel.fields
      .filter((field) => field.control !== null)
      .map((field) => field.key),
  );
  const rostered = new Set([
    ...fieldModel.create,
    ...fieldModel.update,
    ...Object.values(fieldModel.intents?.fields ?? {}).flat(),
  ]);
  const missing = [...rostered].filter(
    (key) =>
      controlled.has(key) &&
      !IMAGE_BLOCK_FIELD_KEYS.has(key) &&
      !placed.has(key),
  );
  if (missing.length > 0)
    throw new EntityDeclarationError(
      `${context}.edit.sections leave controlled roster fields unplaced (the native editor drops them): ${missing.join(", ")}.`,
    );
};

const checkEdit = (
  edit: EntityPresentation["edit"],
  fieldModel: EntityFieldModel,
  lookup: FieldLookup,
) => {
  const { context } = lookup;
  for (const section of edit.sections ?? []) {
    for (const key of section.fields)
      lookup.edit(key, `edit.sections[${section.id}]`);
  }
  if (edit.sections !== null && edit.sections !== undefined)
    checkEditSectionCoverage(edit.sections, fieldModel, context);
  for (const key of edit.readOnlyOnUpdate)
    lookup.edit(key, "edit.readOnlyOnUpdate");
  for (const [index, rule] of edit.readOnlyWhen.entries()) {
    const where = `edit.readOnlyWhen[${index}]`;
    const field = lookup.read(rule.field, where);
    const options = field.control?.options ?? null;
    if (rule.equals === true || rule.equals === false) {
      if (field.kind !== "boolean")
        throw new EntityDeclarationError(
          `${context}.${where} compares ${rule.field} to a boolean but it is ${field.kind}.`,
        );
    } else if (
      options !== null &&
      !options.some((option) => option.value === rule.equals)
    ) {
      throw new EntityDeclarationError(
        `${context}.${where} equals ${rule.equals}, which is not one of ${rule.field}'s control options.`,
      );
    } else if (options === null && field.kind !== "enum") {
      throw new EntityDeclarationError(
        `${context}.${where} compares ${rule.field}, which is neither an enum nor a boolean field.`,
      );
    }
    for (const key of rule.fields) lookup.edit(key, where);
  }
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
export const compilePresentation = (
  presentation: EntityPresentation,
  facts: PresentationFacts,
  context: string,
): CompiledPresentation => {
  const { fieldModel, relations, capabilities, ports } = facts;
  const lookup = fieldLookup(fieldModel, context);
  const { detail, list, edit } = presentation;
  checkHero(detail.hero, lookup);
  const timelineSection = checkSections(
    detail.sections,
    fieldModel,
    relations,
    lookup,
  );
  checkList(list, capabilities, timelineSection, lookup, facts.entityKey);
  if ((capabilities.timeline === "custom") !== (ports.timeline !== null))
    throw new EntityDeclarationError(
      `${context}.capabilities.timeline "custom" and extensions.ports.timeline must be declared together.`,
    );
  checkEdit(edit, fieldModel, lookup);
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
    detail: {
      ...detail,
      hero: {
        ...detail.hero,
        images: detail.hero.images ?? capabilities.images.storage === "gallery",
        actions: detail.hero.actions ?? (facts.hasUpdate ? ["edit"] : []),
      },
    },
    list: {
      ...list,
      // Cards are a universal alternate renderer. Stored images improve the
      // card, but their absence resolves through the entity icon fallback.
      views: list.views.includes("shelf")
        ? list.views
        : [...list.views, "shelf"],
      shelf: { subtitle: shelfSubtitle },
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
  if (descriptor.kind !== "id" && descriptor.kind !== "idMulti")
    throw new EntityDeclarationError(
      `${context} filter descriptor ${section.filter.descriptor} on ${target.key} must be an id or idMulti filter.`,
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

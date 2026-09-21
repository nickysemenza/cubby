import type { CompiledEntityPresentation } from "@cubby/schemas/entity-definitions/definition";
import {
  entityFieldModels,
  type EntityFieldModel,
} from "@cubby/schemas/entity-fields";
import { isGalleryEntity } from "@cubby/schemas/entity-manifest";
import { entityAttachmentRead } from "@cubby/schemas/entity-read-media";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { partitionEntityFiles } from "@cubby/schemas/image";
import { Link } from "@tanstack/react-router";
import { Clock, FileText, ImageIcon, Info, Link2, Puzzle } from "lucide-react";
import { Suspense, useMemo, useState } from "react";
import { z } from "zod";

import type {
  DetailHeroActions,
  DetailHeroStat,
} from "~/components/layouts/page-hero";
import { Page } from "~/components/page/Page";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "~/components/ui/breadcrumb";
import { DetailEditAction } from "~/components/ui/detail-edit-action";
import { Skeleton } from "~/components/ui/skeleton";
import { detailFieldRenderersFor } from "~/entities/detail-field-renderers";
import { detailEditRequest } from "~/entities/editing/editor-requests";
import {
  EntityEditDialog,
  type EntityEditDialogRequest,
} from "~/entities/editing/entity-edit-dialog";
import type { EditableEntity } from "~/entities/editing/types";
import {
  entities,
  entityDetailParams,
  isBrowserRoutedEntity,
} from "~/entities/entities";
import {
  entityMutationOptionsFactory,
  isGeneratedBrowserCrudEntity,
} from "~/entities/entity-contracts";
import {
  editableFieldOverrides,
  EntityBasicInfo,
  renderDetailFieldValue,
  type DetailFieldRenderer,
} from "~/entities/entity-display";
import {
  readRecordField,
  readReferenceField,
} from "~/entities/entity-references";
import { FieldExplanation } from "~/entities/field-explanation";
import { getErrorMessage } from "~/lib/error-utils";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";

import {
  actionVerbs,
  type ActionVerbId,
  verbDef,
} from "../actions/action-verbs";
import { EntityActionButtons } from "../actions/entity-actions";
import { type DetailSection, DetailSections } from "../data-table/detail-page";
import { DocumentViewerList } from "../DocumentViewerList";
import EntityImageList from "../EntityImageList";
import { useEntityActionMutation } from "../hooks/useActionMutation";
import { EntityPhotosSection } from "../photos/entity-photos-section";
import {
  EntityTimeline,
  type EntityTimelineOperations,
} from "../timeline/entity-timeline";
import { detailEditOverrideFor } from "./detail-edit-overrides";
import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";
import { detailSlotsFor } from "./detail-slots";
import {
  EntityRelationTable,
  type EntityRelationTableOperations,
  planRelationSection,
  RelationSectionActions,
} from "./entity-relation-table";

export type { DetailRecordOf, GenericDetailEntity } from "./detail-record";

/** What every detail read carries that the generic page reads by name. */
const detailRecordSchema = z.looseObject({
  id: z.string(),
  attachments: z.array(entityAttachmentRead).optional(),
});
type DetailRecordBag = z.output<typeof detailRecordSchema>;

type DeclaredSection = CompiledEntityPresentation["detail"]["sections"][number];
type DisplayField = EntityFieldModel["fields"][number];

/**
 * A declaration's presentation through the widened compiled shape: the
 * per-entity literal types are what the registries key on, but the page
 * itself walks every entity the same way.
 */
const presentationOf = (
  entity: GenericDetailEntity,
): CompiledEntityPresentation & { singular: string } => entitySummary[entity];

const sectionIcon = (kind: DeclaredSection["kind"]) => {
  switch (kind) {
    case "fields":
      return Info;
    case "relation":
      return Link2;
    case "timeline":
      return Clock;
    case "slot":
      return Puzzle;
  }
};

/** Scalar controls the generic inline editor renders as an `EditableCell`. */
const INLINE_EDITABLE_CONTROLS = new Set([
  "text",
  "textarea",
  "number",
  "date",
  "select",
]);

/**
 * The field keys of one `fields` section that the record's update contract
 * edits through a plain scalar control — those get an inline `EditableCell`;
 * reference, structured and boolean fields keep their read-only rendering
 * and are changed through the edit dialog.
 */
function inlineEditableKeys(
  entity: GenericDetailEntity,
  fields: readonly string[],
): string[] {
  if (!isGeneratedBrowserCrudEntity(entity)) return [];
  const model: EntityFieldModel = entityFieldModels[entity];
  const updateRoster: readonly string[] = model.update;
  const editable = new Set<string>(
    model.fields
      .filter(
        (field) =>
          updateRoster.includes(field.key) &&
          field.control !== null &&
          field.reference === null &&
          INLINE_EDITABLE_CONTROLS.has(field.control.kind) &&
          field.readKey !== null,
      )
      .map((field) => field.key),
  );
  return fields.filter((key) => editable.has(key));
}

function useInlineFieldOverrides(
  entity: GenericDetailEntity,
  record: DetailRecordBag,
  fields: readonly string[],
): Record<string, DetailFieldRenderer<DetailRecordBag>> {
  const crud = isGeneratedBrowserCrudEntity(entity) ? entity : null;
  const mutation = useEntityActionMutation({
    // A non-CRUD entity (image, cookbook) never edits inline; the hook still
    // has to run unconditionally, so it binds to `product` and is never
    // invoked (the override set below is empty).
    entity: crud ?? "product",
    operation: "update",
    intent: "full",
    mutationFn: entityMutationOptionsFactory(crud ?? "product", "update"),
    success: (data) => savedWithBackgroundWork(data.sideEffects),
    error: (error) => getErrorMessage(error) || "Failed to save",
  });
  const keys = useMemo(
    () => inlineEditableKeys(entity, fields),
    [entity, fields],
  );
  if (crud === null || keys.length === 0) return {};
  // SAFETY: `keys` names fields of `crud`'s own update contract; the wire
  // variables are parsed by that contract before the mutation executes.
  return editableFieldOverrides(crud, record, keys, (variables) =>
    mutation.mutateAsync(variables as never),
  );
}

function FieldsSection<E extends GenericDetailEntity>({
  entity,
  record,
  fields,
}: {
  entity: E;
  record: DetailRecordOf<E>;
  fields: readonly string[];
}) {
  const bag = detailRecordSchema.parse(record);
  const inline = useInlineFieldOverrides(entity, bag, fields);
  // A domain renderer for a structured field wins over the generic cell; the
  // inline editor covers the plain scalars a renderer never claims.
  const renderers = detailFieldRenderersFor(entity) ?? {};
  const overrides = { ...inline };
  for (const [key, render] of Object.entries(renderers)) {
    if (!fields.includes(key)) continue;
    // SAFETY: `detailFieldRenderersFor` hands back this entity's own
    // renderers, each typed against the record this page received.
    overrides[key] = () => render(record as never);
  }
  return (
    <EntityBasicInfo
      entity={entity}
      fields={fields}
      record={bag}
      overrides={overrides}
    />
  );
}

const chipValue = z.union([z.string(), z.boolean()]).nullish();

/** The label a chip field's value reads as: its option label, or Yes/Not for a boolean. */
function chipLabel(
  field: DisplayField,
  value: z.output<typeof chipValue>,
): string | null {
  if (value === null || value === undefined) return null;
  if (value === true) return field.label;
  if (value === false) return `Not ${field.label.toLocaleLowerCase()}`;
  return (
    field.control?.options?.find((option) => option.value === value)?.label ??
    value
  );
}

/** The chip, stats and breadcrumb the hero declares, read off the record. */
function heroOf<E extends GenericDetailEntity>(
  entity: E,
  record: DetailRecordOf<E>,
) {
  const { hero } = presentationOf(entity).detail;
  const fields: readonly DisplayField[] = entityFieldModels[entity].fields;
  const field = (key: string) =>
    fields.find((candidate) => candidate.key === key);
  const chipField = hero.chip === null ? undefined : field(hero.chip);
  const chip = chipField
    ? chipLabel(
        chipField,
        readRecordField(record, chipField.readKey ?? chipField.key, chipValue),
      )
    : null;
  const heroStamp =
    chip === null ? undefined : { label: chip, tone: "ink" as const };
  const heroStats: DetailHeroStat[] = hero.stats.flatMap((key) => {
    const statField = field(key);
    return statField
      ? [
          {
            label: statField.label,
            value: renderDetailFieldValue(record, statField),
          },
        ]
      : [];
  });
  const breadcrumbField =
    hero.breadcrumb === null ? undefined : field(hero.breadcrumb);
  return { heroStamp, heroStats, breadcrumbField };
}

const ancestorSchema: z.ZodType<{
  id: string;
  name?: string | null;
  parent?: unknown;
}> = z.looseObject({
  id: z.string(),
  name: z.string().nullish(),
  parent: z.unknown().optional(),
});

/**
 * The ancestry a breadcrumb reference field implies: the nested chain under
 * the key minus `Id` (`parent.parent…`) when the projection carries one,
 * else the one linked record.
 */
function ancestry<TRecord extends object>(
  record: TRecord,
  field: DisplayField,
): Array<{ id: string; name: string }> {
  const reference = readReferenceField(record, field);
  if (reference === null || reference.items.length === 0) return [];
  const base = field.key.replace(/Ids?$/u, "");
  const chain: Array<{ id: string; name: string }> = [];
  let current = ancestorSchema.safeParse(
    readRecordField(record, base, z.unknown()),
  );
  while (current.success) {
    chain.unshift({
      id: current.data.id,
      name: current.data.name ?? current.data.id,
    });
    current = ancestorSchema.safeParse(current.data.parent);
  }
  if (chain.length > 0) return chain;
  const [item] = reference.items;
  return item ? [{ id: item.id, name: item.name ?? item.id }] : [];
}

function AncestryBreadcrumb({
  entity,
  chain,
  current,
}: {
  entity: GenericDetailEntity;
  chain: Array<{ id: string; name: string }>;
  current: string;
}) {
  if (chain.length === 0 || !isBrowserRoutedEntity(entity)) return null;
  return (
    <Breadcrumb className="min-h-11 border-y border-border px-2">
      <BreadcrumbList>
        {chain.map((ancestor) => (
          <BreadcrumbItem key={ancestor.id}>
            <BreadcrumbLink
              render={
                <Link
                  to={entities[entity].routes.detail}
                  params={entityDetailParams(ancestor.id)}
                />
              }
            >
              {ancestor.name}
            </BreadcrumbLink>
            <BreadcrumbSeparator />
          </BreadcrumbItem>
        ))}
        <BreadcrumbItem>
          <BreadcrumbPage>{current}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function SlotFallback() {
  return <Skeleton className="h-16 w-full" />;
}

/** The journal variant leads with its relation; the record's own fields become the rail. */
function orderSections(
  variant: CompiledEntityPresentation["detail"]["variant"],
  declared: readonly DeclaredSection[],
  built: DetailSection[],
): DetailSection[] {
  if (variant !== "journal") return built;
  const kindOf = new Map(declared.map((section) => [section.id, section.kind]));
  const relations = built.filter(
    (section) => kindOf.get(section.id) === "relation",
  );
  const rest = built
    .filter((section) => kindOf.get(section.id) !== "relation")
    .map((section) =>
      section.placement === "primary"
        ? { ...section, placement: "supporting" as const }
        : section,
    );
  return [...relations, ...rest];
}

/** Reads the relation tables and timeline section perform; a test seam. */
export interface GenericEntityDetailOperations {
  list?: EntityRelationTableOperations;
  timeline?: EntityTimelineOperations;
}

function declaredSections<E extends GenericDetailEntity>(
  entity: E,
  record: DetailRecordOf<E>,
  bag: DetailRecordBag,
  operations: GenericEntityDetailOperations,
): DetailSection[] {
  const { detail, singular } = presentationOf(entity);
  const slots = detailSlotsFor(entity);
  const built = detail.sections.flatMap((section): DetailSection[] => {
    const base = {
      id: section.id,
      placement: section.placement,
      icon: sectionIcon(section.kind),
      collapsed: section.collapsed,
    };
    switch (section.kind) {
      case "fields":
        return [
          {
            ...base,
            title: section.title,
            content: (
              <FieldsSection
                entity={entity}
                record={record}
                fields={section.fields}
              />
            ),
          },
        ];
      case "relation": {
        const plan = planRelationSection(entity, section);
        const createLabel =
          detail.variant === "journal" ? verbDef("logEntry").label : undefined;
        return [
          {
            ...base,
            title: section.title,
            overflowVisible: true,
            headerAction: (
              <RelationSectionActions
                plan={plan}
                recordId={bag.id}
                title={section.title}
                createLabel={createLabel}
              />
            ),
            content: (
              <EntityRelationTable
                plan={plan}
                recordId={bag.id}
                title={section.title}
                operations={operations.list}
                emptyLabel={
                  detail.variant === "journal"
                    ? "Nothing logged yet — the first entry starts the journal."
                    : undefined
                }
              />
            ),
          },
        ];
      }
      case "timeline":
        // SAFETY: the compiler only admits a timeline section on an entity
        // with `capabilities.timeline`.
        return [
          {
            ...base,
            title: section.title,
            content: (
              <EntityTimeline
                entity={entity as never}
                ids={[bag.id]}
                mode={section.mode}
                operations={operations.timeline}
              />
            ),
          },
        ];
      case "slot": {
        const slot = slots?.[section.id];
        // SAFETY: `detailSlotsFor` hands back this entity's own slots, each
        // typed against the record this page received.
        if (slot === undefined || slot.applies?.(record as never) === false)
          return [];
        const Slot = slot.component;
        const title = section.title ?? singular;
        // SAFETY: the slot is this entity's own (see above).
        return [
          {
            ...base,
            title,
            headerAction: section.explanationField ? (
              <FieldExplanation
                entity={entity}
                id={bag.id}
                field={section.explanationField}
                label={title}
              />
            ) : undefined,
            surface: section.title === null ? ("plain" as const) : undefined,
            content: (
              <Suspense fallback={<SlotFallback />}>
                <Slot record={record as never} />
              </Suspense>
            ),
          },
        ];
      }
    }
  });
  return orderSections(detail.variant, detail.sections, built);
}

/**
 * The entity's own `update:full` request, which the dialog resolves against
 * the editing registry at runtime.
 */
function editRequestFor<E extends GenericDetailEntity>(
  entity: E,
  record: DetailRecordOf<E>,
): EntityEditDialogRequest<EditableEntity> {
  // SAFETY: the caller proved `isGeneratedBrowserCrudEntity(entity)`, i.e.
  // the entity has the standard update contract this request names.
  const request: unknown = detailEditRequest(
    entity as EditableEntity,
    record as never,
  );
  // SAFETY: `detailEditRequest` returns exactly the `update:full` member of
  // the dialog's request union for this entity.
  return request as EntityEditDialogRequest<EditableEntity>;
}

/**
 * The one detail page: every section, the hero and the edit affordance come
 * from `entitySummary[entity].detail`; a slot is the only hand-written fill
 * and renders only where `detailSlots` provides it.
 */
export function GenericEntityDetail<E extends GenericDetailEntity>({
  entity,
  record,
  operations = {},
}: {
  entity: E;
  record: DetailRecordOf<E>;
  operations?: GenericEntityDetailOperations;
}) {
  const { detail, titleField, singular } = presentationOf(entity);
  const bag = detailRecordSchema.parse(record);
  const title =
    readRecordField(record, titleField, z.string().catch("")) || bag.id;
  const { heroStamp, heroStats, breadcrumbField } = heroOf(entity, record);
  const [editing, setEditing] = useState(false);
  const EditOverride = detailEditOverrideFor(entity);
  const heroActions: readonly string[] = detail.hero.actions;
  const editable =
    heroActions.includes("edit") &&
    (EditOverride !== undefined || isGeneratedBrowserCrudEntity(entity));

  const { images, documents } = partitionEntityFiles(bag.attachments ?? []);
  const heroImages = detail.hero.images ? images : undefined;
  const sections = declaredSections(entity, record, bag, operations);

  // Derived from capabilities, never declared: a gallery's photos edit
  // inline; a cover/logo shows what is attached; documents get a viewer.
  if (isGalleryEntity(entity) && isGeneratedBrowserCrudEntity(entity)) {
    // SAFETY: `isGalleryEntity` proves the entity stores a gallery, and a
    // gallery entity's detail id is its own branded shortcode; the record
    // schema above only widens it to string.
    sections.push({
      id: "images",
      title: "Photos",
      icon: ImageIcon,
      placement: "supporting",
      content: (
        <EntityPhotosSection
          entity={entity as never}
          id={bag.id as never}
          images={images}
        />
      ),
    });
  } else if (images.length > 0) {
    sections.push({
      id: "images",
      title: "Images",
      icon: ImageIcon,
      placement: "supporting",
      content: <EntityImageList images={images} />,
    });
  }
  if (documents.length > 0) {
    sections.push({
      id: "documents",
      title: "Documents",
      icon: FileText,
      placement: "primary",
      content: <DocumentViewerList documents={documents} />,
    });
  }

  // `edit` is the page's own affordance (the hero button); every other
  // declared verb is offered from the registry, on the plate.
  const declaredVerbs = heroActions.filter(
    (verb): verb is ActionVerbId => verb !== "edit" && verb in actionVerbs,
  );
  const hasVerbs = declaredVerbs.length > 0;
  const breadcrumbChain = breadcrumbField
    ? ancestry(record, breadcrumbField)
    : [];
  // SAFETY: `detailEditOverrideFor` hands back this entity's own override,
  // typed against the record this page received.
  const overrideRecord = record as never;
  const plateActions: DetailHeroActions | undefined =
    editable || hasVerbs
      ? {
          // Visible text stays "Edit"; the name carries the entity so the
          // control reads "Edit Ingredient" to assistive tech and tests.
          primary: editable ? (
            <DetailEditAction
              aria-label={`Edit ${singular}`}
              onClick={() => setEditing(true)}
            />
          ) : undefined,
          // Overflow-aware: the plate spells every verb out at `md+` and
          // falls back to a primary + "More actions" popover on phone.
          secondary: hasVerbs
            ? (overflow: "inline" | "menu") => (
                <EntityActionButtons
                  entity={entity}
                  // The whole record, not just its id: a verb's availability
                  // reads the fields it gates on (a planting's status hides
                  // "Start planting" once it has started).
                  record={{ ...record, id: bag.id }}
                  verbs={declaredVerbs}
                  overflow={overflow}
                />
              )
            : undefined,
        }
      : undefined;

  return (
    <Page
      variant="detail"
      entity={entity}
      title={title}
      rawData={record}
      heroImages={heroImages}
      heroNo={bag.id}
      heroStamp={heroStamp}
      heroStats={heroStats.length > 0 ? heroStats : undefined}
      heroActions={plateActions}
    >
      <AncestryBreadcrumb
        entity={entity}
        chain={breadcrumbChain}
        current={title}
      />
      <DetailSections
        sections={sections}
        rawData={record}
        heroImages={heroImages}
      />
      {editable && editing ? (
        EditOverride ? (
          <EditOverride
            record={overrideRecord}
            onClose={() => setEditing(false)}
          />
        ) : (
          <EntityEditDialog<EditableEntity>
            open
            onOpenChange={setEditing}
            request={editRequestFor(entity, record)}
          />
        )
      ) : null}
    </Page>
  );
}

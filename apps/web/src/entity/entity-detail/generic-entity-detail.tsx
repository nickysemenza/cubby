import { connectedViews } from "@cubby/schemas/connected-views";
import type { CompiledEntityPresentation } from "@cubby/schemas/entity-definitions/definition";
import {
  entityFieldModels,
  type EntityFieldModel,
} from "@cubby/schemas/entity-fields";
import { isGalleryEntity } from "@cubby/schemas/entity-manifest";
import { entityAttachmentRead } from "@cubby/schemas/entity-read-media";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { imageOut, partitionEntityFiles } from "@cubby/schemas/image";
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { FileTextIcon } from "@phosphor-icons/react/dist/csr/FileText";
import { ImageIcon } from "@phosphor-icons/react/dist/csr/Image";
import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { LinkIcon } from "@phosphor-icons/react/dist/csr/Link";
import { PuzzlePieceIcon } from "@phosphor-icons/react/dist/csr/PuzzlePiece";
import { QuotesIcon } from "@phosphor-icons/react/dist/csr/Quotes";
import { Link } from "@tanstack/react-router";
import { Suspense, useState } from "react";
import { z } from "zod";

import { RecordEmoji } from "~/entity/components/record-emoji";
import { detailEditRequest } from "~/entity/editing/editor-requests";
import {
  EntityEditDialog,
  type EntityEditDialogRequest,
} from "~/entity/editing/entity-edit-dialog";
import type { EditableEntity } from "~/entity/editing/types";
import {
  entities,
  entityDetailParams,
  isBrowserRoutedEntity,
} from "~/entity/entities";
import { isGeneratedBrowserCrudEntity } from "~/entity/entity-contracts";
import { renderDetailFieldValue } from "~/entity/entity-display";
import {
  readRecordField,
  readDisplayReferenceField,
} from "~/entity/entity-references";
import { heroChipLabel } from "~/entity/enum-field-display";
import { FieldExplanation } from "~/entity/field-explanation";
import { RecordSuggestionsProvider } from "~/features/ai/record-suggestions";
import { RecordWorkQueue } from "~/features/work-queue/record-work-queue";
import { useNativeRunEvidence } from "~/lib/native-workspace";
import type { DetailHeroActions, DetailHeroStat } from "~/ui/layouts/page-hero";
import { Page } from "~/ui/page/Page";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "~/ui/primitives/breadcrumb";
import { DetailEditAction } from "~/ui/primitives/detail-edit-action";
import { Skeleton } from "~/ui/primitives/skeleton";

import { EntityPhotosSection } from "../../features/photos/entity-photos-section";
import {
  type DetailSection,
  DetailSections,
} from "../../ui/data-table/detail-page";
import { DocumentViewerList } from "../../ui/DocumentViewerList";
import {
  actionVerbs,
  type ActionVerbId,
  verbDef,
} from "../actions/action-verbs";
import { EntityActionButtons } from "../actions/entity-actions";
import EntityImageList from "../components/EntityImageList";
import {
  EntityTimeline,
  type EntityTimelineOperations,
} from "../timeline/entity-timeline";
import { ConnectedRecordsSection } from "./connected-records-table";
import { DetailActionProvider, DetailActionTarget } from "./detail-action-bar";
import { detailEditOverrideFor } from "./detail-edit-overrides";
import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";
import { detailSlotsFor } from "./detail-slots";
import { EntityRecordFields } from "./entity-record-fields";
import {
  EntityRelationTable,
  type EntityRelationTableOperations,
  planRelationSection,
  RelationSectionActions,
} from "./entity-relation-table";
import { EntitySourcesSection, recordSources } from "./entity-sources-section";
import { RecordQualityProvider, QualitySectionChecks } from "./record-quality";

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
      return InfoIcon;
    case "relation":
      return LinkIcon;
    case "timeline":
      return ClockIcon;
    case "slot":
      return PuzzlePieceIcon;
  }
};

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
  const chip = chipField ? heroChipLabel(entity, record, chipField) : null;
  const heroStamp =
    chip === null ? undefined : { label: chip, tone: "ink" as const };
  const heroStats: DetailHeroStat[] = hero.stats.flatMap((key) => {
    const statField = field(key);
    return statField
      ? [
          {
            label: statField.label,
            value: renderDetailFieldValue(entity, record, statField),
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
  const reference = readDisplayReferenceField(record, field);
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

/** The journal variant leads with its relation; the record's own fields follow. */
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
  const rest = built.filter((section) => kindOf.get(section.id) !== "relation");
  return [...relations, ...rest];
}

/** Reads the relation tables and timeline section perform; a test seam. */
interface GenericEntityDetailOperations {
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
      overview: section.overview,
      workspace:
        section.workspace ??
        (section.kind === "timeline"
          ? "evidence"
          : section.kind === "relation"
            ? "work"
            : undefined),
    };
    switch (section.kind) {
      case "fields":
        return [
          {
            ...base,
            title: section.title,
            content: (
              <EntityRecordFields
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
                  section.empty ??
                  (detail.variant === "journal"
                    ? "Nothing logged yet — the first entry starts the journal."
                    : undefined)
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

/** Keep the complete attachment list separate from Product's item gallery. */
function detailFiles<E extends GenericDetailEntity>(
  entity: E,
  record: DetailRecordOf<E>,
  bag: DetailRecordBag,
) {
  const attachments = partitionEntityFiles(bag.attachments ?? []);
  // Product's domain gallery excludes confirmed labels; the universal
  // attachment list remains complete for documents and write preconditions.
  const images =
    entity === "product"
      ? partitionEntityFiles(
          readRecordField(record, "images", z.array(imageOut).default([])),
        ).images
      : attachments.images;
  const { documents } = attachments;
  return { images, documents };
}

function detailWayfinding<E extends GenericDetailEntity>(
  entity: E,
  record: DetailRecordOf<E>,
) {
  if (entity !== "run") return undefined;
  return readRecordField(record, "purpose", z.string().optional()) ===
    "photo_inventory"
    ? { label: "Photos", domain: null }
    : undefined;
}

/**
 * The one detail page: every section, the hero and the edit affordance come
 * from `entitySummary[entity].detail`; a slot is the only hand-written fill
 * and renders only where `detailSlots` provides it.
 */
type GenericEntityDetailProps<E extends GenericDetailEntity> = {
  entity: E;
  record: DetailRecordOf<E>;
  operations?: GenericEntityDetailOperations;
};

export function GenericEntityDetail<E extends GenericDetailEntity>(
  props: GenericEntityDetailProps<E>,
) {
  return useNativeRunEvidence() ? (
    <RunEvidenceDetail {...props} />
  ) : (
    <FullEntityDetail {...props} />
  );
}

function RunEvidenceDetail<E extends GenericDetailEntity>({
  entity,
  record,
  operations = {},
}: GenericEntityDetailProps<E>) {
  const bag = detailRecordSchema.parse(record);
  const { titleField } = presentationOf(entity);
  const title =
    readRecordField(record, titleField, z.string().catch("")) || bag.id;
  const sections = declaredSections(entity, record, bag, operations).filter(
    (section) => section.workspace === "evidence",
  );
  return (
    <DetailActionProvider>
      <Page
        variant="detail"
        entity={entity}
        title={`${title} · Evidence`}
        wayfinding={false}
        rawData={record}
      >
        <RecordQualityProvider
          entity={entity}
          id={bag.id}
          visibleSections={sections.map((section) => section.id)}
          visibleFields={presentationOf(entity)
            .detail.sections.filter(
              (section) =>
                section.workspace === "evidence" && section.kind === "fields",
            )
            .flatMap((section) =>
              section.kind === "fields" ? section.fields : [],
            )}
        >
          <DetailSections
            onlyWorkspace="evidence"
            sections={sections.map((section) => ({
              ...section,
              content: (
                <>
                  <QualitySectionChecks section={section.id} />
                  {section.content}
                </>
              ),
            }))}
            rawData={record}
          />
        </RecordQualityProvider>
      </Page>
    </DetailActionProvider>
  );
}

function FullEntityDetail<E extends GenericDetailEntity>({
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

  const { images, documents } = detailFiles(entity, record, bag);
  const heroImages = detail.hero.images ? images : undefined;
  const sections = declaredSections(entity, record, bag, operations);
  if (connectedViews[entity].length > 0) {
    sections.push({
      id: "connected-records",
      title: "Connected records",
      workspace: "relations",
      icon: LinkIcon,
      placement: "primary",
      content: <ConnectedRecordsSection source={entity} sourceId={bag.id} />,
    });
  }

  // Derived from capabilities, never declared: a gallery's photos edit
  // inline; a cover/logo shows what is attached; documents get a viewer.
  if (isGalleryEntity(entity) && isGeneratedBrowserCrudEntity(entity)) {
    // SAFETY: `isGalleryEntity` proves the entity stores a gallery, and a
    // gallery entity's detail id is its own branded shortcode; the record
    // schema above only widens it to string.
    sections.push({
      id: "images",
      title: "Photos",
      count: images.length,
      icon: ImageIcon,
      placement: "primary",
      content: (
        <EntityPhotosSection
          entity={entity as never}
          id={bag.id as never}
          images={images}
        />
      ),
    });
  } else {
    sections.push({
      id: "images",
      title: "Images",
      count: images.length,
      icon: ImageIcon,
      placement: "primary",
      content: <EntityImageList images={images} />,
    });
  }
  sections.push({
    id: "documents",
    title: "Documents",
    count: documents.length,
    icon: FileTextIcon,
    placement: "primary",
    content:
      documents.length > 0 ? (
        <DocumentViewerList documents={documents} />
      ) : null,
  });
  const sources = recordSources(record);
  sections.push({
    id: "sources",
    title: "Sources",
    // The section reports its own count: documents shown plus related ones beyond them,
    // not raw citations (several cite one document).
    icon: QuotesIcon,
    placement: "primary",
    content: (
      <EntitySourcesSection
        entity={entity}
        sourceId={bag.id}
        sources={sources}
      />
    ),
  });

  // `edit` is the page's own affordance (the hero button); every other
  // declared verb is offered from the registry, on the plate.
  const declaredVerbs = heroActions.filter(
    (verb): verb is ActionVerbId => verb !== "edit" && verb in actionVerbs,
  );
  const breadcrumbChain = breadcrumbField
    ? ancestry(record, breadcrumbField)
    : [];
  // SAFETY: `detailEditOverrideFor` hands back this entity's own override,
  // typed against the record this page received.
  const overrideRecord = record as never;
  const plateActions: DetailHeroActions = {
    // Visible text stays "Edit"; the name carries the entity so the
    // control reads "Edit Ingredient" to assistive tech and tests.
    primary: editable ? (
      <DetailEditAction
        aria-label={`Edit ${singular}`}
        onClick={() => setEditing(true)}
      />
    ) : undefined,
    secondary: (
      <EntityActionButtons
        entity={entity}
        // The whole record, not just its id: a verb's availability
        // reads the fields it gates on (a planting's status hides
        // "Start planting" once it has started).
        record={{ ...record, id: bag.id }}
        verbs={declaredVerbs}
        overflow="panel"
        additionalActions={
          <DetailActionTarget entity={entity} record={record} />
        }
      />
    ),
  };

  return (
    <DetailActionProvider>
      <Page
        variant="detail"
        entity={entity}
        wayfinding={detailWayfinding(entity, record)}
        title={
          <span className="flex min-w-0 items-start gap-2">
            <RecordEmoji
              entity={entity}
              record={record}
              emoji={
                z.looseObject({ emoji: z.string().nullish() }).parse(record)
                  .emoji
              }
              size={20}
            />
            <span className="min-w-0">{title}</span>
          </span>
        }
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
        <RecordSuggestionsProvider
          entity={entity}
          records={[record]}
          fieldKeys={entityFieldModels[entity].fields
            .filter((field) => field.display.detail)
            .map((field) => field.key)}
        >
          <RecordQualityProvider
            entity={entity}
            id={bag.id}
            renderedSections={sections.map((section) => section.id)}
          >
            <RecordWorkQueue id={bag.id} />
            <DetailSections
              sections={sections.map((section) => ({
                ...section,
                content: (
                  <>
                    <QualitySectionChecks section={section.id} />
                    {section.content}
                  </>
                ),
              }))}
              rawData={record}
            />
          </RecordQualityProvider>
        </RecordSuggestionsProvider>
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
              request={editRequestFor<E>(entity, record)}
            />
          )
        ) : null}
      </Page>
    </DetailActionProvider>
  );
}

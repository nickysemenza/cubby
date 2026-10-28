import type { CompiledEntityPresentation } from "@cubby/schemas/entity-definitions/definition";
import { onDetailSurface } from "@cubby/schemas/entity-detail-summary";
import { type EntityFieldModel } from "@cubby/schemas/entity-fields";
import { entityAttachmentRead } from "@cubby/schemas/entity-read-media";
import { isGalleryEntity } from "@cubby/schemas/entity-roster";
import { imageOut, partitionEntityFiles } from "@cubby/schemas/image";
import { publicImageUrl } from "@cubby/schemas/image-summary";
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ClockCounterClockwise";
import { FileTextIcon } from "@phosphor-icons/react/dist/csr/FileText";
import { ImageIcon } from "@phosphor-icons/react/dist/csr/Image";
import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { LinkIcon } from "@phosphor-icons/react/dist/csr/Link";
import { PuzzlePieceIcon } from "@phosphor-icons/react/dist/csr/PuzzlePiece";
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { type ComponentProps, lazy, Suspense, useState } from "react";
import { z } from "zod";

import { RecordEmoji } from "~/entity/components/record-emoji";
import { heroChipLabel } from "~/entity/display/enum-field-display";
import { detailEditRequest } from "~/entity/editing/editor-requests";
import {
  EntityEditDialog,
  type EntityEditDialogRequest,
} from "~/entity/editing/entity-edit-dialog";
import type { EditableEntity } from "~/entity/editing/types";
import { entities, isBrowserRoutedEntity } from "~/entity/entities";
import { isGeneratedBrowserCrudEntity } from "~/entity/entity-contracts";
import {
  entityDisplayImageKey,
  useEntityDisplayImages,
  type EntityDisplayImagesQueryOptions,
} from "~/entity/entity-media/entity-display-images";
import { readRecordField } from "~/entity/entity-references";
import { featureRegistry } from "~/entity/feature-registry";
import { entityMetadata, useEntityMetadata } from "~/entity/metadata";
import type { DetailHeroActions } from "~/entity/page/entity-page-header";
import { Page } from "~/entity/page/page";
import { RecordSuggestionsProvider } from "~/entity/suggestions/record-suggestions";
import { RecordWorkQueue } from "~/entity/work-queue/record-work-queue";
import { useNativeRunEvidence } from "~/lib/native-workspace";
import { FactsAddProvider } from "~/ui/common/facts";
import {
  RecordImageChain,
  type ImageChainQueryOptions,
} from "~/ui/derived/image-chain";
import { WhyValue } from "~/ui/derived/why-value";
import { VisibleContent } from "~/ui/hooks/visible-content";
import { Section } from "~/ui/layout";
import { DetailEditAction } from "~/ui/primitives/detail-edit-action";
import { Skeleton } from "~/ui/primitives/skeleton";

import { DocumentViewerList } from "../../ui/document-viewer-list";
import {
  actionVerbs,
  type ActionVerbId,
  verbDef,
} from "../actions/action-verbs";
import { EntityActionButtons } from "../actions/entity-actions";
import EntityImageList from "../components/entity-image-list";
import { type DetailSection, DetailSections } from "../table/detail-page";
import {
  EntityTimeline,
  type EntityTimelineOperations,
} from "../timeline/entity-timeline";
import { ConnectedRecordsSection } from "./connected-records-table";
import { DetailActionProvider, DetailActionTarget } from "./detail-action-bar";
import { DetailActivity } from "./detail-activity";
import { detailEditOverrideFor } from "./detail-edit-overrides";
import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";
import { detailSlotsFor } from "./detail-slots";
import { DetailSummary, isEmptySummaryCell } from "./detail-summary";
import { EntityRecordFields } from "./entity-record-fields";
import {
  EntityRelationTable,
  type EntityRelationTableOperations,
  planRelationSection,
  RelationSectionActions,
} from "./entity-relation-table";
import { NeedsYou, NeedsYouProvider, useNeedsYouTarget } from "./needs-you";
import { RecordQualityProvider, QualitySectionChecks } from "./record-quality";

const RecordProposals = lazy(() =>
  import("~/entity/suggestions/queue/record-proposals").then((module) => ({
    default: module.RecordProposals,
  })),
);
const AutomaticDecisions = lazy(() =>
  import("~/entity/suggestions/queue/automatic-decisions").then((module) => ({
    default: module.AutomaticDecisions,
  })),
);

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
  queryClient: QueryClient,
  entity: GenericDetailEntity,
): CompiledEntityPresentation & { singular: string } =>
  entityMetadata(queryClient, entity).summary;

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

/** The chip the hero declares, read off the record. */
function heroStampOf<E extends GenericDetailEntity>(
  queryClient: QueryClient,
  entity: E,
  record: DetailRecordOf<E>,
) {
  const { hero } = presentationOf(queryClient, entity).detail;
  const fields: readonly DisplayField[] = entityMetadata(queryClient, entity)
    .fields.fields;
  const chipField =
    hero.chip === null
      ? undefined
      : fields.find((candidate) => candidate.key === hero.chip);
  const chip = chipField
    ? heroChipLabel(queryClient, entity, record, chipField)
    : null;
  return chip === null ? undefined : { label: chip, tone: "ink" as const };
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
  displayImages?: EntityDisplayImagesQueryOptions;
  imageChain?: ImageChainQueryOptions;
}

function declaredSections<E extends GenericDetailEntity>(
  queryClient: QueryClient,
  entity: E,
  record: DetailRecordOf<E>,
  bag: DetailRecordBag,
  operations: GenericEntityDetailOperations,
): DetailSection[] {
  const { detail, singular } = presentationOf(queryClient, entity);
  const slots = detailSlotsFor(entity);
  // A field a summary slot shows is not repeated by a later section.
  const summarized = new Set(
    detail.summary.flatMap((slot) =>
      slot.kind === "fields" &&
      onDetailSurface(slot, "web") &&
      !isEmptySummaryCell(queryClient, entity, record, slot)
        ? slot.fields
        : [],
    ),
  );
  const unsummarized = (keys: readonly string[]) =>
    keys.filter((key) => !summarized.has(key));
  const sections = detail.sections.filter((section) =>
    onDetailSurface(section, "web"),
  );
  const built = sections.flatMap((section): DetailSection[] => {
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
      case "fields": {
        const fields = unsummarized(section.fields);
        if (fields.length === 0) return [];
        return [
          {
            ...base,
            title: section.title,
            content: (
              <EntityRecordFields
                entity={entity}
                record={record}
                fields={fields}
              />
            ),
          },
        ];
      }
      case "relation": {
        const plan = planRelationSection(queryClient, entity, section);
        const contextFields = unsummarized(section.contextFields);
        const createLabel =
          detail.variant === "journal" ? verbDef("logEntry").label : undefined;
        return [
          {
            ...base,
            // The index leads a relation with the records it lists.
            icon: isBrowserRoutedEntity(plan.target)
              ? entities[plan.target].phosphorIcon
              : base.icon,
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
              <div className="grid min-w-0 grid-cols-1 gap-3">
                {contextFields.length > 0 ? (
                  <EntityRecordFields
                    entity={entity}
                    record={record}
                    fields={contextFields}
                  />
                ) : null}
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
              </div>
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
            collapsed: slot.collapsed,
            headerAction: section.explanationField ? (
              <WhyValue
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
  const ordered = orderSections(detail.variant, sections, built);
  let streamedRelation = false;
  return ordered.map((section) => {
    const declared = sections.find((candidate) => candidate.id === section.id);
    if (declared?.kind === "fields") return section;
    if (declared?.kind === "relation" && !streamedRelation) {
      streamedRelation = true;
      return section;
    }
    return {
      ...section,
      content: (
        <VisibleContent fallback={<SlotFallback />}>
          {section.content}
        </VisibleContent>
      ),
    };
  });
}

/**
 * The entity's own `update:full` request, which the dialog resolves against
 * the editing registry at runtime.
 */
function editRequestFor<E extends GenericDetailEntity>(
  queryClient: QueryClient,
  entity: E,
  record: DetailRecordOf<E>,
): EntityEditDialogRequest<EditableEntity> {
  // SAFETY: the caller proved `isGeneratedBrowserCrudEntity(entity)`, i.e.
  // the entity has the standard update contract this request names.
  const request: unknown = detailEditRequest(
    queryClient,
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
  // An empty outcome has no local gallery; the canonical cover can still apply.
  const images =
    entity === "product"
      ? partitionEntityFiles(
          readRecordField(record, "images", z.array(imageOut).nullish()) ?? [],
        ).images
      : attachments.images;
  const toDisplayFile = (image: z.output<typeof imageOut>) => {
    const url = publicImageUrl(image);
    return url ? [{ ...image, url }] : [];
  };
  return {
    images: images.flatMap(toDisplayFile),
    documents: attachments.documents.flatMap(toDisplayFile),
  };
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
 * from `entityMetadata(queryClient, entity).summary.detail`; a slot is the only hand-written fill
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
  const queryClient = useQueryClient();
  useEntityMetadata(entity);
  const bag = detailRecordSchema.parse(record);
  const { titleField } = presentationOf(queryClient, entity);
  const title =
    readRecordField(record, titleField, z.string().catch("")) || bag.id;
  const sections = declaredSections(
    queryClient,
    entity,
    record,
    bag,
    operations,
  ).filter((section) => section.workspace === "evidence");
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
          visibleFields={presentationOf(queryClient, entity)
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

/** Suggestion status lands in the page's Needs-you block. */
function DetailSuggestions(
  props: Omit<ComponentProps<typeof RecordSuggestionsProvider>, "statusTarget">,
) {
  const target = useNeedsYouTarget("suggestions");
  return <RecordSuggestionsProvider {...props} statusTarget={target} />;
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
  const queryClient = useQueryClient();
  useEntityMetadata(entity);
  const { detail, titleField, singular } = presentationOf(queryClient, entity);
  const bag = detailRecordSchema.parse(record);
  const title =
    readRecordField(record, titleField, z.string().catch("")) || bag.id;
  const heroStamp = heroStampOf(queryClient, entity, record);
  const [editing, setEditing] = useState(false);
  const EditOverride = detailEditOverrideFor(entity);
  const heroActions: readonly string[] = detail.hero.actions;
  const editable =
    heroActions.includes("edit") &&
    (EditOverride !== undefined || isGeneratedBrowserCrudEntity(entity));

  const { images, documents } = detailFiles(entity, record, bag);
  const heroImages = detail.hero.images ? images : undefined;
  // A local gallery is not the canonical cover: logos and related-record
  // fallbacks are resolved at this page boundary, just as for record pills.
  const imageRef = { entityKind: entity, entityId: bag.id };
  const displayImages = useEntityDisplayImages(
    entityMetadata(queryClient, entity).descriptor.displayImages &&
      !heroImages?.length
      ? [imageRef]
      : [],
    undefined,
    operations.displayImages,
  );
  const heroDisplayImage = displayImages[entityDisplayImageKey(imageRef)];
  const emoji = z
    .looseObject({ emoji: z.string().nullish() })
    .parse(record).emoji;
  const sections = declaredSections(
    queryClient,
    entity,
    record,
    bag,
    operations,
  );
  // The first fields section left after the summary is the record's headline
  // facts, leading the content column ahead of Needs you and Activity.
  const fieldSectionIds = new Set(
    detail.sections.flatMap((section) =>
      section.kind === "fields" ? [section.id] : [],
    ),
  );
  const facts = sections.find((section) => fieldSectionIds.has(section.id));
  // Change history plus declared dated relations, merged into one timeline.
  const timeline =
    entityMetadata(queryClient, entity).descriptor.auditable ||
    detail.activityRelations.length > 0;
  sections.push({
    id: "connected-records",
    title: "Connected records",
    workspace: "relations",
    icon: LinkIcon,
    placement: "primary",
    content: <ConnectedRecordsSection source={entity} sourceId={bag.id} />,
  });

  if (!sections.some((section) => section.id === "suggestions"))
    sections.push({
      id: "suggestions",
      title: "Suggestions",
      icon: SparkleIcon,
      placement: "primary",
      content: (
        <Suspense fallback={<SlotFallback />}>
          <RecordProposals key={bag.id} id={bag.id} />
        </Suspense>
      ),
    });
  sections.push({
    id: "automatic-decisions",
    title: "Review automatic decisions",
    icon: ClockCounterClockwiseIcon,
    placement: "primary",
    content: (
      <Suspense fallback={<SlotFallback />}>
        <AutomaticDecisions key={bag.id} id={bag.id} />
      </Suspense>
    ),
  });

  // Derived from capabilities, never declared: a gallery's photos edit
  // inline; a cover/logo shows what is attached; documents get a viewer.
  if (isGalleryEntity(entity) && isGeneratedBrowserCrudEntity(entity)) {
    const { EntityPhotosSection } = featureRegistry().components;
    // SAFETY: `isGalleryEntity` proves the entity stores a gallery, and a
    // gallery entity's detail id is its own branded shortcode; the record
    // schema above only widens it to string.
    sections.push({
      id: "images",
      title: "Images",
      count: images.length,
      icon: ImageIcon,
      placement: "primary",
      content: (
        <>
          <RecordImageChain
            entity={entity}
            id={bag.id}
            explain={operations.imageChain}
          />
          <EntityPhotosSection
            entity={entity as never}
            id={bag.id as never}
            images={images}
          />
        </>
      ),
    });
  } else {
    sections.push({
      id: "images",
      title: "Images",
      count: images.length,
      icon: ImageIcon,
      placement: "primary",
      content: (
        <>
          <RecordImageChain
            entity={entity}
            id={bag.id}
            explain={operations.imageChain}
          />
          <EntityImageList images={images} />
        </>
      ),
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
  // `edit` is the page's own affordance (the hero button); every other
  // declared verb is offered from the registry, on the plate.
  const declaredVerbs = heroActions.filter(
    (verb): verb is ActionVerbId => verb !== "edit" && verb in actionVerbs,
  );
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
        quickVerbs={detail.quickActions}
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
            {((!heroImages?.length && !heroDisplayImage) || emoji) && (
              <RecordEmoji
                entity={entity}
                record={record}
                emoji={emoji}
                size={20}
              />
            )}
            <span className="min-w-0">{title}</span>
          </span>
        }
        rawData={record}
        heroImages={heroImages}
        heroDisplayImage={heroDisplayImage}
        heroNo={bag.id}
        heroStamp={heroStamp}
        summary={<DetailSummary entity={entity} record={record} />}
        heroActions={plateActions}
      >
        <NeedsYouProvider>
          <FactsAddProvider onAdd={editable ? () => setEditing(true) : null}>
            <DetailSuggestions
              entity={entity}
              records={[record]}
              fieldKeys={entityMetadata(queryClient, entity)
                .fields.fields.filter((field) => field.display.detail)
                .map((field) => field.key)}
            >
              <RecordQualityProvider
                entity={entity}
                id={bag.id}
                renderedSections={sections.map((section) => section.id)}
              >
                <DetailSections
                  sections={sections
                    .filter((section) => section !== facts)
                    .map((section) => ({
                      ...section,
                      content: (
                        <>
                          <QualitySectionChecks section={section.id} />
                          {/* Retained review actions must be available without
                              first scrolling their lower detail section. */}
                          {section.id === "suggestions" ||
                          detail.sections.some(
                            (declared) => declared.id === section.id,
                          ) ? (
                            section.content
                          ) : (
                            <VisibleContent fallback={<SlotFallback />}>
                              {section.content}
                            </VisibleContent>
                          )}
                        </>
                      ),
                    }))}
                  rawData={record}
                  omitActivity={timeline}
                  leadIndex={[
                    ...(facts ? [{ id: facts.id, title: facts.title }] : []),
                    ...(timeline ? [{ id: "history", title: "Activity" }] : []),
                  ]}
                  lead={
                    <>
                      {facts ? (
                        <Section
                          id={facts.id}
                          title={facts.title}
                          headingAs="h2"
                          data-detail-group
                          tabIndex={-1}
                          className="scroll-mt-[calc(var(--app-chrome-top)+3rem)] focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          <QualitySectionChecks section={facts.id} />
                          {facts.content}
                        </Section>
                      ) : null}
                      <NeedsYou>
                        <RecordWorkQueue id={bag.id} variant="rows" />
                      </NeedsYou>
                      {timeline ? (
                        <DetailActivity entity={entity} id={bag.id} />
                      ) : null}
                    </>
                  }
                />
              </RecordQualityProvider>
            </DetailSuggestions>
          </FactsAddProvider>
        </NeedsYouProvider>
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
              request={editRequestFor<E>(queryClient, entity, record)}
            />
          )
        ) : null}
      </Page>
    </DetailActionProvider>
  );
}

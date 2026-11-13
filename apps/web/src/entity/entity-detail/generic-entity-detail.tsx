// Keep the catalog constructor and its universal metadata off the detail entry.
import { relationshipSources } from "@cubby/schemas/connected-view-definitions";
import type { CompiledEntityPresentation } from "@cubby/schemas/entity-definitions/definition";
import { onDetailSurface } from "@cubby/schemas/entity-detail-summary";
import { type EntityFieldModel } from "@cubby/schemas/entity-fields";
import { isGalleryEntity } from "@cubby/schemas/entity-manifest";
import { entityAttachmentRead } from "@cubby/schemas/entity-read-media";
import { fieldEnvelopeFor } from "@cubby/schemas/field-envelope";
import { imageOut, partitionEntityFiles } from "@cubby/schemas/image";
import { publicImageUrl } from "@cubby/schemas/image-summary";
import { embeddableEntitySchema } from "@cubby/schemas/search";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { FileTextIcon } from "@phosphor-icons/react/dist/csr/FileText";
import { ImageIcon } from "@phosphor-icons/react/dist/csr/Image";
import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { LinkIcon } from "@phosphor-icons/react/dist/csr/Link";
import { PuzzlePieceIcon } from "@phosphor-icons/react/dist/csr/PuzzlePiece";
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { type ComponentProps, lazy, Suspense, useState } from "react";
import { z } from "zod";

import { RecordEmoji, recordEmojiOf } from "~/entity/components/record-emoji";
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
import {
  RecordImageChain,
  type ImageChainQueryOptions,
} from "~/entity/fields/explanation/image-chain";
import { WhyValue } from "~/entity/fields/explanation/why-value";
import {
  MachineryStateFallback,
  RecordMachineryHeader,
} from "~/entity/machinery/record-machinery";
import { entityMetadata, useEntityMetadata } from "~/entity/metadata";
import type { DetailHeroActions } from "~/entity/page/entity-page-header";
import { HeaderLines } from "~/entity/page/header-lines";
import { Page } from "~/entity/page/page";
import { entityGraph } from "~/integrations/tanstack-query/generated/domains/entityGraph.gen";
import { DetailEditAction } from "~/ui/forms/detail-edit-action";
import { useHydrated } from "~/ui/hooks/use-hydrated";
import { VisibleContent } from "~/ui/hooks/visible-content";
import { Skeleton } from "~/ui/primitives/skeleton";
import { FactsAddProvider } from "~/ui/records/facts";
import { KindTag } from "~/ui/records/kind-tag";
import { StateBadge } from "~/ui/records/state-badge";
import { Badge } from "~/ui/reui/badge";

import { DocumentViewerList } from "../../ui/media/document-viewer-list";
import {
  actionVerbs,
  type ActionVerbId,
  verbDef,
} from "../actions/action-verbs";
import { EntityActionButtons } from "../actions/entity-actions";
import EntityImageList from "../components/entity-image-list";
import { supportsEntityGraph } from "../relationships/entity-relations";
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
import { declaredNeedsOf, DetailSide } from "./detail-side";
import { detailSlotsFor } from "./detail-slots";
import { detailSectionFields } from "./detail-summary";
import { EntityRecordFields } from "./entity-record-fields";
import {
  EntityRelationTable,
  type EntityRelationTableOperations,
  planRelationSection,
  RelationSectionActions,
  RelationStaticSkeleton,
  relationSkeletonRows,
} from "./entity-relation-table";
import {
  aiSummaryOf,
  headerLinesOf,
  recordKindOf,
  recordStateOf,
} from "./record-header";
import {
  isScoredEntity,
  QualitySectionChecks,
  RecordQualityProvider,
  RecordQualitySection,
  useQualityCheckSections,
} from "./record-quality";

const RelatednessRail = lazy(() =>
  import("~/entity/relatedness/relatedness-rail").then((module) => ({
    default: module.RelatednessRail,
  })),
);

const RecordProposals = lazy(() =>
  import("~/entity/suggestions/queue/record-proposals").then((module) => ({
    default: module.RecordProposals,
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

/**
 * Beside the title: the kind tag, then the state once. An entity with a
 * machinery capability states it in the machinery header's stage line; any
 * other draws its declared `presentation.state` as `StateBadge`, or keeps its
 * declared hero chip.
 */
function headerStatus<E extends GenericDetailEntity>(
  queryClient: QueryClient,
  entity: E,
  record: DetailRecordOf<E>,
  id: string,
) {
  const kind = recordKindOf(queryClient, entity, record);
  const state = recordStateOf(queryClient, entity, record);
  const { hero } = presentationOf(queryClient, entity).detail;
  const fields: readonly DisplayField[] = entityMetadata(queryClient, entity)
    .fields.fields;
  const chipField =
    state !== null || hero.chip === null
      ? undefined
      : fields.find((candidate) => candidate.key === hero.chip);
  const chip = chipField
    ? heroChipLabel(queryClient, entity, record, chipField)
    : null;
  if (!kind && !state && chip === null) return undefined;
  return (
    <>
      {kind ? <KindTag option={kind} /> : null}
      <MachineryStateFallback entity={entity} id={id}>
        {state ? (
          <StateBadge
            size="header"
            option={state.option}
            phase={state.phase}
            reason={
              // The side column's Needs you already says it.
              declaredNeedsOf(queryClient, entity, record).some(
                (item) =>
                  item.title === state.reason || item.subtitle === state.reason,
              )
                ? null
                : state.reason
            }
            wait={state.wait}
            stalled={state.stalled}
          />
        ) : chip !== null ? (
          <Badge variant="secondary">{chip}</Badge>
        ) : null}
      </MachineryStateFallback>
    </>
  );
}

/** A section's group when the entity declares none: from its kind. */
function defaultGroup(section: DeclaredSection) {
  switch (section.kind) {
    case "fields":
      return "overview";
    case "relation":
      return "work";
    case "timeline":
      return "evidence";
    case "slot":
      return section.overview === false ? "evidence" : "overview";
  }
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
  graph?: Pick<typeof entityGraph, "graph">;
}

function declaredSections<E extends GenericDetailEntity>(
  queryClient: QueryClient,
  entity: E,
  record: DetailRecordOf<E>,
  bag: DetailRecordBag,
  operations: GenericEntityDetailOperations,
  placement: {
    omitTitle: boolean;
    relationCount?: (relation: string) => number | undefined;
  } = { omitTitle: false },
): DetailSection[] {
  const { detail, singular } = presentationOf(queryClient, entity);
  const slots = detailSlotsFor(entity);
  const unsummarized = (keys: readonly string[]) =>
    detailSectionFields(queryClient, entity, record, keys, {
      omitTitle: placement.omitTitle,
      placed: true,
    });
  const sections = detail.sections.filter((section) =>
    onDetailSurface(section, "web"),
  );
  const built = sections.flatMap((section): DetailSection[] => {
    const base = {
      id: section.id,
      placement: section.placement,
      icon: sectionIcon(section.kind),
      group:
        section.group ??
        (detail.groups === null ? defaultGroup(section) : undefined),
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
                sectionTitle={section.title}
              />
            ),
          },
        ];
      }
      case "relation": {
        const plan = planRelationSection(queryClient, entity, section);
        const contextFields = unsummarized(section.contextFields);
        const createLabel =
          section.createLabel ??
          (detail.variant === "journal"
            ? verbDef("logEntry").label
            : undefined);
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
                  expectedRows={placement.relationCount?.(section.relation)}
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
        const title = section.title ?? slot.indexTitle ?? singular;
        // SAFETY: the slot is this entity's own (see above).
        return [
          {
            ...base,
            title,
            bare: section.title === null,
            collapsed: slot.collapsed,
            headerAction: section.explanationField ? (
              <WhyValue
                entity={entity}
                id={bag.id}
                field={section.explanationField}
                resolution={fieldEnvelopeFor(record, section.explanationField)}
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
    // Fields and slots mount with the page so a hidden tab's text stays
    // findable and deep links into slot content have a destination.
    if (declared?.kind === "fields" || declared?.kind === "slot")
      return section;
    if (declared?.kind === "relation" && !streamedRelation) {
      streamedRelation = true;
      return section;
    }
    const expected =
      declared?.kind === "relation"
        ? placement.relationCount?.(declared.relation)
        : undefined;
    return {
      ...section,
      content: (
        <VisibleContent
          fallback={
            // The skeleton reserves the table's known height, so resolving it
            // does not move the page.
            expected !== undefined && declared?.kind === "relation" ? (
              <RelationStaticSkeleton
                rows={relationSkeletonRows(
                  planRelationSection(queryClient, entity, declared),
                  expected,
                )}
              />
            ) : (
              <SlotFallback />
            )
          }
        >
          {section.content}
        </VisibleContent>
      ),
    };
  });
}

/**
 * Rows per declared relation from one batched graph read, so empty relations
 * can fold without mounting a table each. Only a loaded branch is a count: an
 * unanswered key or a failed read stays unknown and its table renders.
 */
/**
 * The graph counts local paths only, and a filter override points the table at a
 * different query, so otherwise its count can read 0 over rows the table shows.
 * Such a relation gets no count and never folds as empty.
 */
function graphCountsRelation(
  queryClient: QueryClient,
  entity: GenericDetailEntity,
  relation: string,
  detail: {
    relationFilterOverrides?: Readonly<Record<string, { descriptor: string }>>;
  },
) {
  if (detail.relationFilterOverrides?.[relation]) return false;
  const declared = entityMetadata(
    queryClient,
    entity,
  ).descriptor.relationships.find((candidate) => candidate.key === relation);
  return (
    declared !== undefined &&
    relationshipSources(declared).every(
      (source) => source.provenance.kind === "local-path",
    )
  );
}

function useRelationCounts(
  entity: GenericDetailEntity,
  id: string,
  relations: readonly string[],
  operations: Pick<typeof entityGraph, "graph"> = entityGraph,
) {
  const hydrated = useHydrated();
  const enabled =
    hydrated && relations.length > 0 && supportsEntityGraph(entity);
  const query = useQuery({
    ...operations.graph.queryOptions({
      roots: [{ entityKind: entity, entityId: id }],
      relationshipKeys: [...relations],
      limit: 0,
    }),
    enabled,
  });
  const counts = new Map(
    query.data?.branches.map((branch) => [
      branch.relationshipKey,
      branch.totalCount,
    ]),
  );
  return {
    count: (relation: string) => counts.get(relation),
    pending:
      relations.length > 0 &&
      supportsEntityGraph(entity) &&
      (!hydrated || query.isPending),
  };
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
  return <FullEntityDetail {...props} />;
}

/**
 * A section owning a quality result never folds: every applicable check keeps
 * one visible result beside its evidence.
 */
function DetailBody({
  sections,
  ...props
}: ComponentProps<typeof DetailSections>) {
  const owning = new Set<string>(useQualityCheckSections());
  return (
    <DetailSections
      {...props}
      sections={sections.map((section) =>
        owning.has(section.id) ? { ...section, foldWhenEmpty: false } : section,
      )}
    />
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
  const queryClient = useQueryClient();
  useEntityMetadata(entity);
  const { detail, titleField, singular } = presentationOf(queryClient, entity);
  const bag = detailRecordSchema.parse(record);
  const title =
    readRecordField(record, titleField, z.string().catch("")) || bag.id;
  const status = headerStatus(queryClient, entity, record, bag.id);
  const summary = aiSummaryOf(queryClient, entity, record);
  // A hosted native workspace confines navigation to this record; list links
  // in the trail would be dead there.
  const hosted = useSearch({
    from: "__root__",
    select: (search) => search.nativeWorkspace !== undefined,
  });
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
  // A chosen emoji is the record's mark: it replaces the canonical cover, while
  // the record's own gallery stays in the hero.
  const emoji = recordEmojiOf(entity, record);
  const displayImages = useEntityDisplayImages(
    entityMetadata(queryClient, entity).descriptor.displayImages &&
      !heroImages?.length &&
      !emoji
      ? [imageRef]
      : [],
    undefined,
    operations.displayImages,
  );
  const heroDisplayImage = emoji
    ? undefined
    : displayImages[entityDisplayImageKey(imageRef)];
  const declaredRelations = detail.sections.flatMap((section) =>
    section.kind === "relation" &&
    onDetailSurface(section, "web") &&
    graphCountsRelation(queryClient, entity, section.relation, detail)
      ? [section.relation]
      : [],
  );
  const relationCounts = useRelationCounts(
    entity,
    bag.id,
    declaredRelations,
    operations.graph,
  );
  const sections = declaredSections(
    queryClient,
    entity,
    record,
    bag,
    operations,
    { omitTitle: true, relationCount: relationCounts.count },
  );
  // Change history plus declared dated relations, merged into one timeline.
  const timeline =
    entityMetadata(queryClient, entity).descriptor.auditable ||
    detail.activityRelations.length > 0;
  if (timeline)
    sections.push({
      id: "history",
      title: "Activity",
      group: "activity",
      icon: ClockIcon,
      placement: "primary",
      content: <DetailActivity entity={entity} id={bag.id} />,
    });
  sections.push({
    id: "connected-records",
    title: "Connected records",
    group: "relations",
    icon: LinkIcon,
    placement: "primary",
    content: <ConnectedRecordsSection source={entity} sourceId={bag.id} />,
  });

  const relatedEntity = embeddableEntitySchema.safeParse(entity);
  if (
    relatedEntity.success &&
    entityMetadata(queryClient, entity).descriptor.relatednessSignals.length
  )
    sections.push({
      id: "related-records",
      title: "Related records",
      group: "relations",
      icon: SparkleIcon,
      placement: "primary",
      content: (
        <VisibleContent fallback={<SlotFallback />}>
          <Suspense fallback={<SlotFallback />}>
            <RelatednessRail
              key={bag.id}
              entity={relatedEntity.data}
              id={bag.id}
            />
          </Suspense>
        </VisibleContent>
      ),
    });

  if (!sections.some((section) => section.id === "suggestions"))
    sections.push({
      id: "suggestions",
      title: "Suggestions",
      group: "evidence",
      icon: SparkleIcon,
      placement: "primary",
      content: (
        <Suspense fallback={<SlotFallback />}>
          <RecordProposals key={bag.id} id={bag.id} />
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
      group: "evidence",
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
      group: "evidence",
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
    group: "evidence",
    icon: FileTextIcon,
    placement: "primary",
    content:
      documents.length > 0 ? (
        <DocumentViewerList documents={documents} />
      ) : null,
  });
  // The record's quality summary and the results no section places live in
  // a tab; its open issues join Needs you.
  if (isScoredEntity(entity))
    sections.push({
      id: "record-quality",
      title: "Record quality",
      group: "evidence",
      icon: CheckCircleIcon,
      placement: "primary",
      content: <RecordQualitySection entity={entity} id={bag.id} />,
    });
  const relationOf = new Map(
    detail.sections.flatMap((section) =>
      section.kind === "relation" ? [[section.id, section.relation]] : [],
    ),
  );
  // Match declaredSections: the first relation streams immediately, so a
  // fragment naming it has a mounted destination before counts load.
  const firstRelation = sections.find((section) => relationOf.has(section.id));
  const placed = sections.map((section): DetailSection => {
    const relation = relationOf.get(section.id);
    const count = relation && relationCounts.count(relation);
    return {
      ...section,
      foldWhenEmpty: true,
      knownCount: typeof count === "number" ? count : undefined,
      knownEmpty: count === 0,
      countPending:
        relation !== undefined &&
        section !== firstRelation &&
        relationCounts.pending,
    };
  });
  const renderedFields = detail.sections.flatMap((section) => {
    if (!onDetailSurface(section, "web")) return [];
    if (section.kind === "fields" || section.kind === "relation")
      return detailSectionFields(
        queryClient,
        entity,
        record,
        section.kind === "fields" ? section.fields : section.contextFields,
        { omitTitle: true, placed: true },
      );
    return [];
  });
  const withQualityChecks = (section: DetailSection): DetailSection => ({
    ...section,
    content: (
      <>
        <QualitySectionChecks section={section.id} />
        {/* Retained review actions must be available without first scrolling
            their lower detail section. */}
        {section.id === "suggestions" ||
        detail.sections.some((declared) => declared.id === section.id) ? (
          section.content
        ) : (
          <VisibleContent fallback={<SlotFallback />}>
            {section.content}
          </VisibleContent>
        )}
      </>
    ),
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
        wayfinding={hosted ? false : detailWayfinding(entity, record)}
        title={
          <span className="flex min-w-0 items-center gap-2">
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
        status={status}
        summary={
          <>
            <RecordMachineryHeader entity={entity} id={bag.id} />
            <HeaderLines
              lines={headerLinesOf(queryClient, entity, record)}
              aiSummary={
                summary && {
                  text: summary.text,
                  attribution: `AI-written summary · ${summary.model}, after the ${singular.toLocaleLowerCase()} ended`,
                }
              }
            />
          </>
        }
        heroActions={plateActions}
      >
        <FactsAddProvider onAdd={editable ? () => setEditing(true) : null}>
          <RecordQualityProvider
            entity={entity}
            id={bag.id}
            summary="placed"
            renderedSections={placed.map((section) => section.id)}
            visibleFields={renderedFields}
          >
            <DetailBody
              sections={placed.map(withQualityChecks)}
              rawData={record}
              groups={detail.groups ?? undefined}
              side={<DetailSide entity={entity} record={record} />}
            />
          </RecordQualityProvider>
        </FactsAddProvider>
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

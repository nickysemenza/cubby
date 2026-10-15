import { entitySchema } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { entitySummary } from "@cubby/schemas/entity-summary";
import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/usda";
import { dataTypeLabel } from "@cubby/usda";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { z } from "zod";

import type { EntityActionRow } from "~/entity/actions/entity-actions";
import { RecordEmoji } from "~/entity/components/record-emoji";
import { entityPreviewFacts } from "~/entity/display/entity-display";
import { heroChipLabel } from "~/entity/display/enum-field-display";
import {
  EntityIcon,
  entities,
  entityDetailParams,
  isBrowserRoutedEntity,
} from "~/entity/entities";
import { entityDetailFor } from "~/entity/entity-detail";
import { fdcIdFromParam } from "~/entity/entity-query";
import {
  readDisplayReferenceField,
  readRecordField,
} from "~/entity/entity-references";
import type { EntityDetailByEntity } from "~/entity/generated/entity-details.gen";
import { usdaFood } from "~/integrations/tanstack-query/generated/catalog.gen";
import { dataTypeColor, UsdaDataTypeDot } from "~/lib/usda-data-type";

import {
  type BodyBlock,
  ManifestCard,
  type ManifestCardProps,
} from "../preview/manifest-card";
import type { HoverPreviewEntity } from "../preview/preview-entities";
import { PreviewQuery } from "../preview/preview-query";

type CompactPreviewPresentation = {
  showOpenAction?: boolean;
  showIdentityHeader?: boolean;
  onNameResolved?: (name: string) => void;
  /** The inspector reuses this successful detail payload for its actions. */
  onRecordResolved?: (record: EntityActionRow | undefined) => void;
};

type StandardPreviewPresentation = Required<
  Pick<CompactPreviewPresentation, "showOpenAction" | "showIdentityHeader">
> &
  Pick<CompactPreviewPresentation, "onNameResolved" | "onRecordResolved">;

function ResolvedManifestCard({
  card,
  record,
  showOpenAction,
  showIdentityHeader,
  onNameResolved,
  onRecordResolved,
}: CompactPreviewPresentation & {
  card: ManifestCardProps;
  record: EntityActionRow;
}) {
  useEffect(() => {
    onNameResolved?.(card.name);
  }, [card.name, onNameResolved]);
  useEffect(() => {
    onRecordResolved?.(record);
  }, [onRecordResolved, record]);

  return (
    <ManifestCard
      {...card}
      showOpenAction={showOpenAction}
      showIdentityHeader={showIdentityHeader}
    />
  );
}

// The generic card: a record's manifest hero (chip → identity, breadcrumb →
// cross-link, images → thumb) plus its declared preview facts
// (`entityPreviewFacts`). usda-food keeps its own card: it is the external
// USDA catalog read by fdc_id, not a kernel entity.

type ManifestPreviewEntity = Exclude<HoverPreviewEntity, "usda-food">;

const titleValue = z.string().nullish();
const recordId = z.string();
const displayImageUrls = z.looseObject({
  displayImages: z.array(z.looseObject({ url: z.string() })),
});

export function manifestPreviewCard<E extends ManifestPreviewEntity>(
  entity: E,
  data: EntityDetailByEntity[E],
): ManifestCardProps {
  const presentation = entitySummary[entity];
  const { hero } = presentation.detail;
  const fields = entityFieldModels[entity].fields;
  const field = (key: string | null) =>
    key === null
      ? undefined
      : fields.find((candidate) => candidate.key === key);
  const id = readRecordField(data, "id", recordId);
  const chipField = field(hero.chip);
  const breadcrumbField = field(hero.breadcrumb);
  const breadcrumb = breadcrumbField
    ? readDisplayReferenceField(data, breadcrumbField)
    : null;
  const thumbUrl = hero.images
    ? displayImageUrls.safeParse(data).data?.displayImages[0]?.url
    : undefined;
  const stats = entityPreviewFacts(entity, data);

  const body: BodyBlock[] = [];
  if (thumbUrl) body.push({ kind: "thumb", url: thumbUrl });
  if (stats.length > 0) body.push({ kind: "stats", stats });
  const target = entitySchema.safeParse(breadcrumb?.entity).data;
  return {
    entity,
    routeParam: id,
    icon: (
      <RecordEmoji
        entity={entity}
        record={data}
        emoji={z.looseObject({ emoji: z.string().nullish() }).parse(data).emoji}
        size={14}
      />
    ),
    name: readRecordField(data, presentation.titleField, titleValue) ?? id,
    tag: entity,
    identity: chipField
      ? (heroChipLabel(entity, data, chipField) ?? undefined)
      : undefined,
    crossLinks:
      breadcrumb && target && isBrowserRoutedEntity(target)
        ? breadcrumb.items.map((item) => ({
            to: entities[target].routes.detail,
            params: entityDetailParams(item.id),
            icon: <EntityIcon entity={target} size={12} colored />,
            label: item.name ?? item.id,
          }))
        : undefined,
    body: body.length > 0 ? body : undefined,
  };
}

// ── USDA food ───────────────────────────────────────────────────────────────

export function toUsdaCard(
  fdcId: number,
  data: FoodSummaryWithLinkedProducts,
): ManifestCardProps {
  const dataType = data.foodInfo.data_type;
  const brand =
    data.brandedFoodInfo?.brand_name ??
    data.brandedFoodInfo?.brand_owner ??
    undefined;
  const linkedProduct = data.linkedProducts[0];

  return {
    entity: "usda-food",
    routeParam: String(fdcId),
    icon: dataType ? (
      <EntityIcon
        entity="usda-food"
        size={14}
        style={{ color: dataTypeColor(dataType) }}
      />
    ) : (
      <EntityIcon entity="usda-food" size={14} colored />
    ),
    name: data.foodInfo.description || "Unnamed Food",
    tag: "usda",
    identity: dataType ? (
      <>
        <UsdaDataTypeDot dataType={dataType} />
        {dataTypeLabel(dataType)}
        {brand && <span>· {brand}</span>}
      </>
    ) : undefined,
    crossLinks: linkedProduct
      ? [
          {
            to: "/products/$shortcode",
            params: { shortcode: linkedProduct.id },
            icon: <EntityIcon entity="product" size={12} colored />,
            label: linkedProduct.name ?? "Product",
          },
        ]
      : undefined,
    body: [
      { kind: "nutrients", nutrients: data.nutritionInfo.nutrientsPer100 },
    ],
  };
}

export function UsdaFoodPreviewContent({
  fdcId,
  showOpenAction = true,
  showIdentityHeader = true,
  onNameResolved,
  onRecordResolved,
}: { fdcId: number } & CompactPreviewPresentation) {
  const query = useQuery(usdaFood.detail.queryOptions({ id: fdcId }));

  return (
    <PreviewQuery query={query} label="Food" onUnavailable={onRecordResolved}>
      {(data) => (
        <ResolvedManifestCard
          card={toUsdaCard(fdcId, data)}
          record={{ ...data, id: String(fdcId) }}
          showOpenAction={showOpenAction}
          showIdentityHeader={showIdentityHeader}
          onNameResolved={onNameResolved}
          onRecordResolved={onRecordResolved}
        />
      )}
    </PreviewQuery>
  );
}

// ── Generic dispatch ────────────────────────────────────────────────────────

function ManifestPreviewContent<E extends ManifestPreviewEntity>({
  entity,
  id,
  showOpenAction,
  showIdentityHeader,
  onNameResolved,
  onRecordResolved,
}: { entity: E; id: string } & StandardPreviewPresentation) {
  const query = useQuery(entityDetailFor(entity).queryOptions(id));
  return (
    <PreviewQuery
      query={query}
      label={entitySummary[entity].singular}
      onUnavailable={onRecordResolved}
    >
      {(data) => (
        <ResolvedManifestCard
          card={manifestPreviewCard(entity, data)}
          record={data}
          showOpenAction={showOpenAction}
          showIdentityHeader={showIdentityHeader}
          onNameResolved={onNameResolved}
          onRecordResolved={onRecordResolved}
        />
      )}
    </PreviewQuery>
  );
}

export function EntityPreviewContent({
  entity,
  id,
  showOpenAction = true,
  showIdentityHeader = true,
  onNameResolved,
  onRecordResolved,
}: { entity: HoverPreviewEntity; id: string } & CompactPreviewPresentation) {
  // usda-food is the external USDA catalog (fdc_id, no kernel get). Every
  // other entity is a uniform detail fetch, keyed here so switching entities
  // remounts rather than changing the query a single instance holds.
  if (entity === "usda-food")
    return (
      <UsdaFoodPreviewContent
        fdcId={fdcIdFromParam(id)}
        showOpenAction={showOpenAction}
        showIdentityHeader={showIdentityHeader}
        onNameResolved={onNameResolved}
        onRecordResolved={onRecordResolved}
      />
    );
  return (
    <ManifestPreviewContent
      key={entity}
      entity={entity}
      id={id}
      showOpenAction={showOpenAction}
      showIdentityHeader={showIdentityHeader}
      onNameResolved={onNameResolved}
      onRecordResolved={onRecordResolved}
    />
  );
}

import { entitySchema } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { entitySummary } from "@cubby/schemas/entity-summary";
import type { ImageAssociation, ImageWithEntity } from "@cubby/schemas/image";
import type { CookbookSummary } from "@cubby/schemas/recipe";
import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/usda";
import { dataTypeLabel } from "@cubby/usda-schemas";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { z } from "zod";

import type { EntityActionRow } from "~/app/_components/actions/entity-actions";
import { cookbook } from "~/entities/cookbook.functions";
import {
  EntityIcon,
  entities,
  entityDetailParams,
  isBrowserRoutedEntity,
} from "~/entities/entities";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { entityPreviewFacts } from "~/entities/entity-display";
import { fdcIdFromParam } from "~/entities/entity-query";
import {
  readReferenceField,
  readRecordField,
} from "~/entities/entity-references";
import { enumFieldLabel, heroChipLabel } from "~/entities/enum-field-display";
import type { EntityDetailByEntity } from "~/entities/generated/entity-details.gen";
import { image } from "~/entities/image.functions";
import { usdaFood } from "~/entities/usda.functions";
import { dataTypeColor, UsdaDataTypeDot } from "~/lib/usda-data-type";

import {
  type BodyBlock,
  type CrossLink,
  ManifestCard,
  type ManifestCardProps,
} from "./preview/manifest-card";
import type { HoverPreviewEntity } from "./preview/preview-entities";
import { PreviewQuery } from "./preview/preview-query";

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
// (`entityPreviewFacts`). usda-food, cookbook and image keep their own cards
// because their fetch shape genuinely diverges (fdc_id coercion, list-backed
// detail without a dedicated endpoint, association-bearing image read).

type ManifestPreviewEntity = Exclude<
  HoverPreviewEntity,
  "usda-food" | "cookbook" | "image"
>;

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
    ? readReferenceField(data, breadcrumbField)
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
    icon: <EntityIcon entity={entity} size={14} colored />,
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

// ── Cookbook ────────────────────────────────────────────────────────────────

export function toCookbookCard(data: CookbookSummary): ManifestCardProps {
  const body: BodyBlock[] = [];
  if (data.coverUrl) body.push({ kind: "thumb", url: data.coverUrl });
  body.push({
    kind: "stats",
    stats: [
      {
        label: "Recipes",
        value: data.recipeCount,
        // How many of the book's extracted recipes are actually imported.
        caption:
          data.sourceRecipeCount > data.recipeCount
            ? `of ${data.sourceRecipeCount}`
            : undefined,
      },
      {
        label: "Subjects",
        value:
          data.subjects.length > 0 ? data.subjects.slice(0, 2).join(", ") : "—",
      },
    ],
  });

  return {
    entity: "cookbook",
    routeParam: data.id,
    icon: <EntityIcon entity="cookbook" size={14} colored />,
    name: data.book,
    tag: "cookbook",
    identity: data.author.length > 0 ? data.author.join(", ") : undefined,
    body,
  };
}

export function CookbookPreviewContent({
  cookbookId,
  showOpenAction = true,
  showIdentityHeader = true,
  onNameResolved,
  onRecordResolved,
}: { cookbookId: string } & CompactPreviewPresentation) {
  const query = useQuery(
    cookbook.detail.queryOptions({ shortcode: cookbookId }),
  );

  return (
    <PreviewQuery
      query={query}
      label="Cookbook"
      onUnavailable={onRecordResolved}
    >
      {(data) => (
        <ResolvedManifestCard
          card={toCookbookCard(data)}
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

// ── Images ─────────────────────────────────────────────────────────────────

const imageAssociationCrossLink = (
  association: ImageAssociation,
): CrossLink => ({
  to: entities[association.entityType].routes.detail,
  params: entityDetailParams(association.entityId),
  icon: <EntityIcon entity={association.entityType} size={12} colored />,
  label: `${association.entityName} · ${association.role}`,
});

export function toImageCard(data: ImageWithEntity): ManifestCardProps {
  const dimensions =
    data.width !== null && data.height !== null
      ? `${data.width} × ${data.height}`
      : "—";

  return {
    entity: "image",
    routeParam: data.id,
    icon: <EntityIcon entity="image" size={14} colored />,
    name: data.filename,
    tag: "image",
    identity: enumFieldLabel("image", "status", data.status),
    crossLinks:
      data.associations.length > 0
        ? data.associations.map(imageAssociationCrossLink)
        : undefined,
    body: [
      ...(data.status === "UPLOADED"
        ? [{ kind: "thumb" as const, url: data.url }]
        : []),
      {
        kind: "stats",
        stats: [
          { label: "Dimensions", value: dimensions },
          { label: "Associations", value: data.associations.length },
        ],
      },
    ],
  };
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

function ImagePreviewContent({
  id,
  showOpenAction,
  showIdentityHeader,
  onNameResolved,
  onRecordResolved,
}: {
  id: string;
} & StandardPreviewPresentation) {
  const query = useQuery(image.detail.queryOptions({ id }));

  return (
    <PreviewQuery query={query} label="Image" onUnavailable={onRecordResolved}>
      {(data) => (
        <ResolvedManifestCard
          card={toImageCard(data)}
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
  // usda-food and cookbook fetch differently enough (fdc_id coercion and
  // specialized projections) to stay their own small components.
  // Every other entity is a uniform detail fetch, keyed here so switching
  // entities remounts rather than changing the query a single instance holds.
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
  if (entity === "cookbook")
    return (
      <CookbookPreviewContent
        cookbookId={id}
        showOpenAction={showOpenAction}
        showIdentityHeader={showIdentityHeader}
        onNameResolved={onNameResolved}
        onRecordResolved={onRecordResolved}
      />
    );
  if (entity === "image")
    return (
      <ImagePreviewContent
        id={id}
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

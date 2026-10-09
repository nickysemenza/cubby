import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { entityDetailFor } from "~/entity/entity-detail";
import { usdaFood as usdaFoodOperations } from "~/integrations/tanstack-query/generated/usda.gen";
import {
  BASE_KINDS,
  type BaseKind,
  conversionCoverage,
} from "~/lib/conversion-coverage";
import { wasm } from "~/lib/wasm";
import { useHydrated } from "~/ui/hooks/useHydrated";
import { Row } from "~/ui/layout";
import { StaticTable } from "~/ui/primitives/static-table";

import { KindIcon } from "./kind-icon";

// The base measurement kind a unit belongs to, or null for nutrient:* / other:*
// units (which `kindIconMap` has no icon for). `amount_kind` is a cheap, cached
// WASM probe; it never throws today, but guard defensively.
const baseKindForUnit = (unit: string): BaseKind | null => {
  try {
    const k = wasm.amount_kind({ value: 1, unit });
    return BASE_KINDS.find((kind) => kind === k) ?? null;
  } catch {
    return null;
  }
};

// Leading per-row marker: the target amount's kind icon, lit when that big-4
// kind participates in a working conversion (ties each row to the coverage
// chips above). Nutrient/other rows get a muted dot so the column stays aligned.
const KindAccent: React.FC<{
  unit: string;
  covered: ReadonlySet<BaseKind>;
}> = ({ unit, covered }) => {
  const kind = baseKindForUnit(unit);
  if (!kind) {
    return (
      <span
        aria-hidden
        className="inline-block size-1 shrink-0 rounded-full bg-muted-foreground/30"
      />
    );
  }
  return <KindIcon kind={kind} lit={covered.has(kind)} />;
};

// Component for lazy loading food data and rendering FoodPillLink
const LazyFoodPillLink: React.FC<{ fdcId: number }> = ({ fdcId }) => {
  const { data: usdaFood, isLoading: foodLoading } = useQuery({
    ...usdaFoodOperations.detail.queryOptions({ id: fdcId }),
  });
  // Hydration-stable — see the note on LazyProductPillLink below.
  const hydrated = useHydrated();
  const food = hydrated ? usdaFood : undefined;
  const isLoading = !hydrated || foodLoading;

  // Show placeholder while loading or if no data
  const displayFood = food || {
    fdc_id: fdcId,
    foodInfo: { description: `food ${fdcId}${isLoading ? "..." : ""}` },
  };

  return (
    <EntityRefLink
      displayImage={null}
      entity="usda-food"
      data={displayFood}
      compact
    />
  );
};

// Component for lazy loading product data and rendering ProductPillLink
const LazyProductPillLink: React.FC<{ productId: string }> = ({
  productId,
}) => {
  const { data: fetched, isLoading: productLoading } = useQuery(
    entityDetailFor("product").queryOptions(productId),
  );
  // Hydration-stable. Whether this product has landed differs between the SSR
  // render and the first client render — TanStack Start's query stream races
  // React's hydration — and the two branches below differ by a whole element
  // (plain span vs. link) as well as by the "..." suffix. Gating on `hydrated`
  // makes both renders take the placeholder branch whatever either cache holds.
  // See useHydratedLoading.
  const hydrated = useHydrated();
  const product = hydrated ? fetched : undefined;
  const isLoading = !hydrated || productLoading;

  // No real shortcode to link to until the product loads — render plain text
  // rather than a link that would 404 (or worse, one keyed on the uuid).
  if (!product) {
    return (
      <span className="text-muted-foreground">
        product {productId.slice(0, 8)}
        {isLoading ? "..." : ""}
      </span>
    );
  }

  return (
    <EntityRefLink
      displayImage={product.displayImages[0] ?? null}
      entity="product"
      data={product}
      compact
    />
  );
};

// Source label + provenance pill, shared by the desktop cell and the mobile card.
const MappingSource: React.FC<{ mapping: UnitMapping }> = ({ mapping }) => {
  const { source, sourceMetadata } = mapping;
  if (!sourceMetadata) return <>{source || ""}</>;
  return (
    <Row as="span" align="center" gap="xs">
      <span>{source || ""}</span>
      {sourceMetadata.type === "food" && (
        <LazyFoodPillLink fdcId={sourceMetadata.fdcId} />
      )}
      {sourceMetadata.type === "product" && (
        <LazyProductPillLink productId={sourceMetadata.productId} />
      )}
    </Row>
  );
};

// Bare read-only conversions list for compact panels; the generic data-table's toolbar/pagination/selection chrome overflowed them (see PR for context).
export const UnitMappingsTable: React.FC<{
  mappings: UnitMapping[];
  /** Must match the `kinds` passed to the sibling ConversionCapabilities so
   * row icons and coverage chips grade against the same kind universe. */
  kinds?: readonly BaseKind[];
}> = ({ mappings, kinds }) => {
  // Same engine the coverage chips read, so a row's lit icon and the chip above
  // can't disagree. Cheap (6 cached probes), memoized per mapping set.
  const covered = useMemo(
    () => conversionCoverage(mappings, kinds).covered,
    [mappings, kinds],
  );

  if (mappings.length === 0) return null;

  // table-auto: From/To size to content (no overflow into neighbors); Source takes the slack via w-full and truncates the food name.
  return (
    <StaticTable
      rows={mappings}
      rowKey={(m) =>
        `${m.a.value}-${m.a.unit}-${m.b.value}-${m.b.unit}-${m.source}`
      }
      className="table-auto"
      rowClassName="hover:bg-transparent"
      // TableHead already owns the mono/text-2xs/uppercase/tracking-wider
      // eyebrow look; this override only tightens the dense table.
      headClassName="h-auto p-1"
      cellClassName="p-1 align-top whitespace-nowrap"
      columns={[
        {
          id: "from",
          header: "From",
          cellClassName: "pr-4 tabular-nums",
          cell: (m) => wasm.format_amount(m.a),
        },
        {
          id: "to",
          header: "To",
          cellClassName: "pr-4",
          cell: (m) => (
            <Row as="span" align="center" gap="xs">
              <KindAccent unit={m.b.unit} covered={covered} />
              <span className="tabular-nums">{wasm.format_amount(m.b)}</span>
            </Row>
          ),
        },
        {
          id: "source",
          header: "Source",
          headClassName: "w-full",
          cellClassName: "w-full truncate text-muted-foreground",
          cell: (m) => <MappingSource mapping={m} />,
        },
      ]}
    />
  );
};

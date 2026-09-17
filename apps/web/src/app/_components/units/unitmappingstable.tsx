import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { Row } from "~/components/layout";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { usdaFood as usdaFoodOperations } from "~/entities/usda.functions";
import { useHydrated } from "~/hooks/useHydrated";
import {
  BASE_KINDS,
  type BaseKind,
  conversionCoverage,
} from "~/lib/conversion-coverage";
import { wasm } from "~/lib/wasm";

import { EntityInlineLink } from "../EntityInlineLink";
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
    <EntityInlineLink
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
    <EntityInlineLink
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

  // TableHead already owns the mono/text-2xs/uppercase/tracking-wider eyebrow
  // look; this override only tightens the height/padding for the dense table.
  const head = "h-auto p-1";
  // table-auto: From/To size to content (no overflow into neighbors); Source takes the slack via w-full and truncates the food name.
  const cell = "whitespace-nowrap p-1 align-top";
  return (
    <Table className="table-auto">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className={head}>From</TableHead>
          <TableHead className={head}>To</TableHead>
          <TableHead className={`${head} w-full`}>Source</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {mappings.map((m) => (
          <TableRow
            key={`${m.a.value}-${m.a.unit}-${m.b.value}-${m.b.unit}-${m.source}`}
            className="hover:bg-transparent"
          >
            <TableCell className={`${cell} pr-4 tabular-nums`}>
              {wasm.format_amount(m.a)}
            </TableCell>
            <TableCell className={`${cell} pr-4`}>
              <Row as="span" align="center" gap="xs">
                <KindAccent unit={m.b.unit} covered={covered} />
                <span className="tabular-nums">{wasm.format_amount(m.b)}</span>
              </Row>
            </TableCell>
            <TableCell
              className={`${cell} w-full truncate text-muted-foreground`}
            >
              <MappingSource mapping={m} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

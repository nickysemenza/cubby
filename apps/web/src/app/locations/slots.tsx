import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import type { DetailSlotComponent } from "~/app/_components/entity-detail/detail-slots";
import { AiDescriptionSection } from "~/app/_components/locations/ai-description-section";
import {
  calculateInventoryValuation,
  formatPricingCountsSummary,
} from "~/app/_components/locations/calculate-inventory-valuation";
import { locationChildGroupLabel } from "~/app/_components/locations/location-visual-resolver";
import { Row, Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { Eyebrow } from "~/components/ui/eyebrow";
import { entityListFor } from "~/entities/entity-list.functions";
import { formatCurrency } from "~/lib/utils";

/**
 * Rolled-up total (direct + descendants, from the persisted
 * `location.valuation`) with the by-manufacturer breakdown of the items
 * stored directly here.
 */
export const LocationContentsValuation: DetailSlotComponent<"location"> = ({
  record: location,
}) => {
  const total = location.valuation?.totalValuation ?? 0;
  const totalItems =
    location.valuation?.totalItemCount ?? location.totalItemCount ?? 0;
  const children = location.children ?? [];
  const pricingNote = formatPricingCountsSummary(location.valuation?.total);
  // Stock only, the same read the Contents relation section issues.
  const { data } = useQuery(
    entityListFor("inventory").queryOptions({
      sort: [{ orderBy: "createdAt", direction: "desc" }],
      pagination: { pageIndex: 0, pageSize: 100 },
      filters: { locationIdFilter: location.id, placementFilter: "stock" },
    }),
  );
  const breakdown = useMemo(
    () => calculateInventoryValuation(data?.items ?? []).breakdown,
    [data],
  );
  return (
    <Stack gap="xs">
      <Row align="baseline" justify="between">
        <Eyebrow as="span">Total value</Eyebrow>
        <span className="font-mono text-sm tabular-nums">
          {formatCurrency(total)}
        </span>
      </Row>
      <Description size="xs">
        {totalItems} {totalItems === 1 ? "item" : "items"}
        {children.length > 0
          ? ` across ${children.length} ${locationChildGroupLabel(children).toLowerCase()}`
          : ""}
      </Description>
      {pricingNote && <Description size="xs">{pricingNote}</Description>}
      {breakdown.length > 0 && (
        <div className="mt-2 border-t border-border pt-2">
          <Eyebrow className="mb-1">Direct items by manufacturer</Eyebrow>
          <Stack as="ul" gap="xs">
            {breakdown.slice(0, 6).map((entry) => (
              <Row
                as="li"
                key={entry.key}
                align="center"
                justify="between"
                className="text-xs"
              >
                <span className="truncate pr-2">{entry.label}</span>
                <span className="font-mono tabular-nums">
                  {formatCurrency(entry.valuation)}
                </span>
              </Row>
            ))}
          </Stack>
        </div>
      )}
    </Stack>
  );
};

export const LocationAiDescription: DetailSlotComponent<"location"> = ({
  record: location,
}) => (
  <AiDescriptionSection
    locationId={location.id}
    currentDescription={location.aiDescription ?? null}
    hasImages={(location.images ?? []).length > 0}
  />
);

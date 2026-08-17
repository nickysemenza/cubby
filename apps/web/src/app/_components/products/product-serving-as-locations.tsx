import type { ProductShortcode } from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import type { FC } from "react";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { Stack } from "~/components/layout";
import { useTRPC } from "~/integrations/trpc/react";
import { ShelfEmpty } from "../data-table/shelf";

/**
 * Locations that ARE this product — the bin, tote or rack itself, as opposed
 * to `ProductStockedAt`, which lists shelves holding it as stock.
 *
 * The two together are what "how many do I own" sums: a container in service
 * as a Location is still a unit, which is why `quantityLedger.locationCount`
 * feeds the on-hand figure.
 */
export const ProductServingAsLocations: FC<{
  productId: ProductShortcode;
  count: number;
}> = ({ productId, count }) => {
  const api = useTRPC();
  const { data, isLoading } = useQuery({
    ...api.location.list.queryOptions({
      filters: { productId },
      pagination: { pageIndex: 0, pageSize: 100 },
      sort: [],
    }),
    // The section only renders when the ledger already counted at least one.
    enabled: count > 0,
  });

  if (isLoading) return <ShelfEmpty entity="location" label="Loading…" />;

  const locations = data?.items ?? [];
  if (locations.length === 0) {
    return (
      <ShelfEmpty
        entity="location"
        label="No locations are an instance of this product."
      />
    );
  }

  return (
    <Stack gap="sm">
      {locations.map((location) => (
        <EntityInlineLink key={location.id} entity="location" data={location} />
      ))}
    </Stack>
  );
};

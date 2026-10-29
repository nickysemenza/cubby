import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { location } from "~/integrations/tanstack-query/generated/domains/location.gen";
import { CurrencyValue } from "~/ui/common/currency-value";
import { EmptyState } from "~/ui/feedback/empty-state";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Section } from "~/ui/layout";

import { HomeList, HomeRow, HomeRowsLoading } from "./home-list";

/**
 * Where pantry value is stored: the top locations by persisted direct
 * valuation. Tree structure, inventory relations, products and images stay
 * off this path; the strip shows the total from the same read.
 */
export function usePantryValue() {
  return useQuery(location.valuationSummary.queryOptions());
}

export function HomePantry() {
  const valuation = usePantryValue();
  const locations = valuation.data?.locations ?? [];
  return (
    <Section
      title="Pantry by location"
      headingAs="h2"
      ruled
      actions={<Link to="/inventory">Inventory</Link>}
    >
      {valuation.isError ? (
        <ErrorDisplay
          error={valuation.error}
          title="pantry value"
          onRetry={() => void valuation.refetch()}
          className="mt-2"
        />
      ) : valuation.data === undefined ? (
        <HomeRowsLoading label="Loading pantry value" />
      ) : locations.length === 0 ? (
        <EmptyState size="inline" className="mt-2">
          Add inventory to see where its value lives.
        </EmptyState>
      ) : (
        <HomeList label="Pantry value by location">
          {locations.map((item) => (
            <HomeRow
              key={item.id}
              trailing={
                <CurrencyValue
                  value={item.value}
                  tone={false}
                  className="font-mono text-foreground"
                />
              }
            >
              <EntityRefLink entity="location" id={item.id} name={item.name} />
            </HomeRow>
          ))}
        </HomeList>
      )}
    </Section>
  );
}

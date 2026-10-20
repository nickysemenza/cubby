import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { Page } from "~/entity/page/page";
import { usdaFood } from "~/integrations/tanstack-query/generated/catalog.gen";
import { EmptyState } from "~/ui/feedback/empty-state";
import { Stack } from "~/ui/layout";
import { Skeleton } from "~/ui/primitives/skeleton";

type AlternateId = Parameters<typeof usdaFood.alternateId.queryOptions>[0];

/** Resolves a legacy NDB number or a UPC to its FDC id and replaces the URL. */
export function UsdaAlternateIdRedirect({
  alternateId,
  label,
  notFoundDescription,
}: {
  alternateId: AlternateId;
  /** e.g. "UPC 012345678905" */
  label: string;
  notFoundDescription: string;
}) {
  const navigate = useNavigate();
  const {
    data: food,
    isLoading,
    error,
  } = useQuery(usdaFood.alternateId.queryOptions(alternateId));

  useEffect(() => {
    if (food?.fdc_id) {
      void navigate({
        to: "/usda/$id",
        params: { id: String(food.fdc_id) },
        replace: true,
      });
    }
  }, [food, navigate]);

  if (isLoading) {
    return (
      <Page variant="list" title="Looking up USDA food" entity="usda-food">
        <Stack>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-32 w-full" />
        </Stack>
      </Page>
    );
  }

  if (error || !food) {
    return (
      <Page variant="list" title="USDA food not found" entity="usda-food">
        <EmptyState size="page" description={notFoundDescription}>
          {label} not found
        </EmptyState>
      </Page>
    );
  }

  return (
    <Page variant="list" title="Redirecting to USDA food" entity="usda-food">
      <p className="text-sm text-muted-foreground">Redirecting to USDA food…</p>
    </Page>
  );
}

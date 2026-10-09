import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { usdaFood } from "~/integrations/tanstack-query/generated/usda.gen";
import { Stack } from "~/ui/layout";
import { Page } from "~/ui/page/Page";
import { Empty, EmptyDescription, EmptyTitle } from "~/ui/primitives/empty";
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
      <Page
        variant="list"
        title="Looking up USDA food"
        entity="usda-food"
        compact
      >
        <Stack>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-32 w-full" />
        </Stack>
      </Page>
    );
  }

  if (error || !food) {
    return (
      <Page
        variant="list"
        title="USDA food not found"
        entity="usda-food"
        compact
      >
        <Empty>
          <EmptyTitle>{label} not found</EmptyTitle>
          <EmptyDescription>{notFoundDescription}</EmptyDescription>
        </Empty>
      </Page>
    );
  }

  return (
    <Page
      variant="list"
      title="Redirecting to USDA food"
      entity="usda-food"
      compact
    >
      <p className="text-sm text-muted-foreground">Redirecting to USDA food…</p>
    </Page>
  );
}

import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { Skeleton } from "~/components/ui/skeleton";
import { usdaFoodAlternateIdQueryOptions } from "~/entities/usda.functions";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/usda/upc/$code")({
  head: ({ params }) => ({
    meta: [{ title: pageTitle(`USDA UPC ${params.code}`) }],
  }),
  component: USDAUPCLookupPage,
});

function USDAUPCLookupPage() {
  const { code } = Route.useParams();
  const navigate = useNavigate();

  const {
    data: food,
    isLoading,
    error,
  } = useQuery(
    usdaFoodAlternateIdQueryOptions({ kind: "upc", gtin_upc: code }),
  );

  useEffect(() => {
    if (food?.fdc_id) {
      navigate({
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
        title="Looking up UPC"
        eyebrow="USDA"
        compact
        decoration="none"
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
      <Page variant="list" title="UPC not found" eyebrow="USDA" compact>
        <Empty>
          <EmptyTitle>UPC {code} was not found</EmptyTitle>
          <EmptyDescription>
            No USDA food is linked to that barcode yet.
          </EmptyDescription>
        </Empty>
      </Page>
    );
  }

  return (
    <Page
      variant="list"
      title="Redirecting to USDA food"
      eyebrow="USDA"
      compact
      decoration="none"
    >
      <p className="text-muted-foreground text-sm">Opening USDA food...</p>
    </Page>
  );
}

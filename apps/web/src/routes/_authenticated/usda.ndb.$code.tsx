import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { Skeleton } from "~/components/ui/skeleton";
import { useTRPC } from "~/trpc/react";

export const Route = createFileRoute("/_authenticated/usda/ndb/$code")({
  component: USDANDBLookupPage,
});

function USDANDBLookupPage() {
  const { code } = Route.useParams();
  const navigate = useNavigate();
  const api = useTRPC();

  const {
    data: food,
    isLoading,
    error,
  } = useQuery(
    api.usda.getByAlternateID.queryOptions({
      kind: "ndb",
      ndb_number: parseInt(code, 10),
    }),
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
          <EmptyTitle>NDB {code} not found</EmptyTitle>
          <EmptyDescription>
            No USDA food record matched this legacy NDB number.
          </EmptyDescription>
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
      <p className="text-muted-foreground text-sm">
        Redirecting to USDA food...
      </p>
    </Page>
  );
}

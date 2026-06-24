import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { Stack } from "~/components/layout";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { Skeleton } from "~/components/ui/skeleton";
import { useTRPC } from "~/trpc/react";

export const Route = createFileRoute("/_authenticated/usda/upc/$code")({
  component: USDAUPCLookupPage,
});

function USDAUPCLookupPage() {
  const { code } = Route.useParams();
  const navigate = useNavigate();
  const api = useTRPC();

  const {
    data: food,
    isLoading,
    error,
  } = useQuery(
    api.usda.getByAlternateID.queryOptions({ kind: "upc", gtin_upc: code }),
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
      <PageWrapper>
        <Stack>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-32 w-full" />
        </Stack>
      </PageWrapper>
    );
  }

  if (error || !food) {
    return (
      <PageWrapper>
        <div>UPC {code} not found</div>
      </PageWrapper>
    );
  }

  return (
    <PageWrapper>
      <div>Redirecting to USDA food...</div>
    </PageWrapper>
  );
}

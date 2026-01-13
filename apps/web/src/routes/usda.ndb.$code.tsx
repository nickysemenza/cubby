import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { Skeleton } from "~/components/ui/skeleton";
import { authMiddleware } from "~/lib/protected-route";
import { useTRPC } from "~/trpc/react";

export const Route = createFileRoute("/usda/ndb/$code")({
  component: USDANDBLookupPage,
  server: {
    middleware: [authMiddleware],
  },
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
      <PageWrapper>
        <div className="space-y-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-32 w-full" />
        </div>
      </PageWrapper>
    );
  }

  if (error || !food) {
    return (
      <PageWrapper>
        <div>NDB {code} not found</div>
      </PageWrapper>
    );
  }

  return (
    <PageWrapper>
      <div>Redirecting to USDA food...</div>
    </PageWrapper>
  );
}

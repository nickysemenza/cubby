import { createFileRoute } from "@tanstack/react-router";
import { AuditLogList } from "~/app/_components/audit-log/audit-log-list";
import { EntityLayout } from "~/components/layouts/entity-layout";

export const Route = createFileRoute("/_authenticated/activity")({
  // Warm the first page of the audit feed during route load so the list renders
  // hydrated instead of flashing a spinner on mount. Input + getNextPageParam
  // must match AuditLogList's useInfiniteQuery (default limit 20, no entity
  // filters) or the cache won't be reused. prefetch (not ensure) so a cold feed
  // never blocks navigation.
  loader: async ({ context }) => {
    void context.queryClient.prefetchInfiniteQuery(
      context.trpc.auditLog.list.infiniteQueryOptions(
        { limit: 20 },
        { getNextPageParam: (lastPage) => lastPage.nextCursor },
      ),
    );
  },
  component: ActivityPage,
});

function ActivityPage() {
  return (
    <EntityLayout title="Activity">
      <div className="max-w-3xl">
        <p className="mb-6 text-muted-foreground">
          Recent changes to products, locations, inventory, recipes, and
          ingredients.
        </p>
        <AuditLogList showEntityLink={true} />
      </div>
    </EntityLayout>
  );
}

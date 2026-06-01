import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DollarSign } from "lucide-react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { EntityIcon } from "~/entities/entities";
import { getErrorMessage } from "~/lib/error-utils";
import { formatCurrency } from "~/lib/utils";
import type { InventoryWithStaleValuation } from "~/server/repo/problems";
import { useTRPC } from "~/trpc/react";
import { ProblemSection } from "./problem-section";

export function InventoryWithStaleValuationsList({
  entries,
}: {
  entries: InventoryWithStaleValuation[];
}) {
  const api = useTRPC();
  const queryClient = useQueryClient();

  const backfillMutation = useMutation(
    api.inventory.backfillInventoryValuations.mutationOptions({
      onSuccess: (result) => {
        if (result.updated > 0) {
          toast.success(
            `Synced ${result.updated} inventory valuation${result.updated !== 1 ? "s" : ""}`,
          );
        } else {
          toast.info("No inventory entries need valuation sync");
        }
        // Wrap keys in array to match tRPC's nested structure: [["entity", "list"], {...}]
        queryClient.invalidateQueries({
          queryKey: [api.problems.getAllProblems.queryKey()],
        });
        queryClient.invalidateQueries({
          queryKey: [api.inventory.list.queryKey()],
        });
      },
      onError: (error) => {
        toast.error(getErrorMessage(error));
      },
    }),
  );

  return (
    <ProblemSection
      title="Stale Inventory Valuations"
      description="Inventory entries where the stored valuation doesn't match amount × product price."
      icon={DollarSign}
      items={entries}
      emptyMessage="All inventory valuations are in sync."
      headerAction={
        <Button
          size="sm"
          onClick={() => backfillMutation.mutate()}
          disabled={backfillMutation.isPending}
        >
          {backfillMutation.isPending ? (
            <>
              <Spinner className="mr-2" />
              Syncing...
            </>
          ) : (
            "Sync All Valuations"
          )}
        </Button>
      }
      renderItem={(entry) => ({
        title: entry.productName,
        details: [
          <div
            key="location"
            className="flex items-center gap-2 text-muted-foreground text-sm"
          >
            <EntityIcon entity="location" colored className="h-3 w-3" />
            {entry.locationName}
          </div>,
        ],
        badges: [
          <span key="valuations" className="text-muted-foreground text-sm">
            {entry.storedValuation !== null
              ? formatCurrency(entry.storedValuation)
              : "null"}{" "}
            →{" "}
            {entry.expectedValuation != null
              ? formatCurrency(entry.expectedValuation)
              : "null"}
          </span>,
        ],
        route: { to: "/inventory/$id" as const, params: { id: entry.id } },
      })}
    />
  );
}

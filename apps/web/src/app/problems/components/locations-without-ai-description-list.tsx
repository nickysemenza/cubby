import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { getErrorMessage } from "~/lib/error-utils";
import type { LocationWithoutAiDescription } from "~/server/repo/problems";
import { useTRPC } from "~/trpc/react";
import { ProblemSection } from "./problem-section";

export function LocationsWithoutAiDescriptionList({
  locations,
}: {
  locations: LocationWithoutAiDescription[];
}) {
  const api = useTRPC();
  const queryClient = useQueryClient();

  const backfillMutation = useMutation(
    api.ai.backfillLocationDescriptions.mutationOptions({
      onSuccess: (result) => {
        if (result.analyzed > 0) {
          toast.success(
            `Analyzed ${result.analyzed} location${result.analyzed !== 1 ? "s" : ""}`,
          );
        } else {
          toast.info("No locations need AI description");
        }
        queryClient.invalidateQueries({
          queryKey: [api.problems.getAllProblems.queryKey()],
        });
      },
      onError: (error) => {
        toast.error(getErrorMessage(error));
      },
    }),
  );

  return (
    <ProblemSection
      title="Missing AI Descriptions"
      description="Locations with photos that haven't been analyzed by AI yet. Run backfill to generate descriptions for all."
      icon={Sparkles}
      items={locations}
      emptyMessage="All locations with photos have AI descriptions."
      headerAction={
        <Button
          size="sm"
          onClick={() => backfillMutation.mutate()}
          disabled={backfillMutation.isPending}
        >
          {backfillMutation.isPending ? (
            <>
              <Spinner className="mr-2" />
              Analyzing...
            </>
          ) : (
            `Analyze All (${locations.length})`
          )}
        </Button>
      }
      renderItem={(location) => ({
        title: location.name,
        badges: [
          <Badge key="type" variant="outline" className="capitalize">
            {location.type}
          </Badge>,
          <Badge key="images" variant="secondary">
            {location.imageCount}{" "}
            {location.imageCount === 1 ? "photo" : "photos"}
          </Badge>,
        ],
        route: {
          to: "/locations/$id" as const,
          params: { id: location.id },
        },
      })}
    />
  );
}

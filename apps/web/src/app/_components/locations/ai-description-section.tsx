import type { LocationShortcode } from "@cubby/schemas/identifiers";
import { Eye, Sparkles } from "lucide-react";
import type { FC } from "react";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { Spinner } from "~/components/ui/spinner";
import { entityDetailQueryKey } from "~/entities/entity-detail";
import { useTRPC } from "~/integrations/trpc/react";

interface AiDescriptionSectionProps {
  locationId: LocationShortcode;
  currentDescription: string | null;
  hasImages: boolean;
}

export const AiDescriptionSection: FC<AiDescriptionSectionProps> = ({
  locationId,
  currentDescription,
  hasImages,
}) => {
  const api = useTRPC();

  const describeMutation = useActionMutation({
    mutationFn: api.ai.describeLocation.mutationOptions,
    success: "Description saved.",
    invalidateKeys: [entityDetailQueryKey("location", locationId)],
  });

  const canAnalyze = hasImages;

  return (
    <Stack className="items-start" gap="md">
      <Button
        variant="outline"
        size="sm"
        onClick={() => describeMutation.mutate({ locationId })}
        disabled={!canAnalyze || describeMutation.isPending}
      >
        {describeMutation.isPending ? (
          <Spinner className="mr-2" />
        ) : (
          <Sparkles className="mr-2 size-4" />
        )}
        {currentDescription ? "Re-analyze" : "Analyze Contents"}
      </Button>

      {!hasImages && (
        <Description>
          Add photos to this location to enable AI analysis
        </Description>
      )}

      {currentDescription && (
        <div className="rounded-md bg-muted/50 p-4 text-sm">
          <Row align="center" gap="sm" className="mb-1 text-muted-foreground">
            <Eye className="size-3" />
            <span className="font-medium">AI Description</span>
          </Row>
          <p>{currentDescription}</p>
        </div>
      )}
    </Stack>
  );
};

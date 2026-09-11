import type { AiCacheMetadata, Confidence } from "@cubby/schemas/ai";
import type { LocationShortcode } from "@cubby/schemas/identifiers";
import { Eye } from "lucide-react";
import { type FC, useState } from "react";

import { VerbButton } from "~/app/_components/actions/action-verb-ui";
import {
  AiProposalCard,
  AiProvenance,
  AiTextDiff,
} from "~/app/_components/ai/ai-proposal-card";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { Row, Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { ai } from "~/lib/ai.functions";

interface AiDescriptionSectionProps {
  locationId: LocationShortcode;
  currentDescription: string | null;
  hasImages: boolean;
}

/**
 * "What is in this bin?", answered from the location's photos.
 *
 * The result is reviewed rather than dropped in silently: the card shows the
 * previous description beside the new one, so a re-analysis that lost a detail
 * is visible instead of being discovered weeks later. Accept keeps it; Dismiss
 * closes the review and leaves the "Re-analyze" affordance in reach.
 *
 * KNOWN GAP: `describeLocation` persists the description server-side before it
 * returns, and `Location.aiDescription` is a read-only field with no client
 * write path, so Dismiss cannot undo the write and Keep is an acknowledgement
 * rather than the write itself. Making acceptance the write needs
 * `describeLocation` to stop persisting plus a writable field. The review, the
 * diff and the provenance are the parts that were missing entirely.
 */
export const AiDescriptionSection: FC<AiDescriptionSectionProps> = ({
  locationId,
  currentDescription,
  hasImages,
}) => {
  // The description as it stood when the run started — the left side of the
  // diff. Held locally because the location query refetches under the card.
  const [review, setReview] = useState<{
    previous: string | null;
    next: string;
    confidence: Confidence;
    cache: AiCacheMetadata;
    analyzedAt: Date;
  } | null>(null);

  const describeMutation = useActionMutation({
    mutationFn: ai.describeLocation.mutationOptions,
    success: "Location analyzed.",
    onSuccess: (data) => {
      setReview((prior) => ({
        previous: prior?.previous ?? currentDescription,
        next: data.description,
        confidence: data.confidence,
        cache: data.cache,
        analyzedAt: data.analyzedAt,
      }));
    },
  });

  const analyze = () => {
    setReview(null);
    describeMutation.mutate({ locationId });
  };

  return (
    <Stack className="items-start" gap="md">
      <VerbButton
        verb="analyze"
        pending={describeMutation.isPending}
        disabledReason={
          hasImages ? undefined : "Add a photo to this location to analyze it"
        }
        className="min-h-9 max-sm:min-h-11"
        onClick={analyze}
      />

      {!hasImages && (
        <Description>
          Add photos to this location to enable AI analysis
        </Description>
      )}

      {review && (
        <AiProposalCard
          label="Analyzed contents"
          confidence={review.confidence}
          reasoning="Read from this location's photos."
          diff={<AiTextDiff current={review.previous} proposed={review.next} />}
          provenance={
            <AiProvenance
              model={review.cache.model}
              analyzedAt={review.analyzedAt}
              cacheStatus={review.cache.status}
            />
          }
          acceptLabel="Keep"
          dismissLabel="Hide"
          onAccept={() => setReview(null)}
          onDismiss={() => setReview(null)}
        />
      )}

      {!review && currentDescription && (
        <div className="border border-border bg-muted/30 p-4 text-sm">
          <Row align="center" gap="sm" className="mb-1 text-muted-foreground">
            <Eye className="size-3" />
            <span className="font-medium">AI description</span>
          </Row>
          <p>{currentDescription}</p>
        </div>
      )}
    </Stack>
  );
};

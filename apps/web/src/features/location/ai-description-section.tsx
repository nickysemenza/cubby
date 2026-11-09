import type { AiCacheMetadata, Confidence } from "@cubby/schemas/ai";
import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type { FC } from "react";

import { VerbButton } from "~/entity/actions/action-verb-ui";
import { useActionMutation } from "~/entity/hooks/use-action-mutation";
import {
  AiProposalCard,
  AiProvenance,
  AiTextDiff,
} from "~/entity/suggestions/ai-proposal-card";
import { useAiProposal } from "~/entity/suggestions/use-ai-proposal";
import { ai } from "~/integrations/tanstack-query/generated/domains/ai.gen";
import { Stack } from "~/ui/layout";
import { Description } from "~/ui/text/description";

interface AiDescriptionSectionProps {
  locationId: LocationShortcode;
  hasImages: boolean;
}

interface DescriptionReview {
  previous: string | null;
  next: string;
  confidence: Confidence;
  cache: AiCacheMetadata;
  analyzedAt: Date;
}

/**
 * "What is in this bin?", answered from the location's photos. The `ai-description`
 * collection section lists the saved description; this is its analyze action.
 *
 * The result is shown rather than dropped in silently: the card sets the
 * previous description beside the saved one, so a re-analysis that lost a
 * detail is visible instead of being discovered weeks later.
 *
 * `describeLocation` persists the description before it returns and
 * `Location.aiDescription` has no client write path, so the card reports a
 * saved result and offers only Done, as native does. Making acceptance the
 * write would need `describeLocation` to stop persisting plus a writable field.
 */
export const AiDescriptionSection: FC<AiDescriptionSectionProps> = ({
  locationId,
  hasImages,
}) => {
  const describeMutation = useActionMutation({
    mutationFn: ai.describeLocation.mutationOptions,
    success: "Location analyzed.",
  });

  const {
    proposal: review,
    isLoading,
    request,
    dismiss,
  } = useAiProposal<DescriptionReview>({
    // Nothing here invalidates by input change today — re-analysis only ever
    // happens from an explicit click, which clears the card itself (below) —
    // so a basis that never changes for a mounted instance preserves that.
    basisKey: locationId,
    run: async () => {
      const data = await describeMutation.mutateAsync({ locationId });
      // The server says what the description was before this run (the left
      // side of the diff): the run replaces it, and native reads the same field.
      return {
        previous: data.previousDescription,
        next: data.description,
        confidence: data.confidence,
        cache: data.cache,
        analyzedAt: data.analyzedAt,
      };
    },
    // `useActionMutation` already surfaces its own error toast.
    onError: () => undefined,
  });

  const analyze = () => {
    dismiss();
    void request();
  };

  return (
    <Stack className="items-start" gap="md">
      <VerbButton
        verb="analyze"
        pending={isLoading}
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
          confidence={review.result.confidence}
          reasoning="Read from this location's photos."
          diff={
            <AiTextDiff
              current={review.result.previous}
              proposed={review.result.next}
              labels={{ current: "Previous", proposed: "Saved" }}
            />
          }
          provenance={
            <AiProvenance
              model={review.result.cache.model}
              analyzedAt={review.result.analyzedAt}
              cacheStatus={review.result.cache.status}
            />
          }
          dismissLabel="Done"
          onDismiss={dismiss}
        />
      )}
    </Stack>
  );
};

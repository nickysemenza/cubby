import type { enrichmentProposalPrecomputeInput } from "@cubby/schemas/ai";
import type { z } from "zod";

import { aiStreams } from "~/integrations/tanstack-query/generated/ai.gen";

export const backfillLocationDescriptionsStream = (signal?: AbortSignal) =>
  aiStreams.backfillLocationDescriptions.open(undefined, { signal });
export const precomputeEnrichmentProposalsStream = (
  input: z.input<typeof enrichmentProposalPrecomputeInput>,
  signal?: AbortSignal,
) => aiStreams.precomputeEnrichmentProposals.open(input, { signal });

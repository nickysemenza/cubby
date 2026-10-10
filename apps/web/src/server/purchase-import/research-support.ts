import { runEntityId } from "@cubby/schemas/identifiers";
import {
  researchAssessment,
  type ResearchAssessment,
} from "@cubby/schemas/research-assessment";
import type { ResearchWorkResolution } from "@cubby/schemas/research-tools";
import { z, type JSONType } from "zod";

import { RESEARCH_SUPPORT_FEATURE } from "~/server/ai/features";
import { runStructuredFeature } from "~/server/ai/run-feature";
import type { Database } from "~/server/db";
import { paidResearchPreflight } from "~/server/runs/execution-transport";

import supportRules from "../../../../../.claude/skills/purchase-import/references/research-support.md?raw";
import { attachmentAssessmentContext } from "./research-attachment-content";

export type ResearchAssessmentInput = {
  context: unknown;
  observations: readonly {
    evidenceId: string;
    metadata: unknown;
    content: string;
  }[];
  proposal: ResearchWorkResolution;
};
export type ResearchAssessor = (
  input: ResearchAssessmentInput,
) => Promise<z.input<typeof researchAssessment>>;

const orderedAssessmentContext = z.looseObject({
  orderedVariant: z.array(
    z.looseObject({ originalExtractions: z.array(z.json()) }),
  ),
});

/** Share exact serialized originals; never summarize or mutate retained context. */
function assessmentContext(input: Pick<ResearchAssessmentInput, "context">) {
  const context = input.context;
  const parsed = orderedAssessmentContext.safeParse(context);
  if (!parsed.success || "originalExtractions" in parsed.data) return context;
  const originals = new Map<string, { index: number; value: JSONType }>();
  let count = 0;
  const orderedVariant = parsed.data.orderedVariant.map(
    ({ originalExtractions, ...row }) => ({
      ...row,
      originalExtractionIndices: originalExtractions.map((value) => {
        count++;
        const key = JSON.stringify(value);
        let original = originals.get(key);
        if (!original) {
          original = { index: originals.size, value };
          originals.set(key, original);
        }
        return original.index;
      }),
    }),
  );
  if (originals.size === count) return context;
  return {
    ...parsed.data,
    orderedVariant,
    originalExtractions: [...originals.values()].map(
      (original) => original.value,
    ),
  };
}

/** Build the complete retained-original request for production and interactive probes. */
export async function researchAssessmentRequest(
  input: ResearchAssessmentInput,
) {
  const originals = await attachmentAssessmentContext(input.observations);
  return {
    systemPrompts: [supportRules],
    messages: [
      {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            content: JSON.stringify({
              context: assessmentContext(input),
              observations: originals.observations,
              proposal: input.proposal,
            }),
          },
          ...originals.parts,
        ],
      },
    ],
  };
}

/** The same retained-source contract serves mail linking and catalog research. */
export async function assessResearchProposal(
  input: ResearchAssessmentInput & { db: Database; runId: string },
): Promise<ResearchAssessment> {
  return researchAssessment.parse(
    await runStructuredFeature(
      RESEARCH_SUPPORT_FEATURE,
      await researchAssessmentRequest(input),
      {
        db: input.db,
        runId: runEntityId.parse(input.runId),
        operation: "research-source-support",
        subscriptionRequired: true,
        subscriptionFallback: "budgeted",
        beforePaidRequest: paidResearchPreflight(
          input.db,
          runEntityId.parse(input.runId),
        ),
      },
    ),
  );
}

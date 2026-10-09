import { runEntityId } from "@cubby/schemas/identifiers";
import {
  researchAssessment,
  type ResearchAssessment,
} from "@cubby/schemas/research-assessment";
import type { ResearchWorkResolution } from "@cubby/schemas/research-tools";
import type { z } from "zod";

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
              context: input.context,
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

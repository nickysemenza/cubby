import { assessmentContract } from "~/contracts/assessment.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  reviewAssessment,
  reviewAssessmentBatch,
} from "~/server/repo/assessment-review";

export const assessmentHandlers = implementOperationDomain(assessmentContract, {
  review: (context, input) => reviewAssessment(context.db, context, input),
  reviewBatch: (context, input) =>
    reviewAssessmentBatch(context.db, context, input),
});

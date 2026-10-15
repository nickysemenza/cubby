import { assessmentContract } from "~/contracts/assessment.contract";
import {
  reviewAssessment,
  reviewAssessmentBatch,
} from "~/server/generic/assessment/repo/assessment-review";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

export const assessmentHandlers = implementOperationDomain(assessmentContract, {
  review: (context, input) => reviewAssessment(context.db, context, input),
  reviewBatch: (context, input) =>
    reviewAssessmentBatch(context.db, context, input),
});

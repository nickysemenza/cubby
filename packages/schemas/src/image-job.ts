import { activitySubmissionId } from "./activity";
import { imageJobFilterFields as imageJobBaseFilterFields } from "@cubby/schemas/entities/imageJob";
import { oneOrMany } from "./pagination";

export const imageJobFilterFields = {
  ...imageJobBaseFilterFields,
  /** Jobs that joined any of these submissions (`IPS-…`), including later retries. */
  submissionId: oneOrMany(activitySubmissionId).optional(),
};

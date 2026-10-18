import { z } from "zod";

import { activitySubmissionId } from "./activity";
import {
  imageJobBaseFilterFields,
  imageJobOut,
} from "./generated/imageJob.gen";
import { createPaginatedResponseSchema, oneOrMany } from "./pagination";

export { imageJobOut, type ImageJobOut } from "./generated/imageJob.gen";

export const imageJobFilterFields = {
  ...imageJobBaseFilterFields,
  /** Jobs that joined any of these submissions (`IPS-…`), including later retries. */
  submissionId: oneOrMany(activitySubmissionId).optional(),
};
export const imageJobFilters = z.object(imageJobFilterFields);
export type ImageJobFilters = z.infer<typeof imageJobFilters>;

export const imageJobListResponse = createPaginatedResponseSchema(imageJobOut);

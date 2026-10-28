import { z } from "zod";

import { activitySubmissionId } from "./activity";
import {
  imageJobFilterFields as imageJobBaseFilterFields,
  imageJobOut,
} from "@cubby/schemas/entities/imageJob";
import { createPaginatedResponseSchema, oneOrMany } from "./pagination";

export const imageJobFilterFields = {
  ...imageJobBaseFilterFields,
  /** Jobs that joined any of these submissions (`IPS-…`), including later retries. */
  submissionId: oneOrMany(activitySubmissionId).optional(),
};
export const imageJobFilters = z.object(imageJobFilterFields);
export type ImageJobFilters = z.infer<typeof imageJobFilters>;

export const imageJobListResponse = createPaginatedResponseSchema(imageJobOut);

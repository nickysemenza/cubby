import { z } from "zod";
import { jobFilterFields as jobBaseFilterFields } from "@cubby/schemas/entities/job";

export const jobFilterFields = jobBaseFilterFields;
export const jobFilters = z.object(jobFilterFields);
export type JobFilters = z.infer<typeof jobFilters>;

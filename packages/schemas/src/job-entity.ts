import { z } from "zod";
import { jobBaseFilterFields } from "./generated/job.gen";
export { jobOut, type JobOut } from "./generated/job.gen";
export const jobFilterFields = jobBaseFilterFields;
export const jobFilters = z.object(jobFilterFields);
export type JobFilters = z.infer<typeof jobFilters>;

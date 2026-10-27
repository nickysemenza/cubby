import { z } from "zod";

/** Successful absence is distinct from a computation that has no result. */
export const fieldEmptyReason = z.enum([
  "explicit_none",
  "unset",
  "blocked",
  "mixed",
  "not_applicable",
]);

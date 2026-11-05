import { DERIVED_DRAIN_JOB_KEY } from "~/server/db/derived-trigger-ddl";
/** Retained predecessor address; no claim, fan-out or execution implementation. */
export const DERIVED_DRAIN = {
  key: DERIVED_DRAIN_JOB_KEY,
  kind: "derived.drain",
} as const;

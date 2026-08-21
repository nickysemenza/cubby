// Internal to this module — only `isUnbatchedTRPCPath` is consumed elsewhere
// (the tRPC split link), so the rest stay un-exported rather than read as dead
// exports (knip).
const PROBLEMS_HOT_PATH_PROCEDURES = [
  "getFast",
  "getViews",
  "getCoverage",
  "getUpc",
  "getTracker",
] as const;

const PROBLEMS_UNBATCHED_PROCEDURES = [
  ...PROBLEMS_HOT_PATH_PROCEDURES,
] as const;

export type ProblemsHotPathProcedure =
  (typeof PROBLEMS_HOT_PATH_PROCEDURES)[number];

const PROBLEMS_UNBATCHED_PATHS = new Set(
  PROBLEMS_UNBATCHED_PROCEDURES.map(
    (procedure) => `problems.${procedure}` as const,
  ),
);

export function isUnbatchedTRPCPath(path: string) {
  return PROBLEMS_UNBATCHED_PATHS.has(
    path as `problems.${(typeof PROBLEMS_UNBATCHED_PROCEDURES)[number]}`,
  );
}

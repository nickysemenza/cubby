export const PROBLEMS_HOT_PATH_PROCEDURES = [
  "getFast",
  "getCoverage",
  "getUpc",
] as const;

export type ProblemsHotPathProcedure =
  (typeof PROBLEMS_HOT_PATH_PROCEDURES)[number];

export function problemsProcedurePath(procedure: ProblemsHotPathProcedure) {
  return `problems.${procedure}` as const;
}

export const PROBLEMS_UNBATCHED_PATHS = new Set(
  PROBLEMS_HOT_PATH_PROCEDURES.map(problemsProcedurePath),
);

export function isUnbatchedTRPCPath(path: string) {
  return PROBLEMS_UNBATCHED_PATHS.has(
    path as ReturnType<typeof problemsProcedurePath>,
  );
}

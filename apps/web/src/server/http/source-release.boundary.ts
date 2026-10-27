import { getSourceRelease } from "~/server/cf-env";

export interface SourceRelease {
  commit: string;
  branch: string;
  date: string | null;
  sentryRelease: string;
}

/** The deployed Worker's release values for the root document. */
export function readSourceRelease(): SourceRelease {
  return getSourceRelease();
}

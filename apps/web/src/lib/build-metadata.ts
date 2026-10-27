import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";

import { readSourceRelease } from "~/server/http/source-release.boundary";

// The deployed Worker's values, not build constants: one bundle serves every
// commit. The root head also hands the release to browser Sentry (router.tsx).
const getBuildMetadata = createServerFn({ method: "GET" }).handler(() =>
  readSourceRelease(),
);

/** The root document's meta tag naming the deployed Sentry release. */
export const SENTRY_RELEASE_META = "cubby-release";

export type BuildMetadata = Awaited<ReturnType<typeof getBuildMetadata>>;

// The root loader hydrates this snapshot with the document. Retain it for the
// page lifetime, including navigation and invalidation, without persisting it
// across document loads or refetching metadata from a newer deployment.
export const buildMetadataQueryOptions = queryOptions({
  queryKey: ["build-metadata"],
  queryFn: () => getBuildMetadata(),
  staleTime: Infinity,
  gcTime: Infinity,
});

import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";

const getBuildMetadata = createServerFn({ method: "GET" }).handler(() => ({
  date: __BUILD_DATE__,
  branch: __SOURCE_BRANCH__,
  commit: __SOURCE_COMMIT__,
}));

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

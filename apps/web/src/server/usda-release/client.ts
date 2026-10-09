import { releaseId, usdaReleaseObjectName } from "@cubby/usda/release";

import type { UsdaReleaseRpc } from "./rpc";

export { usdaReleaseObjectName };

/**
 * The active USDA release's Durable Object. Pinned to western North America,
 * beside the database and the Worker's placement: an object lives where it is
 * first created, and a first touch from a travelling phone must not decide it.
 */
export function activeUsdaRelease(
  env: Pick<Env, "USDA_RELEASE" | "USDA_ACTIVE_RELEASE">,
): UsdaReleaseRpc {
  return env.USDA_RELEASE.getByName(
    usdaReleaseObjectName(releaseId.parse(env.USDA_ACTIVE_RELEASE)),
    { locationHint: "wnam" },
  );
}

import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

/** Data-layer subset of the generated Worker bindings. */
export interface EdgeBindings {
  DB: D1Database;
  USDA_BUNDLES: R2Bucket;
}

/** Colo cache surface consumed by the USDA data layer. */
export interface EdgeCachePort {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

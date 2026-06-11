import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

export interface EdgeBindings {
  DB: D1Database;
  USDA_BUNDLES: R2Bucket;
}

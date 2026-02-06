// Shim for `pg` on Cloudflare Workers.
// CF Workers always use the Neon WebSocket path — the `pg` Pool/Client are
// unreachable, but drizzle-orm's neon-serverless session destructures
// `{ Pool, types }` from what resolves as `pg`, so types must be real.
//
// Re-export Pool and types from @neondatabase/serverless which bundles pg-types
// internally (includes builtins, getTypeParser, setTypeParser).

import { Pool, types } from "@neondatabase/serverless";

export { Pool, types };

export class Client {
  constructor() {
    throw new Error(
      "pg Client is not available in Cloudflare Workers. Use a Neon database URL.",
    );
  }
}

export const native = null;

const pg = { Pool, Client, types, native };
export default pg;

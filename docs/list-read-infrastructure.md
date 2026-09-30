# List-read infrastructure limits

Read-only inspection on 2026-09-29 verified regional alignment and existing policy. No deployment, routes, secrets, configuration, persistent namespaces, database records, indexes, or migrations changed. Private identifiers, origin hostnames, credentials, and records are omitted.

| Configuration             | Verified value                                   |
| ------------------------- | ------------------------------------------------ |
| Neon PostgreSQL           | Version 17, `aws-us-west-2`                      |
| Active Worker placement   | Targeted `aws:us-west-2`                         |
| Strong Hyperdrive         | Origin limit 12; query caching disabled          |
| Bounded-stale Hyperdrive  | Origin limit 5; query caching enabled            |
| Hyperdrive origins        | Same database and host in US West 2              |
| Request-local client caps | Five strong sockets and one bounded-stale socket |

The deployed placement was read from the active version through authenticated Wrangler 4.134.0. Hyperdrive configuration was also inspected live. Request-local caps come from [`DatabaseRuntimeResolver`](../apps/web/src/server/db-runtime-resolver.ts); they are separate from Hyperdrive's origin limits. No deployed socket usage, saturation, pool wait, or cache-hit measurement is claimed.

The cached Hyperdrive response omitted optional timing overrides. Cloudflare documents defaults of 60 seconds maximum age and 15 seconds stale while revalidating, matching [`hyperdrive-cache-policy.ts`](../apps/web/src/lib/hyperdrive-cache-policy.ts). [Cloudflare query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/), [Hyperdrive response fields](https://developers.cloudflare.com/api/resources/hyperdrive/).

Production statement statistics had recently reset. A branch-scoped Product/Image/ImageDerivative statement search returned no application SQL; slow-query results contained platform statements only. No observed slow application statement or production execution plan supports an index change. The authoritative [`loadImageRepresentations`](../apps/web/src/server/repo/image-processing.ts) retains current hash, processor revision, ready status, purpose, and live-row gates.

Version URLs do not support the required Durable Object path. The installed Wrangler remote-preview implementation explicitly omits placement, so remote dev cannot verify the configured regional placement or compare placement variants. The ephemeral preview was stopped. Performance sampling was stopped at the user's request; no candidate timing artifacts are published and no latency improvement is claimed. Existing placement and pool policy are retained.

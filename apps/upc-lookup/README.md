# upc-lookup

A UPC/barcode → product lookup service on Cloudflare Workers (Hono + Drizzle/D1 + R2).
Resolves a barcode to product info (name, brand, category, price, image), caches it in
D1, and stores images in R2. Consumed by the main cubby web app as the general-products
fallback in its barcode-scan flow.

## Surfaces

- **REST API** — `/lookup/:upc`, `/search`, `/stats` (API-key auth). Interactive docs
  (Scalar) at `/`, raw spec at `/openapi.json`.
- **Admin UI** — `/admin` (cookie auth). Browse/search with pagination, create, edit,
  re-fetch, and delete cached products.
- **MCP** — `/mcp` (Streamable HTTP). Tools for agents with full parity to the admin:
  `lookup_upc`, `search_products`, `get_product`, `create_product`, `update_product`,
  `refetch_product`, `delete_product`, `get_stats`. Auth via `X-API-Key` or
  `Authorization: Bearer <key>`.

## Data sources

External lookups go through a **pluggable source registry** (`src/api/sources/`).
`lookupExternalProduct` tries each registered source in order and returns the first hit.
Currently only **UPCitemdb** ships. To add a source: implement the `ProductSource`
interface in its own module and append it to `SOURCES` in `src/api/sources/index.ts` —
the `source` type and the validation enum derive from that array automatically.

## Development

```sh
pnpm --filter @cubby/upc-lookup dev:local      # vite dev server
pnpm --filter @cubby/upc-lookup db:generate    # generate a migration after schema edits
pnpm --filter @cubby/upc-lookup db:migrate:local
pnpm --filter @cubby/upc-lookup test           # vitest
pnpm --filter @cubby/upc-lookup deploy         # build + wrangler deploy
pnpm --filter @cubby/upc-lookup db:migrate:remote
```

The `API_KEY` secret gates the API, admin, and MCP. Set it with
`wrangler secret put API_KEY` (and `.dev.vars` locally).

# UPC Lookup Worker Design

## Overview

Cloudflare Worker that provides UPC/barcode lookup functionality for recipehub inventory management. Caches product data (name, manufacturer, price, images) from free external APIs to avoid rate limits.

## Use Case

General inventory lookup - both food products and non-food items (tools, electronics, household goods). Auto-fill product details when user enters a UPC during inventory input or CSV import.

## Architecture

```
recipehub (web)
  └── tRPC Router (upc.lookup)
        │
        │ API Key auth
        ▼
UPC Lookup Worker (Cloudflare)
  ├── D1 (product metadata cache, searchable)
  ├── R2 (product images)
  │
  └── External APIs (cascading fallback):
        1. UPCitemdb (100 req/day free)
        2. Open Food Facts (unlimited, food-focused)
```

## Tech Stack

- **Runtime**: Cloudflare Workers
- **Framework**: Hono with `@hono/zod-openapi`
- **Database**: D1 (SQLite) with Drizzle ORM
- **Image Storage**: R2
- **Build**: Vite (for admin UI)

## Deployment

- **Separate repo**: `../upc-lookup` (not in recipehub monorepo)
- **Single production instance**: Used by both dev and prod recipehub environments
- **Auth**: API key in `X-API-Key` header

## D1 Schema

```sql
CREATE TABLE products (
  upc TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  manufacturer TEXT,
  brand TEXT,
  category TEXT,
  description TEXT,
  price_cents INTEGER,
  price_currency TEXT,
  image_key TEXT,               -- R2 object key
  source TEXT NOT NULL,         -- "upcitemdb" | "openfoodfacts"
  source_data TEXT,             -- full JSON response
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_products_name ON products(name);
CREATE INDEX idx_products_manufacturer ON products(manufacturer);
```

## API Endpoints

### `GET /lookup/:upc`

Primary lookup endpoint. Returns cached data or fetches from external APIs.

**Headers**: `X-API-Key: <secret>`

**Response**:
```json
{
  "upc": "012345678901",
  "name": "Product Name",
  "manufacturer": "Brand Co",
  "brand": "Brand",
  "category": "Electronics",
  "description": "Product description",
  "price": { "cents": 1999, "currency": "USD" },
  "imageUrl": "https://r2-public-url/images/012345678901.jpg",
  "source": "upcitemdb",
  "cached": true
}
```

**404 Response** (not found):
```json
{
  "found": false,
  "upc": "012345678901"
}
```

### `GET /search?q=<query>&limit=20`

Search cached products by name/manufacturer.

**Headers**: `X-API-Key: <secret>`

**Response**:
```json
{
  "products": [...],
  "total": 42
}
```

### `GET /stats`

Cache statistics for monitoring.

**Headers**: `X-API-Key: <secret>`

**Response**:
```json
{
  "totalProducts": 1234,
  "bySource": { "upcitemdb": 800, "openfoodfacts": 434 },
  "storageUsed": { "d1Rows": 1234, "r2Objects": 1100 }
}
```

## Lookup Flow

1. Check D1 cache by UPC
2. If cache hit → return cached data with `cached: true`
3. If cache miss → try UPCitemdb API
4. If UPCitemdb fails/empty → try Open Food Facts API
5. If found → store metadata in D1, download image to R2, return data
6. If all sources miss → return 404

## R2 Image Handling

```typescript
async function storeImage(upc: string, imageUrl: string, env: Env): Promise<string | null> {
  const res = await fetch(imageUrl);
  if (!res.ok) return null;

  const contentType = res.headers.get("content-type") ?? "image/jpeg";
  const ext = contentType.includes("png") ? "png" : "jpg";
  const key = `images/${upc}.${ext}`;

  await env.IMAGES.put(key, res.body, {
    httpMetadata: { contentType },
  });

  return `${env.R2_PUBLIC_URL}/${key}`;
}
```

- Bucket: `upc-images` with public access enabled
- Key format: `images/{upc}.{ext}`
- Failed image fetch doesn't block product data return

## Recipehub Integration

### Client

```typescript
// apps/web/src/server/clients/upc.ts
const UPC_WORKER_URL = process.env.UPC_WORKER_URL;
const UPC_API_KEY = process.env.UPC_API_KEY;

export async function lookupUPC(upc: string) {
  const res = await fetch(`${UPC_WORKER_URL}/lookup/${upc}`, {
    headers: { "X-API-Key": UPC_API_KEY },
  });

  if (!res.ok) return null;
  return upcLookupResponseSchema.parse(await res.json());
}
```

### tRPC Router

```typescript
// apps/web/src/server/api/routers/upc.ts
export const upcRouter = createTRPCRouter({
  lookup: protectedProcedure
    .input(z.object({ upc: z.string() }))
    .output(upcLookupResponseSchema.nullable())
    .query(async ({ input }) => {
      return lookupUPC(input.upc);
    }),
});
```

### Schema Sharing

Copy Zod schemas from worker to recipehub (manual sync). Small, stable API surface makes this manageable.

```typescript
// apps/web/src/schemas/upc-lookup.ts
export const upcLookupResponseSchema = z.object({
  upc: z.string(),
  name: z.string(),
  manufacturer: z.string().nullable(),
  brand: z.string().nullable(),
  category: z.string().nullable(),
  description: z.string().nullable(),
  price: z.object({
    cents: z.number(),
    currency: z.string()
  }).nullable(),
  imageUrl: z.string().nullable(),
  source: z.enum(["upcitemdb", "openfoodfacts"]),
  cached: z.boolean(),
});
```

### CSV Import Integration

```typescript
// In row-processor.ts
if (row.upc && !row.product_name) {
  const lookup = await lookupUPC(row.upc);
  if (lookup) {
    row.product_name = lookup.name;
    row.manufacturer = lookup.manufacturer ?? "(unspecified)";
  }
}
```

### Image Handling

Treat R2 image URLs as read-only external images. Display directly in product forms/lists without storing in recipehub's Image table.

## Error Handling

**Worker-side:**
- Invalid UPC format → 400 Bad Request
- External API timeout (5s) → fail to next source
- Image fetch fails → return product without image
- Rate limited → return 404, don't cache failure
- D1/R2 down → 503 Service Unavailable

**Recipehub-side:**
- UPC lookup failure → user manually enters product details
- Lookup is enhancement, not hard dependency

## Admin UI

Small Vite-powered UI for:
- Browsing cached products
- Viewing cache stats
- Searching the database
- Debugging lookups

## Environment Variables

### Worker
- `DB` - D1 binding
- `IMAGES` - R2 binding
- `R2_PUBLIC_URL` - Public URL for R2 bucket
- `API_KEY` - Secret for authenticating requests

### Recipehub
- `UPC_WORKER_URL` - Worker endpoint
- `UPC_API_KEY` - API key for worker auth

## Future Considerations (not in v1)

- Durable Objects for quota tracking across API sources
- Webhook to notify recipehub of new cached products
- Batch lookup endpoint for CSV import performance
- Cache expiration/refresh for stale data

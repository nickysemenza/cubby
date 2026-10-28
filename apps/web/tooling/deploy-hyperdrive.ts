/** Only the serialized normal GitHub deployment changes Hyperdrive configuration.
 * API: https://developers.cloudflare.com/api/resources/hyperdrive/subresources/configs/
 */
import { appendFileSync } from "node:fs";
import { z } from "zod";

import { HYPERDRIVE_CACHE_POLICY } from "../src/server/db/freshness/hyperdrive-cache-policy.ts";

const id = z.string().regex(/^[a-f0-9]{32}$/);
const config = z.object({
  id,
  name: z.string(),
  origin_connection_limit: z.number(),
  caching: z.object({
    disabled: z.boolean(),
    max_age: z.number().optional(),
    stale_while_revalidate: z.number().optional(),
  }),
});
const apiEnvelope = z.object({ success: z.boolean(), result: z.unknown() });
const mode = z.enum(["prepare", "apply"]).parse(process.argv[2]);
if (
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.GITHUB_REF !== "refs/heads/main" ||
  !process.env.GITHUB_ENV
)
  throw new Error(
    "Hyperdrive setup runs only in the normal GitHub main deployment",
  );
const account = id.parse(process.env.CLOUDFLARE_ACCOUNT_ID);
const token = z.string().min(1).parse(process.env.CLOUDFLARE_API_TOKEN);
const base = `https://api.cloudflare.com/client/v4/accounts/${account}/hyperdrive/configs`;

async function api<S extends z.ZodType>(
  schema: S,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<z.output<S>> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  // API bodies can contain origin credentials; never print them on failure.
  if (!response.ok)
    throw new Error(`Hyperdrive ${method} failed (HTTP ${response.status})`);
  const envelope = apiEnvelope.parse(await response.json());
  if (!envelope.success) throw new Error(`Hyperdrive ${method} was refused`);
  return schema.parse(envelope.result);
}

if (mode === "prepare") {
  const configs = await api(z.array(config), "");
  const existing = configs.filter((item) => item.name === "cubby-background");
  if (existing.length > 1)
    throw new Error(
      "Multiple cubby-background configurations require operator reconciliation",
    );
  let background = existing[0];
  if (!background) {
    const connection = new URL(
      z.string().url().parse(process.env.PRODUCTION_DIRECT_DATABASE_URL),
    );
    if (
      !["postgres:", "postgresql:"].includes(connection.protocol) ||
      connection.hostname.includes("-pooler.")
    )
      throw new Error("Hyperdrive requires the direct PostgreSQL origin");
    background = await api(config, "", "POST", {
      name: "cubby-background",
      origin: {
        scheme: "postgres",
        host: connection.hostname,
        port: Number(connection.port || 5432),
        database: decodeURIComponent(connection.pathname.slice(1)),
        user: decodeURIComponent(connection.username),
        password: decodeURIComponent(connection.password),
      },
      caching: { disabled: true },
      origin_connection_limit: 10,
    });
  }
  appendFileSync(
    process.env.GITHUB_ENV,
    `CUBBY_BACKGROUND_HYPERDRIVE_ID=${background.id}\n`,
  );
} else {
  const backgroundId = id.parse(process.env.CUBBY_BACKGROUND_HYPERDRIVE_ID);
  const desired = [
    {
      id: "adc9757dfffd45bc94d5c2a66b2ad410",
      limit: 12,
      caching: { disabled: true },
    },
    {
      id: "427dd7a2876c4dccbe056d37fa7374ff",
      limit: 20,
      caching: {
        disabled: false,
        max_age: HYPERDRIVE_CACHE_POLICY.maxAgeSeconds,
        stale_while_revalidate:
          HYPERDRIVE_CACHE_POLICY.staleWhileRevalidateSeconds,
      },
    },
    { id: backgroundId, limit: 10, caching: { disabled: true } },
  ];
  for (const target of desired) {
    const current = await api(config, `/${target.id}`);
    const expectedCaching = config.shape.caching.parse(target.caching);
    const cachingMatches = (actual: z.output<typeof config.shape.caching>) =>
      actual.disabled === expectedCaching.disabled &&
      (expectedCaching.max_age === undefined ||
        actual.max_age === expectedCaching.max_age) &&
      (expectedCaching.stale_while_revalidate === undefined ||
        actual.stale_while_revalidate ===
          expectedCaching.stale_while_revalidate);
    if (target.id === backgroundId && current.name !== "cubby-background")
      throw new Error(
        "Background Hyperdrive identity changed during deployment",
      );
    if (
      current.origin_connection_limit !== target.limit ||
      !cachingMatches(current.caching)
    ) {
      await api(config, `/${target.id}`, "PATCH", {
        origin_connection_limit: target.limit,
        caching: target.caching,
      });
    }
    const verified = await api(config, `/${target.id}`);
    if (
      verified.origin_connection_limit !== target.limit ||
      !cachingMatches(verified.caching)
    )
      throw new Error("Hyperdrive policy read-back failed");
  }
}

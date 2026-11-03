import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import { createDatabase } from "~/server/db/database-runtime";
import { drizzleSchema as schema } from "~/server/db/drizzle-schema";
import {
  auditShipmentCarriers,
  auditShipmentCarriersInput,
} from "~/server/domains/shipment/repo/carrier-audit";

const { values } = parseArgs({
  options: {
    scope: { type: "string", default: "shipments" },
    after: { type: "string" },
    limit: { type: "string", default: "50" },
    output: { type: "string" },
  },
});
const connectionString = process.env.CARRIER_AUDIT_DATABASE_URL;
if (!connectionString || !values.output)
  throw new Error(
    "Set CARRIER_AUDIT_DATABASE_URL and supply --output for the private audit report.",
  );
// pg gives URL parameters precedence over config.options; never let a URL
// replace the read-only session setting supplied below.
if (new URL(connectionString).searchParams.has("options"))
  throw new Error(
    "Connection URL options are not accepted by the read-only audit command.",
  );

// Enforce read-only before the first statement; this command never applies candidates.
const connection = new Client({
  connectionString,
  options: "-c default_transaction_read_only=on",
});
await connection.connect();
try {
  const client = drizzle(connection, { schema });
  const db = createDatabase(() => ({
    client,
    withConnection: (run) => run(client),
  }));
  const report = await auditShipmentCarriers(
    db,
    auditShipmentCarriersInput.parse({
      scope: values.scope,
      after: values.after,
      limit: Number(values.limit),
    }),
  );
  await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
} finally {
  await connection.end();
}

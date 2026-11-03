import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import type { z } from "zod";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import { createDatabase } from "~/server/db/database-runtime";
import { drizzleSchema as schema } from "~/server/db/drizzle-schema";
import {
  auditShipmentCarriers,
  auditShipmentCarriersInput,
} from "~/server/domains/shipment/repo/carrier-audit";

/** The CLI and its dangerous-rule scenario share the same read-only implementation. */
export async function writeShipmentCarrierAudit(
  input: z.input<typeof auditShipmentCarriersInput> & {
    databaseUrl: string;
    output: string;
  },
) {
  const { databaseUrl, output, ...scope } = input;
  // pg gives URL parameters precedence over config.options; never let a URL
  // replace the read-only session setting supplied below.
  if (new URL(databaseUrl).searchParams.has("options"))
    throw new Error(
      "Connection URL options are not accepted by the read-only audit command.",
    );

  // Enforce read-only before the first statement; this command never applies candidates.
  const connection = new Client({
    connectionString: databaseUrl,
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
      auditShipmentCarriersInput.parse(scope),
    );
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
  } finally {
    await connection.end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { values } = parseArgs({
    options: {
      scope: { type: "string", default: "shipments" },
      after: { type: "string" },
      limit: { type: "string", default: "50" },
      output: { type: "string" },
    },
  });
  const databaseUrl = process.env.CARRIER_AUDIT_DATABASE_URL;
  if (!databaseUrl || !values.output)
    throw new Error(
      "Set CARRIER_AUDIT_DATABASE_URL and supply --output for the private audit report.",
    );
  await writeShipmentCarrierAudit({
    ...auditShipmentCarriersInput.parse({
      scope: values.scope,
      after: values.after,
      limit: Number(values.limit),
    }),
    databaseUrl,
    output: values.output,
  });
}

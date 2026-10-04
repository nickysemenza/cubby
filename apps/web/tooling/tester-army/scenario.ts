import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { z } from "zod";
import { pollUntil } from "@cubby/shared/retry";
import { shortcodeSchema } from "@cubby/schemas/identifiers";
import { IMPORT_AGENT_ORDER } from "../scenarios/import-agent-order";

const browserState = z.object({
  cookies: z.array(
    z.object({
      name: z.string(),
      value: z.string(),
      domain: z.string(),
      path: z.string(),
      expires: z.number(),
      httpOnly: z.boolean(),
      secure: z.boolean(),
      sameSite: z.enum(["Strict", "Lax", "None"]),
    }),
  ),
});

export function readBrowserCookies() {
  const file = z.string().min(1).parse(process.env.TESTER_ARMY_WEB_STATE);
  return browserState.parse(JSON.parse(readFileSync(file, "utf8"))).cookies;
}

export function importScenario() {
  return {
    vendorShortcode: shortcodeSchema("vendor").parse(
      process.env.TESTER_ARMY_VENDOR_ID,
    ),
    vendorId: z.uuid().parse(process.env.TESTER_ARMY_VENDOR_UUID),
    vendorName: IMPORT_AGENT_ORDER.vendor,
    orderId: IMPORT_AGENT_ORDER.orderId,
  };
}

const importOutcome = z.object({
  status: z.string(),
  failureCode: z.string().nullable(),
});
const importedLine = z.object({
  orderId: z.string().nullable(),
  cost: z.coerce.number(),
});

const progressRow = z.object({
  phase: z.string(),
  detail: z.string().nullable(),
});
const operationRow = z.object({
  kind: z.string(),
  state: z.string(),
  error: z.string().nullable(),
});

/** Why the newest run stopped: its last progress and every failed operation. */
async function runDiagnosis(pool: Pool) {
  const progress = z
    .array(progressRow)
    .parse(
      (
        await pool.query(
          'SELECT phase, detail FROM "RunProgress" ORDER BY "createdAt" DESC LIMIT 3',
        )
      ).rows,
    );
  const failed = z
    .array(operationRow)
    .parse(
      (
        await pool.query(
          'SELECT kind, state, error FROM "RunOperation" WHERE state = $1 ORDER BY "startedAt"',
          ["failed"],
        )
      ).rows,
    );
  return JSON.stringify({ progress, failed }, null, 2);
}

/**
 * The live run must finish on its own, and its committed Purchase must carry
 * the confirmation's order and amount. A run that stops for review or fails
 * ends the wait with its own status as the error.
 */
export async function assertImportedPurchase(scenario = importScenario()) {
  const pool = new Pool({
    connectionString: z.string().min(1).parse(process.env.DATABASE_URL),
  });
  try {
    await pollUntil(
      async () => {
        const run = importOutcome.safeParse(
          (
            await pool.query(
              'SELECT status, "failureCode" FROM "Run" ORDER BY "startedAt" DESC LIMIT 1',
            )
          ).rows[0],
        ).data;
        if (!run || run.status === "running" || run.status.startsWith("paused"))
          return undefined;
        if (run.status !== "completed")
          throw new Error(
            `Import run ended ${run.status}${run.failureCode ? ` (${run.failureCode})` : ""}\n${await runDiagnosis(pool)}`,
          );
        return true;
      },
      { label: "live import run completed", timeoutMs: 480_000 },
    );
    const lines = z
      .array(importedLine)
      .parse(
        (
          await pool.query(
            'SELECT p."orderId", e.cost FROM "Purchase" p JOIN "Expense" e ON e."purchaseId" = p.id WHERE p."vendorId" = $1 AND p."deletedAt" IS NULL AND e."deletedAt" IS NULL',
            [scenario.vendorId],
          )
        ).rows,
      );
    const totalCents = Math.round(
      lines.reduce((sum, line) => sum + line.cost, 0) * 100,
    );
    if (
      lines.length === 0 ||
      lines.some((line) => line.orderId !== scenario.orderId) ||
      totalCents !== IMPORT_AGENT_ORDER.totalCents
    )
      throw new Error(
        `Imported purchase does not match the confirmation: ${JSON.stringify(lines)}`,
      );
  } finally {
    await pool.end();
  }
}

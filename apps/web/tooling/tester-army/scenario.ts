import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { z } from "zod";
import { pollUntil } from "@cubby/shared/retry";
import { shortcodeSchema } from "@cubby/schemas/identifiers";
import {
  SIM_PRODUCT_NAME,
  SIM_PRODUCT_UPDATED_NAME,
} from "../scenarios/simulator";

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

export function productScenario() {
  return {
    productId: shortcodeSchema("product").parse(
      process.env.TESTER_ARMY_PRODUCT_ID,
    ),
    name: SIM_PRODUCT_NAME,
    updatedName: SIM_PRODUCT_UPDATED_NAME,
  };
}

export function expectedProductName() {
  return process.env.TESTER_ARMY_EXPECTED_NAME ?? SIM_PRODUCT_UPDATED_NAME;
}

export async function assertPersistedProductName(
  productId = productScenario().productId,
) {
  const pool = new Pool({
    connectionString: z.string().min(1).parse(process.env.DATABASE_URL),
  });
  try {
    await pollUntil(
      async () => {
        const result = await pool.query<{ name: string }>(
          'SELECT name FROM "Product" WHERE shortcode = $1 AND "deletedAt" IS NULL',
          [productId],
        );
        return result.rows[0]?.name === expectedProductName()
          ? true
          : undefined;
      },
      { label: "synthetic product name persisted", timeoutMs: 15_000 },
    );
  } finally {
    await pool.end();
  }
}

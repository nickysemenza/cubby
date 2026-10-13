import type { Page } from "@playwright/test";
import superjson from "superjson";
import { z } from "zod";

import { BROWSER_OPERATION_PATH } from "~/lib/browser-operation-path";
import { superJsonResultSchema } from "~/lib/superjson-wire";

/** Runs browser-only operations through the same Start dispatch as the app. */
export async function startOperation(
  page: Page,
  operation: string,
  input: unknown,
) {
  if (page.url() === "about:blank") {
    const session = await page.request.get("/api/auth/get-session");
    await page.goto(new URL("/", session.url()).href);
  }
  const response = await page.evaluate(
    async ({ path, payload }) => {
      const result = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return { status: result.status, text: await result.text() };
    },
    {
      path: BROWSER_OPERATION_PATH,
      payload: superjson.serialize({ operation, input }),
    },
  );
  const envelope = z
    .object({
      ok: z.boolean(),
      data: z.unknown().optional(),
      error: z.unknown().optional(),
    })
    .parse(
      superjson.deserialize(
        superJsonResultSchema.parse(JSON.parse(response.text)),
      ),
    );
  const body = envelope.ok ? envelope.data : envelope.error;
  return {
    body,
    status: () => response.status,
    ok: () => response.status >= 200 && response.status < 300 && envelope.ok,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

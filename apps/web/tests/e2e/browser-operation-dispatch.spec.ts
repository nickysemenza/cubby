import { entityApi } from "./support/entity-api";
import superjson from "superjson";
import { z } from "zod";

import { auditLogListOut } from "@cubby/schemas/audit";
import { BROWSER_OPERATION_PATH } from "~/lib/browser-operation-path";
import { expect, test } from "./support/e2e-test";

test("browser dispatch preserves operation dates and rejects foreign origins", async ({
  page,
  baseURL,
}) => {
  const created = await entityApi(page.request).create(
    "vendor",
    { name: `Dispatch fixture ${Date.now()}` },
    { headers: { Origin: baseURL! } },
  );
  expect(created.status(), await created.text()).toBe(200);
  const id = z
    .object({ item: z.object({ id: z.string() }) })
    .parse(await created.json()).item.id;
  try {
    const payload = superjson.serialize({
      operation: "auditLog.list",
      input: { limit: 5 },
    });
    const foreign = await page.request.post(BROWSER_OPERATION_PATH, {
      data: payload,
      headers: { Origin: "https://example.invalid" },
    });
    expect(foreign.status()).toBe(403);

    const http = await page.request.get("/api/v1/auditLog/list?limit=5", {
      headers: { Origin: baseURL! },
    });
    expect(http.status(), await http.text()).toBe(200);

    const response = await page.request.post(BROWSER_OPERATION_PATH, {
      data: payload,
      headers: { Origin: baseURL! },
    });
    expect(response.status(), await response.text()).toBe(200);
    const result = z
      .object({ ok: z.literal(true), data: auditLogListOut })
      .parse(superjson.deserialize(await response.json())).data;
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries[0]?.createdAt).toBeInstanceOf(Date);
  } finally {
    await entityApi(page.request).remove("vendor", id, {
      headers: { Origin: baseURL! },
    });
  }
});

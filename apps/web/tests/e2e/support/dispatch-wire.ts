import type { Page, Request, Response, Route } from "@playwright/test";
import { z } from "zod";

import { isBrowserOperationPath } from "~/lib/browser-operation-path";

/**
 * Reads the browser dispatch wire in either shape. Concurrent queries share
 * one `{ batch: [...] }` request answered as NDJSON lines (`{ i, r }`); a
 * mutation, or a query alone in its tick, is a single `{ operation, input }`
 * request answered as one JSON envelope. Specs observe operations through
 * here so they keep working whichever shape the page happened to use.
 */
const itemSchema = z.object({ operation: z.string(), input: z.unknown() });
const bodySchema = z.union([
  z.object({ batch: z.array(itemSchema) }),
  itemSchema,
]);

export type DispatchedOperation = z.infer<typeof itemSchema>;

export function dispatchOperations(request: Request): DispatchedOperation[] {
  if (
    request.method() !== "POST" ||
    !isBrowserOperationPath(new URL(request.url()).pathname)
  )
    return [];
  const parsed = bodySchema.safeParse(request.postDataJSON());
  if (!parsed.success) return [];
  return "batch" in parsed.data ? parsed.data.batch : [parsed.data];
}

export function dispatchesOperation(
  request: Request,
  operation: string,
  matches: (item: DispatchedOperation) => boolean = () => true,
): boolean {
  return dispatchOperations(request).some(
    (item) => item.operation === operation && matches(item),
  );
}

/** Wait for the committed operation, including its decoded success envelope. */
export async function performOperation(
  page: Page,
  operation: string,
  action: () => Promise<void>,
): Promise<void> {
  const [response] = await Promise.all([
    page.waitForResponse((response) =>
      dispatchesOperation(response.request(), operation),
    ),
    action(),
  ]);
  await operationResult(response, operation, z.unknown());
}

const lineSchema = z.object({
  i: z.number(),
  r: z.object({ ok: z.literal(true), value: z.unknown() }),
});

/** `operation`'s successful result in this response, parsed by `schema`. */
export async function operationResult<Schema extends z.ZodType>(
  response: Response,
  operation: string,
  schema: Schema,
): Promise<z.output<Schema>> {
  const envelope = z.object({ ok: z.literal(true), data: z.unknown() });
  const operations = dispatchOperations(response.request());
  const index = operations.findIndex((item) => item.operation === operation);
  if (index === -1) throw new Error(`${operation} was not dispatched here`);
  if (!(response.headers()["content-type"] ?? "").includes("x-ndjson"))
    return schema.parse(envelope.parse(await response.json()).data);
  for (const line of (await response.text()).split("\n")) {
    if (!line) continue;
    const { i, r } = lineSchema.parse(JSON.parse(line));
    if (i === index) return schema.parse(envelope.parse(r.value).data);
  }
  throw new Error(`${operation} had no result line`);
}

/**
 * Lets a spec mock or hold specific operations with per-request handlers: a
 * batch carrying any of them is refused, and the client resends each of its
 * queries alone (the transport's fallback path), so the spec's handler sees
 * the target operation as its own request. Returns whether it refused.
 */
export async function unbatchFor(
  route: Route,
  operations: readonly string[],
): Promise<boolean> {
  const carried = dispatchOperations(route.request());
  if (
    carried.length < 2 ||
    !carried.some((item) => operations.includes(item.operation))
  )
    return false;
  await route.fulfill({ status: 503, body: "unbatch for spec" });
  return true;
}

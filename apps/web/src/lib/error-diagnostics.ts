import { z } from "zod";

const errorCauseSchema = z.object({
  name: z.string(),
  message: z.string(),
  code: z.string().optional(),
  status: z.number().optional(),
});

export const errorDiagnosticsSchema = z.object({
  origin: z.literal("server"),
  operation: z.string(),
  entity: z.string().optional(),
  module: z.string().optional(),
  stage: z.enum(["context", "input", "run", "output", "dispatch"]),
  causes: z.array(errorCauseSchema),
  truncated: z.boolean().optional(),
  batchIndex: z.number().int().nonnegative().optional(),
  sentryEventId: z.string().optional(),
  sentryUrl: z
    .string()
    .regex(/^https:\/\/nicky-semenza\.sentry\.io\/issues\/\?query=/u)
    .optional(),
  cfRayId: z.string().optional(),
  cloudflareUrl: z
    .literal(
      "https://dash.cloudflare.com/?to=/:account/workers-and-pages/observability",
    )
    .optional(),
});

export type ErrorDiagnostics = z.infer<typeof errorDiagnosticsSchema>;

export const sentryEventUrl = (eventId: string): string =>
  `https://nicky-semenza.sentry.io/issues/?query=${encodeURIComponent(eventId)}`;

export const CLOUDFLARE_OBSERVABILITY_URL =
  "https://dash.cloudflare.com/?to=/:account/workers-and-pages/observability";

/** Only messages cross the boundary: SQL wrappers contain their parameters too. */
export function scrubErrorMessage(message: string): string {
  if (message.startsWith("Failed query:")) return "Database query failed";
  return message
    .replace(
      /\b(authorization|cookie|set-cookie)\s*:\s*[^\r\n]+/giu,
      "$1: [REDACTED]",
    )
    .replace(/\b([a-z][a-z\d+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/giu, "$1[REDACTED]@")
    .replace(/\b(Bearer|Basic)\s+[\w.+/=-]+/giu, "$1 [REDACTED]")
    .replace(
      /([?&](?:key|api_?key|token|access_token|refresh_token|password|secret|signature|x-amz-signature)=)[^\s&#]*/giu,
      "$1[REDACTED]",
    )
    .replace(
      /\b((?:password|passwd|secret|api_?key|token|access_token|refresh_token|authorization|cookie|set-cookie)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/giu,
      "$1[REDACTED]",
    )
    .slice(0, 2000);
}

const errorNodeSchema = z.object({
  name: z.string().optional().catch(undefined),
  message: z.string().optional().catch(undefined),
  code: z.union([z.string(), z.number()]).optional().catch(undefined),
  status: z.number().optional().catch(undefined),
  statusCode: z.number().optional().catch(undefined),
  cause: z.unknown().optional(),
  originalError: z.unknown().optional(),
  errors: z.array(z.unknown()).optional().catch(undefined),
});

const thrownPrimitiveSchema = z.union([z.string(), z.number(), z.boolean()]);

function errorCause(
  node: z.infer<typeof errorNodeSchema>,
): z.infer<typeof errorCauseSchema> {
  const result: z.infer<typeof errorCauseSchema> = {
    name: scrubErrorMessage(node.name ?? "Error"),
    message: scrubErrorMessage(node.message ?? "Operation failed"),
  };
  if (node.code !== undefined)
    result.code = scrubErrorMessage(String(node.code));
  const status = node.status ?? node.statusCode;
  if (status !== undefined) result.status = status;
  return result;
}

function readErrorNode<TError>(error: TError) {
  try {
    return errorNodeSchema.safeParse(error);
  } catch {
    return errorNodeSchema.safeParse({
      name: "Error",
      message: "Could not inspect thrown error",
    });
  }
}

export function describeErrorCauses<TError>(
  error: TError,
): Pick<ErrorDiagnostics, "causes" | "truncated"> {
  const result: Pick<ErrorDiagnostics, "causes" | "truncated"> = { causes: [] };
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  while (pending.length && result.causes.length < 8 && seen.size < 24) {
    const current = pending.shift();
    if (seen.has(current)) {
      result.truncated = true;
      continue;
    }
    seen.add(current);
    const parsed = readErrorNode(current);
    if (!parsed.success) {
      const primitive = thrownPrimitiveSchema.safeParse(current);
      result.causes.push({
        name: "Error",
        message: scrubErrorMessage(
          primitive.success
            ? String(primitive.data)
            : "An unknown value was thrown",
        ),
      });
      continue;
    }
    const node = parsed.data;
    if (node.message || node.code) result.causes.push(errorCause(node));
    if ((node.message?.length ?? 0) > 2000) result.truncated = true;
    if (node.cause !== undefined) pending.push(node.cause);
    if (node.originalError !== undefined) pending.push(node.originalError);
    if (node.errors) {
      pending.push(...node.errors.slice(0, 8));
      if (node.errors.length > 8) result.truncated = true;
    }
  }
  if (pending.length) result.truncated = true;
  return result;
}

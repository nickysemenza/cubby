import { z } from "zod";

import type { ErrorDiagnostics } from "./error-diagnostics";

/**
 * Shared failure path for the hand-rolled `fetch` wrappers under `~/lib` and
 * `~/app/**` that talk to a plain REST route instead of a Start operation
 * (Start operations already carry `data.diagnostics` end to end). Throwing
 * this instead of a bare `Error` lets `getAppErrorDetails` (`~/lib/error-utils`)
 * recognize the failure and lets `showErrorToast` attach a Details action, the
 * same as a transport-owned mutation failure gets.
 */

const jsonErrorBodySchema = z.object({ error: z.string() });

/** Bounds how much raw response text lands in a toast's Details panel. */
const MAX_BODY_LENGTH = 2000;

export interface HttpResponseErrorData {
  code: string;
  requestId?: string;
  diagnostics: ErrorDiagnostics;
}

/** Thrown by `throwHttpError`/`readJsonOrThrow` so `getAppErrorDetails` parses
 * it exactly like a Start operation's transport failure: `.message` plus a
 * `.data` shape matching `transportErrorSchema` in `~/lib/error-utils`. */
export class HttpResponseError extends Error {
  readonly data: HttpResponseErrorData;

  constructor(message: string, data: HttpResponseErrorData) {
    super(message);
    this.name = "HttpResponseError";
    this.data = data;
  }
}

function truncateBody(bodyText: string): string {
  const trimmed = bodyText.trim();
  return trimmed.length > MAX_BODY_LENGTH
    ? `${trimmed.slice(0, MAX_BODY_LENGTH)}…`
    : trimmed;
}

/** `{ "error": "..." }` is the shape every existing wrapper's route responds
 * with on failure; anything else (an HTML error page, an empty body, a JSON
 * body without that field) falls back to `fallbackMessage`. */
function parseServerErrorMessage(bodyText: string): string | null {
  try {
    const parsed = jsonErrorBodySchema.safeParse(JSON.parse(bodyText));
    return parsed.success ? parsed.data.error : null;
  } catch {
    // bodyText is arbitrary response text (HTML, empty, truncated JSON);
    // JSON.parse throwing just means "not the { error } shape".
    return null;
  }
}

/**
 * Reads `response`'s body exactly once and throws an `HttpResponseError`
 * carrying it — the message (server-provided `error` string, or
 * `fallbackMessage` with the status code), the `x-request-id` header when
 * present, and a `causes[0].message` with the full (truncated) raw body so
 * "Technical details" still shows it even when the message above is generic.
 *
 * `method` is not recoverable from a `Response`, so callers that want it in
 * `diagnostics.operation` pass it explicitly.
 */
export async function throwHttpError(
  response: Response,
  fallbackMessage: string,
  options?: { method?: string },
): Promise<never> {
  const bodyText = await response.text();
  const serverMessage = parseServerErrorMessage(bodyText);
  const pathname = new URL(response.url, "http://localhost").pathname;
  const requestId = response.headers.get("x-request-id");

  const data: HttpResponseErrorData = {
    code: `HTTP_${response.status}`,
    diagnostics: {
      origin: "server",
      operation: options?.method ? `${options.method} ${pathname}` : pathname,
      stage: "dispatch",
      causes: [
        {
          name: "HttpError",
          status: response.status,
          message: truncateBody(bodyText),
        },
      ],
    },
  };
  if (requestId !== null) data.requestId = requestId;

  throw new HttpResponseError(
    serverMessage ?? `${fallbackMessage} (${response.status})`,
    data,
  );
}

/** `throwHttpError` on a non-ok response, else `schema.parse` the JSON body. */
export async function readJsonOrThrow<T>(
  response: Response,
  schema: z.ZodType<T>,
  fallbackMessage: string,
  options?: { method?: string },
): Promise<T> {
  if (!response.ok)
    return await throwHttpError(response, fallbackMessage, options);
  return schema.parse(await response.json());
}

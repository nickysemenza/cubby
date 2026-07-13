const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 5;
export const MAX_EXTERNAL_HTML_BYTES = 5 * 1024 * 1024;
export const MAX_EXTERNAL_IMAGE_BYTES = 50 * 1024 * 1024;

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
]);

export class ExternalFetchError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid-url"
      | "blocked-url"
      | "redirect-limit"
      | "missing-location"
      | "unexpected-content-type"
      | "body-too-large",
  ) {
    super(message);
    this.name = "ExternalFetchError";
  }
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map(Number);
  if (
    octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  ) {
    return false;
  }
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIpv6(host: string): boolean {
  const normalized = host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (!normalized.includes(":")) return false;
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fe80") || /^f[cd]/.test(normalized)) return true;
  const ipv4Tail = normalized.split(":").pop();
  return Boolean(ipv4Tail?.includes(".") && isPrivateIpv4(ipv4Tail));
}

/** Validate a user/upstream-controlled URL before a server-side fetch. */
export function validateExternalHttpUrl(value: string | URL): URL {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value) : new URL(value);
  } catch {
    throw new ExternalFetchError(
      "External URL must be a valid URL",
      "invalid-url",
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ExternalFetchError(
      "External fetches only support HTTP(S) URLs",
      "blocked-url",
    );
  }
  if (url.username || url.password) {
    throw new ExternalFetchError(
      "External URLs cannot include credentials",
      "blocked-url",
    );
  }

  const host = url.hostname.toLowerCase();
  if (
    BLOCKED_HOSTNAMES.has(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    isPrivateIpv4(host) ||
    isPrivateIpv6(host)
  ) {
    throw new ExternalFetchError(
      "External URL points to a private or local host",
      "blocked-url",
    );
  }
  return url;
}

/** Safe log representation: never includes credentials, query, or fragment. */
export function sanitizeExternalUrl(value: string | URL): string {
  try {
    const url = value instanceof URL ? new URL(value) : new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "[invalid-url]";
  }
}

export type ExternalFetchOptions = Omit<RequestInit, "fetcher"> & {
  fetcher?: typeof fetch;
  timeoutMs?: number;
  maxRedirects?: number;
};

/** Fetch with a bounded redirect chain, validating every redirect target. */
export async function fetchExternalResponse(
  value: string | URL,
  options: ExternalFetchOptions = {},
): Promise<Response> {
  const {
    fetcher = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    ...init
  } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let current = validateExternalHttpUrl(value);

  try {
    for (let redirects = 0; ; redirects += 1) {
      const response = await fetcher(current, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status < 300 || response.status >= 400) return response;

      await response.body?.cancel();
      if (redirects >= maxRedirects) {
        throw new ExternalFetchError(
          `External fetch exceeded ${maxRedirects} redirects`,
          "redirect-limit",
        );
      }
      const location = response.headers.get("location");
      if (!location) {
        throw new ExternalFetchError(
          "External redirect omitted its Location header",
          "missing-location",
        );
      }
      current = validateExternalHttpUrl(new URL(location, current));
    }
  } finally {
    clearTimeout(timeout);
  }
}

export function assertResponseContentType(
  response: Response,
  allowedPrefixes: readonly string[],
): string {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!allowedPrefixes.some((prefix) => contentType.startsWith(prefix))) {
    throw new ExternalFetchError(
      `Unexpected response content type: ${contentType || "missing"}`,
      "unexpected-content-type",
    );
  }
  return contentType.split(";", 1)[0] ?? contentType;
}

function assertAdvertisedSize(response: Response, maxBytes: number): void {
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    throw new ExternalFetchError(
      `External response exceeds ${maxBytes} bytes`,
      "body-too-large",
    );
  }
}

export async function readResponseWithLimit(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  assertAdvertisedSize(response, maxBytes);
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ExternalFetchError(
          `External response exceeds ${maxBytes} bytes`,
          "body-too-large",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** Preserve streaming while failing the consumer once the byte budget is crossed. */
export function responseBodyWithLimit(
  response: Response,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  assertAdvertisedSize(response, maxBytes);
  if (!response.body) return new ReadableStream({ start: (c) => c.close() });
  let total = 0;
  return response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > maxBytes) {
          controller.error(
            new ExternalFetchError(
              `External response exceeds ${maxBytes} bytes`,
              "body-too-large",
            ),
          );
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

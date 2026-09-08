import ipaddr from "ipaddr.js";

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

const BLOCKED_IPV4_RANGES = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
].map((range) => ipaddr.IPv4.parseCIDR(range));

const BLOCKED_IPV6_RANGES = ["::/128", "::1/128", "fe80::/10", "fc00::/7"].map(
  (range) => ipaddr.IPv6.parseCIDR(range),
);

function isPrivateIp(host: string): boolean {
  const normalized = host.replace(/^\[/, "").replace(/\]$/, "");
  if (!ipaddr.isValid(normalized)) return false;
  const address = ipaddr.process(normalized);
  return address.kind() === "ipv4"
    ? BLOCKED_IPV4_RANGES.some((range) => address.match(range))
    : BLOCKED_IPV6_RANGES.some((range) => address.match(range));
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
    isPrivateIp(host)
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

function responseWithDeadline(
  response: Response,
  signal: AbortSignal,
  cleanup: () => void,
): Response {
  if (!response.body) {
    cleanup();
    return response;
  }

  const reader = response.body.getReader();
  let closed = false;
  let reading = false;
  let released = false;
  let streamController: ReadableStreamDefaultController<Uint8Array>;

  const release = () => {
    if (released || reading) return;
    released = true;
    reader.releaseLock();
  };
  const finish = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", abortBody);
    cleanup();
  };
  const abortBody = () => {
    if (closed) return;
    const reason = signal.reason;
    finish();
    void reader
      .cancel(reason)
      .finally(release)
      .catch(() => undefined);
    streamController.error(reason);
  };
  signal.addEventListener("abort", abortBody, { once: true });

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      if (signal.aborted) abortBody();
    },
    async pull(controller) {
      reading = true;
      try {
        const { done, value } = await reader.read();
        if (closed) return;
        if (done) {
          finish();
          controller.close();
        } else if (value) {
          controller.enqueue(value);
        }
      } catch (error) {
        if (closed) return;
        finish();
        controller.error(error);
      } finally {
        reading = false;
        if (closed) release();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        finish();
        release();
      }
    },
  });

  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

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
  let current = validateExternalHttpUrl(value);
  const controller = new AbortController();
  const callerSignal = init.signal;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  if (callerSignal?.aborted) abortFromCaller();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const cleanup = () => {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  };
  let responseOwnsDeadline = false;

  try {
    for (let redirects = 0; ; redirects += 1) {
      if (controller.signal.aborted) throw controller.signal.reason;
      const response = await fetcher(current, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        void response.body
          ?.cancel(controller.signal.reason)
          .catch(() => undefined);
        throw controller.signal.reason;
      }
      if (response.status < 300 || response.status >= 400) {
        const boundedResponse = responseWithDeadline(
          response,
          controller.signal,
          cleanup,
        );
        responseOwnsDeadline = true;
        return boundedResponse;
      }

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
    if (!responseOwnsDeadline) cleanup();
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

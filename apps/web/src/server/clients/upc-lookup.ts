import {
  bulkLookupResponseSchema,
  productLookupResponseSchema,
  type SearchResponse,
  searchResponseSchema,
  type UPCLookupResponse,
} from "@cubby/upc-contract";
import { chunk } from "es-toolkit";

import { env } from "~/env";
import { getBindingFetcher } from "~/server/cf-env";
import { injectTraceContext, TraceNames, withTrace } from "~/server/tracing";

const DEFAULT_TIMEOUT_MS = 5000;

// Matches bulkLookupRequestSchema.upcs.max(200) on the worker.
const BULK_MAX_UPCS = 200;

interface UpcRequestHeaders extends Record<string, string> {
  "user-agent": string;
}

export class UPCLookupClient {
  private timeoutMs: number;
  private fetcher: typeof fetch;

  constructor(
    private baseUrl: string,
    private apiKey?: string,
    options?: { timeoutMs?: number; fetcher?: typeof fetch },
  ) {
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Service binding fetch in prod, global fetch (public URL) in dev
    this.fetcher = options?.fetcher ?? fetch;
  }

  private getHeaders(): UpcRequestHeaders {
    const headers: UpcRequestHeaders = {
      "user-agent": "cubby",
    };

    // Inject trace context for distributed tracing (dev only — the CF platform
    // propagates across service bindings in prod).
    injectTraceContext(headers);

    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }

    return headers;
  }

  private async traced<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    return withTrace(TraceNames.api("upc-lookup", operation), fn);
  }

  // Best-effort read of the worker's error body on a non-2xx, so an intermittent
  // 401 logs the full envelope (e.g. `{"error":"...","code":"MISSING_API_KEY"}`,
  // distinguishing no-key-sent from stale/wrong-key) instead of a bare status.
  // Length-capped so a stray HTML/platform error page can't flood the log. Never
  // throws.
  private async errorBody(res: Response): Promise<string> {
    try {
      const body = (await res.clone().text()).trim();
      if (!body) return "";
      const capped = body.length > 300 ? `${body.slice(0, 300)}…` : body;
      return ` — ${capped}`;
    } catch {
      return "";
    }
  }

  async lookup(upc: string): Promise<UPCLookupResponse | null> {
    return this.traced("lookup", async () => {
      const url = new URL(`/lookup/${upc}`, this.baseUrl);

      try {
        const res = await this.fetcher(url.toString(), {
          method: "GET",
          headers: this.getHeaders(),
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (!res.ok) {
          // A 404 just means the UPC isn't in the lookup DB — an expected miss,
          // not a failure. Only warn on genuinely unexpected statuses.
          if (res.status !== 404) {
            console.warn(
              `[UPC Lookup] Failed for ${upc}: ${res.status} ${res.statusText}${await this.errorBody(res)}`,
            );
          }
          return null;
        }

        const data = await res.json();
        const parsed = productLookupResponseSchema.safeParse(data);

        if (!parsed.success) {
          console.warn("[UPC Lookup] Response parse error:", parsed.error);
          return null;
        }

        return parsed.data;
      } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
          console.warn(
            `[UPC Lookup] Timeout for ${upc} after ${this.timeoutMs}ms`,
          );
        } else {
          console.warn(`[UPC Lookup] Error for ${upc}:`, error);
        }
        return null;
      }
    });
  }

  /**
   * Look up many UPCs in one or more bulk requests. Returns a Map of UPC →
   * cached product for the hits; UPCs with no cached data are simply absent
   * (no per-UPC 404, so no log spam). The worker also kicks off a bounded
   * background first-try for never-checked UPCs, surfacing on a later call.
   */
  async lookupBatch(upcs: string[]): Promise<Map<string, UPCLookupResponse>> {
    const result = new Map<string, UPCLookupResponse>();
    if (upcs.length === 0) return result;

    return this.traced("lookupBatch", async () => {
      let failure: Error | null = null;
      const failedUpcs: string[] = [];
      for (const batch of chunk(upcs, BULK_MAX_UPCS)) {
        try {
          const res = await this.fetcher(
            new URL("/lookup/batch", this.baseUrl).toString(),
            {
              method: "POST",
              headers: {
                ...this.getHeaders(),
                "content-type": "application/json",
              },
              body: JSON.stringify({ upcs: batch }),
              signal: AbortSignal.timeout(this.timeoutMs),
            },
          );

          if (!res.ok) {
            console.warn(
              `[UPC Lookup] Batch failed: ${res.status} ${res.statusText}${await this.errorBody(res)}`,
            );
            failure ??= new Error(`UPC batch lookup failed (${res.status})`);
            failedUpcs.push(...batch);
            continue;
          }

          const parsed = bulkLookupResponseSchema.safeParse(await res.json());
          if (!parsed.success) {
            console.warn(
              "[UPC Lookup] Batch response parse error:",
              parsed.error,
            );
            failure ??= new Error(
              "UPC batch lookup returned an invalid response",
            );
            failedUpcs.push(...batch);
            continue;
          }

          // Every bulk result is a cache hit by definition.
          for (const p of parsed.data.products) {
            result.set(p.upc, { ...p, cached: true });
          }
        } catch (error) {
          if (error instanceof Error && error.name === "TimeoutError") {
            console.warn(
              `[UPC Lookup] Batch timeout after ${this.timeoutMs}ms`,
            );
          } else {
            console.warn("[UPC Lookup] Batch error:", error);
          }
          failure ??=
            error instanceof Error
              ? error
              : new Error("UPC batch lookup failed");
          failedUpcs.push(...batch);
        }
      }
      // Callers that need a truthful health state (the cached Problems
      // projection) must be able to distinguish an empty, successful provider
      // result from a transport/provider failure. The old best-effort return
      // silently collapsed those two states into the same empty Map.
      if (failure) {
        throw new PartialUpcBatchLookupError(failure, result, failedUpcs);
      }
      return result;
    });
  }

  async search(query: string, limit = 20): Promise<SearchResponse> {
    return this.traced("search", async () => {
      const url = new URL("/search", this.baseUrl);
      url.searchParams.set("q", query);
      url.searchParams.set("limit", String(limit));

      try {
        const res = await this.fetcher(url.toString(), {
          method: "GET",
          headers: this.getHeaders(),
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (!res.ok) {
          return { products: [], total: 0 };
        }

        // The /search response omits `cached` (it's not a cache read), so
        // validate against searchResponseSchema rather than casting — a cast
        // here silently produced the wrong shape (claimed `cached` present).
        const parsed = searchResponseSchema.safeParse(await res.json());
        if (!parsed.success) {
          console.warn(
            "[UPC Lookup] Search response parse error:",
            parsed.error,
          );
          return { products: [], total: 0 };
        }
        return parsed.data;
      } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
          console.warn(`[UPC Lookup] Search timeout after ${this.timeoutMs}ms`);
        }
        return { products: [], total: 0 };
      }
    });
  }
}

export type UpcLookupPort = Pick<UPCLookupClient, "lookup" | "lookupBatch">;

/** Production service-binding adapter with the public HTTP fallback for Node. */
export const createUpcLookupClient = (): UPCLookupClient =>
  new UPCLookupClient(env.UPC_LOOKUP_API_URL, env.UPC_LOOKUP_API_KEY, {
    fetcher: getBindingFetcher("UPC_LOOKUP"),
  });

/** A multi-chunk lookup failed partially; completed chunks remain usable. */
export class PartialUpcBatchLookupError extends Error {
  constructor(
    cause: Error,
    readonly results: ReadonlyMap<string, UPCLookupResponse>,
    readonly failedUpcs: readonly string[],
  ) {
    super(cause.message, { cause });
    this.name = "PartialUpcBatchLookupError";
  }
}

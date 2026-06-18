import {
  bulkLookupResponseSchema,
  type UPCLookupResponse,
  upcLookupResponseSchema,
} from "@cubby/upc-lookup/schemas";
import { chunk } from "es-toolkit";
import { injectTraceContext, TraceNames, withTrace } from "~/server/tracing";

const DEFAULT_TIMEOUT_MS = 5000;

// Matches bulkLookupRequestSchema.upcs.max(200) on the worker.
const BULK_MAX_UPCS = 200;

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

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
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
              `[UPC Lookup] Failed for ${upc}: ${res.status} ${res.statusText}`,
            );
          }
          return null;
        }

        const data = await res.json();
        const parsed = upcLookupResponseSchema.safeParse(data);

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
              `[UPC Lookup] Batch failed: ${res.status} ${res.statusText}`,
            );
            continue;
          }

          const parsed = bulkLookupResponseSchema.safeParse(await res.json());
          if (!parsed.success) {
            console.warn(
              "[UPC Lookup] Batch response parse error:",
              parsed.error,
            );
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
        }
      }
      return result;
    });
  }

  async search(
    query: string,
    limit = 20,
  ): Promise<{ products: UPCLookupResponse[]; total: number }> {
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

        const data = await res.json();
        return data as { products: UPCLookupResponse[]; total: number };
      } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
          console.warn(`[UPC Lookup] Search timeout after ${this.timeoutMs}ms`);
        }
        return { products: [], total: 0 };
      }
    });
  }
}

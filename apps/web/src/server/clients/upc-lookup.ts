import {
  type UPCLookupResponse,
  upcLookupResponseSchema,
} from "@cubby/upc-lookup/schemas";
import { context, propagation } from "@opentelemetry/api";
import { getErrorMessage } from "~/lib/error-utils";
import { getTracer, TraceNames } from "~/server/tracing";

const DEFAULT_TIMEOUT_MS = 5000;

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

    // Inject OpenTelemetry trace context for distributed tracing
    propagation.inject(context.active(), headers);

    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }

    return headers;
  }

  private async traced<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    const tracer = getTracer();
    return tracer.startActiveSpan(
      TraceNames.api("upc-lookup", operation),
      async (span) => {
        try {
          const res = await fn();
          span.setStatus({ code: 1 });
          return res;
        } catch (e) {
          span.setStatus({ code: 2, message: getErrorMessage(e) });
          throw e;
        } finally {
          span.end();
        }
      },
    );
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
          console.warn(
            `[UPC Lookup] Failed for ${upc}: ${res.status} ${res.statusText}`,
          );
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

import { getTracer, TraceNames } from "~/server/tracing";
import { context, propagation } from "@opentelemetry/api";
import {
  upcLookupResponseSchema,
  type UPCLookupResponse,
} from "@recipehub/upc-lookup/schemas";

const DEFAULT_TIMEOUT_MS = 5000;

export class UPCLookupClient {
  constructor(
    private baseUrl: string,
    private apiKey?: string,
    private timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "user-agent": "recipehub",
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
          const err = e instanceof Error ? e : new Error(String(e));
          span.setStatus({ code: 2, message: err.message });
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
        const res = await fetch(url.toString(), {
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
        const res = await fetch(url.toString(), {
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

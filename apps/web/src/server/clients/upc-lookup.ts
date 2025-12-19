import { getTracer, TraceNames } from "~/server/tracing";
import { context, propagation } from "@opentelemetry/api";
import {
  upcLookupResponseSchema,
  type UPCLookupResponse,
} from "@recipehub/upc-lookup/schemas";

export class UPCLookupClient {
  constructor(
    private baseUrl: string,
    private apiKey?: string,
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

      const res = await fetch(url.toString(), {
        method: "GET",
        headers: this.getHeaders(),
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

      const res = await fetch(url.toString(), {
        method: "GET",
        headers: this.getHeaders(),
      });

      if (!res.ok) {
        return { products: [], total: 0 };
      }

      const data = await res.json();
      return data as { products: UPCLookupResponse[]; total: number };
    });
  }
}

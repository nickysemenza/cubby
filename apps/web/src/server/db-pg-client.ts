import pg from "pg";
import { z } from "zod";

import type { RequestDbRole } from "./db-pg-tracing";
import { withTrace } from "./tracing";

const clientOrdinals = new WeakMap<pg.ClientBase, number>();

export const databaseClientOrdinal = (client: pg.ClientBase) =>
  clientOrdinals.get(client);

const connectionErrorSchema = z.object({
  code: z.union([
    z.string().regex(/^[0-9A-Z]{5}$/u),
    z.enum([
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EAI_AGAIN",
      "EPIPE",
    ]),
  ]),
});

/** One constructor per runtime; physical clients never cross Worker invocations. */
export const createDatabaseClientConstructor = (
  role: RequestDbRole,
  nextOrdinal?: () => number,
) => {
  let ordinal = 0;
  return class DatabaseClient extends pg.Client {
    constructor(config?: string | pg.ClientConfig) {
      super(config);
      clientOrdinals.set(this, nextOrdinal?.() ?? ++ordinal);
    }

    override connect(): Promise<pg.Client>;
    override connect(
      callback: (error: Error | null, client?: pg.Client) => void,
    ): void;
    override connect(
      callback?: (error: Error | null, client?: pg.Client) => void,
    ): Promise<pg.Client> | void {
      const connected = withTrace("db.client.connect", async (span) => {
        const startedAt = performance.now();
        span.setAttributes({
          "db.system.name": "postgresql",
          "cubby.db.binding_role": role,
          "db.client.ordinal": databaseClientOrdinal(this),
        });
        try {
          return await super.connect();
        } catch (error) {
          const parsed = connectionErrorSchema.safeParse(error);
          span.setAttribute(
            "db.connect.error_class",
            parsed.success
              ? parsed.data.code
              : error instanceof Error
                ? "connection-error"
                : "non-error-throw",
          );
          throw error;
        } finally {
          span.setAttribute(
            "db.connect.duration_ms",
            Math.round(performance.now() - startedAt),
          );
        }
      });
      if (!callback) return connected;
      void connected.then(
        (client) => callback(null, client),
        (error: Error) => callback(error),
      );
    }
  };
};

import pg from "pg";
import { z } from "zod";

import type { RequestDbRole } from "./db-pg-tracing";
import { type AppSpan, withTrace } from "./tracing";

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

/** Driver events measure observable startup boundaries, not origin-pool internals. */
const observeConnectionSetup = (
  client: pg.Client,
  span: AppSpan,
  startedAt: number,
) => {
  let phase: "socket" | "startup" | "authentication" | "ready" = "socket";
  let phaseStartedAt = startedAt;
  let lastMilestone = "connect-called";
  let ready = false;
  let authRequested = false;
  const cleanup: Array<() => void> = [];
  const milestone = (name: string) => {
    lastMilestone = name;
    span.setAttribute(
      `db.connect.${name}.elapsed_ms`,
      Math.round(performance.now() - startedAt),
    );
  };
  const finishPhase = (complete: boolean) => {
    span.setAttributes({
      [`db.connect.phase.${phase}.duration_ms`]: Math.round(
        performance.now() - phaseStartedAt,
      ),
      [`db.connect.phase.${phase}.complete`]: complete,
    });
  };
  const advance = (next: typeof phase) => {
    finishPhase(true);
    phase = next;
    phaseStartedAt = performance.now();
  };
  const listen = (
    emitter: pg.Connection | pg.Connection["stream"],
    event: string,
    listener: () => void,
  ) => {
    emitter.once(event, listener);
    cleanup.push(() => emitter.removeListener(event, listener));
  };
  listen(client.connection, "connect", () => {
    milestone("socket_ready");
    advance("startup");
  });
  listen(client.connection, "sslconnect", () => {
    // pg emits sslconnect before TLS completion; it only signals stream creation.
    milestone("ssl_stream_created");
    listen(client.connection.stream, "secureConnect", () => {
      milestone("tls_ready");
    });
  });
  for (const [event, mechanism] of [
    ["authenticationCleartextPassword", "cleartext"],
    ["authenticationMD5Password", "md5"],
    ["authenticationSASL", "sasl"],
  ] as const) {
    listen(client.connection, event, () => {
      if (authRequested) return;
      authRequested = true;
      span.setAttribute("db.connect.auth.mechanism", mechanism);
      milestone("auth_requested");
      advance("authentication");
    });
  }
  listen(client.connection, "authenticationSASLContinue", () => {
    milestone("sasl_continue");
  });
  listen(client.connection, "authenticationSASLFinal", () => {
    milestone("sasl_final");
  });
  listen(client.connection, "authenticationOk", () => {
    if (!authRequested)
      span.setAttribute("db.connect.auth.mechanism", "no-challenge");
    milestone("auth_ok");
    advance("ready");
  });
  listen(client.connection, "readyForQuery", () => {
    milestone("ready_for_query");
    finishPhase(true);
    ready = true;
  });
  return () => {
    for (const remove of cleanup) remove();
    if (!ready) finishPhase(false);
    span.setAttribute("db.connect.last_milestone", lastMilestone);
  };
};

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
        const finishSetup = span.isRecording
          ? observeConnectionSetup(this, span, startedAt)
          : () => {};
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
          finishSetup();
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

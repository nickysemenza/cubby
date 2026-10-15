import { Pool, type PoolConfig, type PoolClient } from "pg";
import { z } from "zod";

const clientClosures = new WeakMap<Pool, Map<PoolClient, Promise<void>>>();
const openClients = new Map<PoolClient, Promise<void>>();

// pg exposes BackendKeyData.processID at runtime but omits it from its types.
const postgresBackendKey = z.object({ processID: z.number().int().positive() });
const backendPid = (client: PoolClient): number =>
  postgresBackendKey.parse(client).processID;

/**
 * Reset must not hand a killed idle client to the next test before its error
 * arrives: a successful pg_terminate_backend does not mean node-postgres has
 * received the fatal 57P01, and checking the client out first removes its pool
 * error listener. Server selection, owned-client protection and termination
 * name the same fixed session set; unknown sessions fail before any kill.
 * Every selected target keeps a temporary handler through
 * socket closure, even if a later checkout removes pg-pool's idle handler.
 * Only the deliberate 57P01 and its disconnect are consumed; other errors surface.
 */
export async function terminateOtherPostgresConnections(
  pool: Pool,
): Promise<void> {
  if (!clientClosures.has(pool))
    throw new Error("Reset requires a createPostgresPool pool");
  const control = await pool.connect();
  try {
    const beforeSelection = new Map(openClients);
    const { rows: selected } = await control.query<{
      pid: number;
      started: string;
    }>(`
      SELECT pid, backend_start::text AS started FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND backend_type = 'client backend'`);
    // Match actual connected-driver identity, never guessed URL equivalence.
    const candidates = [
      ...new Map([...beforeSelection, ...openClients]),
    ].filter(
      ([client]) =>
        client !== control &&
        client.host === control.host &&
        client.port === control.port &&
        client.database === control.database,
    );
    const byPid = new Map(
      candidates.map(([client, closed]) => [
        backendPid(client),
        { client, closed },
      ]),
    );
    const unowned = selected.filter(({ pid }) => !byPid.has(pid));
    if (unowned.length)
      throw new Error(
        `Postgres reset found unowned database sessions: ${unowned.map(({ pid }) => pid).join(", ")}. Close and drain separate-process runtimes and borrowed clients before resetting their database.`,
      );
    const targets = selected.map(({ pid }) => byPid.get(pid)!);
    const listeners = targets.map(({ client }) => {
      const expectedTermination = (error: Error) => {
        if ("code" in error && error.code === "57P01") {
          return;
        }
        if (error.message === "Connection terminated unexpectedly") return;
        throw error;
      };
      // A client can move from idle to checked out while the fatal packet is buffered.
      client.on("error", expectedTermination);
      return { client, expectedTermination };
    });
    try {
      const terminated = await control.query<{
        pid: number;
        terminated: boolean;
      }>(
        `
        SELECT activity.pid, pg_terminate_backend(activity.pid) AS terminated
        FROM pg_stat_activity activity
        JOIN unnest($1::integer[], $2::text[]) AS selected(pid, started)
          ON activity.pid = selected.pid AND activity.backend_start::text = selected.started`,
        [
          selected.map(({ pid }) => pid),
          selected.map(({ started }) => started),
        ],
      );
      if (terminated.rows.some((row) => !row.terminated))
        throw new Error(
          "Postgres reset could not terminate every selected owned session",
        );
      await Promise.all(targets.map(({ closed }) => closed));
    } finally {
      for (const { client, expectedTermination } of listeners)
        client.removeListener("error", expectedTermination);
    }
  } finally {
    control.release();
  }
}

/** Pool.end must close sockets before a caller releases a disposable database. */
export function createPostgresPool(config: PoolConfig): Pool {
  const pool = new Pool(config);
  const openSockets = new Set<Promise<void>>();
  const clients = new Map<PoolClient, Promise<void>>();
  clientClosures.set(pool, clients);
  pool.on("connect", (client) => {
    const closed = new Promise<void>((resolve) => client.once("end", resolve));
    openSockets.add(closed);
    clients.set(client, closed);
    openClients.set(client, closed);
    void closed.then(() => {
      openSockets.delete(closed);
      clients.delete(client);
      openClients.delete(client);
    });
  });

  const endPool = pool.end.bind(pool);
  function end(): Promise<void>;
  function end(callback: (error?: Error) => void): void;
  function end(callback?: (error?: Error) => void): Promise<void> | void {
    // Include clients pg-pool already evicted: its count reaches zero before
    // their asynchronous Client.end callbacks run.
    const ended = endPool().then(async () => {
      await Promise.all(openSockets);
    });
    if (callback) {
      void ended.then(() => callback(), callback);
      return;
    }
    return ended;
  }
  pool.end = end;
  return pool;
}

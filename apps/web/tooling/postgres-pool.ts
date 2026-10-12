import { Pool, type PoolConfig, type PoolClient } from "pg";

const clientClosures = new WeakMap<Pool, Map<PoolClient, Promise<void>>>();

/** Reset must not hand a killed idle client to the next test before its error arrives. */
export async function terminateOtherPostgresConnections(
  pool: Pool,
): Promise<void> {
  const clients = clientClosures.get(pool);
  if (!clients) throw new Error("Reset requires a createPostgresPool pool");
  const control = await pool.connect();
  try {
    const closing = [...clients]
      .filter(([client]) => client !== control)
      .map(([, closed]) => closed);
    await control.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()`);
    await Promise.all(closing);
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
    void closed.then(() => {
      openSockets.delete(closed);
      clients.delete(client);
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

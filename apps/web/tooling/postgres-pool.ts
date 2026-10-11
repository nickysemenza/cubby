import { Pool, type PoolConfig } from "pg";

/** Pool.end must close sockets before a caller releases a disposable database. */
export function createPostgresPool(config: PoolConfig): Pool {
  const pool = new Pool(config);
  const openSockets = new Set<Promise<void>>();
  pool.on("connect", (client) => {
    const closed = new Promise<void>((resolve) => client.once("end", resolve));
    openSockets.add(closed);
    void closed.then(() => openSockets.delete(closed));
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

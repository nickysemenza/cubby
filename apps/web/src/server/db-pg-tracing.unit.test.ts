import { fromPartial } from "@total-typescript/shoehorn";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { withDatabaseOperationMetrics } from "./db-observability";
import {
  createPoolQueryOwnershipBoundary,
  traceStandaloneClient,
  tracePool,
  createPoolConnectAdapter,
  createPoolQueryAdapter,
  createObservedQuery,
  createTracedQuery,
  observePgPoolAndClientQueries,
  type PgPoolConnectImplementation,
  type PgQueryImplementation,
} from "./db-pg-tracing";

const queryResult = (): pg.QueryResult => ({
  command: "SELECT",
  rowCount: 1,
  oid: 0,
  fields: [],
  rows: [{ id: "row-1" }],
});

// Failures: queued work can look like database execution, a rejected query can
// poison the client tail, or reused leases can inherit the wrong role/owner.
describe("node-postgres tracing adapters", () => {
  // A coordinator awaiting a model or another Worker must not retain database
  // capacity. A transaction, however, retains it through rollback after failure.
  it("admits standalone statements and retains one permit through rollback", async () => {
    const dispose = vi.fn();
    const acquire = vi.fn(async () => ({ [Symbol.dispose]: dispose }));
    const rawQuery = vi
      .fn()
      .mockResolvedValueOnce(queryResult())
      .mockRejectedValueOnce(new Error("statement sentinel"))
      .mockResolvedValue(queryResult());
    const client = traceStandaloneClient(
      fromPartial<pg.Client>({ query: rawQuery }),
      "strong",
      acquire,
    );
    await client.query("BEGIN");
    await expect(client.query("SELECT broken")).rejects.toThrow(
      "statement sentinel",
    );
    expect(acquire).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();
    await client.query("ROLLBACK");
    expect(dispose).toHaveBeenCalledOnce();
    await client.query("SELECT recovered");
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  // Admission must precede Hyperdrive connection setup and remain held across
  // every statement on a leased transaction connection, including failure.
  it("holds one admission permit for a connection lease and releases it once", async () => {
    const gate = Promise.withResolvers<Disposable>();
    const dispose = vi.fn();
    const release = vi.fn();
    const rawQuery = vi.fn(async () => queryResult());
    const client = fromPartial<pg.PoolClient>({ query: rawQuery, release });
    const connect = vi.fn(async () => client);
    const pool = tracePool(
      fromPartial<pg.Pool>({
        connect,
        query: rawQuery,
        totalCount: 0,
        idleCount: 0,
        waitingCount: 0,
      }),
      "strong",
      () => gate.promise,
    );
    const leased = pool.connect();
    await Promise.resolve();
    expect(connect).not.toHaveBeenCalled();
    gate.resolve({ [Symbol.dispose]: dispose });
    const connection = await leased;
    await connection.query("BEGIN");
    await connection.query("SELECT 1");
    await connection.query("COMMIT");
    expect(dispose).not.toHaveBeenCalled();
    connection.release();
    connection.release();
    expect(dispose).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("measures serialized client waits separately and continues after rejection", async () => {
    let rejectFirst: (error: Error) => void = () => {};
    const firstGate = new Promise<pg.QueryResult>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const rawQuery = vi
      .fn()
      .mockImplementationOnce(() => firstGate)
      .mockResolvedValue(queryResult());
    const client = traceStandaloneClient(
      fromPartial<pg.Client>({ query: rawQuery }),
      "strong",
    );
    await withDatabaseOperationMetrics(async (metrics) => {
      const first = client.query("select first");
      const rejected = first.catch((error: Error) => error);
      const second = client.query("select second");
      await vi.waitFor(() => expect(rawQuery).toHaveBeenCalledTimes(1));
      rejectFirst(new Error("query sentinel"));
      expect(await rejected).toEqual(new Error("query sentinel"));
      await second;
      expect(metrics).toMatchObject({
        queryCount: 2,
        queryMaxConcurrency: 1,
        clientQueueCount: 2,
      });
      expect(metrics.clientQueueDurationSumMs).toBeGreaterThan(0);
    });
  });

  it("traces promise queries and records their returned rows", async () => {
    const result = queryResult();
    const rawQuery = vi.fn(async () => result);
    const query = createTracedQuery(rawQuery, () => true, "bounded-stale");

    await withDatabaseOperationMetrics(async (metrics) => {
      expect(await query("select id from example")).toBe(result);
      expect(metrics.queryCount).toBe(1);
    });
    expect(rawQuery).toHaveBeenCalledOnce();
  });

  it("preserves callback queries without converting them to promises", async () => {
    const result = queryResult();
    const callback = vi.fn(
      (_error: Error, _response: pg.QueryResult | pg.QueryArrayResult) =>
        undefined,
    );
    const rawQuery: PgQueryImplementation = () => {
      callback(new Error("callback sentinel"), result);
    };
    const query = createTracedQuery(rawQuery, () => false, "strong");

    await withDatabaseOperationMetrics(async (metrics) => {
      expect(query("select id from example", callback)).toBeUndefined();
      expect(metrics.queryCount).toBe(0);
    });
    expect(callback).toHaveBeenCalledWith(expect.any(Error), result);
  });

  it("acquires and releases one non-transaction connection per promise query", async () => {
    const result = queryResult();
    const release = vi.fn();
    const clientQuery = vi.fn(async () => result);
    const acquire = vi.fn(async () => ({ query: clientQuery, release }));
    const rawQuery = vi.fn(async () => result);
    const query = createPoolQueryAdapter(rawQuery, acquire);

    expect(await query("select id from example")).toBe(result);
    expect(acquire).toHaveBeenCalledWith(false);
    expect(clientQuery).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(rawQuery).not.toHaveBeenCalled();
  });

  it("leaves callback queries on pg's callback path without manual acquire", () => {
    const callback = vi.fn(
      (_error: Error, _response: pg.QueryResult | pg.QueryArrayResult) =>
        undefined,
    );
    const rawQuery = vi.fn(() => undefined);
    const acquire = vi.fn(async () => {
      throw new Error("callback query must not acquire manually");
    });
    const query = createPoolQueryAdapter(rawQuery, acquire);

    expect(query("select id from example", callback)).toBeUndefined();
    expect(rawQuery).toHaveBeenCalledWith("select id from example", callback);
    expect(acquire).not.toHaveBeenCalled();
  });

  it("marks promise-based pool connections as transaction-capable", async () => {
    const sentinel = new Error("stop after role assertion");
    const acquire = vi.fn(async () => {
      throw sentinel;
    });
    const rawConnect: PgPoolConnectImplementation = () => undefined;
    const connect = createPoolConnectAdapter(rawConnect, acquire);

    await expect(connect()).rejects.toBe(sentinel);
    expect(acquire).toHaveBeenCalledWith(true);
  });

  it("observes queries through the overload bridge", async () => {
    const result = queryResult();
    const rawQuery: PgQueryImplementation = () => Promise.resolve(result);
    const statements: string[] = [];
    const query = createObservedQuery(rawQuery, (statement) =>
      statements.push(statement),
    );

    await expect(query("select 1")).resolves.toBe(result);

    expect(statements).toEqual(["select 1"]);
  });

  it("distinguishes a pool-owned checkout from an explicit client checkout", () => {
    const ownership = createPoolQueryOwnershipBoundary();

    expect(ownership.shouldMapConnectedClient()).toBe(true);
    ownership.runPoolQuery(() => {
      expect(ownership.shouldMapConnectedClient()).toBe(false);
    });
    expect(ownership.shouldMapConnectedClient()).toBe(true);
  });

  it("counts pool and explicit-client queries once and restores reused clients", async () => {
    const result = queryResult();
    const release = vi.fn();
    const rawClientQuery: PgQueryImplementation = (...args) =>
      args.length === 3 ? undefined : Promise.resolve(result);
    const physicalClient = fromPartial<pg.PoolClient>({
      query: rawClientQuery,
      release,
    });
    let pool = fromPartial<pg.Pool>({});
    const rawConnect: PgPoolConnectImplementation = (...args) => {
      const callback = args[0];
      if (callback) {
        callback(undefined, physicalClient, release);
        return;
      }
      return Promise.resolve(physicalClient);
    };
    const rawPoolQuery: PgQueryImplementation = () => {
      pool.connect(() => undefined);
      physicalClient.query("select internal dispatch", [], () => undefined);
      return Promise.resolve(result);
    };
    pool = fromPartial<pg.Pool>({
      connect: rawConnect,
      query: rawPoolQuery,
    });
    const statements: string[] = [];
    observePgPoolAndClientQueries(pool, (statement) =>
      statements.push(statement),
    );

    await pool.query("select pool promise");
    pool.query("select pool callback", [], () => undefined);
    const client = await pool.connect();
    await client.query("select explicit promise");
    client.query("select explicit callback", [], () => undefined);
    client.release();
    physicalClient.query("select reused physical", [], () => undefined);

    expect(statements).toEqual([
      "select pool promise",
      "select pool callback",
      "select explicit promise",
      "select explicit callback",
    ]);
    expect(release).toHaveBeenCalledOnce();
  });
});

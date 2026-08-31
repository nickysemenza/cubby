import { fromPartial } from "@total-typescript/shoehorn";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { withDatabaseOperationMetrics } from "./db-observability";
import {
  createPoolQueryOwnershipBoundary,
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

describe("node-postgres tracing adapters", () => {
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

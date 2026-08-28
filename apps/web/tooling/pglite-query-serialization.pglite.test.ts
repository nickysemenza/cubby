import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let embedded: PGlite;
let socket: PGLiteSocketServer;
let firstPool: pg.Pool;
let secondPool: pg.Pool;

beforeAll(async () => {
  embedded = await PGlite.create();
  socket = new PGLiteSocketServer({
    db: embedded,
    host: "127.0.0.1",
    port: 0,
    maxConnections: 64,
  });
  await socket.start();
  const connectionString = `postgresql://postgres:postgres@${socket.getServerConn()}/postgres`;
  firstPool = new pg.Pool({ connectionString, max: 16 });
  secondPool = new pg.Pool({ connectionString, max: 16 });
});

afterAll(async () => {
  await Promise.all([firstPool.end(), secondPool.end()]);
  await socket.stop();
  await embedded.close();
});

describe("PGlite socket query cycles", () => {
  it("keeps differently shaped concurrent parameterized results correlated", async () => {
    for (let wave = 0; wave < 10; wave += 1) {
      const inputs = Array.from(
        { length: 200 },
        (_, index) => wave * 200 + index,
      );
      const results = await Promise.all(
        inputs.map((iteration, index) =>
          index % 2 === 0
            ? firstPool
                .query<{ who: string; iteration: number }>(
                  "select $1::text as who, $2::integer as iteration",
                  ["first-client", iteration],
                )
                .then((result) => ({ kind: "first" as const, result }))
            : secondPool
                .query<{ doubled: number; suffix: string }>(
                  "select $1::integer * 2 as doubled, $2::text || 'y' as suffix",
                  [iteration + 1000, "x"],
                )
                .then((result) => ({ kind: "second" as const, result })),
        ),
      );

      const rowsByQuery = results.map(({ kind, result }) => ({
        kind,
        rows: result.rows,
      }));
      const expectedRowsByQuery = inputs.map((iteration, index) =>
        index % 2 === 0
          ? {
              kind: "first",
              rows: [{ who: "first-client", iteration }],
            }
          : {
              kind: "second",
              rows: [{ doubled: (iteration + 1000) * 2, suffix: "xy" }],
            },
      );
      expect(rowsByQuery).toEqual(expectedRowsByQuery);
    }
  });

  it("keeps a transaction's protocol cycle ahead of outside queries", async () => {
    const transactionClient = await firstPool.connect();
    let released = false;
    try {
      await transactionClient.query("begin");
      let outsideSettled = false;
      const outside = secondPool
        .query<{ value: number }>("select $1::integer as value", [22])
        .then((result) => {
          outsideSettled = true;
          return result;
        });

      await Promise.resolve();
      expect(outsideSettled).toBe(false);
      await expect(
        transactionClient.query<{ value: number }>(
          "select $1::integer as value",
          [11],
        ),
      ).resolves.toMatchObject({ rows: [{ value: 11 }] });
      await transactionClient.query("commit");
      transactionClient.release();
      released = true;

      await expect(outside).resolves.toMatchObject({ rows: [{ value: 22 }] });
    } finally {
      if (!released) transactionClient.release();
    }
  });

  it("continues serving queued cycles after a statement error", async () => {
    await expect(
      firstPool.query("select cubby_missing_column"),
    ).rejects.toThrow(/cubby_missing_column/u);

    const values = Array.from({ length: 128 }, (_, index) => index);
    const recovered = await Promise.all(
      values.map((value, index) =>
        (index % 2 === 0 ? firstPool : secondPool).query<{ value: number }>(
          "select $1::integer as value",
          [value],
        ),
      ),
    );
    expect(recovered.map(({ rows }) => rows)).toEqual(
      values.map((value) => [{ value }]),
    );
  });
});

import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { readRefreshDependencyPacket } from "./dependencies";

// Empty-route batching must preserve the next unread route, row continuation,
// and a successful prefix when a later preparation fails outside a transaction.
describe("dependency preparation packets", () => {
  const ctx = withTestDb();
  const sourceId = "00000000-0000-4000-8000-000000000001";
  const empty = {
    entity: "product",
    select: () => sql`SELECT NULL::uuid AS id WHERE false`,
  } satisfies Parameters<typeof readRefreshDependencyPacket>[1][number];
  const populated = {
    entity: "product",
    select: () => sql`SELECT ${sourceId}::uuid AS id`,
  } satisfies typeof empty;

  it("crosses empty routes without skipping the first populated route", async () => {
    const packet = await readRefreshDependencyPacket(
      ctx.db,
      [empty, empty, populated, empty],
      sourceId,
      { route: 0, after: null },
    );
    expect(packet.refs).toEqual([
      { entityKind: "product", entityId: sourceId, traverse: false },
    ]);
    expect(packet.cursor).toEqual({ route: 3, after: null, done: false });
    expect(
      (
        await readRefreshDependencyPacket(
          ctx.db,
          [empty, empty, populated, empty],
          sourceId,
          packet.cursor,
        )
      ).cursor.done,
    ).toBe(true);
  });

  it("checkpoints an empty prefix before retrying a failed route alone", async () => {
    const broken = {
      entity: "product",
      select: () => sql`SELECT 'synthetic invalid uuid'::uuid AS id`,
    } satisfies typeof empty;
    const packet = await readRefreshDependencyPacket(
      ctx.db,
      [empty, broken, populated],
      sourceId,
      { route: 0, after: null },
    );
    expect(packet).toEqual({
      refs: [],
      cursor: { route: 1, after: null, done: false },
    });
    await expect(
      readRefreshDependencyPacket(
        ctx.db,
        [empty, broken, populated],
        sourceId,
        packet.cursor,
      ),
    ).rejects.toThrow(/synthetic invalid uuid/);
  });

  it("continues a full indexed page before advancing its route", async () => {
    const many = {
      entity: "product",
      select: () =>
        sql`SELECT ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid AS id FROM generate_series(1,101) i`,
    } satisfies typeof empty;
    const first = await readRefreshDependencyPacket(
      ctx.db,
      [empty, many],
      sourceId,
      { route: 0, after: null },
    );
    expect(first.refs).toHaveLength(100);
    expect(first.cursor).toEqual({
      route: 1,
      after: first.refs.at(-1)?.entityId,
      done: false,
    });
    const last = await readRefreshDependencyPacket(
      ctx.db,
      [empty, many],
      sourceId,
      first.cursor,
    );
    expect(last.refs.map((ref) => ref.entityId)).toEqual([
      "00000000-0000-4000-8000-000000000101",
    ]);
    expect(last.cursor.done).toBe(true);
  });

  it("resumes at the next unread route when the query bound is reached", async () => {
    const routes = [...Array.from({ length: 32 }, () => empty), populated];
    const first = await readRefreshDependencyPacket(ctx.db, routes, sourceId, {
      route: 0,
      after: null,
    });
    expect(first.refs).toEqual([]);
    expect(first.cursor.done).toBe(false);
    expect(first.cursor.route).toBeGreaterThan(0);
    expect(first.cursor.route).toBeLessThan(routes.length - 1);
    let cursor = first.cursor;
    const refs = [...first.refs];
    while (!cursor.done) {
      const packet = await readRefreshDependencyPacket(
        ctx.db,
        routes,
        sourceId,
        cursor,
      );
      expect(packet.cursor.route).toBeGreaterThan(cursor.route);
      refs.push(...packet.refs);
      cursor = packet.cursor;
    }
    expect(refs.map((ref) => ref.entityId)).toEqual([sourceId]);
  });
});

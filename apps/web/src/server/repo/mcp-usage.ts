import type { Entity } from "@cubby/schemas/entity-core";
import { unsafeUserId } from "@cubby/schemas/identifiers";
import type {
  McpToolCallOutcome,
  McpToolCallSurface,
  McpUsageActivityOut,
  McpUsageWindow,
} from "@cubby/schemas/telemetry";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  isNull,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Database } from "~/server/db";
import { mcpToolCall, oauthClient, user } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

export function mcpUsageSince(window: McpUsageWindow): Date | null {
  if (window === "lifetime") return null;
  return new Date(Date.now() - window * 24 * 60 * 60 * 1000);
}

const countInt = (expression: SQL = sql`*`) =>
  sql<number>`count(${expression})::int`;

export async function getMcpUsageAggregateData(
  db: Database,
  window: McpUsageWindow,
) {
  const drizzle = getDb(db);
  const since = mcpUsageSince(window);
  const periodWhere = since ? gte(mcpToolCall.occurredAt, since) : undefined;

  const [
    observationRows,
    lifetimeTools,
    periodTools,
    daily,
    toolUsers,
    toolClients,
    userBreakdown,
    clientBreakdown,
    surfaceBreakdown,
    entityBreakdown,
  ] = await Promise.all([
    drizzle
      .select({ startedAt: sql<Date | null>`min(${mcpToolCall.occurredAt})` })
      .from(mcpToolCall),
    drizzle
      .select({
        toolName: mcpToolCall.toolName,
        calls: countInt(),
        firstUsedAt: sql<Date>`min(${mcpToolCall.occurredAt})`,
        lastUsedAt: sql<Date>`max(${mcpToolCall.occurredAt})`,
        lastRelease: sql<string>`(array_agg(${mcpToolCall.release} order by ${mcpToolCall.occurredAt} desc))[1]`,
      })
      .from(mcpToolCall)
      .groupBy(mcpToolCall.toolName),
    drizzle
      .select({
        toolName: mcpToolCall.toolName,
        calls: countInt(),
        successes: sql<number>`count(*) filter (where ${mcpToolCall.outcome} = 'success')::int`,
        errors: sql<number>`count(*) filter (where ${mcpToolCall.outcome} = 'error')::int`,
      })
      .from(mcpToolCall)
      .where(periodWhere)
      .groupBy(mcpToolCall.toolName),
    drizzle
      .select({
        toolName: mcpToolCall.toolName,
        day: sql<string>`to_char(date_trunc('day', ${mcpToolCall.occurredAt}), 'YYYY-MM-DD')`,
        success: sql<number>`count(*) filter (where ${mcpToolCall.outcome} = 'success')::int`,
        error: sql<number>`count(*) filter (where ${mcpToolCall.outcome} = 'error')::int`,
        total: countInt(),
      })
      .from(mcpToolCall)
      .where(periodWhere)
      .groupBy(
        mcpToolCall.toolName,
        sql`date_trunc('day', ${mcpToolCall.occurredAt})`,
      )
      .orderBy(asc(sql`date_trunc('day', ${mcpToolCall.occurredAt})`)),
    drizzle
      .select({
        toolName: mcpToolCall.toolName,
        id: user.id,
        name: user.name,
        email: user.email,
      })
      .from(mcpToolCall)
      .innerJoin(user, eq(mcpToolCall.userId, user.id))
      .where(periodWhere)
      .groupBy(mcpToolCall.toolName, user.id, user.name, user.email),
    drizzle
      .select({
        toolName: mcpToolCall.toolName,
        id: mcpToolCall.clientId,
        name: oauthClient.name,
      })
      .from(mcpToolCall)
      .leftJoin(oauthClient, eq(mcpToolCall.clientId, oauthClient.clientId))
      .where(periodWhere)
      .groupBy(mcpToolCall.toolName, mcpToolCall.clientId, oauthClient.name),
    drizzle
      .select({
        key: user.id,
        label: sql<string>`coalesce(${user.name}, ${user.email})`,
        count: countInt(),
      })
      .from(mcpToolCall)
      .innerJoin(user, eq(mcpToolCall.userId, user.id))
      .where(periodWhere)
      .groupBy(user.id, user.name, user.email)
      .orderBy(desc(countInt())),
    drizzle
      .select({
        key: sql<string>`coalesce(${mcpToolCall.clientId}, 'unknown')`,
        label: sql<string>`case when ${mcpToolCall.clientId} = 'cubby-agent' then 'Cubby in-app agent' else coalesce(${oauthClient.name}, ${mcpToolCall.clientId}, 'Unknown client') end`,
        count: countInt(),
      })
      .from(mcpToolCall)
      .leftJoin(oauthClient, eq(mcpToolCall.clientId, oauthClient.clientId))
      .where(periodWhere)
      .groupBy(mcpToolCall.clientId, oauthClient.name)
      .orderBy(desc(countInt())),
    drizzle
      .select({
        key: mcpToolCall.surface,
        label: sql<string>`case when ${mcpToolCall.surface} = 'external_mcp' then 'External MCP' else 'In-app agent' end`,
        count: countInt(),
      })
      .from(mcpToolCall)
      .where(periodWhere)
      .groupBy(mcpToolCall.surface)
      .orderBy(desc(countInt())),
    // Which entity each call targeted, where derivable. `entity` is only
    // populated for CRUD-shaped tools plus merge/attach/detach — everything
    // else (find_*, patch_*, verify_*, statement/usda/problems workflows)
    // stays null, so this is a coarser lens than the per-tool breakdown
    // above, not a replacement for it: it is what lets a `delete_entity` /
    // `merge_entity` / `attach_entity` / `detach_entity` row (collapsed
    // under one toolName) say WHAT it acted on.
    drizzle
      .select({
        key: sql<string>`coalesce(${mcpToolCall.entity}, 'unknown')`,
        label: sql<string>`coalesce(${mcpToolCall.entity}, 'Unattributed')`,
        count: countInt(),
      })
      .from(mcpToolCall)
      .where(periodWhere)
      .groupBy(mcpToolCall.entity)
      .orderBy(desc(countInt())),
  ]);

  return {
    observationStartedAt: observationRows[0]?.startedAt ?? null,
    lifetimeTools,
    periodTools,
    daily,
    toolUsers,
    toolClients,
    userBreakdown,
    clientBreakdown,
    surfaceBreakdown,
    entityBreakdown,
  };
}

const CURSOR_PREFIX = "v1.";

function encodeCursor(row: { occurredAt: Date; id: string }): string {
  const encoded = btoa(
    JSON.stringify({ occurredAt: row.occurredAt.toISOString(), id: row.id }),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  return `${CURSOR_PREFIX}${encoded}`;
}

function decodeCursor(cursor: string): { occurredAt: Date; id: string } {
  try {
    if (!cursor.startsWith(CURSOR_PREFIX)) throw new Error("bad prefix");
    const raw = cursor
      .slice(CURSOR_PREFIX.length)
      .replaceAll("-", "+")
      .replaceAll("_", "/");
    const parsed = JSON.parse(
      atob(raw.padEnd(Math.ceil(raw.length / 4) * 4, "=")),
    ) as { occurredAt?: unknown; id?: unknown };
    if (
      typeof parsed.occurredAt !== "string" ||
      typeof parsed.id !== "string"
    ) {
      throw new Error("bad shape");
    }
    const occurredAt = new Date(parsed.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) throw new Error("bad date");
    return { occurredAt, id: parsed.id };
  } catch {
    throw new Error("Invalid MCP usage cursor");
  }
}

export async function listMcpUsageActivity(
  db: Database,
  input: {
    window: McpUsageWindow;
    toolName?: string;
    userId?: string;
    clientId?: string | null;
    surface?: McpToolCallSurface;
    outcome?: McpToolCallOutcome;
    entity?: Entity;
    cursor?: string;
    limit: number;
  },
): Promise<McpUsageActivityOut> {
  const conditions: SQL[] = [];
  const since = mcpUsageSince(input.window);
  if (since) conditions.push(gte(mcpToolCall.occurredAt, since));
  if (input.toolName) conditions.push(eq(mcpToolCall.toolName, input.toolName));
  if (input.entity) conditions.push(eq(mcpToolCall.entity, input.entity));
  if (input.userId) {
    conditions.push(eq(mcpToolCall.userId, unsafeUserId(input.userId)));
  }
  if (input.clientId !== undefined) {
    conditions.push(
      input.clientId === null
        ? isNull(mcpToolCall.clientId)
        : eq(mcpToolCall.clientId, input.clientId),
    );
  }
  if (input.surface) conditions.push(eq(mcpToolCall.surface, input.surface));
  if (input.outcome) conditions.push(eq(mcpToolCall.outcome, input.outcome));
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor);
    conditions.push(
      or(
        lt(mcpToolCall.occurredAt, cursor.occurredAt),
        and(
          eq(mcpToolCall.occurredAt, cursor.occurredAt),
          lt(mcpToolCall.id, cursor.id),
        ),
      )!,
    );
  }

  const rows = await getDb(db)
    .select({
      id: mcpToolCall.id,
      toolName: mcpToolCall.toolName,
      outcome: mcpToolCall.outcome,
      registeredAtCall: mcpToolCall.registeredAtCall,
      surface: mcpToolCall.surface,
      entity: mcpToolCall.entity,
      release: mcpToolCall.release,
      occurredAt: mcpToolCall.occurredAt,
      ingestedAt: mcpToolCall.ingestedAt,
      userId: user.id,
      userName: user.name,
      userEmail: user.email,
      clientId: mcpToolCall.clientId,
      clientName: oauthClient.name,
    })
    .from(mcpToolCall)
    .innerJoin(user, eq(mcpToolCall.userId, user.id))
    .leftJoin(oauthClient, eq(mcpToolCall.clientId, oauthClient.clientId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(mcpToolCall.occurredAt), desc(mcpToolCall.id))
    .limit(input.limit + 1);

  const hasMore = rows.length > input.limit;
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    entries: page.map((row) => ({
      id: row.id,
      toolName: row.toolName,
      outcome: row.outcome,
      registeredAtCall: row.registeredAtCall,
      surface: row.surface,
      entity: row.entity,
      release: row.release,
      occurredAt: row.occurredAt,
      ingestedAt: row.ingestedAt,
      user: { id: row.userId, name: row.userName, email: row.userEmail },
      client: { id: row.clientId, name: row.clientName },
    })),
    nextCursor: hasMore && last ? encodeCursor(last) : null,
  };
}

export const percentile = (numbers: readonly number[], quantile: number) =>
  [...numbers].sort((a, b) => a - b)[
    Math.ceil(numbers.length * quantile) - 1
  ] ?? null;

/** Read only the closed metrics emitted by db-observability's request collector. */
export function readDatabaseTiming(headers: Headers) {
  const unavailable = {
    sqlCount: null,
    acquisitionMs: null,
    queryActiveWallMs: null,
    clientQueueActiveWallMs: null,
  };
  // Stream headers precede completion and cannot describe all database work.
  const contentType = headers.get("content-type") ?? "";
  if (/x-ndjson|text\/event-stream/i.test(contentType)) return unavailable;
  const header = headers.get("server-timing") ?? "";
  const entries = header.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const metric = (name: string) => {
    const matches = entries.filter((entry) =>
      entry.trim().startsWith(`${name};`),
    );
    if (matches.length !== 1) return null;
    const match = matches[0]
      ?.trim()
      .match(
        /^[\w-]+;dur=(\d+(?:\.\d+)?)(?:;desc="n=(\d+) max=\d+ conc=\d+")?$/,
      );
    if (!match) return null;
    const duration = Number(match[1]);
    const count = match[2] === undefined ? null : Number(match[2]);
    return Number.isFinite(duration) &&
      (count === null || Number.isSafeInteger(count))
      ? { duration, count }
      : null;
  };
  const query = metric("db-query");
  return {
    sqlCount: query?.count ?? null,
    acquisitionMs: metric("db-acquire")?.duration ?? null,
    queryActiveWallMs: query?.duration ?? null,
    clientQueueActiveWallMs: metric("db-queue")?.duration ?? null,
  };
}

import pRetry from "p-retry";

// food-cli / the WASM extractor pass the .epub filename as `source`; turn it
// into a clean, editable book label that stays stable across re-imports.
export const deriveBookName = (source: string): string => {
  const base = source.split(/[/\\]/).pop() ?? source;
  return base.replace(/\.(epub|json)$/i, "");
};

/**
 * Case/whitespace-insensitive recipe-name key, matching how the server keys a
 * cookbook upsert (`normalizeTitle`). It is what lets a tree item find the
 * recipe a previous import created from it.
 */
export const normalize = (value: string): string => value.trim().toLowerCase();

/** `$1.23`, or `<$0.01` for a cost too small to render at cent precision. */
export const formatUsd = (usd: number): string =>
  usd > 0 && usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;

/** A duration in whole minutes and seconds, for estimates and elapsed time. */
export const formatDuration = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
};

/** `~3–7 min`, the shape an estimate range reads best in. */
export const formatMinuteRange = (lowMs: number, highMs: number): string => {
  const low = Math.max(1, Math.round(lowMs / 60_000));
  const high = Math.max(low, Math.round(highMs / 60_000));
  return low === high ? `~${low} min` : `~${low}–${high} min`;
};

/** `12.3k` for token counts, which run to six figures. */
export const formatCount = (value: number): string =>
  value >= 1000 ? `${(value / 1000).toFixed(1)}k` : `${value}`;

/** Retry with exponential backoff; resolves with the first success. */
export async function withRetry<R>(
  fn: () => Promise<R>,
  attempts = 3,
): Promise<R> {
  return pRetry(
    async () => {
      try {
        return await fn();
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(error.message || "AbortError", { cause: error });
        }
        throw error;
      }
    },
    {
      retries: Math.max(0, attempts - 1),
      factor: 2,
      minTimeout: 500,
    },
  );
}

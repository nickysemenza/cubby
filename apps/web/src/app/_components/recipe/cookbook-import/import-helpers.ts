import pRetry from "p-retry";

// food-cli / the WASM extractor pass the .epub filename as `source`; turn it
// into a clean, editable book label that stays stable across re-imports.
export const deriveBookName = (source: string): string => {
  const base = source.split(/[/\\]/).pop() ?? source;
  return base.replace(/\.epub$/i, "");
};

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

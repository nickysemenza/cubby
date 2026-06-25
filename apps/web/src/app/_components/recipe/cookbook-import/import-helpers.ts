// food-cli / the WASM extractor pass the .epub filename as `source`; turn it
// into a clean, editable book label that stays stable across re-imports.
export const deriveBookName = (source: string): string => {
  const base = source.split(/[/\\]/).pop() ?? source;
  return base.replace(/\.epub$/i, "");
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry with exponential backoff; resolves with the first success. */
export async function withRetry<R>(
  fn: () => Promise<R>,
  attempts = 3,
): Promise<R> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastErr = error;
      if (attempt < attempts - 1) await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr;
}

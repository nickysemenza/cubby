import type { chunkResponseOut } from "@cubby/schemas/import-recipe";
import type { z } from "zod";

import { withRetry } from "./import-helpers";

type ChunkResponse = z.output<typeof chunkResponseOut>;

/** Retry the network hop without losing usage from a response that did arrive. */
export async function callChunkWithTransportRetry(
  call: () => Promise<ChunkResponse>,
): Promise<ChunkResponse> {
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  let truncated = false;
  try {
    return await withRetry(async () => {
      const response = await call();
      for (const key of [
        "input_tokens",
        "output_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
      ] as const) {
        usage[key] += response.usage[key];
      }
      truncated ||= response.truncated;
      const lastResponse = { ...response, usage: { ...usage }, truncated };
      if (response.error?.kind === "transport")
        throw new Error(response.error.message);
      return lastResponse;
    });
  } catch (error) {
    return {
      input: null,
      usage,
      truncated,
      error: {
        kind: "transport",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

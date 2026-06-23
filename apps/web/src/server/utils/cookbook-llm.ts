import { chat } from "@tanstack/ai";
import { getAnthropicClient } from "~/server/clients/anthropic";

// Cookbook extraction runs the orchestration loop in the browser (WASM splits
// the EPUB into chunks, each carrying a ready-to-send LLM request). This proxy
// is the one server hop per chunk: it forwards the chunk as a structured-output
// call and returns the `{ recipes: [...] }` object for the WASM
// `assemble_recipes` to parse. It holds no recipe knowledge.
//
// Claude (claude-haiku-4-5) via the shared Anthropic client, which routes
// through Cubby's Cloudflare AI Gateway (`cubby`) — binding in prod / REST in
// dev. The model + token budget are server-owned (not client-supplied) so an
// authenticated user can't run up bills.
const MAX_TOKENS = 16_000;
// Bound each gateway call so a hung request can't pin a concurrency slot forever
// (the browser orchestrator's retry only fires on rejection, not a hang). Real
// calls finish in seconds — this is purely a backstop. `chat()` has no abort
// signal, so this races rather than cancels; the reject is enough to free the
// orchestrator.
const REQUEST_TIMEOUT_MS = 120_000;

/** Reject if `promise` doesn't settle within `REQUEST_TIMEOUT_MS`. */
function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error("cookbook extraction timed out")),
        REQUEST_TIMEOUT_MS,
      ),
    ),
  ]);
}

/** One chunk's LLM request, built by `recipebridge`'s `chunk_epub` (WASM). */
interface CookbookChunkRequest {
  system: string;
  user: string;
  toolName: string;
  /** JSON Schema for the `{ recipes: [...] }` output. */
  toolSchema: Record<string, unknown>;
}

// `outputSchema` accepts a raw JSON Schema object; `chunk_epub` builds one but
// types it loosely, so narrow at the boundary.
type OutputSchema = Parameters<typeof chat>[0]["outputSchema"];

/**
 * Structured-output call for one cookbook chunk. Returns the model's
 * `{ recipes: [...] }` object — the WASM `assemble_recipes` parses it. The
 * chunk's `toolSchema` (raw JSON Schema from `chunk_epub`) drives the output
 * shape, so `toolName` is unused here.
 */
export async function extractCookbookChunk(
  req: CookbookChunkRequest,
): Promise<unknown> {
  const t0 = performance.now();
  // Reuse the shared client's adapter (gateway binding in prod / REST in dev).
  const adapter = getAnthropicClient().getTextAdapter();
  const out = await withTimeout(
    chat({
      adapter,
      // Cache the large, stable system prompt across a book's chunks.
      systemPrompts: [
        {
          content: req.system,
          metadata: { cache_control: { type: "ephemeral" } },
        },
      ],
      messages: [{ role: "user", content: req.user }],
      outputSchema: req.toolSchema as OutputSchema,
      modelOptions: { max_tokens: MAX_TOKENS },
    }),
  );
  console.log(`[cookbook-llm] claude ${Math.round(performance.now() - t0)}ms`);
  return out ?? { recipes: [] };
}

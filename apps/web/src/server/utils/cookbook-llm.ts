import { chunkRequestInput } from "@cubby/schemas/import-recipe";
import { chat } from "@tanstack/ai";
import { z } from "zod";

import {
  COOKBOOK_ESCALATION_MODEL,
  DEFAULT_CHAT_MODEL,
} from "~/server/ai/models";
import { aiGatewayUsageMiddleware } from "~/server/clients/ai-gateway-usage";
import { getAnthropicClient } from "~/server/clients/anthropic";
import type { Database } from "~/server/db";

// Cookbook extraction runs the orchestration loop in the browser (WASM splits
// the EPUB into chunks, each carrying a ready-to-send LLM request). This proxy
// is the one server hop per chunk: it forwards the chunk as a structured-output
// call and returns the `{ recipes: [...] }` object for the WASM driver
// (`extract_cookbook`) to parse. It holds no recipe knowledge.
//
// Claude (claude-haiku-4-5) via the shared Anthropic client, which routes
// through Cubby's Cloudflare AI Gateway (`cubby`) — binding in prod / REST in
// dev. The model + token budget are server-owned (not client-supplied) so an
// authenticated user can't run up bills.
const MAX_TOKENS = 16_000;
// Stronger model the browser escalates a chunk to when the default (Haiku, set
// in `anthropic.ts`) can't return parseable output. Server-owned (the client
// sends a bool, not a model id) so an authenticated user can't run up bills on
// an arbitrary model. The two models fail on *different* chunks — the malformed-
// JSON failure is deterministic per model + chunk content — so escalating a
// default-model failure to this one recovers it.
// Bound each gateway call so a hung request can't pin a concurrency slot forever
// (the browser orchestrator's retry only fires on rejection, not a hang). Real
// calls finish in seconds — this is purely a backstop. `chat()` has no abort
// signal, so this races rather than cancels; the reject is enough to free the
// orchestrator.
const REQUEST_TIMEOUT_MS = 120_000;

/** Reject if `promise` doesn't settle within `REQUEST_TIMEOUT_MS`. */
function withTimeout<T>(promise: Promise<T>): Promise<T> {
  // Clear the timer once the real promise settles, so it doesn't outlive the
  // request and keep the Worker isolate alive toward its wall-clock limit.
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("cookbook extraction timed out")),
        REQUEST_TIMEOUT_MS,
      );
    }),
  ]);
}

/** One chunk's LLM request, built by `recipebridge`'s `chunk_epub` (WASM). */
type CookbookChunkRequest = z.output<typeof chunkRequestInput>;
const cookbookChunkOutputSchema = z.record(z.string(), z.json());
type CookbookChunkOutput = z.output<typeof cookbookChunkOutputSchema>;

export interface CookbookLlmPort {
  getTextAdapter: ReturnType<typeof getAnthropicClient>["getTextAdapter"];
}

const productionCookbookLlmPort: CookbookLlmPort = {
  getTextAdapter: (...args) => getAnthropicClient().getTextAdapter(...args),
};

// `outputSchema` accepts a raw JSON Schema object; `chunk_epub` builds one but
// types it loosely, so narrow at the boundary.
type OutputSchema = Parameters<typeof chat>[0]["outputSchema"];

/**
 * Structured-output call for one cookbook chunk. Returns the model's
 * `{ recipes: [...] }` object — the WASM driver (`extract_cookbook`) parses it.
 * The chunk's `toolSchema` (raw JSON Schema from `chunk_epub`) drives the output
 * shape, so `toolName` is unused here.
 */
export async function extractCookbookChunk(
  req: CookbookChunkRequest,
  opts?: { db?: Database },
  ai: CookbookLlmPort = productionCookbookLlmPort,
): Promise<CookbookChunkOutput> {
  const t0 = performance.now();
  // Reuse the shared client's adapter (gateway binding in prod / REST in dev).
  // Escalated chunks use the stronger model; the default stays Haiku.
  const model = req.escalate ? COOKBOOK_ESCALATION_MODEL : DEFAULT_CHAT_MODEL;
  const adapter = ai.getTextAdapter(undefined, model);
  const out = await withTimeout(
    chat({
      adapter,
      middleware: aiGatewayUsageMiddleware(
        opts?.db
          ? {
              db: opts.db,
              feature: "cookbook-epub-parsing",
              provider: "anthropic",
              model,
              operation: req.escalate
                ? "extractCookbookChunk.escalated"
                : "extractCookbookChunk",
              cacheStatus: "none",
            }
          : undefined,
      ),
      // Cache the large, stable system prompt across a book's chunks.
      systemPrompts: [
        {
          content: req.system,
          metadata: { cache_control: { type: "ephemeral" } },
        },
      ],
      messages: [{ role: "user", content: req.user }],
      // SAFETY: TanStack AI's JSON-Schema input type is nominally narrower
      // than the JSON value accepted by its adapter; chunkRequestInput has
      // already parsed this object as JSON at the WASM/server boundary.
      outputSchema: req.toolSchema as OutputSchema,
      modelOptions: { max_tokens: MAX_TOKENS },
    }),
  );
  console.log(
    `[cookbook-llm] ${model} ${Math.round(performance.now() - t0)}ms`,
  );
  const parsed = cookbookChunkOutputSchema.safeParse(out);
  return parsed.success ? parsed.data : { recipes: [] };
}

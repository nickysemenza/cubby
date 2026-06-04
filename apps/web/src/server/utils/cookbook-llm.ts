import { env } from "~/env";
import { AI_GATEWAY_BASE_URL } from "~/server/clients/anthropic";

// Cookbook extraction runs the orchestration loop in the browser (WASM splits
// the EPUB into chunks, each carrying a ready-to-send LLM request). This proxy
// is the one server hop per chunk: it authenticates to the gateway with the key
// the browser must never see, forwards the forced-tool call, and returns the raw
// tool output for the WASM `assemble_recipes` to parse. It holds no recipe
// knowledge.
//
// Both providers go through the one Cloudflare AI Gateway (`cubby`), which is
// BYOK: the provider keys live in the gateway and every request authenticates
// with a single `cf-aig-authorization: Bearer ${AI_GATEWAY_API_KEY}` token (the
// same way ingredient-parser reaches Anthropic *or* Gemini with one key). Only
// the provider path segment differs:
//   - Gemini    → `${gateway}/google-ai-studio/v1beta/openai` (OpenAI-compat)
//   - Anthropic → `${gateway}/anthropic`
// Gemini (gemini-2.5-flash) is the default — ~2.5× cheaper at full recipe
// coverage, and the native extractor's default. The model + token budget are
// server-owned (not client-supplied) so an authenticated user can't run up bills.
const PROVIDER: "gemini" | "anthropic" = "gemini";
const GEMINI_MODEL = "gemini-2.5-flash";
const ANTHROPIC_MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 16_000;
const ANTHROPIC_VERSION = "2023-06-01";
// Bound each gateway call so a hung request can't pin a concurrency slot forever
// (the native extractor uses a reqwest 180s timeout; the browser orchestrator's
// retry only fires on rejection, not a hang). With thinking disabled, real calls
// finish in seconds — this is purely a backstop.
const REQUEST_TIMEOUT_MS = 120_000;

// Per-provider routes on the same gateway base.
const ANTHROPIC_GATEWAY_URL = `${AI_GATEWAY_BASE_URL}/anthropic`;
const GEMINI_GATEWAY_URL = `${AI_GATEWAY_BASE_URL}/google-ai-studio/v1beta/openai`;

function gatewayToken(): string {
  if (!env.AI_GATEWAY_API_KEY) {
    throw new Error(
      "AI_GATEWAY_API_KEY is not configured. Add it to your .env.",
    );
  }
  return env.AI_GATEWAY_API_KEY;
}

/** `fetch` with an abort-based timeout backstop. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** One chunk's LLM request, built by `recipebridge`'s `chunk_epub` (WASM). */
export interface CookbookChunkRequest {
  system: string;
  user: string;
  toolName: string;
  /** JSON Schema for the forced tool's `{ recipes: [...] }` input. */
  toolSchema: Record<string, unknown>;
}

/**
 * Forced-tool call for one cookbook chunk. Returns the tool's raw `input`
 * object (`{ recipes: [...] }`) verbatim — the WASM `assemble_recipes` parses
 * it. Both providers authenticate with the single gateway token (BYOK).
 */
export async function extractCookbookChunk(
  req: CookbookChunkRequest,
): Promise<unknown> {
  return PROVIDER === "gemini"
    ? extractViaGemini(req)
    : extractViaAnthropic(req);
}

// --- Gemini (OpenAI-compatible, via the gateway) — default ------------------

interface OpenAiToolCallResponse {
  choices?: {
    message?: { tool_calls?: { function?: { arguments?: string } }[] };
  }[];
}

async function extractViaGemini(req: CookbookChunkRequest): Promise<unknown> {
  const t0 = performance.now();
  const resp = await fetchWithTimeout(
    `${GEMINI_GATEWAY_URL}/chat/completions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-aig-authorization": `Bearer ${gatewayToken()}`,
      },
      body: JSON.stringify({
        model: GEMINI_MODEL,
        max_tokens: MAX_TOKENS,
        // gemini-2.5-flash "thinks" by default, which adds 20-30s + tokens to a
        // mechanical extraction that needs no reasoning. Disable it — this is the
        // single biggest latency win (and keeps the call well under the Worker
        // wall-clock limit in prod).
        reasoning_effort: "none",
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: req.toolName,
              description: "Return every recipe found in the cookbook section.",
              parameters: req.toolSchema,
            },
          },
        ],
        tool_choice: { type: "function", function: { name: req.toolName } },
      }),
    },
  );
  if (!resp.ok) {
    throw new Error(
      `Gemini extraction failed (${resp.status}): ${await resp.text()}`,
    );
  }
  const data = (await resp.json()) as OpenAiToolCallResponse;
  // Profiling: gateway+model time only (excludes browser↔Worker overhead).
  console.log(`[cookbook-llm] gemini ${Math.round(performance.now() - t0)}ms`);
  // OpenAI-compat returns the tool input as a JSON-encoded string.
  const args = data.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!args) return { recipes: [] };
  return JSON.parse(args);
}

// --- Anthropic (Claude) — alternative ---------------------------------------

interface AnthropicToolUseResponse {
  content?: { type?: string; input?: unknown }[];
}

async function extractViaAnthropic(
  req: CookbookChunkRequest,
): Promise<unknown> {
  const resp = await fetchWithTimeout(`${ANTHROPIC_GATEWAY_URL}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": ANTHROPIC_VERSION,
      "cf-aig-authorization": `Bearer ${gatewayToken()}`,
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: MAX_TOKENS,
      system: [
        {
          type: "text",
          text: req.system,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [
        {
          name: req.toolName,
          description: "Return every recipe found in the cookbook section.",
          input_schema: req.toolSchema,
        },
      ],
      tool_choice: { type: "tool", name: req.toolName },
      messages: [{ role: "user", content: req.user }],
    }),
  });
  if (!resp.ok) {
    throw new Error(
      `Anthropic extraction failed (${resp.status}): ${await resp.text()}`,
    );
  }
  const data = (await resp.json()) as AnthropicToolUseResponse;
  const block = data.content?.find((b) => b.type === "tool_use");
  return block?.input ?? { recipes: [] };
}

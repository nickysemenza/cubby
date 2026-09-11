import type { AdapterYieldChunk, AnyTextAdapter } from "@tanstack/ai";
import { z } from "zod";

type ProviderRunError = Error & {
  code?: string;
};

/**
 * What a thrown `structuredOutput` error might carry beyond its `message`:
 * whichever of these the underlying adapter happened to preserve (see the
 * catch clause in {@link surfaceStructuredOutputRunErrors}'s `structuredOutput`
 * wrapper). Parsed rather than duck-typed so reading `.code` off an arbitrary
 * thrown value is one boundary check instead of a `typeof`/`in` chain.
 */
const thrownProviderErrorSchema = z.object({
  name: z.string().optional(),
  message: z.string().optional(),
  code: z.string().optional(),
});

function providerRunError(
  chunk: Extract<AdapterYieldChunk, { type: "RUN_ERROR" }>,
) {
  const error: ProviderRunError = new Error(
    chunk.message || chunk.error?.message || "AI provider request failed",
  );
  error.name = "AIProviderRunError";
  const code = chunk.code ?? chunk.error?.code;
  if (code) error.code = code;
  return error;
}

async function* throwProviderRunErrors(
  stream: AsyncIterable<AdapterYieldChunk>,
): AsyncIterable<AdapterYieldChunk> {
  for await (const chunk of stream) {
    if (chunk.type === "RUN_ERROR") throw providerRunError(chunk);
    yield chunk;
  }
}

/**
 * TanStack AI currently converts provider RUN_ERROR events encountered during
 * structured generation into a generic "finalization produced no result"
 * exception. Preserve the provider's actionable message for our internal
 * structured calls. The public text adapter remains unwrapped because agent
 * callers consume stream lifecycle events themselves.
 *
 * `opts.streaming` (default `true`, unchanged behaviour) picks which of the
 * engine's two structured-output code paths runs. TanStack AI's `chat()`
 * always prefers `adapter.structuredOutputStream` over `adapter.structuredOutput`
 * when the former is defined, regardless of the caller's own `stream` option
 * (`@tanstack/ai/dist/esm/activities/chat/index.js`'s `runStructuredFinalization`).
 * `streaming: false` clears `structuredOutputStream` on the returned adapter to
 * force the engine's `fallbackStructuredOutputStream` fallback, which calls
 * `adapter.structuredOutput` directly and puts `stream: false` on the wire —
 * required for the AI Gateway's exact-body cache match, since a streaming
 * request always carries `stream: true` and a different shape. On that path a
 * provider failure never reaches us as a RUN_ERROR chunk to intercept:
 * `fallbackStructuredOutputStream` catches whatever `adapter.structuredOutput`
 * throws and only carries it forward as `finalizationError.cause` inside a
 * generic engine `Error`, never as our named `AIProviderRunError`. So on this
 * path we wrap `structuredOutput` itself instead of the stream.
 */
export function surfaceStructuredOutputRunErrors<T extends AnyTextAdapter>(
  adapter: T,
  opts?: { streaming?: boolean },
): T {
  const streaming = opts?.streaming ?? true;

  const chatStream: AnyTextAdapter["chatStream"] = (options) =>
    throwProviderRunErrors(adapter.chatStream(options));
  const structuredOutputStream: NonNullable<
    AnyTextAdapter["structuredOutputStream"]
  > = (options) => {
    if (!adapter.structuredOutputStream) {
      throw new Error("Structured output streaming is unavailable");
    }
    return throwProviderRunErrors(adapter.structuredOutputStream(options));
  };
  const structuredOutput: AnyTextAdapter["structuredOutput"] = async (
    options,
  ) => {
    try {
      return await adapter.structuredOutput(options);
    } catch (caught) {
      const parsed = thrownProviderErrorSchema.safeParse(caught);
      if (parsed.success && parsed.data.name === "AIProviderRunError") {
        // SAFETY: the parsed shape ({name, message?, code?}) matched
        // `AIProviderRunError`'s own name, which only this module's error
        // constructors ever set — chatStream's `throwProviderRunErrors`
        // throws the same shape, so this is a re-thrown one of ours.
        throw caught as ProviderRunError;
      }
      const message =
        parsed.success && parsed.data.message !== undefined
          ? parsed.data.message
          : "AI provider structured output request failed";
      const wrapped: ProviderRunError = new Error(message, { cause: caught });
      wrapped.name = "AIProviderRunError";
      if (parsed.success && parsed.data.code !== undefined) {
        wrapped.code = parsed.data.code;
      }
      throw wrapped;
    }
  };

  // Providers are class instances: spreading them drops prototype methods.
  // Delegate the text-adapter contract with the original instance as receiver.
  return {
    ...adapter,
    structuredOutput: streaming
      ? adapter.structuredOutput.bind(adapter)
      : structuredOutput,
    supportsCombinedToolsAndSchema:
      adapter.supportsCombinedToolsAndSchema?.bind(adapter),
    chatStream,
    structuredOutputStream:
      streaming && adapter.structuredOutputStream
        ? structuredOutputStream
        : undefined,
  };
}

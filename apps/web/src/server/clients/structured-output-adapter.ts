import type { AnyTextAdapter, StreamChunk } from "@tanstack/ai";

type ProviderRunError = Error & {
  code?: string;
};

function providerRunError(chunk: Extract<StreamChunk, { type: "RUN_ERROR" }>) {
  const error: ProviderRunError = new Error(
    chunk.message || chunk.error?.message || "AI provider request failed",
  );
  error.name = "AIProviderRunError";
  const code = chunk.code ?? chunk.error?.code;
  if (code) error.code = code;
  return error;
}

async function* throwProviderRunErrors(
  stream: AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
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
 */
export function surfaceStructuredOutputRunErrors<T extends AnyTextAdapter>(
  adapter: T,
): T {
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

  // Providers are class instances: spreading them drops prototype methods.
  // Delegate the text-adapter contract with the original instance as receiver.
  return {
    ...adapter,
    structuredOutput: adapter.structuredOutput.bind(adapter),
    supportsCombinedToolsAndSchema:
      adapter.supportsCombinedToolsAndSchema?.bind(adapter),
    chatStream,
    structuredOutputStream: adapter.structuredOutputStream
      ? structuredOutputStream
      : undefined,
  };
}

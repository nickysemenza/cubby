import {
  getEmbeddingModelConfig,
  type SupportedEmbeddingModel,
} from "./models";

let tokenizer: Promise<import("js-tiktoken/lite").Tiktoken> | undefined;
const loadTokenizer = () =>
  (tokenizer ??= Promise.all([
    import("js-tiktoken/lite"),
    import("js-tiktoken/ranks/cl100k_base"),
  ]).then(([{ Tiktoken }, { default: ranks }]) => new Tiktoken(ranks)));

/**
 * One-vector semantic input. Builders order identity before free-form notes.
 * Bound tokenizer work as well as provider input; never modify stored source text.
 */
export async function prepareEmbeddingText(
  text: string,
  model: SupportedEmbeddingModel,
): Promise<string> {
  const { maxInputTokens } = getEmbeddingModelConfig(model);
  // Byte-pair tokens cannot outnumber UTF-8 bytes. Most inputs need no tokenizer.
  if (
    text.length <= maxInputTokens &&
    new TextEncoder().encode(text).length <= maxInputTokens
  )
    return text;
  const encoder = await loadTokenizer();
  const candidate = text.slice(0, maxInputTokens * 4);
  const tokens = encoder.encode(candidate, [], []).slice(0, maxInputTokens);
  let prepared = encoder.decode(tokens);
  // A token boundary can split a Unicode scalar. Keep a true source prefix and
  // recheck after decoding so replacement bytes never violate the token limit.
  while (
    !text.startsWith(prepared) ||
    encoder.encode(prepared, [], []).length > maxInputTokens
  ) {
    tokens.pop();
    prepared = encoder.decode(tokens);
  }
  return prepared;
}

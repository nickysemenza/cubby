import type { AiChatRequest } from "~/server/ai/policy/feature-identity";

/** `input` is the merchant key, so every spelling of one merchant shares an answer. */
export function merchantIdentityRequest(input: {
  merchant: string;
}): AiChatRequest {
  return {
    systemPrompts: [
      "Extract one canonical business name supported by the merchant descriptor. Remove store numbers and payment prefixes only when the business remains clear. Abstain for people, processor-only text, or ambiguous identities. Never invent a business. Return name=null when unsupported. The descriptor arrives lowercased; return the name in the business's usual capitalization.",
    ],
    messages: [{ role: "user", content: JSON.stringify(input) }],
  };
}

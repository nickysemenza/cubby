import type { AiChatRequest } from "~/server/ai/run-feature";

export function merchantIdentityRequest(
  merchant: string,
  description: string | null,
): AiChatRequest {
  return {
    systemPrompts: [
      "Extract one canonical business name supported by the merchant descriptor. Remove store numbers and payment prefixes only when the business remains clear. Abstain for people, processor-only text, or ambiguous identities. Never invent a business. Return name=null when unsupported.",
    ],
    messages: [
      { role: "user", content: JSON.stringify({ merchant, description }) },
    ],
  };
}

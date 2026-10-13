import type { AiChatRequest } from "~/server/ai/run-feature";

const SELECTION_FRAME =
  "You are given a subject and a numbered shortlist. Choose exactly one entry's id, or null when none fits.";

export const selectionOverflowRequest = (
  rules: string,
  subject: string,
  shortlist: string,
): AiChatRequest => ({
  systemPrompts: [SELECTION_FRAME, rules, `Shortlist:\n${shortlist}`],
  messages: [{ role: "user", content: subject }],
});

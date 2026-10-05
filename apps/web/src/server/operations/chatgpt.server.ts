import { chatgptContract } from "~/contracts/chatgpt.contract";
import { requireChatGptPlan } from "~/server/ai/chatgpt/client";
import { implementOperationDomain } from "~/server/operation-domain.server";

export const chatgptHandlers = implementOperationDomain(chatgptContract, {
  authorizationHost: async () => requireChatGptPlan().authorizationHost(),
  connect: async (_context, input) => requireChatGptPlan().connect(input),
});

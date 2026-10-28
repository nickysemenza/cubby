import { chatgptContract } from "~/contracts/chatgpt.contract";

import { defineOperationDomain } from "../operation-catalog";

export const chatgpt = /* @__PURE__ */ defineOperationDomain(chatgptContract);

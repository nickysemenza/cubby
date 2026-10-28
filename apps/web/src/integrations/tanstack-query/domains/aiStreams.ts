import { aiStreamsContract } from "~/contracts/ai.contract";

import { defineOperationDomain } from "../operation-catalog";

export const aiStreams =
  /* @__PURE__ */ defineOperationDomain(aiStreamsContract);

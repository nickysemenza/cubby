import { entityTimelineContract } from "~/contracts/entity-timeline.contract";

import { defineOperationDomain } from "../operation-catalog";
import { entityTimelineOverrides } from "../operation-overrides/entityTimeline";

export const entityTimeline = /* @__PURE__ */ defineOperationDomain(
  entityTimelineContract,
  entityTimelineOverrides,
);

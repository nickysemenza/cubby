import {
  AnalyzeLocationAction,
  LocationAiDescription,
  LocationContentsValuation,
} from "~/app/locations/slots";
import { defineDetailHooks } from "~/entity/entity-detail/detail-hooks";

export const locationDetailHooks = defineDetailHooks("location", {
  slots: {
    "contents-valuation": { component: LocationContentsValuation },
    "ai-description": { component: LocationAiDescription },
  },
  collectionActions: { analyzeLocation: AnalyzeLocationAction },
});

import {
  ImportOutcomeDetail,
  readImportOutcomeDetail,
} from "~/entity/components/import-outcome-detail";
import { NoneValue } from "~/ui/text/none-value";

import type { EntityDetailFieldRenderers } from "./index";

export const emailDetailFields = {
  "email-import-outcome": (email) => {
    const detail = readImportOutcomeDetail(email);
    return {
      value: detail ? <ImportOutcomeDetail detail={detail} /> : <NoneValue />,
    };
  },
} satisfies EntityDetailFieldRenderers<"email">;

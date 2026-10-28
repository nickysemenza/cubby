import { calendarContract } from "~/contracts/calendar.contract";

import { defineOperationDomain } from "../operation-catalog";

export const calendar = /* @__PURE__ */ defineOperationDomain(calendarContract);

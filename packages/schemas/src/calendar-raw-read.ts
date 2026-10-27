/** Internal occurrence assembly. Public Calendar sources use canonical field envelopes. */
import { z } from "zod";
import { displayImagesField } from "./display-images";
import {
  calendarMealItem,
  calendarTaskItem,
  calendarExpenseItem,
  calendarPurchaseItem,
  calendarProjectItem,
  calendarPlantingItem,
  rawCalendarMealSource,
  rawCalendarTaskSource,
  rawCalendarExpenseSource,
  rawCalendarPurchaseSource,
  rawCalendarProjectSource,
  rawCalendarPlantingSource,
} from "./calendar";
const media = { displayImages: displayImagesField.default([]) };
export const rawCalendarItem = z.discriminatedUnion("kind", [
  calendarMealItem.extend({ ...media, source: rawCalendarMealSource }),
  calendarTaskItem.extend({ ...media, source: rawCalendarTaskSource }),
  calendarExpenseItem.extend({ ...media, source: rawCalendarExpenseSource }),
  calendarPurchaseItem.extend({
    ...media,
    source: rawCalendarPurchaseSource.optional(),
  }),
  calendarProjectItem.extend({ ...media, source: rawCalendarProjectSource }),
  calendarPlantingItem.extend({
    ...media,
    source: rawCalendarPlantingSource.optional(),
  }),
]);
export type RawCalendarItem = z.infer<typeof rawCalendarItem>;

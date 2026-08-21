import { addDays, format, type Locale } from "date-fns";
import type {
  CalendarPeriod,
  EventCalendarDateRange,
} from "./event-calendar-types";

interface EventCalendarI18nConfig {
  labels: {
    addEvent: string;
    allDay: string;
    more: (count: number) => string;
    week: (weekNumber: number) => string;
    continues: string;
  };
  formats: {
    monthTitle: string;
    monthDayHeader: string;
    monthDayHeaderNarrow: string;
    moreDayHeader: string;
    monthCellAriaLabel: string;
    monthCellDay: string;
    eventTime: string;
  };
  functions: {
    formatTitle: (period: CalendarPeriod, ctx: { date: Date; activeRange: EventCalendarDateRange; visibleRange: EventCalendarDateRange; locale?: Locale }) => string;
    formatEventTime: (start: Date, end: Date, allDay: boolean, opts?: { locale?: Locale }) => string;
    formatEventLabel?: (title: string, timeLabel: string) => string | undefined;
    formatEventAriaLabel?: (title: string, timeLabel: string, continues: boolean) => string;
  };
}
const DEFAULT_LABELS: EventCalendarI18nConfig["labels"] = { addEvent: "Add event", allDay: "All day", more: (count) => `+${count} more`, week: (weekNumber) => `W${weekNumber}`, continues: "continues" };
const DEFAULT_FORMATS: EventCalendarI18nConfig["formats"] = { monthTitle: "MMMM yyyy", monthDayHeader: "EEE", monthDayHeaderNarrow: "EEEEE", moreDayHeader: "EEEE, MMMM d", monthCellAriaLabel: "PPPP", monthCellDay: "d", eventTime: "h:mm a" };
function functions(cfg: Pick<EventCalendarI18nConfig, "labels" | "formats">): EventCalendarI18nConfig["functions"] { return { formatTitle: (view, { date, activeRange, locale }) => {
  // A fortnight straddles months as often as not, so its label has to name the
  // range; every other view is titled by the month containing the anchor.
  if (view !== "fortnight") return format(date, cfg.formats.monthTitle, { locale });
  const last = addDays(activeRange.end, -1);
  return `${format(activeRange.start, "MMM d", { locale })} \u2013 ${format(last, "MMM d, yyyy", { locale })}`;
}, formatEventTime: (start, end, allDay, opts) => allDay ? cfg.labels.allDay : `${format(start, cfg.formats.eventTime, opts)} - ${format(end, cfg.formats.eventTime, opts)}` }; }
const DEFAULT_EVENT_CALENDAR_I18N: EventCalendarI18nConfig = { labels: DEFAULT_LABELS, formats: DEFAULT_FORMATS, functions: functions({ labels: DEFAULT_LABELS, formats: DEFAULT_FORMATS }) };
type EventCalendarI18nOverrides = { [K in keyof EventCalendarI18nConfig]?: Partial<EventCalendarI18nConfig[K]> };
function mergeEventCalendarI18n(overrides?: EventCalendarI18nOverrides): EventCalendarI18nConfig { if (!overrides) return DEFAULT_EVENT_CALENDAR_I18N; const labels = { ...DEFAULT_LABELS, ...overrides.labels }; const formats = { ...DEFAULT_FORMATS, ...overrides.formats }; return { labels, formats, functions: { ...functions({ labels, formats }), ...overrides.functions } }; }
export type { EventCalendarI18nConfig, EventCalendarI18nOverrides };
export { mergeEventCalendarI18n };

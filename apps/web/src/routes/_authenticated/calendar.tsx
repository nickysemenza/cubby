import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { useMemo } from "react";
import { CalendarFilterBar } from "~/app/calendar/calendar-filter-bar";
import { buildCalendarFilters } from "~/app/calendar/calendar-filters";
import {
  calendarSearchDefaults,
  calendarSearchSchema,
} from "~/app/calendar/calendar-search";
import { CalendarSubscribeDialog } from "~/app/calendar/calendar-subscribe-dialog";
import { UnifiedCalendar } from "~/app/calendar/unified-calendar";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/calendar")({
  validateSearch: calendarSearchSchema,
  search: { middlewares: [stripSearchParams(calendarSearchDefaults)] },
  component: CalendarRoute,
  head: () => ({ meta: [{ title: pageTitle("Calendar") }] }),
});

function CalendarRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  // `search` is referentially stable per navigation, and `filters` is a
  // `useMemo` dependency of the query range downstream — building it inline
  // would allocate a fresh object every render and churn the range.
  const filters = useMemo(() => buildCalendarFilters(search), [search]);

  return (
    <Page
      variant="list"
      title="Calendar"
      fullWidth
      actions={<CalendarSubscribeDialog />}
    >
      <CalendarFilterBar
        search={search}
        onSearchChange={(params) =>
          void navigate({
            search: (previous) => ({ ...previous, ...params }),
            replace: true,
          })
        }
      />
      <UnifiedCalendar
        date={search.date}
        day={search.day}
        filters={filters}
        onDateChange={(date) =>
          void navigate({
            search: (previous) => ({ ...previous, date }),
            replace: true,
          })
        }
        onDayChange={(day) =>
          void navigate({
            search: (previous) => ({ ...previous, day }),
            replace: true,
          })
        }
      />
    </Page>
  );
}

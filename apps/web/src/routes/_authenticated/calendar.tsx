import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import { listChromePage } from "~/app/_components/routing/entity-routes";
import { CalendarConnectDialog } from "~/app/calendar/calendar-connect-dialog";
import { CalendarFilterBar } from "~/app/calendar/calendar-filter-bar";
import { buildCalendarFilters } from "~/app/calendar/calendar-filters";
import {
  calendarSearchDefaults,
  calendarSearchSchema,
} from "~/app/calendar/calendar-search";
import { UnifiedCalendar } from "~/app/calendar/unified-calendar";
import { pageTitle } from "~/lib/page-title";

// Bound to a const, not inlined into the options object below: see
// `entity-routes.tsx`'s doc comment on why the splitter needs a literal
// identifier here, not an inline factory call.
const CalendarRoute = listChromePage({
  title: "Calendar",
  layout: "full",
  actions: () => <CalendarConnectDialog />,
  page: CalendarBody,
});

export const Route = createFileRoute("/_authenticated/calendar")({
  validateSearch: calendarSearchSchema,
  search: { middlewares: [stripSearchParams(calendarSearchDefaults)] },
  component: CalendarRoute,
  head: () => ({ meta: [{ title: pageTitle("Calendar") }] }),
});

function CalendarBody() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  // `search` is referentially stable per navigation, and `filters` is a
  // `useMemo` dependency of the query range downstream — building it inline
  // would allocate a fresh object every render and churn the range.
  const filters = useMemo(() => buildCalendarFilters(search), [search]);
  const filterBarSearch = useMemo(() => {
    if (search.period !== "schedule") return search;
    const kinds = filters.kinds
      ?.filter((kind) => kind === "task" || kind === "planting")
      .join(",");
    return { ...search, kinds: kinds || undefined };
  }, [filters, search]);
  // Stable, so `ManifestFilterBar`'s `commit` callback — and the draft effect
  // that depends on it — don't churn every render. `LedgerFilters` gets this
  // for free from its `[table]` dep; the URL-backed bar has to say it.
  const onSearchChange = useCallback(
    (params: Record<string, string | undefined>) =>
      void navigate({
        search: (previous) => ({ ...previous, ...params }),
        replace: true,
      }),
    [navigate],
  );

  return (
    <>
      <CalendarFilterBar
        search={filterBarSearch}
        onSearchChange={onSearchChange}
        mode={search.period === "schedule" ? "schedule" : "calendar"}
      />
      <UnifiedCalendar
        period={search.period ?? "month"}
        date={search.date}
        day={search.day}
        filters={filters}
        onPeriodChange={(period) =>
          void navigate({
            search: (previous) => ({
              ...previous,
              period: period === "month" ? undefined : period,
              day: period === "schedule" ? undefined : previous.day,
            }),
            replace: true,
          })
        }
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
    </>
  );
}

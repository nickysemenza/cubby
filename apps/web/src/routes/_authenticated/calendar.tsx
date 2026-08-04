import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import {
  calendarSearchDefaults,
  calendarSearchSchema,
} from "~/app/calendar/calendar-search";
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

  return (
    <Page variant="list" title="Calendar" fullWidth>
      <UnifiedCalendar
        date={search.date}
        day={search.day}
        kinds={search.kinds}
        projectKinds={search.projectKinds}
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
        onKindsChange={(kinds) =>
          void navigate({
            search: (previous) => ({ ...previous, kinds }),
            replace: true,
          })
        }
        onProjectKindsChange={(projectKinds) =>
          void navigate({
            search: (previous) => ({ ...previous, projectKinds }),
            replace: true,
          })
        }
      />
    </Page>
  );
}

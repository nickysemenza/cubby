import {
  calendarFeedOut,
  type calendarRangeInput,
  calendarRangeOut,
  calendarRotateFeedOut,
} from "@cubby/schemas/calendar";
import { mutationOptions, queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import { startOperation } from "~/integrations/tanstack-query/start-transport";
import { queryKeys } from "~/lib/query-keys";
import * as calendarBrowser from "~/server/calendar-browser.server";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";

const getCalendarRangeTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as z.input<typeof calendarRangeInput>)
  .handler(
    async ({ data, context }) =>
      await calendarBrowser.getCalendarRangeForBrowser({
        data,
        request: context.startOperation,
      }),
  );

const getCalendarFeedTransport = createServerFn({ method: "GET" })
  .middleware([authenticatedStartServerFunction])
  .handler(
    async ({ context }) =>
      await calendarBrowser.getCalendarFeedForBrowser({
        request: context.startOperation,
      }),
  );

const rotateCalendarFeedTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .handler(
    async ({ context }) =>
      await calendarBrowser.rotateCalendarFeedForBrowser({
        request: context.startOperation,
      }),
  );

const calendarRangeOperation = startOperation<
  z.input<typeof calendarRangeInput>,
  z.output<typeof calendarRangeOut>
>({
  operation: "calendar.range",
  transport: (data, { signal, headers }) =>
    getCalendarRangeTransport({ data, signal, headers }),
  parse: (result) => calendarRangeOut.parse(result),
});

const calendarFeedOperation = startOperation<
  null,
  z.output<typeof calendarFeedOut>
>({
  operation: "calendar.getFeed",
  transport: (_input, { signal, headers }) =>
    getCalendarFeedTransport({ signal, headers }),
  parse: (result) => calendarFeedOut.parse(result),
});

const calendarRotateFeedOperation = startOperation<
  null,
  z.output<typeof calendarRotateFeedOut>
>({
  operation: "calendar.rotateFeed",
  kind: "mutation",
  transport: (_input, { headers }) => rotateCalendarFeedTransport({ headers }),
  parse: (result) => calendarRotateFeedOut.parse(result),
});

export const calendarRangeQueryOptions = (
  input: z.input<typeof calendarRangeInput>,
) =>
  queryOptions({
    queryKey: [[...queryKeys.calendar.all, "range"], { input }] as const,
    meta: calendarRangeOperation.meta,
    queryFn: ({ signal }) => calendarRangeOperation.call(input, { signal }),
  });

export const calendarFeedQueryKey = [
  ...queryKeys.calendar.all,
  "getFeed",
] as const;

export const calendarFeedQueryOptions = () =>
  queryOptions({
    queryKey: calendarFeedQueryKey,
    meta: calendarFeedOperation.meta,
    queryFn: ({ signal }) => calendarFeedOperation.call(null, { signal }),
  });

export const calendarRotateFeedMutationOptions = () =>
  mutationOptions({
    mutationKey: [...queryKeys.calendar.all, "rotateFeed"] as const,
    mutationFn: async () => {
      const result = await calendarRotateFeedOperation.call(null);
      return result;
    },
    meta: calendarRotateFeedOperation.meta,
  });

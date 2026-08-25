import * as schemas from "@cubby/schemas/project";
import {
  mutationOptions,
  queryOptions,
  type UseMutationOptions,
} from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  type StartOperation,
  startOperation,
} from "~/integrations/tanstack-query/start-transport";
import { markFreshReads } from "~/lib/fresh-read-marker";
import { queryKeys } from "~/lib/query-keys";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";
import * as browser from "~/server/project-browser.server";

const summaryTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) => v as z.input<typeof schemas.projectDashboardFiltersSchema>,
  )
  .handler(({ data, context }) =>
    browser.getProjectDashboardSummaryForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const treeTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((v: unknown) => v as z.input<typeof schemas.projectTreeInput>)
  .handler(({ data, context }) =>
    browser.getProjectTreeForBrowser({ data, request: context.startOperation }),
  );
const analyticsTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) => v as z.input<typeof schemas.projectDashboardFiltersSchema>,
  )
  .handler(({ data, context }) =>
    browser.getProjectPortfolioAnalyticsForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const optionsTransport = createServerFn({ method: "GET" })
  .middleware([authenticatedStartServerFunction])
  .handler(({ context }) =>
    browser.getProjectOptionsForBrowser({ request: context.startOperation }),
  );
const createFromTasksTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) => v as z.input<typeof schemas.createProjectFromTasksInput>,
  )
  .handler(({ data, context }) =>
    browser.createProjectFromTasksForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const resourcesTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) => v as z.input<typeof schemas.projectResourceProjectInput>,
  )
  .handler(({ data, context }) =>
    browser.listProjectResourcesForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const suggestionsTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) => v as z.input<typeof schemas.projectResourceProjectInput>,
  )
  .handler(({ data, context }) =>
    browser.suggestProjectToolsForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const attachTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) => v as z.input<typeof schemas.projectResourceMutationInput>,
  )
  .handler(({ data, context }) =>
    browser.attachProjectResourcesForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const detachTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) => v as z.input<typeof schemas.projectResourceMutationInput>,
  )
  .handler(({ data, context }) =>
    browser.detachProjectResourcesForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const matrixTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) => v as z.input<typeof schemas.projectToolMatrixInput>,
  )
  .handler(({ data, context }) =>
    browser.projectToolMatrixForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const usageTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) => v as z.input<typeof schemas.projectToolUsageSetInput>,
  )
  .handler(({ data, context }) =>
    browser.setProjectToolUsageForBrowser({
      data,
      request: context.startOperation,
    }),
  );

const summaryOperation = startOperation<
  z.input<typeof schemas.projectDashboardFiltersSchema>,
  z.output<typeof schemas.projectDashboardSummaryOut>
>({
  operation: "project.dashboardSummary",
  transport: (data, o) => summaryTransport({ data, ...o }),
  parse: (result) => schemas.projectDashboardSummaryOut.parse(result),
});
const treeOperation = startOperation<
  z.input<typeof schemas.projectTreeInput>,
  z.output<typeof schemas.projectTreeOut>
>({
  operation: "project.tree",
  transport: (data, o) => treeTransport({ data, ...o }),
  parse: (result) => schemas.projectTreeOut.parse(result),
});
const analyticsOperation = startOperation<
  z.input<typeof schemas.projectDashboardFiltersSchema>,
  z.output<typeof schemas.projectPortfolioAnalyticsOut>
>({
  operation: "project.portfolioAnalytics",
  transport: (data, o) => analyticsTransport({ data, ...o }),
  parse: (result) => schemas.projectPortfolioAnalyticsOut.parse(result),
});
const optionsOperation = startOperation<
  undefined,
  z.output<typeof schemas.projectOptionsOut>[]
>({
  operation: "project.options",
  transport: (_data, o) => optionsTransport(o),
  parse: (result) => z.array(schemas.projectOptionsOut).parse(result),
});
const createFromTasksOperation = startOperation<
  z.input<typeof schemas.createProjectFromTasksInput>,
  z.output<typeof schemas.createProjectFromTasksOut>
>({
  operation: "project.createFromTasks",
  kind: "mutation",
  transport: (data, o) => createFromTasksTransport({ data, ...o }),
  parse: (result) => schemas.createProjectFromTasksOut.parse(result),
});
const resourcesOperation = startOperation<
  z.input<typeof schemas.projectResourceProjectInput>,
  z.output<typeof schemas.projectResourcesOut>
>({
  operation: "project.resources",
  transport: (data, o) => resourcesTransport({ data, ...o }),
  parse: (result) => schemas.projectResourcesOut.parse(result),
});
const suggestionsOperation = startOperation<
  z.input<typeof schemas.projectResourceProjectInput>,
  z.output<typeof schemas.projectToolSuggestionsOut>
>({
  operation: "project.toolSuggestions",
  transport: (data, o) => suggestionsTransport({ data, ...o }),
  parse: (result) => schemas.projectToolSuggestionsOut.parse(result),
});
const attachOperation = startOperation<
  z.input<typeof schemas.projectResourceMutationInput>,
  z.output<typeof schemas.projectResourceMutationOut>
>({
  operation: "project.attachResources",
  kind: "mutation",
  transport: (data, o) => attachTransport({ data, ...o }),
  parse: (result) => schemas.projectResourceMutationOut.parse(result),
});
const detachOperation = startOperation<
  z.input<typeof schemas.projectResourceMutationInput>,
  z.output<typeof schemas.projectResourceMutationOut>
>({
  operation: "project.detachResources",
  kind: "mutation",
  transport: (data, o) => detachTransport({ data, ...o }),
  parse: (result) => schemas.projectResourceMutationOut.parse(result),
});
const matrixOperation = startOperation<
  z.input<typeof schemas.projectToolMatrixInput>,
  z.output<typeof schemas.projectToolMatrixOut>
>({
  operation: "project.toolMatrix",
  transport: (data, o) => matrixTransport({ data, ...o }),
  parse: (result) => schemas.projectToolMatrixOut.parse(result),
});
const usageOperation = startOperation<
  z.input<typeof schemas.projectToolUsageSetInput>,
  z.output<typeof schemas.projectToolUsageSetOut>
>({
  operation: "project.setToolUsage",
  kind: "mutation",
  transport: (data, o) => usageTransport({ data, ...o }),
  parse: (result) => schemas.projectToolUsageSetOut.parse(result),
});

export const projectDashboardSummaryQueryOptions = (
  input: z.input<typeof schemas.projectDashboardFiltersSchema>,
) =>
  queryOptions({
    queryKey: [[...queryKeys.project.all, "dashboardSummary"], input] as const,
    queryFn: ({ signal }) => summaryOperation.call(input, { signal }),
    meta: summaryOperation.meta,
  });
export const projectTreeQueryOptions = (
  input: z.input<typeof schemas.projectTreeInput>,
) =>
  queryOptions({
    queryKey: [[...queryKeys.project.all, "tree"], input] as const,
    queryFn: ({ signal }) => treeOperation.call(input, { signal }),
    meta: treeOperation.meta,
  });
export const projectPortfolioAnalyticsQueryOptions = (
  input: z.input<typeof schemas.projectDashboardFiltersSchema>,
) =>
  queryOptions({
    queryKey: [
      [...queryKeys.project.all, "portfolioAnalytics"],
      input,
    ] as const,
    queryFn: ({ signal }) => analyticsOperation.call(input, { signal }),
    meta: analyticsOperation.meta,
  });
export const projectOptionsQueryOptions = () =>
  queryOptions({
    queryKey: [[...queryKeys.project.all, "options"]] as const,
    queryFn: ({ signal }) => optionsOperation.call(undefined, { signal }),
    meta: optionsOperation.meta,
  });
export const projectResourcesQueryOptions = (
  input: z.input<typeof schemas.projectResourceProjectInput>,
) =>
  queryOptions({
    queryKey: [[...queryKeys.project.all, "resources"], input] as const,
    queryFn: ({ signal }) => resourcesOperation.call(input, { signal }),
    meta: resourcesOperation.meta,
  });
export const projectToolSuggestionsQueryOptions = (
  input: z.input<typeof schemas.projectResourceProjectInput>,
  options?: { enabled?: boolean },
) =>
  queryOptions({
    queryKey: [[...queryKeys.project.all, "toolSuggestions"], input] as const,
    queryFn: ({ signal }) => suggestionsOperation.call(input, { signal }),
    meta: suggestionsOperation.meta,
    ...options,
  });
export const projectToolMatrixQueryOptions = (
  input: z.input<typeof schemas.projectToolMatrixInput>,
) =>
  queryOptions({
    queryKey: [[...queryKeys.project.all, "toolMatrix"], input] as const,
    queryFn: ({ signal }) => matrixOperation.call(input, { signal }),
    meta: matrixOperation.meta,
  });

type MutationOverrides<I, O> = Omit<
  UseMutationOptions<O, Error, I, unknown>,
  "mutationFn" | "mutationKey"
>;
const mutation = <I, O>(
  operation: StartOperation<I, O>,
  key: string,
  options?: MutationOverrides<I, O>,
) =>
  mutationOptions({
    mutationKey: [...queryKeys.project.all, key],
    mutationFn: async (input: I) => {
      const result = await operation.call(input);
      markFreshReads();
      return result;
    },
    meta: operation.meta,
    ...options,
  });
export const projectCreateFromTasksMutationOptions = (
  options?: MutationOverrides<
    z.input<typeof schemas.createProjectFromTasksInput>,
    z.output<typeof schemas.createProjectFromTasksOut>
  >,
) => mutation(createFromTasksOperation, "createFromTasks", options);
export const projectAttachResourcesMutationOptions = (
  options?: MutationOverrides<
    z.input<typeof schemas.projectResourceMutationInput>,
    z.output<typeof schemas.projectResourceMutationOut>
  >,
) => mutation(attachOperation, "attachResources", options);
export const projectDetachResourcesMutationOptions = (
  options?: MutationOverrides<
    z.input<typeof schemas.projectResourceMutationInput>,
    z.output<typeof schemas.projectResourceMutationOut>
  >,
) => mutation(detachOperation, "detachResources", options);
export const projectSetToolUsageMutationOptions = (
  options?: MutationOverrides<
    z.input<typeof schemas.projectToolUsageSetInput>,
    z.output<typeof schemas.projectToolUsageSetOut>
  >,
) => mutation(usageOperation, "setToolUsage", options);

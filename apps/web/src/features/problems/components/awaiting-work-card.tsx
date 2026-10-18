import type { AwaitingWork } from "@cubby/schemas/maintenance";
import { useQuery } from "@tanstack/react-query";
import pluralize from "pluralize";
import type { ReactNode } from "react";

import { maintenance } from "~/integrations/tanstack-query/generated/catalog.gen";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Row, Stack } from "~/ui/layout";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/ui/primitives/card";
import { Description } from "~/ui/primitives/description";

/** Poll only while something is waiting; a clean card has nothing to watch. */
export const awaitingWorkRefetchInterval = (
  data: AwaitingWork | undefined,
): number | false =>
  data &&
  data.staleRecipeTotals +
    data.unembeddedEntities +
    data.pendingUploads +
    data.staleImageMetadata >
    0
    ? 15_000
    : false;

const LINES: ReadonlyArray<{
  key: keyof Omit<AwaitingWork, "computedAt">;
  noun: string;
  detail: string;
}> = [
  {
    key: "staleRecipeTotals",
    noun: "recipe",
    detail: "awaiting cost / nutrition totals",
  },
  {
    key: "unembeddedEntities",
    noun: "record",
    detail: "awaiting a search embedding",
  },
  {
    key: "pendingUploads",
    noun: "upload",
    detail: "abandoned more than a day ago",
  },
  {
    key: "staleImageMetadata",
    noun: "image",
    detail: "awaiting embedded EXIF/GPS extraction",
  },
];

/** Live diagnostics for work that app-open recovery and daily maintenance repair. */
export interface AwaitingWorkOperations {
  awaitingWork: typeof maintenance.awaitingWork.queryOptions;
}

const defaultOperations: AwaitingWorkOperations = {
  awaitingWork: maintenance.awaitingWork.queryOptions,
};

export function AwaitingWorkCard({
  operations = defaultOperations,
}: {
  operations?: AwaitingWorkOperations;
}) {
  const awaiting = useQuery({
    ...operations.awaitingWork(),
    refetchInterval: (query) => awaitingWorkRefetchInterval(query.state.data),
  });
  const data = awaiting.data;
  const total = data
    ? data.staleRecipeTotals +
      data.unembeddedEntities +
      data.pendingUploads +
      data.staleImageMetadata
    : undefined;

  let body: ReactNode;
  if (awaiting.isError) {
    body = (
      <ErrorDisplay
        error={awaiting.error}
        title="the waiting counts"
        onRetry={() => void awaiting.refetch()}
      />
    );
  } else if (!data) {
    body = <Description size="xs">Checking…</Description>;
  } else if (total === 0) {
    body = <Description size="xs">Nothing waiting.</Description>;
  } else {
    body = (
      <Stack gap="tight">
        {LINES.filter((line) => data[line.key] > 0).map((line) => (
          <span key={line.key} className="text-sm">
            <span className="font-mono tabular-nums">{data[line.key]}</span>{" "}
            {pluralize(line.noun, data[line.key])} {line.detail}
          </span>
        ))}
      </Stack>
    );
  }

  return (
    <Card data-testid="awaiting-work-card">
      <CardHeader>
        <Row align="start" justify="between" gap="md" wrap>
          <Stack gap="xs">
            <CardTitle>Awaiting work</CardTitle>
            <CardDescription>
              Derived data whose background update hasn't landed. Read from the
              records themselves. Recovery runs automatically on app open and
              during daily maintenance.
            </CardDescription>
          </Stack>
        </Row>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

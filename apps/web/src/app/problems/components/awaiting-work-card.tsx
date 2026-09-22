import type { AwaitingWork } from "@cubby/schemas/maintenance";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { ErrorDisplay } from "~/components/feedback/error-display";
import { Row, Stack } from "~/components/layout";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Description } from "~/components/ui/description";
import { maintenance } from "~/lib/maintenance.functions";
import { pluralWord } from "~/lib/pluralize";

import { ProblemActionButton } from "./problem-action-button";

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

/**
 * Derived work that is waiting on a queue message that may never arrive.
 *
 * These counts are read from the source rows themselves — a null totals stamp,
 * a text hash that no vector matches, a PENDING upload — so they are live
 * truth, not a job ledger's opinion. Publication after a commit is best-effort
 * by design; this card is the visible backstop, and "Settle now" republishes
 * exactly what the counts describe. It never waits for completion: the counts
 * shrink as the queue lands, and the nightly assertion reports if they don't.
 */
export interface AwaitingWorkOperations {
  awaitingWork: typeof maintenance.awaitingWork.queryOptions;
  settleAwaitingWork: typeof maintenance.settleAwaitingWork.mutationOptions;
}

const defaultOperations: AwaitingWorkOperations = {
  awaitingWork: maintenance.awaitingWork.queryOptions,
  settleAwaitingWork: maintenance.settleAwaitingWork.mutationOptions,
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
  const settle = useActionMutation({
    mutationFn: operations.settleAwaitingWork,
    success: (result) => {
      const parts = [
        result.publishedRecipeTasks > 0
          ? `${result.publishedRecipeTasks} recipe ${pluralWord("recompute", result.publishedRecipeTasks)}`
          : null,
        result.publishedEmbeddingTasks > 0
          ? `${result.publishedEmbeddingTasks} embedding ${pluralWord("refresh", result.publishedEmbeddingTasks)}`
          : null,
        result.culledUploads > 0
          ? `${result.culledUploads} abandoned ${pluralWord("upload", result.culledUploads)} removed`
          : null,
        result.publishedImageMetadataTasks > 0
          ? `${result.publishedImageMetadataTasks} image metadata ${pluralWord("extraction", result.publishedImageMetadataTasks)}`
          : null,
      ].filter((part): part is string => part !== null);
      if (parts.length === 0) return "Nothing was waiting.";
      return result.transport === "inline"
        ? `Ran ${parts.join(", ")} inline.`
        : `Published ${parts.join(", ")}; they run in the background.`;
    },
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
            {pluralWord(line.noun, data[line.key])} {line.detail}
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
              records themselves, so this is the truth right now.
            </CardDescription>
          </Stack>
          <ProblemActionButton
            onClick={() => settle.mutate(undefined)}
            isPending={settle.isPending}
            idleLabel="Settle now"
            pendingLabel="Publishing…"
          />
        </Row>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

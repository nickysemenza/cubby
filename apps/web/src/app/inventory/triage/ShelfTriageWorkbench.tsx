/**
 * Walk the products that are bought but held nowhere, deciding each in one
 * pass: discard, stock at a location, or park in Unknown.
 *
 * The queue is the `unlocated` saved view — the same predicate the list shows,
 * read once as a snapshot and frozen for the pass (handling a product removes
 * it from the view, and letting that renumber the queue mid-pass is the bug
 * `useQueuePass` exists to prevent). An import run narrows it to the products
 * bought on that run's purchases. Every choice is an immediate, explicit write;
 * the pass only remembers where you were.
 */
import type {
  PurchaseShortcode,
  RunShortcode,
} from "@cubby/schemas/identifiers";
import { purchaseShortcode } from "@cubby/schemas/identifiers";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { ListChecksIcon } from "@phosphor-icons/react/dist/csr/ListChecks";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { z } from "zod";

import {
  QueuePassProgress,
  QueuePassResumePrompt,
} from "~/app/_components/queue-pass/QueuePassProgress";
import {
  type QueuePassPersistence,
  useQueuePass,
} from "~/app/_components/queue-pass/useQueuePass";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button, buttonVariants } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Description } from "~/components/ui/description";
import {
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyTitle,
} from "~/components/ui/empty";
import { Spinner } from "~/components/ui/spinner";
import { run as runOperations } from "~/integrations/tanstack-query/generated/catalog.gen";
import { getErrorMessage } from "~/lib/error-utils";
import { cn } from "~/lib/utils";

import { runHref } from "../../purchases/purchase-import-links";
import { useProductViewSnapshot } from "../worklist/useProductViewSnapshot";
import type { TriageProduct } from "./triage-types";
import { TriageStopCard } from "./TriageStopCard";

const TRIAGE_PERSISTENCE: QueuePassPersistence<undefined> = {
  storageKey: (scopeKey) => `cubby:shelf-triage:${scopeKey}`,
  version: 1,
  extraSchema: z.undefined(),
};

/** The saved view this pass works through. */
const TRIAGE_VIEW_ID = "unlocated";

export function ShelfTriageWorkbench({ run }: { run?: RunShortcode }) {
  return run ? (
    <RunScopedTriage run={run} />
  ) : (
    <TriagePass scopeKey="unlocated" purchaseIds={undefined} />
  );
}

/**
 * Narrows the pass to one import run: the products bought on the purchases the
 * run touched. A run that touched none (a photo import, say) yields an empty
 * queue, never the unfiltered one — see `useProductViewSnapshot`.
 */
function RunScopedTriage({ run }: { run: RunShortcode }) {
  const runQuery = useQuery(runOperations.work.queryOptions({ runId: run }));
  const purchaseIds = useMemo(
    () =>
      runQuery.data?.affectedPurchases.flatMap(({ shortcode }) => {
        const parsed = purchaseShortcode.safeParse(shortcode);
        return parsed.success ? [parsed.data] : [];
      }),
    [runQuery.data],
  );

  if (runQuery.isError) {
    return (
      <TriageLoadError
        title="Couldn't load that import run"
        error={runQuery.error}
        onRetry={() => void runQuery.refetch()}
      />
    );
  }
  if (!purchaseIds) return <TriageSpinner />;
  return (
    <TriagePass scopeKey={`run:${run}`} purchaseIds={purchaseIds} run={run} />
  );
}

function TriagePass({
  scopeKey,
  purchaseIds,
  run,
}: {
  scopeKey: string;
  purchaseIds: readonly PurchaseShortcode[] | undefined;
  run?: RunShortcode;
}) {
  const snapshot = useProductViewSnapshot({
    viewId: TRIAGE_VIEW_ID,
    purchaseIds,
  });
  const rows = snapshot.data;

  const stopsById = useMemo(
    () => new Map((rows ?? []).map((row) => [row.id, row] as const)),
    [rows],
  );
  const candidateIds = useMemo(() => (rows ?? []).map((row) => row.id), [rows]);

  const pass = useQueuePass<TriageProduct>({
    // Held back until the snapshot lands so no frame keys a pass to an empty
    // queue.
    scopeKey: rows ? scopeKey : null,
    candidateIds,
    stopsById,
    persistence: TRIAGE_PERSISTENCE,
  });

  if (snapshot.isError) {
    return (
      <TriageLoadError
        title="Couldn't load the products awaiting a shelf"
        error={snapshot.error}
        onRetry={() => void snapshot.refetch()}
      />
    );
  }
  if (!rows) return <TriageSpinner />;

  if (rows.length === 0) {
    return (
      <Empty className="min-h-80">
        <EmptyTitle>Nothing is waiting on a shelf</EmptyTitle>
        <EmptyDescription>
          {run
            ? "That run's purchases have no product bought, never sold, and held nowhere."
            : "Every product the ledger says you own is on a shelf, a bin, or inside a kit — or already reviewed."}
        </EmptyDescription>
        <EmptyActions>
          <Link
            to="/products"
            className={buttonVariants({ variant: "outline" })}
          >
            Back to products
          </Link>
        </EmptyActions>
      </Empty>
    );
  }

  if (pass.resumeCandidate) {
    return (
      <QueuePassResumePrompt
        candidate={pass.resumeCandidate}
        title="Resume shelf triage?"
        itemNoun="products"
        resumeLabel="Resume triage"
        startOverLabel="Start new triage"
        onResume={pass.resumePass}
        onStartNew={pass.startNewPass}
      />
    );
  }

  if (pass.startedAt === null) return <TriageSpinner />;

  const heading = run ? (
    <Description size="xs">
      From import run{" "}
      <a
        className="font-medium text-primary hover:underline"
        href={runHref(run)}
      >
        {run}
      </a>
    </Description>
  ) : null;

  if (pass.complete) {
    return (
      <Card className="mx-auto w-full max-w-2xl">
        <CardHeader>
          <Row align="center" gap="sm">
            <CheckCircleIcon className="size-6 text-positive" />
            <h2>
              <CardTitle>Shelf triage complete</CardTitle>
            </h2>
          </Row>
        </CardHeader>
        <CardContent>
          <Stack gap="md">
            <p className="text-sm">
              {pass.counts.completed} handled
              {pass.counts.skipped > 0
                ? ` · ${pass.counts.skipped} skipped`
                : ""}
            </p>
            <Row gap="sm" wrap>
              {pass.counts.skipped > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-12"
                  onClick={pass.revisitSkipped}
                >
                  <ListChecksIcon />
                  Revisit {pass.counts.skipped} skipped
                </Button>
              )}
              <Link
                to="/products"
                className={buttonVariants({
                  variant: "outline",
                  className: "min-h-12",
                })}
              >
                Back to products
              </Link>
            </Row>
          </Stack>
        </CardContent>
      </Card>
    );
  }

  const current = pass.current;
  return (
    <Stack gap="md" className="min-w-0">
      {heading}
      <QueuePassProgress counts={pass.counts} noun="handled" />
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        {current && (
          <TriageStopCard
            key={current.id}
            product={current}
            index={pass.currentIndex}
            total={pass.stops.length}
            onSettled={() => pass.settle(current.id, "completed")}
            onSkip={() => pass.settle(current.id, "skipped")}
          />
        )}
        <Card className="overflow-hidden">
          <CardHeader className="border-b p-4">
            <CardTitle>Queue</CardTitle>
          </CardHeader>
          <CardContent className="max-h-[60dvh] overflow-auto p-0">
            {pass.stops.map((stop) => {
              const settled = pass.settled.has(stop.id);
              return (
                <button
                  key={stop.id}
                  type="button"
                  disabled={settled}
                  onClick={() => pass.jumpToId(stop.id)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-2 text-left text-sm transition-colors last:border-b-0 hover:bg-muted disabled:opacity-60",
                    current?.id === stop.id && "bg-primary/5",
                  )}
                >
                  <span className="min-w-0 truncate">{stop.name}</span>
                  {pass.progress.skipped.has(stop.id) ? (
                    <Badge variant="slate">skipped</Badge>
                  ) : settled ? (
                    <Badge variant="secondary">done</Badge>
                  ) : null}
                </button>
              );
            })}
          </CardContent>
        </Card>
      </div>
    </Stack>
  );
}

function TriageSpinner() {
  return (
    <Row align="center" justify="center" className="min-h-80">
      <Spinner />
    </Row>
  );
}

function TriageLoadError({
  title,
  error,
  onRetry,
}: {
  title: string;
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <Empty role="alert" className="min-h-80">
      <EmptyTitle>{title}</EmptyTitle>
      <EmptyDescription>{getErrorMessage(error)}</EmptyDescription>
      <EmptyActions>
        <Button
          type="button"
          variant="outline"
          className="min-h-12 md:min-h-10"
          onClick={onRetry}
        >
          Retry
        </Button>
      </EmptyActions>
    </Empty>
  );
}

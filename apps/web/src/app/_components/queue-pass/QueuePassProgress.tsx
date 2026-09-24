import { ArrowCounterClockwiseIcon as RotateCcw } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { formatDistanceToNow } from "date-fns";
import type { ReactNode } from "react";

import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Description } from "~/components/ui/description";
import { Progress } from "~/components/ui/progress";
import { cn } from "~/lib/utils";

import type { PassCounts } from "./queue-pass";
import type { QueuePassResumeCandidate } from "./useQueuePass";

/**
 * The pass header: how far through the queue you are, plus a bar.
 *
 * Three flows had grown three unrelated versions of this line, each phrasing
 * and counting it differently. `counts` comes from `passCounts`, which measures
 * against the frozen queue rather than the progress sets, so the numbers cannot
 * exceed the total.
 */
export function QueuePassProgress({
  counts,
  noun = "done",
  trailing,
}: {
  counts: PassCounts;
  /** Past-tense label for the completed tally, e.g. "photographed". */
  noun?: string;
  /** Optional right-aligned affordance, e.g. a "Change scope" link. */
  trailing?: ReactNode;
}) {
  return (
    <Card>
      <CardContent className="px-4 py-2">
        <Stack gap="xs">
          <Row align="center" justify="between" gap="sm">
            <Description>
              {counts.completed} {noun}
              {counts.skipped > 0 && `, ${counts.skipped} skipped`} of{" "}
              {counts.total}
            </Description>
            {trailing}
          </Row>
          <Progress value={counts.settled} max={Math.max(counts.total, 1)} />
        </Stack>
      </CardContent>
    </Card>
  );
}

/**
 * The inline "3 of 12" a card shows in its own corner, for flows that render
 * one stop at a time without a bar.
 */
export function QueuePassPosition({
  index,
  total,
  className,
}: {
  /** Zero-based cursor; displayed one-based. */
  index: number;
  total: number;
  className?: string;
}) {
  return (
    <div className={cn("text-right text-xs text-muted-foreground", className)}>
      {index + 1} of {total}
    </div>
  );
}

/**
 * Resume-or-restart choice for a scope that already has stored progress.
 *
 * Shown instead of the working screen, never alongside it: the hook suppresses
 * its own persistence while this is pending, so offering the choice cannot
 * overwrite the blob being offered.
 */
export function QueuePassResumePrompt<TExtra>({
  candidate,
  title,
  itemNoun,
  detail,
  resumeLabel = "Resume",
  startOverLabel = "Start over",
  onResume,
  onStartNew,
}: {
  candidate: QueuePassResumeCandidate<TExtra>;
  title: string;
  /** Plural noun for the tally, e.g. "locations". */
  itemNoun: string;
  /** Extra sentence about what else is staged, if the flow stages anything. */
  detail?: ReactNode;
  resumeLabel?: string;
  startOverLabel?: string;
  onResume: () => void;
  onStartNew: () => void;
}) {
  return (
    <Card className="mx-auto w-full max-w-xl">
      <CardContent className="p-4">
        <Stack gap="md">
          <div className="text-base font-medium">{title}</div>
          <Description>
            Started{" "}
            {formatDistanceToNow(candidate.startedAt, { addSuffix: true })}. You
            finished {candidate.completedCount} of {candidate.totalCount}{" "}
            {itemNoun}
            {candidate.skippedCount > 0
              ? ` (${candidate.skippedCount} skipped)`
              : ""}
            . {detail}
          </Description>
          <Row gap="sm" wrap>
            <Button type="button" className="min-h-12" onClick={onResume}>
              {resumeLabel}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-12"
              onClick={onStartNew}
            >
              <RotateCcw />
              {startOverLabel}
            </Button>
          </Row>
        </Stack>
      </CardContent>
    </Card>
  );
}

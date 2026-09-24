import type { Progress } from "@cubby/recipebridge";
import { ProhibitIcon } from "@phosphor-icons/react/dist/csr/Prohibit";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";

import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { Spinner } from "~/components/ui/spinner";

import { formatDuration, formatMinuteRange, formatUsd } from "./import-helpers";
import type { Book } from "./types";

/** The one-line status that sits in the book card's header. */
export function ExtractStatusLine({
  book,
  recipeCount,
}: {
  book: Book;
  recipeCount: number;
}) {
  const phase = book.extract;
  if (phase.status === "opening") {
    return (
      <Row
        as="span"
        align="center"
        gap="xs"
        className="text-xs text-muted-foreground"
      >
        <Spinner className="size-3" /> Opening…
      </Row>
    );
  }
  if (phase.status === "opened") {
    const outline = book.outline;
    return (
      <Description as="span" size="xs">
        {outline
          ? `${outline.chapters} chapter${outline.chapters === 1 ? "" : "s"} · ${outline.navRecipeTitles} recipe${outline.navRecipeTitles === 1 ? "" : "s"} in contents`
          : "Ready to extract"}
      </Description>
    );
  }
  if (phase.status === "extracting") {
    const progress = phase.progress;
    return (
      <Row
        as="span"
        align="center"
        gap="xs"
        className="text-xs text-muted-foreground"
      >
        <Spinner className="size-3" />
        {progress
          ? `${progress.phase} ${progress.done}/${progress.total}`
          : "Starting…"}
      </Row>
    );
  }
  if (phase.status === "error") {
    return (
      <Row
        as="span"
        align="center"
        gap="xs"
        className="text-xs text-destructive"
      >
        <WarningCircleIcon className="size-3" /> {phase.message}
      </Row>
    );
  }
  return (
    <Description as="span" size="xs">
      {recipeCount} recipe{recipeCount === 1 ? "" : "s"}
    </Description>
  );
}

/**
 * The live counters, shown while a run is in flight.
 *
 * Everything here comes from one `Progress` the crate emits after each settled
 * chunk; nothing is derived or smoothed. `failed` and `cached` are on screen
 * alongside `done` on purpose — a run that is "finishing fast" because half its
 * chunks failed should not look the same as one that is genuinely quick.
 */
export function ExtractProgressPanel({
  progress,
  onCancel,
}: {
  progress: Progress | null;
  onCancel: () => void;
}) {
  return (
    <Stack gap="xs" className="border border-border bg-muted/30 p-3">
      <Row align="center" justify="between" gap="sm" wrap>
        <Row as="span" align="center" gap="xs" className="text-sm">
          <Spinner className="size-3" />
          <span className="font-medium">
            {progress ? `${progress.done} / ${progress.total}` : "Starting…"}
          </span>
          {progress && (
            <Description as="span" size="xs">
              {progress.phase}
            </Description>
          )}
        </Row>
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          <ProhibitIcon className="mr-1 size-3" />
          Cancel
        </Button>
      </Row>
      {progress && (
        <>
          <Description size="xs">
            {progress.in_flight} in flight · {progress.failed} failed ·{" "}
            {progress.cached} cached · {progress.recipes_so_far} recipe
            {progress.recipes_so_far === 1 ? "" : "s"} ·{" "}
            {formatUsd(progress.cost_so_far_usd)} spent ·{" "}
            {formatDuration(progress.elapsed_ms)} elapsed
          </Description>
          <Description size="xs">
            {formatMinuteRange(
              progress.eta.remaining_low_ms,
              progress.eta.remaining_high_ms,
            )}{" "}
            left · projected {formatUsd(progress.eta.projected_cost_usd)}
            {progress.active_models.length > 0 &&
              ` · ${progress.active_models.join(", ")}`}
          </Description>
        </>
      )}
    </Stack>
  );
}

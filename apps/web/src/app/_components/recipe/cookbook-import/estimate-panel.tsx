import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";

import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";

import { formatCount, formatMinuteRange, formatUsd } from "./import-helpers";
import type { BookEstimate } from "./types";

/**
 * What one extraction will cost, shown BEFORE the first model call.
 *
 * Opening an EPUB and estimating it are free; extracting it spends real money
 * and several minutes. So a book rests here with its numbers on screen and
 * nothing starts until Extract is clicked — the estimate exists to be read,
 * not to scroll past while a run is already under way.
 */
export function EstimatePanel({
  estimate,
  onExtract,
  disabled,
}: {
  estimate: BookEstimate;
  onExtract: () => void;
  disabled?: boolean;
}) {
  return (
    <Stack gap="sm" className="border border-border bg-muted/30 p-3">
      <Row align="center" justify="between" gap="sm" wrap>
        <Row as="span" wrap align="baseline" gap="sm">
          <span className="font-medium">
            {formatUsd(estimate.costLow)}–{formatUsd(estimate.costHigh)}
          </span>
          <Description as="span" size="xs">
            {formatMinuteRange(estimate.wallMsLow, estimate.wallMsHigh)} ·{" "}
            {estimate.chunks} chunk{estimate.chunks === 1 ? "" : "s"} ·{" "}
            {formatCount(estimate.lines)} lines ·{" "}
            {formatCount(estimate.inputTokens)} in /{" "}
            {formatCount(estimate.outputTokens)} out tokens
          </Description>
        </Row>
        <Button type="button" size="sm" onClick={onExtract} disabled={disabled}>
          <SparkleIcon className="mr-1 size-4" />
          Extract
        </Button>
      </Row>
      <Description size="xs">
        {estimate.ladder.length > 0
          ? `Models: ${estimate.ladder.join(" → ")}`
          : "Models: catalog default"}
        {` · ${estimate.concurrency} chunks in flight`}
      </Description>
      {estimate.assumptions.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-2xs text-muted-foreground">
          {estimate.assumptions.map((assumption) => (
            <li key={assumption}>{assumption}</li>
          ))}
        </ul>
      )}
    </Stack>
  );
}

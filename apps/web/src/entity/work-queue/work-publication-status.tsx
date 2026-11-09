import type { WorkQueueOut } from "@cubby/schemas/work-queue";

import { formatRelative, formatTimestamp } from "~/lib/date-format";
import { useDisplayNow } from "~/ui/hooks/use-display-now";
import {
  DisclosureBody,
  DisclosureRoot,
  DisclosureTrigger,
} from "~/ui/layout/disclosure";
import { Button } from "~/ui/primitives/button";
import {
  CodeBlock,
  CodeBlockContent,
  CodeBlockHeader,
} from "~/ui/text/code-block";

type Publication = WorkQueueOut["meta"]["publication"];

/** Published rows older than this say when they were last updated. */
const QUIET_FOR_MS = 10 * 60_000;

/**
 * The published Needs you read is behind: its latest republish failed, or its
 * rows are older than ten minutes. Unknown before hydration, so the server
 * render and the first client render agree.
 */
export function useWorkPublicationBehind(publication: Publication) {
  const now = useDisplayNow();
  if (!publication || now === undefined) return null;
  return publication.error ||
    now - Date.parse(publication.publishedAt) > QUIET_FOR_MS
    ? { ...publication, now }
    : null;
}

/**
 * Home and Work keep serving the last published rows while republishing fails;
 * this one quiet line says when they were read and exposes the raw failure.
 */
export function WorkPublicationStatus({
  subject = "Needs you",
  publication,
  onRetry,
}: {
  /** The read the line names: Needs you, or the full Work queue. */
  subject?: string;
  publication: Publication;
  onRetry: () => void;
}) {
  const behind = useWorkPublicationBehind(publication);
  if (!behind) return null;
  return (
    <DisclosureRoot
      state={{}}
      className="flex min-w-0 flex-wrap items-center gap-x-1.5 py-1 text-xs text-muted-foreground"
    >
      <span>
        {subject} last updated{" "}
        <time
          dateTime={behind.publishedAt}
          title={formatTimestamp(behind.publishedAt, behind.now)}
        >
          {formatRelative(behind.publishedAt, behind.now)}
        </time>
        {behind.error ? "; the latest update failed" : null}
      </span>
      {/* Each separator travels with its item, so a wrap never strands one. */}
      {behind.error ? (
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden>·</span>
          <DisclosureTrigger>Technical details</DisclosureTrigger>
        </span>
      ) : null}
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden>·</span>
        <Button
          variant="link"
          size="xs"
          className="h-auto px-0 text-xs"
          onClick={onRetry}
        >
          Retry
        </Button>
      </span>
      {behind.error ? (
        <DisclosureBody className="basis-full pt-1">
          <CodeBlock>
            <CodeBlockHeader label="Publication error" value={behind.error} />
            <CodeBlockContent className="max-h-60 overflow-y-auto">
              {behind.error}
            </CodeBlockContent>
          </CodeBlock>
        </DisclosureBody>
      ) : null}
    </DisclosureRoot>
  );
}

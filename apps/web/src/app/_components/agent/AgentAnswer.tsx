import type { AgentResult, AgentSource } from "@cubby/schemas/agent";
import type { ReactNode } from "react";
import { Row } from "~/components/layout";
import { MarkdownText } from "~/components/markdown";
import { IconTile } from "~/components/ui/icon-tile";
import { Spinner } from "~/components/ui/spinner";
import { EntityIcon } from "~/entities/entities";
import { entityTypeMap } from "../search/search-utils";

/** Turn a tool name like "list_inventory" into "inventory" for status text. */
function humanizeTool(tool: string): string {
  return tool.replace(/^(list|get|search|find)_/, "").replace(/_/g, " ");
}

/**
 * Media + label for one cited source — the inner content of a source row.
 * Callers wrap this in whatever click target their chrome wants (a cmdk
 * `CommandItem` in the palette, a plain `<button>` on the /ask page).
 */
export function AgentSourceContent({ source }: { source: AgentSource }) {
  return (
    <>
      <IconTile size="md" className="rounded bg-muted/50">
        <EntityIcon
          entity={entityTypeMap[source.entityType]}
          colored
          className="h-4 w-4 shrink-0"
        />
      </IconTile>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{source.name}</div>
        {source.detail && (
          <div className="truncate text-muted-foreground text-xs">
            {source.detail}
          </div>
        )}
      </div>
    </>
  );
}

interface AgentAnswerProps {
  /** Live answer text (streams in). */
  answer: string;
  /** Name of the tool currently running, if any (for the "looking up…" hint). */
  toolStatus: string | null;
  isStreaming: boolean;
  sources: AgentResult["sources"];
  /**
   * Wraps the "Sources" section — the palette passes a `CommandGroup`, the /ask
   * page a titled block. Receives the source rows as children.
   */
  sourcesWrapper: (children: ReactNode) => ReactNode;
  /**
   * Wraps one source's content in a click target. The palette returns a
   * `CommandItem` (cmdk keyboard nav), /ask a plain `<button>`. `key` must be
   * applied to the returned element.
   */
  renderSource: (source: AgentSource) => ReactNode;
  /** Wraps the streamed answer markdown (palette: `CommandGroup`; /ask: `Card`). */
  answerWrapper: (children: ReactNode) => ReactNode;
  /**
   * The tool-call telemetry log, rendered once the run completes. Each surface
   * owns its own chrome (palette: a compact `CommandGroup` list; /ask: a
   * `<details>` disclosure with args) and its own devtools/visibility gating,
   * so this is a plain slot rather than shared markup.
   */
  toolCalls?: ReactNode;
}

/**
 * Shared, chrome-agnostic body for the streamed "Ask Cubby" answer: a
 * "looking up…" status while tools run, the answer text as it streams, then
 * cited sources + an optional tool-call log on completion. Both the command
 * palette and the /ask page render this over their own chrome — the wrapper
 * render props let each keep its native semantics (cmdk vs plain DOM).
 */
export function AgentAnswer({
  answer,
  toolStatus,
  isStreaming,
  sources,
  sourcesWrapper,
  renderSource,
  answerWrapper,
  toolCalls,
}: AgentAnswerProps) {
  return (
    <>
      {/* Status line while the agent is working and no text is showing yet */}
      {isStreaming && answer.length === 0 && (
        <Row
          align="center"
          justify="center"
          gap="sm"
          className="py-6 text-muted-foreground text-sm"
        >
          <Spinner />
          {toolStatus ? `Looking up ${humanizeTool(toolStatus)}…` : "Thinking…"}
        </Row>
      )}

      {/* Answer text — rendered live as deltas stream in */}
      {answer.length > 0 &&
        answerWrapper(
          <MarkdownText className="px-2 py-2 text-sm leading-relaxed">
            {answer}
          </MarkdownText>,
        )}

      {/* Sources appear once the run completes */}
      {!isStreaming &&
        sources.length > 0 &&
        sourcesWrapper(sources.map((source) => renderSource(source)))}

      {/* Tool-call telemetry — each surface supplies its own chrome */}
      {!isStreaming && toolCalls}
    </>
  );
}

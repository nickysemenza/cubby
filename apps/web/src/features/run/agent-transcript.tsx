import type {
  AgentConversationMessage,
  AgentConversationPart,
  AgentConversationSettlement,
} from "@cubby/schemas/agent-conversation";
import { contextBreakdownSchema } from "@cubby/schemas/context-breakdown";
import { humanize } from "@cubby/shared";
import { ArrowDownIcon } from "@phosphor-icons/react/dist/csr/ArrowDown";
import { ArrowsInLineVerticalIcon } from "@phosphor-icons/react/dist/csr/ArrowsInLineVertical";
import { BellIcon } from "@phosphor-icons/react/dist/csr/Bell";
import { BrainIcon } from "@phosphor-icons/react/dist/csr/Brain";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { FlagIcon } from "@phosphor-icons/react/dist/csr/Flag";
import { PaperclipIcon } from "@phosphor-icons/react/dist/csr/Paperclip";
import { UserIcon } from "@phosphor-icons/react/dist/csr/User";
import { WrenchIcon } from "@phosphor-icons/react/dist/csr/Wrench";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { Fragment, useLayoutEffect, useRef, useState } from "react";

import { MarkdownText } from "~/entity/prose/markdown";
import { displayToolAction } from "~/features/purchase/agent-tool-names";
import { formatCompactCount, formatCount } from "~/lib/number-format";
import { Button } from "~/ui/primitives/button";
import { Spinner } from "~/ui/primitives/spinner";
import { StatusText } from "~/ui/primitives/status-text";
import {
  CodeBlock,
  CodeBlockContent,
  CodeBlockHeader,
} from "~/ui/text/code-block";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "~/ui/text/trace";

import {
  formatToolValue,
  toolRenderer,
  toolSummary,
  type ToolCall,
} from "./agent-tool-renderers";

type ToolPart = Extract<AgentConversationPart, { type: "tool" }>;

/** Within this many pixels of the end, new rows keep the pane pinned. */
const BOTTOM_SLACK_PX = 24;

/**
 * The run agent's conversation as one dense log: assistant prose, one line
 * per tool call (expandable to its payloads), wake signals and settlements.
 * `live` pins the pane to the newest row until the member scrolls away.
 */
export function AgentTranscript({
  messages,
  settlements,
  live,
}: {
  messages: readonly AgentConversationMessage[];
  settlements: readonly AgentConversationSettlement[];
  live: boolean;
}) {
  const paneRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const lastMessage = messages.at(-1);
  // The whole snapshot is replaced on every stream frame; the newest message
  // is where rows grow, so its parts and their states are what move the tail.
  const tailKey = `${messages.length}:${lastMessage?.parts.length ?? 0}:${
    lastMessage?.parts
      .map((part) => (part.type === "tool" ? part.state : ""))
      .join() ?? ""
  }`;
  useLayoutEffect(() => {
    const pane = paneRef.current;
    if (!pane || !live || !pinned) return;
    pane.scrollTop = pane.scrollHeight;
  }, [tailKey, live, pinned]);

  if (messages.length === 0 && settlements.length === 0)
    return <StatusText>No agent messages have been recorded yet.</StatusText>;

  const placed = placeSettlements(messages, settlements);
  return (
    <div className="relative">
      <div
        ref={paneRef}
        className="max-h-[70vh] overflow-auto border-y border-border py-1"
        aria-label="Agent conversation transcript"
        onScroll={(event) => {
          const pane = event.currentTarget;
          setPinned(
            pane.scrollHeight - pane.scrollTop - pane.clientHeight <=
              BOTTOM_SLACK_PX,
          );
        }}
      >
        {messages.map((message) => (
          <TranscriptMessage
            key={message.id}
            message={message}
            live={live}
            settlementsAfter={placed.afterTool}
          />
        ))}
        {placed.trailing.length ? (
          <Trace className="py-1">
            {placed.trailing.map((settlement) => (
              <SettlementLine
                key={settlement.operationId}
                settlement={settlement}
              />
            ))}
          </Trace>
        ) : null}
      </div>
      {live && !pinned ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="absolute right-3 bottom-3"
          onClick={() => {
            const pane = paneRef.current;
            if (pane) pane.scrollTop = pane.scrollHeight;
            setPinned(true);
          }}
        >
          <ArrowDownIcon aria-hidden="true" />
          Jump to latest
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Settlements carry no timestamp, so each one follows the last tool call
 * whose payload names its operation; the rest close the transcript.
 */
function placeSettlements(
  messages: readonly AgentConversationMessage[],
  settlements: readonly AgentConversationSettlement[],
) {
  const afterTool = new Map<string, AgentConversationSettlement[]>();
  const trailing: AgentConversationSettlement[] = [];
  const tools = messages.flatMap((message) =>
    message.parts.flatMap((part) =>
      part.type === "tool"
        ? [
            {
              id: part.toolCallId,
              text: `${JSON.stringify(part.input)}${JSON.stringify(part.output ?? null)}`,
            },
          ]
        : [],
    ),
  );
  for (const settlement of settlements) {
    const tool = tools
      .filter(({ text }) => text.includes(settlement.operationId))
      .at(-1);
    if (!tool) {
      trailing.push(settlement);
      continue;
    }
    afterTool.set(tool.id, [...(afterTool.get(tool.id) ?? []), settlement]);
  }
  return { afterTool, trailing };
}

function TranscriptMessage({
  message,
  live,
  settlementsAfter,
}: {
  message: AgentConversationMessage;
  live: boolean;
  settlementsAfter: ReadonlyMap<string, AgentConversationSettlement[]>;
}) {
  if (message.role === "signal") return <SignalLine message={message} />;
  const member = message.role === "user";
  return (
    <article
      className="grid min-w-0 gap-1 px-2 py-1.5"
      aria-label={`${message.purpose} · ${message.display}`}
    >
      {member ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <UserIcon aria-hidden="true" className="size-3.5" />
          <span className="font-medium text-foreground">{message.purpose}</span>
          <span>{message.display}</span>
        </p>
      ) : null}
      <Trace>
        {message.parts.map((part, index) => {
          if (part.type !== "tool")
            return (
              // A recorded message's parts are positional and append-only.
              // oxlint-disable-next-line react/no-array-index-key
              <MessagePart key={`${message.id}:${index}`} part={part} />
            );
          return (
            <Fragment key={part.toolCallId}>
              <ToolStep part={part} live={live} />
              {settlementsAfter.get(part.toolCallId)?.map((settlement) => (
                <SettlementLine
                  key={settlement.operationId}
                  settlement={settlement}
                />
              ))}
            </Fragment>
          );
        })}
      </Trace>
      {member ? null : <TurnMetadata message={message} />}
    </article>
  );
}

function MessagePart({
  part,
}: {
  part: Exclude<AgentConversationPart, { type: "tool" }>;
}) {
  if (part.type === "text")
    return <MarkdownText className="py-0.5">{part.text}</MarkdownText>;
  if (part.type === "reasoning") {
    const firstLine = part.text.trim().split("\n")[0] ?? "";
    return (
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceIcon>
              <BrainIcon />
            </TraceIcon>
            <TraceTitle className="font-sans italic">
              {firstLine || "Thinking"}
            </TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <p className="text-xs whitespace-pre-wrap text-muted-foreground">
            {part.text}
          </p>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    );
  }
  return (
    <TraceLine>
      <TraceIcon>
        <PaperclipIcon />
      </TraceIcon>
      <TraceTitle>{part.filename ?? "Agent attachment"}</TraceTitle>
      <TraceDescription>{part.mediaType}</TraceDescription>
    </TraceLine>
  );
}

function ToolStep({ part, live }: { part: ToolPart; live: boolean }) {
  const call: ToolCall = {
    name: displayToolAction(part.toolName, part.input),
    input: part.input,
    output: part.output,
  };
  const failed = part.state === "output-error";
  const pending = part.state === "input-available";
  const rendered =
    part.state === "output-available"
      ? (toolRenderer(call.name)?.render?.(call) ?? null)
      : null;
  const summary = toolSummary(call);
  return (
    <TraceCollapsible defaultOpen={failed}>
      <TraceCollapsibleTrigger>
        <TraceLine
          status={
            failed
              ? "error"
              : pending
                ? live
                  ? "running"
                  : "pending"
                : undefined
          }
        >
          <TraceIcon>
            {failed ? (
              <XIcon />
            ) : pending && live ? (
              <Spinner size="sm" aria-label="Running" />
            ) : pending ? (
              <WrenchIcon />
            ) : (
              <CheckIcon className="text-positive" />
            )}
          </TraceIcon>
          <TraceTitle className="shrink-0 font-medium text-foreground">
            {call.name}
          </TraceTitle>
          {summary ? <TraceTitle>{summary}</TraceTitle> : null}
          {part.durationMs !== undefined ? (
            <TraceDescription>
              {formatDuration(part.durationMs)}
            </TraceDescription>
          ) : pending && !live ? (
            <TraceDescription>no result</TraceDescription>
          ) : null}
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        {failed ? (
          <CodeBlock className="border-destructive/30 text-destructive">
            <CodeBlockHeader label="Error" value={part.errorText ?? ""} />
            <CodeBlockContent>
              {part.errorText ?? "No error text"}
            </CodeBlockContent>
          </CodeBlock>
        ) : null}
        {rendered ? (
          <>
            {rendered}
            <TraceCollapsible>
              <TraceCollapsibleTrigger>
                <TraceLine>
                  <TraceTitle>Raw arguments and result</TraceTitle>
                </TraceLine>
              </TraceCollapsibleTrigger>
              <TraceCollapsibleContent>
                <ToolPayloads part={part} />
              </TraceCollapsibleContent>
            </TraceCollapsible>
          </>
        ) : (
          <ToolPayloads part={part} />
        )}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

function ToolPayloads({ part }: { part: ToolPart }) {
  return (
    <>
      <ToolPayload label="Arguments" value={part.input} />
      {part.state === "output-available" ? (
        <ToolPayload label="Result" value={part.output} />
      ) : null}
    </>
  );
}

function ToolPayload({
  label,
  value,
}: {
  label: string;
  value: ToolCall["output"];
}) {
  const text = formatToolValue(value);
  return (
    <CodeBlock>
      <CodeBlockHeader label={label} value={text} />
      <CodeBlockContent>{text}</CodeBlockContent>
    </CodeBlock>
  );
}

function SignalLine({ message }: { message: AgentConversationMessage }) {
  const signal = message.signal;
  const compaction = signal?.type === "compaction";
  const attributes = signal?.attributes
    ? Object.entries(signal.attributes)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ")
    : "";
  return (
    <TraceLine className="px-2 py-1" aria-label={`${message.purpose} signal`}>
      <TraceIcon>
        {compaction ? <ArrowsInLineVerticalIcon /> : <BellIcon />}
      </TraceIcon>
      <TraceTitle>
        {compaction ? "Context compacted" : (signal?.type ?? message.purpose)}
        {attributes ? ` · ${attributes}` : ""}
      </TraceTitle>
      <TraceDescription>{message.display}</TraceDescription>
    </TraceLine>
  );
}

function SettlementLine({
  settlement,
}: {
  settlement: AgentConversationSettlement;
}) {
  return (
    <TraceLine status={settlement.outcome === "done" ? undefined : "error"}>
      <TraceIcon>
        <FlagIcon />
      </TraceIcon>
      <TraceTitle className="shrink-0">
        Settled {settlement.operationId}
      </TraceTitle>
      <TraceDescription>
        {settlement.reason ?? humanize(settlement.outcome)}
      </TraceDescription>
    </TraceLine>
  );
}

function TurnMetadata({ message }: { message: AgentConversationMessage }) {
  const usage = message.metadata?.usage;
  const model = message.metadata?.model;
  const breakdown = contextBreakdownSchema.safeParse(
    message.metadata?.contextBreakdown,
  ).data;
  const context = breakdown?.calls
    .map(({ sections }) =>
      [
        `instructions ${formatCompactCount(sections.instructions, 1)}`,
        `tool schemas ${formatCompactCount(sections.agentToolSchemas + sections.mcpToolSchemas, 1)}`,
        `conversation ${formatCompactCount(sections.conversation, 1)}`,
        `tool results ${formatCompactCount(
          Object.values(sections.toolResults).reduce((sum, n) => sum + n, 0),
          1,
        )}`,
      ].join(" · "),
    )
    .join("\n");
  const facts = [
    message.purpose,
    message.display,
    model,
    usage ? `${formatCompactCount(usage.inputTokens, 1)} in` : null,
    usage ? `${formatCompactCount(usage.outputTokens, 1)} out` : null,
    usage?.cacheReadTokens
      ? `${formatCompactCount(usage.cacheReadTokens, 1)} cached`
      : null,
  ].filter(Boolean);
  return (
    <p
      className="text-xs/4 text-muted-foreground tabular-nums"
      title={context ? `Context: ${context}` : undefined}
    >
      {facts.join(" · ")}
    </p>
  );
}

function formatDuration(ms: number): string {
  return ms < 1_000 ? `${formatCount(ms)}ms` : `${formatCount(ms / 1_000, 1)}s`;
}

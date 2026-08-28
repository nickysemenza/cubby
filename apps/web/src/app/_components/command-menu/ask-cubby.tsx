import type { AgentResult } from "@cubby/schemas/agent";
import type { SearchableEntity } from "@cubby/schemas/search";
import { ArrowLeft } from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";

import { Row, Stack } from "~/components/layout";
import { CommandGroup, CommandItem } from "~/components/ui/command";

import { AgentAnswer, AgentSourceContent } from "../agent/AgentAnswer";
import { useAgentStream } from "../hooks/useAgentStream";

interface AskCubbyPanelProps {
  query: string;
  showToolCalls: boolean;
  onBack: () => void;
  onSelectSource: (
    entityType: SearchableEntity,
    shortcode: string | null,
    name?: string,
  ) => void;
}

/** Loaded only after Ask is selected, keeping streaming and markdown out of ⌘K. */
export function AskCubbyPanel({
  query,
  showToolCalls,
  onBack,
  onSelectSource,
}: AskCubbyPanelProps) {
  const agent = useAgentStream();

  useEffect(() => {
    void agent.ask(query);
    return agent.reset;
  }, [agent.ask, agent.reset, query]);

  useEffect(() => {
    if (agent.error) toast.error(agent.error);
  }, [agent.error]);

  return (
    <>
      <CommandGroup>
        <CommandItem
          value="ask-back"
          onSelect={onBack}
          className="flex items-center gap-2 text-muted-foreground"
        >
          <ArrowLeft className="size-4" />
          <span>Back to search</span>
        </CommandItem>
      </CommandGroup>
      <AgentAnswer
        answer={agent.answer}
        toolStatus={agent.toolStatus}
        isStreaming={agent.isStreaming}
        sources={agent.result?.sources ?? []}
        answerWrapper={(children) => (
          <CommandGroup heading={`Answer · "${query}"`}>
            {children}
          </CommandGroup>
        )}
        sourcesWrapper={(children) => (
          <CommandGroup heading="Sources">{children}</CommandGroup>
        )}
        renderSource={(source) => (
          <CommandItem
            key={`${source.entityType}-${source.id}`}
            value={`source-${source.entityType}-${source.id}`}
            onSelect={() =>
              onSelectSource(source.entityType, source.id, source.name)
            }
            className="flex items-center gap-2"
          >
            <AgentSourceContent source={source} />
          </CommandItem>
        )}
        toolCalls={
          showToolCalls && (agent.result?.toolCalls.length ?? 0) > 0 ? (
            <ToolCalls calls={agent.result?.toolCalls ?? []} />
          ) : undefined
        }
      />
    </>
  );
}

function ToolCalls({ calls }: { calls: AgentResult["toolCalls"] }) {
  return (
    <CommandGroup heading="Tool calls">
      <Stack gap="xs" className="px-2 py-1">
        {calls.map((call, i) => (
          <Row
            // biome-ignore lint/suspicious/noArrayIndexKey: ordered log, no stable id
            key={i}
            align="center"
            gap="sm"
            className="font-mono text-xs text-muted-foreground"
          >
            <span className={call.ok ? "text-primary" : "text-destructive"}>
              {call.ok ? "✓" : "✗"}
            </span>
            <span>{call.tool}</span>
            <span className="ml-auto">{call.durationMs}ms</span>
          </Row>
        ))}
      </Stack>
    </CommandGroup>
  );
}

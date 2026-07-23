import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Search, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AgentAnswer,
  AgentSourceContent,
} from "~/app/_components/agent/AgentAnswer";
import { pushRecent } from "~/app/_components/command-menu/recents";
import { useAgentStream } from "~/app/_components/hooks/useAgentStream";
import { entityTypeMap } from "~/app/_components/search/search-utils";
import { Row, Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { entities } from "~/entities/entities";

export const Route = createFileRoute("/_authenticated/ask")({
  component: AskPage,
  head: () => ({ meta: [{ title: "Ask | cubby" }] }),
});

const EXAMPLE_PROMPTS = [
  "Where's the orange spool of cable?",
  "What can I cook with what I have?",
  "How many cans of tomatoes do I have?",
  "Which locations are empty?",
];

function AskPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");

  const agent = useAgentStream();

  // Surface stream errors as a toast.
  const agentError = agent.error;
  useEffect(() => {
    if (agentError) toast.error(agentError);
  }, [agentError]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = query.trim();
    if (trimmed.length > 0) agent.ask(trimmed);
  };

  const sources = agent.result?.sources ?? [];
  const toolCalls = agent.result?.toolCalls ?? [];
  const hasRun =
    agent.isStreaming || agent.answer.length > 0 || sources.length > 0;

  // Mirror the palette's onSelectSource path so /ask sources also seed recents.
  const goToSource = (source: (typeof sources)[number]) => {
    pushRecent({
      entityType: source.entityType,
      id: source.id,
      name: source.name,
    });
    navigate({
      to: `/${entities[entityTypeMap[source.entityType]].basePath}/${source.id}`,
    });
  };

  return (
    <Page variant="list" compact decoration="none" title="Ask Cubby">
      <Stack>
        <Row as="form" onSubmit={submit} gap="sm">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="where's the orange spool of cable?"
            autoFocus
          />
          <Button
            type="submit"
            disabled={agent.isStreaming || query.trim() === ""}
          >
            {agent.isStreaming ? (
              <>
                <Spinner className="mr-2" />
                Thinking…
              </>
            ) : (
              <>
                <Search className="mr-2 size-4" />
                Ask
              </>
            )}
          </Button>
        </Row>

        {!hasRun && (
          <Stack gap="sm">
            <Row align="center" gap="snug" className="eyebrow px-1">
              <Sparkles className="size-3.5" />
              Try asking
            </Row>
            <div className="grid gap-2">
              {EXAMPLE_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => {
                    setQuery(prompt);
                    agent.ask(prompt);
                  }}
                  className="flex items-center gap-2 rounded-md border border-border/50 px-2 py-2 text-left text-sm transition-colors hover:bg-muted/50 active:bg-muted/70"
                >
                  <Search className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">{prompt}</span>
                </button>
              ))}
            </div>
          </Stack>
        )}

        {hasRun && (
          <Stack>
            <AgentAnswer
              answer={agent.answer}
              toolStatus={agent.toolStatus}
              isStreaming={agent.isStreaming}
              sources={sources}
              answerWrapper={(children) => (
                <Card>
                  <CardContent className="pt-4">{children}</CardContent>
                </Card>
              )}
              sourcesWrapper={(children) => (
                <Stack gap="xs">
                  <h2 className="eyebrow">Sources</h2>
                  <div className="grid gap-1">{children}</div>
                </Stack>
              )}
              renderSource={(source) => (
                <button
                  type="button"
                  key={`${source.entityType}-${source.id}`}
                  onClick={() => goToSource(source)}
                  className="flex items-center gap-2 rounded-md border border-border/50 px-2 py-2 text-left transition-colors hover:bg-muted/50"
                >
                  <AgentSourceContent source={source} />
                </button>
              )}
              toolCalls={
                toolCalls.length > 0 ? (
                  <details className="rounded-md border border-border/50 px-2 py-2">
                    <summary className="eyebrow cursor-pointer">
                      {toolCalls.length} tool call
                      {toolCalls.length === 1 ? "" : "s"}
                    </summary>
                    <Stack gap="xs" className="mt-2">
                      {toolCalls.map((call, i) => (
                        <Row
                          // biome-ignore lint/suspicious/noArrayIndexKey: tool calls are an ordered log with no stable id
                          key={i}
                          align="center"
                          gap="sm"
                          className="font-mono text-xs"
                        >
                          <span
                            className={
                              call.ok ? "text-primary" : "text-destructive"
                            }
                          >
                            {call.ok ? "✓" : "✗"}
                          </span>
                          <span className="font-medium">{call.tool}</span>
                          <span className="truncate text-muted-foreground">
                            {JSON.stringify(call.args)}
                          </span>
                          <span className="ml-auto shrink-0 text-muted-foreground">
                            {call.durationMs}ms
                          </span>
                        </Row>
                      ))}
                    </Stack>
                  </details>
                ) : undefined
              }
            />
          </Stack>
        )}
      </Stack>
    </Page>
  );
}

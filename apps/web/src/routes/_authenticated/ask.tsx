import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { verbDef } from "~/app/_components/actions/action-verbs";
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
import { entityDetailLink, isBrowserRoutedEntity } from "~/entities/entities";
import { focusOnMount } from "~/hooks/focus-on-mount";
import { pageTitle } from "~/lib/page-title";

/**
 * `?q=` is how every other surface hands a question over: the entity action
 * bar's "Ask about this" deep-links here with the record already named, so the
 * page opens mid-question rather than at a blank box the user has to retype
 * the shortcode into.
 */
const askSearchSchema = z.object({ q: z.string().optional() });

export const Route = createFileRoute("/_authenticated/ask")({
  component: AskPage,
  validateSearch: askSearchSchema,
  head: () => ({ meta: [{ title: pageTitle("Ask") }] }),
});

// The registry's Sparkles, not `Search`: asking Cubby is the AI verb, and the
// magnifying glass said "this is the search box" on the one page that is not.
const AskIcon = verbDef("ask").icon;

const EXAMPLE_PROMPTS = [
  "Where's the orange spool of cable?",
  "What can I cook with what I have?",
  "How many cans of tomatoes do I have?",
  "Which locations are empty?",
];

function AskPage() {
  const navigate = useNavigate();
  const { q } = Route.useSearch();
  const [query, setQuery] = useState(q ?? "");

  const agent = useAgentStream();

  // Run a deep-linked question once, and again only if the link changes.
  const askedRef = useRef<string | null>(null);
  const agentAsk = agent.ask;
  useEffect(() => {
    const prefilled = q?.trim();
    if (!prefilled || askedRef.current === prefilled) return;
    askedRef.current = prefilled;
    setQuery(prefilled);
    void agentAsk(prefilled);
  }, [agentAsk, q]);

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
    const entity = entityTypeMap[source.entityType];
    if (!isBrowserRoutedEntity(entity)) return;
    pushRecent({
      entityType: source.entityType,
      id: source.id,
      name: source.name,
    });
    navigate(entityDetailLink(entity, source.id));
  };

  return (
    <Page variant="list" compact decoration="none" title="Ask Cubby">
      <Stack>
        <Row as="form" onSubmit={submit} gap="sm">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="where's the orange spool of cable?"
            ref={focusOnMount}
          />
          {agent.isStreaming ? (
            <>
              <Button
                type="submit"
                disabled
                className="min-h-9 max-sm:min-h-11"
              >
                <Spinner className="mr-2" />
                Thinking…
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-9 max-sm:min-h-11"
                onClick={agent.cancel}
              >
                Cancel
              </Button>
            </>
          ) : (
            <Button
              type="submit"
              disabled={query.trim() === ""}
              className="min-h-9 max-sm:min-h-11"
            >
              <AskIcon className="mr-2 size-4" />
              Ask
            </Button>
          )}
        </Row>

        {!hasRun && (
          <Stack gap="sm">
            <Row align="center" gap="snug" className="px-1 eyebrow">
              <AskIcon className="size-3.5" />
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
                  className="flex items-center gap-2 border border-border/50 px-2 py-2 text-left text-sm transition-colors hover:bg-muted/50 active:bg-muted/70"
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
                  className="flex items-center gap-2 border border-border/50 px-2 py-2 text-left transition-colors hover:bg-muted/50"
                >
                  <AgentSourceContent source={source} />
                </button>
              )}
              toolCalls={
                toolCalls.length > 0 ? (
                  <details className="border border-border/50 px-2 py-2">
                    <summary className="cursor-pointer eyebrow">
                      {toolCalls.length} tool call
                      {toolCalls.length === 1 ? "" : "s"}
                    </summary>
                    <Stack gap="xs" className="mt-2">
                      {toolCalls.map((call, index) => (
                        <Row
                          // oxlint-disable-next-line react/no-array-index-key -- Tool calls are an append-only ordered log with no stable id, and duplicate calls are valid.
                          key={index}
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

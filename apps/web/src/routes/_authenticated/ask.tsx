import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Search, Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { entityTypeMap } from "~/app/_components/search/search-utils";
import { MarkdownText } from "~/components/markdown";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { EntityIcon, entities } from "~/entities/entities";
import { useTRPC } from "~/trpc/react";

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
  const api = useTRPC();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");

  const ask = useMutation(
    api.agent.ask.mutationOptions({
      onError: (error) => toast.error(error.message),
    }),
  );

  const result = ask.data;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = query.trim();
    if (trimmed.length > 0) ask.mutate({ query: trimmed });
  };

  return (
    <Page variant="list" title="Ask Cubby">
      <div className="space-y-4">
        <form onSubmit={submit} className="flex gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="where's the orange spool of cable?"
            autoFocus
          />
          <Button type="submit" disabled={ask.isPending || query.trim() === ""}>
            {ask.isPending ? (
              <>
                <Spinner className="mr-2" />
                Thinking…
              </>
            ) : (
              <>
                <Search className="mr-2 h-4 w-4" />
                Ask
              </>
            )}
          </Button>
        </form>

        {!result && !ask.isPending && (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 px-1 font-medium text-muted-foreground text-xs uppercase tracking-wider">
              <Sparkles className="h-3.5 w-3.5" />
              Try asking
            </div>
            <div className="grid gap-1.5">
              {EXAMPLE_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => {
                    setQuery(prompt);
                    ask.mutate({ query: prompt });
                  }}
                  className="flex items-center gap-2 rounded-md border border-border/50 px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted/50 active:bg-muted/70"
                >
                  <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">{prompt}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {result && (
          <div className="space-y-4">
            {/* Answer */}
            <Card>
              <CardContent className="pt-4">
                <MarkdownText className="text-sm leading-relaxed">
                  {result.answer}
                </MarkdownText>
              </CardContent>
            </Card>

            {/* Sources */}
            {result.sources.length > 0 && (
              <div className="space-y-1">
                <h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
                  Sources
                </h2>
                <div className="grid gap-1">
                  {result.sources.map((source) => (
                    <button
                      type="button"
                      key={`${source.entityType}-${source.id}`}
                      onClick={() =>
                        navigate({
                          to: `/${entities[entityTypeMap[source.entityType]].basePath}/${source.id}`,
                        })
                      }
                      className="flex items-center gap-3 rounded-md border border-border/50 px-3 py-2 text-left transition-colors hover:bg-muted/50"
                    >
                      <EntityIcon
                        entity={entityTypeMap[source.entityType]}
                        colored
                        className="h-4 w-4 shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm">{source.name}</div>
                        {source.detail && (
                          <div className="truncate text-muted-foreground text-xs">
                            {source.detail}
                          </div>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Tool calls (debug) */}
            {result.toolCalls.length > 0 && (
              <details className="rounded-md border border-border/50 px-3 py-2">
                <summary className="cursor-pointer font-medium text-muted-foreground text-xs uppercase tracking-wider">
                  {result.toolCalls.length} tool call
                  {result.toolCalls.length === 1 ? "" : "s"}
                </summary>
                <div className="mt-2 space-y-1">
                  {result.toolCalls.map((call, i) => (
                    <div
                      // biome-ignore lint/suspicious/noArrayIndexKey: tool calls are an ordered log with no stable id
                      key={i}
                      className="flex items-center gap-2 font-mono text-xs"
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
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}
      </div>
    </Page>
  );
}

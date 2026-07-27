import type { LocationType } from "@cubby/schemas/location";
import type { ProjectStatus, TaskStatus } from "@cubby/schemas/project";
import {
  type SearchableEntity,
  type SearchResultItem,
  searchableEntities,
} from "@cubby/schemas/search";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Search, Send } from "lucide-react";
import { useState } from "react";
import { match } from "ts-pattern";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { useTRPC } from "~/integrations/trpc/react";

function SearchResultEntityLink({ item }: { item: SearchResultItem }) {
  return match(item)
    .with({ entityType: "product" }, (i) => (
      <EntityInlineLink
        entity="product"
        data={{
          id: i.id,
          name: i.name,
          manufacturer: i.subtitle ?? undefined,
        }}
        compact
      />
    ))
    .with({ entityType: "location" }, (i) => (
      <EntityInlineLink
        entity="location"
        data={{
          id: i.id,
          name: i.name,
          type: i.typeHint ? (i.typeHint as LocationType) : undefined,
        }}
        compact
      />
    ))
    .with({ entityType: "recipe" }, (i) => (
      <EntityInlineLink
        entity="recipe"
        data={{ id: i.id, name: i.name }}
        compact
      />
    ))
    .with({ entityType: "ingredient" }, (i) => (
      <EntityInlineLink
        entity="ingredient"
        data={{ id: i.id, name: i.name }}
        compact
      />
    ))
    .with({ entityType: "inventory" }, (i) => (
      <EntityInlineLink
        entity="inventory"
        data={{ id: i.id, name: i.name }}
        compact
      />
    ))
    .with({ entityType: "cookbook" }, (i) => (
      <EntityInlineLink
        entity="cookbook"
        data={{ id: i.id, name: i.name, authors: i.authors }}
        compact
      />
    ))
    .with({ entityType: "meal" }, (i) => (
      <EntityInlineLink
        entity="meal"
        data={{ id: i.id, name: i.name, date: i.date }}
        compact
      />
    ))
    .with({ entityType: "project" }, (i) => (
      <EntityInlineLink
        entity="project"
        data={{
          id: i.id,
          name: i.name,
          status: i.status ? (i.status as ProjectStatus) : undefined,
        }}
        compact
      />
    ))
    .with({ entityType: "task" }, (i) => (
      <EntityInlineLink
        entity="task"
        data={{
          id: i.id,
          name: i.name,
          status: i.status ? (i.status as TaskStatus) : undefined,
          projectName: i.projectName ?? undefined,
        }}
        compact
      />
    ))
    .with({ entityType: "purchase" }, (i) => (
      <EntityInlineLink
        entity="purchase"
        data={{
          id: i.id,
          name: i.name,
          cost: i.cost ?? undefined,
          projectName: i.projectName ?? undefined,
        }}
        compact
      />
    ))
    .exhaustive();
}

function ResultTable({
  title,
  items,
}: {
  title: string;
  items: SearchResultItem[];
}) {
  return (
    <section className="border border-border bg-card p-4">
      <h2 className="mb-2 font-mono font-semibold text-muted-foreground text-xs uppercase tracking-wide">
        {title}
      </h2>
      <Table className="table-auto">
        <TableHeader>
          <TableRow>
            <TableHead>Rank</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Score</TableHead>
            <TableHead>Match</TableHead>
            <TableHead>Terms</TableHead>
            <TableHead>Reason</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item, index) => (
            <TableRow key={`${item.entityType}:${item.id}`}>
              <TableCell>{index + 1}</TableCell>
              <TableCell>{item.entityType}</TableCell>
              <TableCell>
                <SearchResultEntityLink item={item} />
              </TableCell>
              <TableCell>{item.score?.toFixed(3) ?? ""}</TableCell>
              <TableCell>{item.matchKind ?? ""}</TableCell>
              <TableCell className="whitespace-normal text-muted-foreground">
                {item.matchTerms?.join(", ") ?? ""}
              </TableCell>
              <TableCell className="whitespace-normal text-muted-foreground">
                {item.matchReason ?? ""}
              </TableCell>
            </TableRow>
          ))}
          {items.length === 0 ? (
            <TableRow>
              <TableCell className="text-muted-foreground" colSpan={7}>
                No candidates
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </section>
  );
}

export function SearchDebugPage() {
  const api = useTRPC();
  const [query, setQuery] = useState("plastic tarp");
  const [submitted, setSubmitted] = useState(query);
  const [entityTypes, setEntityTypes] = useState<SearchableEntity[]>([
    ...searchableEntities,
  ]);
  const debugQuery = useQuery({
    ...api.search.debug.queryOptions({ query: submitted, limit: 10 }),
    enabled: submitted.trim().length > 0,
  });
  const backfill = useMutation(
    api.search.enqueueEmbeddingBackfill.mutationOptions(),
  );

  return (
    <Stack gap="md">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(query);
        }}
      >
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search debug query"
        />
        <Button type="submit" variant="outline">
          <Search />
          Run
        </Button>
      </form>

      <Stack gap="sm" className="border border-border bg-card p-4">
        <Row align="center" justify="between" gap="sm" wrap>
          <h2 className="font-mono font-semibold text-muted-foreground text-xs uppercase tracking-wide">
            Semantic backfill
          </h2>
          <Row gap="sm" wrap>
            <Button
              type="button"
              variant="outline"
              disabled={backfill.isPending || entityTypes.length === 0}
              onClick={() =>
                backfill.mutate({
                  entityTypes,
                })
              }
            >
              {backfill.isPending ? <Spinner className="size-3" /> : <Send />}
              Enqueue remaining
            </Button>
          </Row>
        </Row>
        <Row gap="sm" wrap>
          {searchableEntities.map((entityType) => (
            <label
              key={entityType}
              className="inline-flex items-center gap-1 text-sm"
            >
              <input
                type="checkbox"
                checked={entityTypes.includes(entityType)}
                onChange={(event) => {
                  setEntityTypes((prev) =>
                    event.target.checked
                      ? [...prev, entityType]
                      : prev.filter((type) => type !== entityType),
                  );
                }}
              />
              {entityType}
            </label>
          ))}
        </Row>
      </Stack>

      {backfill.data ? (
        <p className="text-muted-foreground text-xs">
          Enqueued {backfill.data.totalJobs} embedding job
          {backfill.data.totalJobs === 1 ? "" : "s"} in{" "}
          <Link
            to="/background-jobs"
            search={{ batchId: backfill.data.batchId }}
            className="underline decoration-border decoration-dotted underline-offset-2 hover:decoration-primary"
          >
            batch {backfill.data.batchId.slice(0, 8)}
          </Link>
          .
        </p>
      ) : null}

      {debugQuery.isLoading ? <Spinner /> : null}
      {debugQuery.error ? (
        <p className="text-destructive text-sm">{debugQuery.error.message}</p>
      ) : null}
      {debugQuery.data ? (
        <>
          <ResultTable title="Final rank" items={debugQuery.data.results} />
          <ResultTable
            title="Lexical candidates"
            items={debugQuery.data.lexical}
          />
          <ResultTable
            title="Semantic candidates"
            items={debugQuery.data.semantic}
          />
        </>
      ) : null}

      <section className="border border-border bg-card p-4">
        <Row align="center" justify="between" gap="sm" wrap>
          <Stack gap="xs">
            <h2 className="font-mono font-semibold text-muted-foreground text-xs uppercase tracking-wide">
              AI usage
            </h2>
          </Stack>
          <Link
            to="/ai-usage"
            className="border border-border bg-card px-2 py-1 text-xs hover:bg-muted"
          >
            Open AI usage
          </Link>
        </Row>
      </section>
    </Stack>
  );
}

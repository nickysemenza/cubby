import type { SearchHit } from "@cubby/schemas/search";
import { MagnifyingGlassIcon as Search } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

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
import { search } from "~/lib/search.functions";

import { getSearchResultRoute } from "./search-utils";

function SearchResultEntityLink({ item }: { item: SearchHit }) {
  return <Link {...getSearchResultRoute(item)}>{item.title}</Link>;
}

function ResultTable({ title, items }: { title: string; items: SearchHit[] }) {
  return (
    <section className="border border-border bg-card p-4">
      <h2 className="mb-2 font-mono text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h2>
      <Table className="table-auto">
        <TableHeader>
          <TableRow>
            <TableHead>Rank</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Name</TableHead>
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
  const [query, setQuery] = useState("plastic tarp");
  const [submitted, setSubmitted] = useState(query);
  const shouldSearch = submitted.trim().length > 0;
  const debugQuery = useQuery({
    ...search.debug.queryOptions({
      query: shouldSearch ? submitted : "inactive-search",
      limit: 10,
    }),
    enabled: shouldSearch,
  });

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

      {debugQuery.isLoading ? <Spinner /> : null}
      {debugQuery.error ? (
        <p className="text-sm text-destructive">{debugQuery.error.message}</p>
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
            <h2 className="font-mono text-xs font-semibold tracking-wide text-muted-foreground uppercase">
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

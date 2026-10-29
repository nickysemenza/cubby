import type { SearchHit } from "@cubby/schemas/search";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { search } from "~/integrations/tanstack-query/generated/domains/search.gen";
import { Row, Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import { Input } from "~/ui/primitives/input";
import { Spinner } from "~/ui/primitives/spinner";
import { StaticTable } from "~/ui/primitives/static-table";

import { getSearchResultRoute } from "../../entity/presentation/search-utils";

function SearchResultEntityLink({ item }: { item: SearchHit }) {
  return <Link {...getSearchResultRoute(item)}>{item.title}</Link>;
}

function ResultTable({ title, items }: { title: string; items: SearchHit[] }) {
  return (
    <section className="border border-border bg-card p-4">
      <h2 className="mb-2 text-xs font-semibold text-muted-foreground">
        {title}
      </h2>
      <StaticTable
        className="table-auto"
        emptyMessage="No candidates"
        rows={items}
        rowKey={(item) => `${item.entityKind}:${item.id}`}
        columns={[
          { id: "column-0", header: "Rank", cell: (_row0, index) => index + 1 },
          { id: "column-1", header: "Type", cell: (item) => item.entityKind },
          {
            id: "column-2",
            header: "Name",
            cell: (item) => <SearchResultEntityLink item={item} />,
          },
          {
            id: "column-3",
            header: "Match",
            cell: (item) => item.matchKind ?? "",
          },
          {
            id: "column-4",
            header: "Terms",
            cellClassName: "whitespace-normal text-muted-foreground",
            cell: (item) => item.matchTerms?.join(", ") ?? "",
          },
          {
            id: "column-5",
            header: "Reason",
            cellClassName: "whitespace-normal text-muted-foreground",
            cell: (item) => item.matchReason ?? "",
          },
        ]}
      />
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
          <MagnifyingGlassIcon />
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
            <h2 className="text-xs font-semibold text-muted-foreground">
              AI usage
            </h2>
          </Stack>
          <Link
            to="/ai"
            search={{ tab: "usage" }}
            className="border border-border bg-card px-2 py-1 text-xs hover:bg-muted"
          >
            Open AI usage
          </Link>
        </Row>
      </section>
    </Stack>
  );
}

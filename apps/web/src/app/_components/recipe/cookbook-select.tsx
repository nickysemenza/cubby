import type { CookbookId } from "@cubby/schemas/identifiers";
import { unsafeCookbookId } from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { Row } from "~/components/layout";
import { useTRPC } from "~/trpc/react";

interface CookbookSelectProps {
  value: CookbookId | undefined;
  onChange: (id: CookbookId | undefined) => void;
}

/**
 * "Cookbook" scope filter: a labeled native select over recipe.listCookbooks
 * with an "All cookbooks" empty option. Owns the query and the string →
 * CookbookId boundary cast so callers deal only in branded ids.
 */
export function CookbookSelect({ value, onChange }: CookbookSelectProps) {
  const api = useTRPC();
  const { data: cookbooks } = useQuery(api.recipe.listCookbooks.queryOptions());

  return (
    <Row as="label" align="center" gap="sm" className="w-fit text-sm">
      <span className="text-muted-foreground">Cookbook</span>
      <select
        className="h-8 rounded-md border bg-background px-2 text-sm"
        value={value ?? ""}
        onChange={(e) =>
          onChange(
            e.target.value ? unsafeCookbookId(e.target.value) : undefined,
          )
        }
      >
        <option value="">All cookbooks</option>
        {cookbooks?.map((c) => (
          <option key={c.id} value={c.id}>
            {c.book}
          </option>
        ))}
      </select>
    </Row>
  );
}

import type { CookbookShortcode } from "@cubby/schemas/identifiers";
import { unsafeCookbookShortcode } from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { Row } from "~/components/layout";
import { NativeSelect } from "~/components/ui/native-select";
import { useTRPC } from "~/integrations/trpc/react";

interface CookbookSelectProps {
  value: CookbookShortcode | undefined;
  onChange: (id: CookbookShortcode | undefined) => void;
}

/**
 * "Cookbook" scope filter: a labeled native select over recipe.listCookbooks
 * with an "All cookbooks" empty option. Owns the query and the string →
 * CookbookShortcode boundary cast so callers deal only in branded ids.
 */
export function CookbookSelect({ value, onChange }: CookbookSelectProps) {
  const api = useTRPC();
  const { data: cookbooks } = useQuery(api.recipe.listCookbooks.queryOptions());

  return (
    <Row as="label" align="center" gap="sm" className="w-fit text-sm">
      <span className="text-muted-foreground">Cookbook</span>
      <NativeSelect
        value={value ?? ""}
        onChange={(e) =>
          onChange(
            e.target.value
              ? unsafeCookbookShortcode(e.target.value)
              : undefined,
          )
        }
      >
        <option value="">All cookbooks</option>
        {cookbooks?.map((c) => (
          <option key={c.id} value={c.id}>
            {c.book}
          </option>
        ))}
      </NativeSelect>
    </Row>
  );
}

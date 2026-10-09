import {
  type CookbookShortcode,
  cookbookShortcode,
} from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";

import { cookbook } from "~/integrations/tanstack-query/generated/cookbook.gen";
import { Row } from "~/ui/layout";
import { NativeSelect } from "~/ui/primitives/native-select";

interface CookbookSelectProps {
  value: CookbookShortcode | undefined;
  onChange: (id: CookbookShortcode | undefined) => void;
}

/**
 * "Cookbook" scope filter: a labeled native select over the Cookbook list
 * with an "All cookbooks" empty option. Owns the query and the string →
 * CookbookShortcode boundary cast so callers deal only in branded ids.
 */
export function CookbookSelect({ value, onChange }: CookbookSelectProps) {
  const { data: cookbooks } = useQuery(cookbook.list.queryOptions(null));

  return (
    <Row as="label" align="center" gap="sm" className="w-fit text-sm">
      <span className="text-muted-foreground">Cookbook</span>
      <NativeSelect
        value={value ?? ""}
        onChange={(e) =>
          onChange(
            e.target.value
              ? cookbookShortcode.parse(e.target.value)
              : undefined,
          )
        }
      >
        <option value="">All cookbooks</option>
        {cookbooks?.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </NativeSelect>
    </Row>
  );
}

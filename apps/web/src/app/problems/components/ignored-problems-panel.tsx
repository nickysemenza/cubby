import { useQuery } from "@tanstack/react-query";
import { EyeOff, Undo2 } from "lucide-react";
import { useState } from "react";
import { useProblemCardMutation } from "~/app/_components/hooks/useProblemCardMutation";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Description } from "~/components/ui/description";
import { useTRPC } from "~/trpc/react";

/** Human label for a section id — matches the summary-chip labels. */
const SECTION_LABEL: Record<string, string> = {
  duplicates: "Duplicate",
  orphaned: "Orphaned product",
  "unit-coverage": "Unit coverage",
  "no-product-ingredients": "Ingredient without a product",
  "unused-with-product": "Unused ingredient (has product)",
  "unused-no-product": "Unused ingredient",
  images: "Missing image",
  "ai-descriptions": "Missing AI description",
  "orphaned-embeddings": "Orphaned embedding",
  "upc-updates": "UPC update",
};

/**
 * "Ignored (N)" — the un-ignore affordance for consciously-accepted problems.
 * Collapsed by default (it's a rare housekeeping surface); expanding lists each
 * ignored key with an "Un-ignore" that re-surfaces the card on the next detector
 * run. Both mutations go through useProblemCardMutation, which invalidates the
 * whole `problems.*` path (this list + the detector groups + the navbar badge).
 */
export function IgnoredProblemsPanel() {
  const api = useTRPC();
  const [open, setOpen] = useState(false);
  const { data: ignored } = useQuery(api.problems.listIgnored.queryOptions());

  const unignore = useProblemCardMutation({
    mutationFn: api.problems.unignore.mutationOptions,
    success: "Un-ignored — it will re-appear if still flagged",
  });

  const count = ignored?.length ?? 0;
  if (count === 0) return null;

  return (
    <Card>
      <CardHeader>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center justify-between text-left"
        >
          <CardTitle>
            <EyeOff className="h-4 w-4 text-muted-foreground" />
            Ignored
            <Badge variant="outline">{count}</Badge>
          </CardTitle>
          <span className="text-muted-foreground text-sm">
            {open ? "Hide" : "Show"}
          </span>
        </button>
      </CardHeader>
      {open && (
        <CardContent>
          <Stack gap="sm">
            {ignored?.map((row) => (
              <Row key={row.key} justify="between" align="center" gap="sm">
                <Stack gap="tight" className="min-w-0">
                  <span className="truncate font-medium text-sm">
                    {SECTION_LABEL[row.sectionId] ?? row.sectionId}
                  </span>
                  <Description size="xs" className="truncate font-mono">
                    {row.itemId}
                  </Description>
                </Stack>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => unignore.mutate({ key: row.key })}
                  disabled={unignore.isPending}
                >
                  <Undo2 className="mr-1 h-3 w-3" />
                  Un-ignore
                </Button>
              </Row>
            ))}
          </Stack>
        </CardContent>
      )}
    </Card>
  );
}

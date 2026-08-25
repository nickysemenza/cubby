import type { CategoryAudit as CategoryAuditResult } from "@cubby/schemas/ai";
import { Sparkles } from "lucide-react";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Description } from "~/components/ui/description";
import { Spinner } from "~/components/ui/spinner";
import { auditCategoriesMutationOptions } from "~/lib/ai.functions";

export function CategoryAudit() {
  const auditMutation = useActionMutation({
    mutationFn: auditCategoriesMutationOptions,
  });

  const result = auditMutation.data;

  return (
    <Card>
      <CardHeader>
        <Row align="center" justify="between">
          <Stack gap="xs">
            <CardTitle icon={Sparkles}>Category Audit</CardTitle>
            <CardDescription>
              Use AI to identify gaps in your category system based on your
              current product catalog.
            </CardDescription>
          </Stack>
          <Button
            onClick={() => auditMutation.mutate(undefined)}
            disabled={auditMutation.isPending}
          >
            {auditMutation.isPending ? (
              <>
                <Spinner className="mr-2" />
                Auditing...
              </>
            ) : (
              <>
                <Sparkles className="mr-2 size-4" />
                Run Audit
              </>
            )}
          </Button>
        </Row>
      </CardHeader>

      {result && (
        <CardContent>
          <Stack>
            <Description>{result.summary}</Description>

            {result.suggestions.length > 0 && (
              <div className="divide-y divide-border/60">
                {result.suggestions.map((suggestion) => (
                  <SuggestionRow
                    key={suggestion.categoryName}
                    suggestion={suggestion}
                  />
                ))}
              </div>
            )}
          </Stack>
        </CardContent>
      )}
    </Card>
  );
}

function SuggestionRow({
  suggestion,
}: {
  suggestion: CategoryAuditResult["suggestions"][number];
}) {
  return (
    <Stack gap="sm" className="py-4">
      <Badge variant="secondary">{suggestion.categoryName}</Badge>
      <p className="text-sm">{suggestion.description}</p>
      <Description size="xs">{suggestion.reasoning}</Description>
      {suggestion.productNames.length > 0 && (
        <Row wrap gap="sm" className="pt-1">
          {suggestion.productNames.map((name) => (
            <Badge
              key={name}
              variant="outline"
              // Free-form product names — opt out of the mono-uppercase stamp.
              className="font-sans text-xs normal-case tracking-normal"
            >
              {name}
            </Badge>
          ))}
        </Row>
      )}
    </Stack>
  );
}

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
import { useTRPC } from "~/integrations/trpc/react";

export function CategoryAudit() {
  const api = useTRPC();

  const auditMutation = useActionMutation({
    mutationFn: api.ai.auditCategories.mutationOptions,
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
            onClick={() => auditMutation.mutate()}
            disabled={auditMutation.isPending}
          >
            {auditMutation.isPending ? (
              <>
                <Spinner className="mr-2" />
                Auditing...
              </>
            ) : (
              <>
                <Sparkles className="mr-2 h-4 w-4" />
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
              <Stack>
                {result.suggestions.map((suggestion) => (
                  <SuggestionCard
                    key={suggestion.categoryName}
                    suggestion={suggestion}
                  />
                ))}
              </Stack>
            )}
          </Stack>
        </CardContent>
      )}
    </Card>
  );
}

function SuggestionCard({
  suggestion,
}: {
  suggestion: CategoryAuditResult["suggestions"][number];
}) {
  return (
    <Stack gap="sm" className="rounded-lg border border-[var(--border)] p-4">
      <Row align="center" gap="sm">
        <Badge variant="secondary">{suggestion.categoryName}</Badge>
      </Row>
      <p className="text-sm">{suggestion.description}</p>
      <Description size="xs">{suggestion.reasoning}</Description>
      {suggestion.productNames.length > 0 && (
        <Row wrap gap="sm" className="pt-1">
          {suggestion.productNames.map((name) => (
            <Badge key={name} variant="outline" className="text-xs">
              {name}
            </Badge>
          ))}
        </Row>
      )}
    </Stack>
  );
}

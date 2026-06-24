import type { CategoryAudit as CategoryAuditResult } from "@cubby/schemas/ai";
import { useMutation } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Spinner } from "~/components/ui/spinner";
import { useTRPC } from "~/trpc/react";

export function CategoryAudit() {
  const api = useTRPC();

  const auditMutation = useMutation(
    api.ai.auditCategories.mutationOptions({
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );

  const result = auditMutation.data;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <CardTitle icon={Sparkles}>Category Audit</CardTitle>
            <CardDescription>
              Use AI to identify gaps in your category system based on your
              current product catalog.
            </CardDescription>
          </div>
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
        </div>
      </CardHeader>

      {result && (
        <CardContent className="space-y-4">
          <p className="text-muted-foreground text-sm">{result.summary}</p>

          {result.suggestions.length > 0 && (
            <div className="space-y-4">
              {result.suggestions.map((suggestion) => (
                <SuggestionCard
                  key={suggestion.categoryName}
                  suggestion={suggestion}
                />
              ))}
            </div>
          )}
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
    <div className="space-y-2 rounded-lg border border-[var(--border-chunky)] p-4">
      <div className="flex items-center gap-2">
        <Badge variant="secondary">{suggestion.categoryName}</Badge>
      </div>
      <p className="text-sm">{suggestion.description}</p>
      <p className="text-muted-foreground text-xs">{suggestion.reasoning}</p>
      {suggestion.productNames.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-1">
          {suggestion.productNames.map((name) => (
            <Badge key={name} variant="outline" className="text-xs">
              {name}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

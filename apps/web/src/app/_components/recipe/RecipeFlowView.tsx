import type { RecipeOut } from "@cubby/schemas/recipe";
import type { RecipeFlowOperation } from "@cubby/schemas/recipe-flow";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  GitBranch,
  RefreshCw,
  Sparkles,
  Table2,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { MarkdownText } from "~/components/markdown";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Skeleton } from "~/components/ui/skeleton";
import { Textarea } from "~/components/ui/textarea";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";
import { useIsMobile } from "~/hooks/useMobile";
import { useTRPC } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import { invalidateQueryRoots, queryKeys } from "~/lib/query-keys";
import { CopyJsonButton } from "./copy-debug-button";
import { RecipeFlowMap, RecipeFlowTable } from "./RecipeFlowRenderers";

export type RecipeFlowLayoutMode = "map" | "table";

const FLOW_LAYOUT_OPTIONS: ViewSwitcherOption<RecipeFlowLayoutMode>[] = [
  { value: "map", label: "Map", icon: GitBranch },
  { value: "table", label: "Table", icon: Table2 },
];

function FlowLoading() {
  return (
    <div className="border border-[var(--border)] bg-card p-4">
      <div className="mb-4 flex items-center gap-2">
        <Sparkles className="size-5 text-primary" />
        <div>
          <div className="font-heading font-semibold">Building recipe flow</div>
          <div className="text-muted-foreground text-xs">
            Mapping ingredients to the authored cooking steps…
          </div>
        </div>
      </div>
      <div className="grid grid-cols-[2fr_1fr_1fr] gap-4">
        <Skeleton className="h-48" />
        <Skeleton className="h-48" />
        <Skeleton className="h-48" />
      </div>
    </div>
  );
}

function instructionText(recipe: RecipeOut, operation: RecipeFlowOperation) {
  return operation.instructionRefs.flatMap((ref) => {
    const section = recipe.sections.find(
      (candidate) => candidate.id === ref.sectionId,
    );
    const instruction = section?.instructions[ref.instructionIndex];
    if (!section || !instruction) return [];
    return [
      {
        key: `${ref.sectionId}:${ref.instructionIndex}`,
        sectionName: section.name,
        instructionIndex: ref.instructionIndex,
        text: instruction.instruction,
      },
    ];
  });
}

export function RecipeFlowView({
  recipe,
  scaledRecipe,
  layout: controlledLayout,
  onLayoutChange,
  onReadyChange,
}: {
  recipe: RecipeOut;
  scaledRecipe: RecipeOut;
  layout?: RecipeFlowLayoutMode;
  onLayoutChange?: (layout: RecipeFlowLayoutMode) => void;
  onReadyChange?: (ready: boolean) => void;
}) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const [internalLayout, setInternalLayout] =
    useState<RecipeFlowLayoutMode>("table");
  const layout = controlledLayout ?? (isMobile ? "map" : internalLayout);
  const setLayout = onLayoutChange ?? setInternalLayout;
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(
    null,
  );
  const [guidanceOpen, setGuidanceOpen] = useState(false);
  const [guidance, setGuidance] = useState("");
  const [generationError, setGenerationError] = useState<string | null>(null);
  const autoStartedFingerprint = useRef<string | null>(null);

  const flowQuery = useQuery(
    api.recipe.getFlow.queryOptions({ id: recipe.id }),
  );
  const flowState = flowQuery.data;
  const artifact =
    flowState?.status === "current" || flowState?.status === "stale"
      ? flowState.artifact
      : null;

  // Raw useMutation is intentional: automatic generation failures are rendered
  // inline in this view instead of being reduced to the shared toast-only path.
  const generation = useMutation(
    api.recipe.generateFlow.mutationOptions({
      onSuccess: (_data, variables) => {
        setGenerationError(null);
        setGuidanceOpen(false);
        invalidateQueryRoots(queryClient, [queryKeys.recipe.flow]);
        if (variables.force) toast.success("Recipe flow regenerated");
      },
      onError: (error) => {
        setGenerationError(getErrorMessage(error));
      },
    }),
  );

  useEffect(() => {
    if (
      !flowState ||
      flowState.status === "current" ||
      generation.isPending ||
      autoStartedFingerprint.current === flowState.currentFingerprint
    ) {
      return;
    }
    autoStartedFingerprint.current = flowState.currentFingerprint;
    generation.mutate({ id: recipe.id, force: false });
  }, [flowState, generation, recipe.id]);

  const selectedOperation = useMemo(
    () =>
      artifact?.plan.operations.find(
        (operation) => operation.id === selectedOperationId,
      ) ?? null,
    [artifact, selectedOperationId],
  );
  const selectedInstructions = useMemo(
    () => (selectedOperation ? instructionText(recipe, selectedOperation) : []),
    [recipe, selectedOperation],
  );

  useEffect(() => {
    onReadyChange?.(
      flowState?.status === "current" &&
        artifact != null &&
        !generation.isPending,
    );
  }, [artifact, flowState?.status, generation.isPending, onReadyChange]);

  const openGuidance = () => {
    setGuidance(artifact?.guidance ?? "");
    setGuidanceOpen(true);
  };
  const submitGuidance = (event: FormEvent) => {
    event.preventDefault();
    generation.mutate({
      id: recipe.id,
      guidance: guidance.trim() || null,
      force: true,
    });
  };

  if (flowQuery.isLoading || (!artifact && generation.isPending)) {
    return <FlowLoading />;
  }
  if (flowQuery.error && !artifact) {
    return (
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>Could not load recipe flow</AlertTitle>
        <AlertDescription>{getErrorMessage(flowQuery.error)}</AlertDescription>
      </Alert>
    );
  }
  if (!artifact) {
    return (
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>Could not generate recipe flow</AlertTitle>
        <AlertDescription>
          {generationError ?? "No valid flow is available for this recipe."}
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="mt-2"
            onClick={() => generation.mutate({ id: recipe.id, force: true })}
            disabled={generation.isPending}
          >
            <RefreshCw />
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="border border-[var(--border)] bg-card">
      <header className="border-primary border-b-2 px-4 py-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="my-0 font-heading font-semibold text-xl tracking-tight">
              {scaledRecipe.name}
            </h2>
            <div className="font-mono text-2xs text-slate uppercase tracking-wider">
              {artifact.plan.sources.length} additions →{" "}
              {artifact.plan.operations.length} operations →{" "}
              {artifact.plan.outputOperationIds.length}{" "}
              {artifact.plan.outputOperationIds.length === 1
                ? "output"
                : "outputs"}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <ViewSwitcher
              ariaLabel="Flow layout"
              options={FLOW_LAYOUT_OPTIONS}
              value={layout}
              onValueChange={setLayout}
            />
            <CopyJsonButton
              value={artifact.plan}
              title="Copy the validated recipe flow JSON"
              label="Copy JSON"
              toastLabel="Copied recipe flow JSON"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={openGuidance}
              disabled={generation.isPending}
            >
              <Sparkles />
              Regenerate
            </Button>
          </div>
        </div>
      </header>

      {flowState?.status === "stale" && (
        <Alert className="border-x-0 border-t-0">
          <RefreshCw className={generation.isPending ? "animate-spin" : ""} />
          <AlertTitle>Recipe changed</AlertTitle>
          <AlertDescription>
            Showing the previous flow while Cubby generates an updated one.
          </AlertDescription>
        </Alert>
      )}
      {generationError && (
        <Alert variant="destructive" className="border-x-0 border-t-0">
          <AlertTriangle />
          <AlertTitle>Refresh failed</AlertTitle>
          <AlertDescription>{generationError}</AlertDescription>
        </Alert>
      )}

      {artifact.plan.setup.length > 0 && (
        <div className="grid gap-1 border-b px-4 py-2 sm:grid-cols-2">
          {artifact.plan.setup.map((setup) => (
            <div
              key={setup.id}
              className="flex items-center justify-between gap-2 border border-[var(--border)] border-dashed px-2 py-1 text-xs"
            >
              <span>{setup.label}</span>
              <span className="flex flex-wrap gap-1">
                {setup.annotations.map((annotation) => (
                  <Badge
                    variant="outline"
                    key={`${annotation.kind}:${annotation.text}`}
                    className="font-sans normal-case tracking-normal"
                  >
                    {annotation.text}
                  </Badge>
                ))}
              </span>
            </div>
          ))}
        </div>
      )}

      {artifact.warnings.length > 0 && (
        <details className="border-b px-4 py-2">
          <summary className="cursor-pointer font-mono text-2xs text-warning uppercase tracking-wider">
            {artifact.warnings.length} flow{" "}
            {artifact.warnings.length === 1 ? "warning" : "warnings"}
          </summary>
          <ul className="mt-2 list-disc pl-4 text-muted-foreground text-xs">
            {artifact.warnings.map((warning) => (
              <li
                key={`${warning.code}:${warning.message}:${warning.nodeIds.join(",")}`}
              >
                {warning.message}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="p-4">
        {layout === "map" ? (
          <RecipeFlowMap
            recipe={scaledRecipe}
            plan={artifact.plan}
            selectedOperationId={selectedOperationId}
            onSelectOperation={setSelectedOperationId}
          />
        ) : (
          <RecipeFlowTable
            recipe={scaledRecipe}
            plan={artifact.plan}
            selectedOperationId={selectedOperationId}
            onSelectOperation={setSelectedOperationId}
          />
        )}
      </div>

      <footer className="border-t px-4 py-2 font-mono text-2xs text-slate">
        Generated by {artifact.model} · {artifact.generatedAt.toLocaleString()}
        {artifact.guidance && " · guided"}
      </footer>

      <Dialog
        open={selectedOperation != null}
        onOpenChange={(open) => {
          if (!open) setSelectedOperationId(null);
        }}
      >
        <DialogContent size="md">
          {selectedOperation && (
            <>
              <DialogHeader>
                <DialogTitle>{selectedOperation.label}</DialogTitle>
                <DialogDescription>
                  AI-generated label; the authored instructions below remain the
                  source of truth.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-2">
                {selectedOperation.annotations.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {selectedOperation.annotations.map((annotation) => (
                      <Badge
                        variant="outline"
                        key={`${annotation.kind}:${annotation.text}`}
                        className="font-sans normal-case tracking-normal"
                      >
                        {annotation.text}
                      </Badge>
                    ))}
                  </div>
                )}
                {selectedInstructions.map((instruction) => (
                  <div
                    key={instruction.key}
                    className="border border-[var(--border)] px-2 py-2"
                  >
                    <div className="mb-1 font-mono text-2xs text-slate uppercase tracking-wider">
                      {instruction.sectionName ?? "Method"} · step{" "}
                      {instruction.instructionIndex + 1}
                    </div>
                    <MarkdownText className="[&_p]:my-0">
                      {instruction.text}
                    </MarkdownText>
                  </div>
                ))}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={guidanceOpen} onOpenChange={setGuidanceOpen}>
        <DialogContent size="md">
          <form onSubmit={submitGuidance}>
            <DialogHeader>
              <DialogTitle>Regenerate recipe flow</DialogTitle>
              <DialogDescription>
                Guidance persists for this recipe and is reused after future
                ingredient or instruction edits. Leave it blank to clear the
                current guidance.
              </DialogDescription>
            </DialogHeader>
            <Textarea
              value={guidance}
              onChange={(event) => setGuidance(event.target.value)}
              maxLength={1000}
              placeholder="For example: keep the sauce as a separate branch until plating."
              className="mt-2"
            />
            <DialogFooter className="mt-4">
              <Button type="submit" disabled={generation.isPending}>
                {generation.isPending && <RefreshCw className="animate-spin" />}
                Regenerate
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

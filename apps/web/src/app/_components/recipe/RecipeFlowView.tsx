import type { RecipeOut } from "@cubby/schemas/recipe";
import type {
  RecipeFlowArtifact,
  RecipeFlowOperation,
} from "@cubby/schemas/recipe-flow";
import { ArrowClockwiseIcon as RefreshCw } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { BookOpenIcon as BookOpen } from "@phosphor-icons/react/dist/csr/BookOpen";
import { GitBranchIcon as GitBranch } from "@phosphor-icons/react/dist/csr/GitBranch";
import { SparkleIcon as Sparkles } from "@phosphor-icons/react/dist/csr/Sparkle";
import { TableIcon as Table2 } from "@phosphor-icons/react/dist/csr/Table";
import { WarningIcon as AlertTriangle } from "@phosphor-icons/react/dist/csr/Warning";
import { useMutation, useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { VerbButton } from "~/app/_components/actions/action-verb-ui";
import { recipe as recipeOperations } from "~/app/recipes/recipe.functions";
import { Row, Stack } from "~/components/layout";
import { MarkdownText } from "~/components/markdown";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Skeleton } from "~/components/ui/skeleton";
import { Textarea } from "~/components/ui/textarea";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";
import { getErrorMessage } from "~/lib/error-utils";

import { CopyJsonButton } from "./copy-debug-button";
import { RecipeFlowMap, RecipeFlowTable } from "./RecipeFlowRenderers";
import { RecipeWalkthrough } from "./RecipeWalkthrough";

export type RecipeFlowLayoutMode = "walkthrough" | "map" | "table";

const FLOW_LAYOUT_OPTIONS: ViewSwitcherOption<RecipeFlowLayoutMode>[] = [
  { value: "walkthrough", label: "Walkthrough", icon: BookOpen },
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
          <div className="text-xs text-muted-foreground">
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

function FlowAvailability({
  loading,
  error,
  artifact,
  generationError,
  isGenerating,
  onRetry,
}: {
  loading: boolean;
  error: unknown;
  artifact: unknown;
  generationError: string | null;
  isGenerating: boolean;
  onRetry: () => void;
}) {
  if (loading) return <FlowLoading />;
  if (error && !artifact)
    return (
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>Could not load recipe flow</AlertTitle>
        <AlertDescription>{getErrorMessage(error)}</AlertDescription>
      </Alert>
    );
  if (artifact) return null;
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
          onClick={onRetry}
          disabled={isGenerating}
        >
          <RefreshCw />
          Retry
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function FlowStatus({
  stale,
  generating,
  error,
}: {
  stale: boolean;
  generating: boolean;
  error: string | null;
}) {
  return (
    <>
      {stale ? (
        <Alert className="border-x-0 border-t-0">
          <RefreshCw className={generating ? "animate-spin" : ""} />
          <AlertTitle>Recipe changed</AlertTitle>
          <AlertDescription>
            {generating
              ? "Generating an updated flow from the current recipe."
              : "Regenerate the flow to use the latest recipe instructions."}
          </AlertDescription>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive" className="border-x-0 border-t-0">
          <AlertTriangle />
          <AlertTitle>Refresh failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </>
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

function FlowPlan({
  artifact,
  recipe,
  layout,
  onLayoutChange,
  selectedOperationId,
  onSelectOperation,
  generating,
  stale,
  generationError,
  guidance,
  onGuidanceChange,
  onRegenerate,
}: {
  artifact: RecipeFlowArtifact;
  recipe: RecipeOut;
  layout: RecipeFlowLayoutMode;
  onLayoutChange: (layout: RecipeFlowLayoutMode) => void;
  selectedOperationId: string | null;
  onSelectOperation: (operationId: string | null) => void;
  generating: boolean;
  stale: boolean;
  generationError: string | null;
  guidance: string;
  onGuidanceChange: (guidance: string) => void;
  onRegenerate: (event: FormEvent) => void;
}) {
  const outputCount = artifact.plan.outputOperationIds.length;

  return (
    <>
      <header className="border-b-2 border-primary px-4 py-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="my-0 font-heading text-xl font-semibold tracking-tight">
              {recipe.name}
            </h2>
            <div className="font-mono text-2xs tracking-wider text-slate uppercase">
              {artifact.plan.sources.length} additions →{" "}
              {artifact.plan.operations.length} operations → {outputCount}{" "}
              {outputCount === 1 ? "output" : "outputs"}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <ViewSwitcher
              ariaLabel="Flow layout"
              options={FLOW_LAYOUT_OPTIONS}
              value={layout}
              onValueChange={onLayoutChange}
            />
            <CopyJsonButton
              value={artifact.plan}
              title="Copy the validated recipe flow JSON"
              label="Copy JSON"
              toastLabel="Copied recipe flow JSON"
            />
          </div>
        </div>

        {/*
          Guidance inline rather than behind a dialog. It was a modal around a
          single textarea and a submit — interruption with nothing to protect,
          and it hid the guidance already in force behind a click, so the
          persisted instruction that shaped the flow on screen was invisible
          while reading it.
        */}
        <Row
          as="form"
          align="end"
          gap="sm"
          wrap
          onSubmit={onRegenerate}
          className="mt-2 print:hidden"
        >
          <Stack gap="tight" className="min-w-56 flex-1">
            <label
              htmlFor="recipe-flow-guidance"
              className="eyebrow text-muted-foreground"
            >
              Guidance
            </label>
            <Textarea
              id="recipe-flow-guidance"
              value={guidance}
              onChange={(event) => onGuidanceChange(event.target.value)}
              maxLength={1000}
              rows={2}
              placeholder="For example: keep the sauce as a separate branch until plating."
              aria-describedby="recipe-flow-guidance-help"
            />
            <Description size="2xs" id="recipe-flow-guidance-help">
              Persists for this recipe and is reused after future ingredient or
              instruction edits. Clear it to drop the current guidance.
            </Description>
          </Stack>
          <VerbButton
            verb="regenerate"
            pending={generating}
            phoneIconOnly
            className="min-h-9 max-sm:min-h-11"
          />
        </Row>
      </header>

      <FlowStatus
        stale={stale}
        generating={generating}
        error={generationError}
      />

      {layout !== "walkthrough" && artifact.plan.setup.length > 0 && (
        <div className="grid gap-1 border-b px-4 py-2 sm:grid-cols-2">
          {artifact.plan.setup.map((setup) => (
            <div
              key={setup.id}
              className="flex items-center justify-between gap-2 border border-dashed border-[var(--border)] px-2 py-1 text-xs"
            >
              <span>{setup.label}</span>
              <span className="flex flex-wrap gap-1">
                {setup.annotations.map((annotation) => (
                  <Badge
                    variant="outline"
                    key={`${annotation.kind}:${annotation.text}`}
                    className="font-sans tracking-normal normal-case"
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
          <summary className="cursor-pointer font-mono text-2xs tracking-wider text-warning-ink uppercase">
            {artifact.warnings.length} flow{" "}
            {artifact.warnings.length === 1 ? "warning" : "warnings"}
          </summary>
          <ul className="mt-2 list-disc pl-4 text-xs text-muted-foreground">
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
        {layout === "walkthrough" ? (
          stale ? (
            <p className="text-sm text-muted-foreground">
              The recipe has changed.{" "}
              {generating
                ? "Updating the walkthrough…"
                : "Regenerate the flow to read an updated walkthrough."}
            </p>
          ) : artifact.plan.walkthrough ? (
            <RecipeWalkthrough
              key={`${recipe.id}:${artifact.contentFingerprint}:${artifact.generatedAt.toISOString()}`}
              recipe={recipe}
              plan={artifact.plan}
            />
          ) : (
            <div className="grid justify-items-start gap-3 py-4">
              <p className="max-w-prose text-sm leading-relaxed">
                Turn this recipe flow into a guided walkthrough, with
                ingredients beside the original instructions and explanations
                along the way.
              </p>
              <Button
                type="button"
                onClick={onRegenerate}
                disabled={generating}
              >
                <BookOpen />
                Generate walkthrough
              </Button>
            </div>
          )
        ) : layout === "map" ? (
          <RecipeFlowMap
            recipe={recipe}
            plan={artifact.plan}
            selectedOperationId={selectedOperationId}
            onSelectOperation={onSelectOperation}
          />
        ) : (
          <RecipeFlowTable
            recipe={recipe}
            plan={artifact.plan}
            selectedOperationId={selectedOperationId}
            onSelectOperation={onSelectOperation}
          />
        )}
      </div>

      <footer className="border-t px-4 py-2 font-mono text-2xs text-slate">
        Generated by {artifact.model} · {artifact.generatedAt.toLocaleString()}
        {artifact.guidance && " · guided"}
      </footer>
    </>
  );
}

function SelectedOperationDialog({
  recipe,
  artifact,
  selectedOperationId,
  onSelectOperation,
}: {
  recipe: RecipeOut;
  artifact: RecipeFlowArtifact;
  selectedOperationId: string | null;
  onSelectOperation: (operationId: string | null) => void;
}) {
  const selectedOperation = artifact.plan.operations.find(
    (operation) => operation.id === selectedOperationId,
  );
  const instructions = selectedOperation
    ? instructionText(recipe, selectedOperation)
    : [];

  return (
    <Dialog
      open={selectedOperation != null}
      onOpenChange={(open) => {
        if (!open) onSelectOperation(null);
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
                      className="font-sans tracking-normal normal-case"
                    >
                      {annotation.text}
                    </Badge>
                  ))}
                </div>
              )}
              {instructions.map((instruction) => (
                <div
                  key={instruction.key}
                  className="border border-[var(--border)] px-2 py-2"
                >
                  <div className="mb-1 font-mono text-2xs tracking-wider text-slate uppercase">
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
  );
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
  const [internalLayout, setInternalLayout] =
    useState<RecipeFlowLayoutMode>("walkthrough");
  const layout = controlledLayout ?? internalLayout;
  const setLayout = onLayoutChange ?? setInternalLayout;
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(
    null,
  );
  const [guidance, setGuidance] = useState("");
  const [guidanceSource, setGuidanceSource] = useState<string | null>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const autoStartedFingerprint = useRef<string | null>(null);

  const flowQuery = useQuery(
    recipeOperations.getFlow.queryOptions({ id: recipe.id }),
  );
  const flowState = flowQuery.data;
  const artifact =
    flowState?.status === "current" || flowState?.status === "stale"
      ? flowState.artifact
      : null;

  // Raw useMutation is intentional: automatic generation failures are rendered
  // inline in this view instead of being reduced to the shared toast-only path.
  const generation = useMutation(
    recipeOperations.generateFlow.mutationOptions({
      onSuccess: (_data, variables) => {
        setGenerationError(null);
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

  useEffect(() => {
    onReadyChange?.(
      flowState?.status === "current" &&
        artifact != null &&
        !generation.isPending,
    );
  }, [artifact, flowState?.status, generation.isPending, onReadyChange]);

  // Seed the box from the artifact's persisted guidance once per artifact, so
  // what shaped the flow on screen is what the field shows — without
  // clobbering an edit in progress when the query refetches.
  const persistedGuidance = artifact?.guidance ?? "";
  if (guidanceSource !== persistedGuidance) {
    setGuidanceSource(persistedGuidance);
    setGuidance(persistedGuidance);
  }

  const submitGuidance = (event: FormEvent) => {
    event.preventDefault();
    generation.mutate({
      id: recipe.id,
      guidance: guidance.trim() || null,
      force: true,
    });
  };

  const unavailable = (
    <FlowAvailability
      loading={flowQuery.isLoading || (!artifact && generation.isPending)}
      error={flowQuery.error}
      artifact={artifact}
      generationError={generationError}
      isGenerating={generation.isPending}
      onRetry={() => generation.mutate({ id: recipe.id, force: true })}
    />
  );
  if (!artifact) return unavailable;

  return (
    <div className="border border-[var(--border)] bg-card">
      <FlowPlan
        artifact={artifact}
        recipe={scaledRecipe}
        layout={layout}
        onLayoutChange={setLayout}
        selectedOperationId={selectedOperationId}
        onSelectOperation={setSelectedOperationId}
        generating={generation.isPending}
        stale={flowState?.status === "stale"}
        generationError={generationError}
        guidance={guidance}
        onGuidanceChange={setGuidance}
        onRegenerate={submitGuidance}
      />
      <SelectedOperationDialog
        recipe={recipe}
        artifact={artifact}
        selectedOperationId={selectedOperationId}
        onSelectOperation={setSelectedOperationId}
      />
    </div>
  );
}

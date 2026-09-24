import type { RecipeOut } from "@cubby/schemas/recipe";
import type {
  RecipeFlowInstructionRef,
  RecipeFlowPlan,
} from "@cubby/schemas/recipe-flow";
import { ArrowLeftIcon as ArrowLeft } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { ArrowRightIcon as ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { useRef, useState } from "react";

import { Row, Stack } from "~/components/layout";
import { MarkdownText } from "~/components/markdown";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

import { FlowSourceContent } from "./RecipeFlowRenderers";

function Instructions({
  recipe,
  refs,
}: {
  recipe: RecipeOut;
  refs: RecipeFlowInstructionRef[];
}) {
  return refs.map((ref) => {
    const section = recipe.sections.find(
      (candidate) => candidate.id === ref.sectionId,
    );
    const instruction = section?.instructions[ref.instructionIndex];
    if (!instruction) return null;
    return (
      <Stack key={`${ref.sectionId}:${ref.instructionIndex}`} gap="xs">
        <span className="text-xs text-muted-foreground">
          {section?.name ?? "Method"} · step {ref.instructionIndex + 1}
        </span>
        <MarkdownText className="text-sm leading-relaxed [&_p]:my-0">
          {instruction.instruction}
        </MarkdownText>
      </Stack>
    );
  });
}

export function RecipeWalkthrough({
  recipe,
  plan,
}: {
  recipe: RecipeOut;
  plan: RecipeFlowPlan;
}) {
  const walkthrough = plan.walkthrough;
  const [activeIndex, setActiveIndex] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  if (!walkthrough) return null;
  const stop = walkthrough.stops[activeIndex];
  if (!stop) return null;

  const operations = new Map(
    plan.operations.map((operation) => [operation.id, operation]),
  );
  const stopRefs = new Map<string, RecipeFlowInstructionRef>();
  for (const id of stop.operationIds) {
    for (const ref of operations.get(id)?.instructionRefs ?? []) {
      stopRefs.set(`${ref.sectionId}:${ref.instructionIndex}`, ref);
    }
  }
  const sources = new Map(plan.sources.map((source) => [source.id, source]));
  const usages = new Map(
    recipe.sections.flatMap((section) =>
      section.ingredients.map((usage) => [usage.id, usage] as const),
    ),
  );
  const usageCounts = new Map<string, number>();
  for (const operation of plan.operations) {
    for (const input of operation.inputs) {
      const source =
        input.kind === "source" ? sources.get(input.id) : undefined;
      if (source?.kind === "usage")
        usageCounts.set(
          source.usageId,
          (usageCounts.get(source.usageId) ?? 0) + 1,
        );
    }
  }
  const selectStop = (index: number) => {
    setActiveIndex(index);
    heading.current?.focus();
  };

  return (
    <Stack gap="lg" className="min-w-0">
      <Stack gap="sm" className="max-w-prose">
        <h3 className="text-lg font-semibold">Walkthrough</h3>
        <p className="text-sm leading-relaxed">{walkthrough.overview}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          AI arranges the steps and adds explanations. The recipe instructions
          are shown below unchanged. Ingredient amounts follow your selected
          scale; quantities written in instructions do not.
        </p>
      </Stack>

      {plan.setup.length > 0 && (
        <Stack gap="md" className="border-y py-4">
          <h4 className="font-semibold">Before you start</h4>
          {plan.setup.map((setup) => (
            <Instructions
              key={setup.id}
              recipe={recipe}
              refs={setup.instructionRefs}
            />
          ))}
        </Stack>
      )}

      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
        <nav aria-label="Walkthrough stops">
          <ol className="grid gap-1">
            {walkthrough.stops.map((entry, index) => (
              <li key={entry.id}>
                <button
                  type="button"
                  aria-label={`${index + 1}. ${entry.title}`}
                  aria-current={index === activeIndex ? "step" : undefined}
                  onClick={() => selectStop(index)}
                  className={cn(
                    "flex min-h-11 w-full items-baseline gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring",
                    index === activeIndex &&
                      "bg-primary/10 font-medium text-primary",
                  )}
                >
                  <span className="shrink-0 tabular-nums">{index + 1}.</span>
                  <span className="min-w-0 break-words">{entry.title}</span>
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <Stack gap="lg" className="max-w-prose min-w-0">
          <h4
            ref={heading}
            tabIndex={-1}
            className="text-xl font-semibold focus-visible:outline-2 focus-visible:outline-ring"
          >
            {stop.title}
          </h4>
          <details key={stop.id} className="border-y py-2">
            <summary className="min-h-11 cursor-pointer content-center text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
              Why this step · AI explanation
            </summary>
            <p className="pb-2 text-sm leading-relaxed text-muted-foreground">
              {stop.explanation}
            </p>
          </details>
          {stop.operationIds.map((id) => {
            const operation = operations.get(id);
            if (!operation) return null;
            return (
              <Stack key={id} gap="md" className="border-b pb-4">
                {stop.operationIds.length > 1 && (
                  <h5 className="text-sm font-semibold">{operation.label}</h5>
                )}
                <ul
                  className="grid gap-2"
                  aria-label={`Ingredients and prepared components for ${operation.label}`}
                >
                  {operation.inputs.map((input) => {
                    if (input.kind === "operation") {
                      const previous = operations.get(input.id);
                      return (
                        <li key={input.id} className="text-sm">
                          <span className="font-medium">
                            {previous?.outputLabel ?? previous?.label}
                          </span>
                          <span className="text-muted-foreground">
                            {" "}
                            · from an earlier step
                          </span>
                        </li>
                      );
                    }
                    const source = sources.get(input.id);
                    if (!source) return null;
                    const divided =
                      source.kind === "usage" &&
                      (usageCounts.get(source.usageId) ?? 0) > 1;
                    return (
                      <li key={input.id}>
                        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-4">
                          <FlowSourceContent
                            source={source}
                            usages={usages}
                            readable
                          />
                        </div>
                        {divided && (
                          <p className="mt-1 text-xs text-warning-ink">
                            Divided ingredient: this is the batch total. Follow
                            the instruction for this addition.
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </Stack>
            );
          })}
          <Stack
            as="section"
            aria-label={`Recipe instructions for ${stop.title}`}
            gap="md"
          >
            <Instructions recipe={recipe} refs={[...stopRefs.values()]} />
          </Stack>
          <Row align="center" justify="between" gap="sm" className="flex-wrap">
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={activeIndex === 0}
              onClick={() => selectStop(activeIndex - 1)}
            >
              <ArrowLeft />
              Previous
            </Button>
            <output className="text-xs text-muted-foreground">
              Step {activeIndex + 1} of {walkthrough.stops.length}
            </output>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={activeIndex === walkthrough.stops.length - 1}
              onClick={() => selectStop(activeIndex + 1)}
            >
              Next
              <ArrowRight />
            </Button>
          </Row>
        </Stack>
      </div>

      <details className="border-t pt-2">
        <summary className="min-h-11 cursor-pointer content-center text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
          Full original method
        </summary>
        <Stack gap="md" className="max-w-prose py-4">
          {recipe.sections.map((section) => (
            <Instructions
              key={section.id}
              recipe={recipe}
              refs={section.instructions.map(
                (_instruction, instructionIndex) => ({
                  sectionId: section.id,
                  instructionIndex,
                }),
              )}
            />
          ))}
        </Stack>
      </details>
    </Stack>
  );
}

import { Link } from "@tanstack/react-router";

import type { WorkActionProps } from "~/entity/work-queue/work-actions";
import { ProblemItemsAction } from "~/features/work-queue/problem-items-action";
import { Button } from "~/ui/primitives/button";

import { UnitCoverageInlineFix } from "./unit-coverage-fix";

/** `productsWithIslandedMappings:add-conversion`: bridge the row's islands. */
export function IslandedMappingsAction(props: WorkActionProps) {
  return (
    <ProblemItemsAction
      {...props}
      problemKey="productsWithIslandedMappings"
      matches={(item, id) => item.id === id}
    >
      {(item, close) => (
        <UnitCoverageInlineFix
          item={{ kind: "islanded", ...item }}
          close={close}
        />
      )}
    </ProblemItemsAction>
  );
}

/** `ingredientsWithPartialCoverage:repair-coverage`: the workbench is the one
 * editor for ingredient enrichment, so the flow hands off to it. */
export function PartialCoverageAction(props: WorkActionProps) {
  return (
    <ProblemItemsAction
      {...props}
      problemKey="ingredientsWithPartialCoverage"
      matches={(item, id) => item.id === id}
    >
      {(item) => (
        <Button
          size="sm"
          variant="outline"
          nativeButton={false}
          render={
            <Link
              to="/ingredients/workbench"
              search={{ focus: item.ingredientId }}
            />
          }
        >
          Fix {item.name} in the workbench
        </Button>
      )}
    </ProblemItemsAction>
  );
}

import type { WorkAction, WorkQueueRow } from "@cubby/schemas/work-queue";

// Kept free of React and UI imports: the server-side Problem action
// declarations type their handlers with these.

type WorkActionTargets = {
  readonly item: { readonly scope: "item"; readonly row: WorkQueueRow };
  readonly group: {
    readonly scope: "group";
    readonly reason: string;
    readonly count: number;
  };
};

/**
 * What a declared action acts on: one row (`item`), or a reason group's
 * whole population (`group`), which the handler re-reads server-side rather
 * than trusting the loaded rows.
 */
export type WorkActionTarget<
  Scope extends WorkAction["scope"] = WorkAction["scope"],
> = WorkActionTargets[Scope];

export interface WorkActionProps<
  Scope extends WorkAction["scope"] = WorkAction["scope"],
> {
  readonly action: WorkAction;
  readonly target: WorkActionTarget<Scope>;
}

import type { ReportSlot } from "@cubby/schemas/entity-report";
import { createContext, type ReactNode, useContext } from "react";

/**
 * The detail header's action placement, shared by the header target
 * (`./detail-action-bar`) and the report renderers (`./report-slot`,
 * `./records-block`) as a leaf so neither imports the other.
 */
const DetailActionContext = createContext(false);

/** Section controls are supplied once by the header, independent of the selected tab. */
export function DetailActionProvider({ children }: { children: ReactNode }) {
  return (
    <DetailActionContext.Provider value={true}>
      {children}
    </DetailActionContext.Provider>
  );
}

/** Inside the header target itself, slot controls render where they are. */
export function DetailActionScope({ children }: { children: ReactNode }) {
  return (
    <DetailActionContext.Provider value={false}>
      {children}
    </DetailActionContext.Provider>
  );
}

/** Standalone slot consumers retain their local controls. */
export function DetailAction({ children }: { children: ReactNode }) {
  return useContext(DetailActionContext) ? null : children;
}

/** Explicit row exceptions: an attempt is diagnostic context for its owning Run. */
export type ReportDetailActionPlacement = {
  rows?: readonly string[];
  commands?: boolean;
  verbs?: boolean;
};
type ReportDetailActionRegistry = Partial<
  Record<ReportSlot, ReportDetailActionPlacement>
>;
const reportDetailActions = {
  "purchase.financial-settlement": { verbs: true },
  "purchase.reconciliation": { verbs: true },
  "expense.settlement": { verbs: true },
  "run.live-progress": { rows: ["workflow"] },
} satisfies ReportDetailActionRegistry;

export function reportDetailActionsFor(
  slot: ReportSlot,
): ReportDetailActionPlacement | undefined {
  return Object.entries(reportDetailActions).find(([key]) => key === slot)?.[1];
}

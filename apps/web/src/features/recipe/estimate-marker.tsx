/**
 * Small muted "est." tag so estimated (usage-adjusted / modeled) values don't
 * read as measured ones. Shared by the table view and the magazine ledger so
 * the two surfaces stay visually consistent.
 */
export const EstimateMarker = () => (
  <span className="ml-1 text-2xs text-muted-foreground">est.</span>
);

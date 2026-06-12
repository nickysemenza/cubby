export interface SummaryItem {
  label: string;
  value: string | number;
  formatter?: (value: string | number) => string;
  /** Optional small muted caption rendered beneath the value (e.g. coverage). */
  caption?: string;
  /** Optional secondary line rendered beneath the value (e.g. "$0.42 / serving"). */
  subValue?: string;
}

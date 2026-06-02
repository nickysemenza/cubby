export interface SummaryItem {
  label: string;
  value: string | number;
  formatter?: (value: string | number) => string;
  /** Optional small muted caption rendered beneath the value (e.g. coverage). */
  caption?: string;
}

export interface SummaryItem {
  label: string;
  value: string | number;
  formatter?: (value: string | number) => string;
}

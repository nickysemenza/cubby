import type { FC } from "hono/jsx";
import { Card } from "../admin/layout";

export function formatUSD(dollars: number | null): string {
  return dollars === null ? "—" : `$${dollars.toFixed(2)}`;
}

export const StatCard: FC<{ label: string; value: number }> = ({
  label,
  value,
}) => (
  <Card class="p-4">
    <div class="text-2xl font-bold tabular-nums text-zinc-900">{value}</div>
    <div class="mt-1 truncate text-xs uppercase tracking-wide text-zinc-500">
      {label}
    </div>
  </Card>
);

export const FormError: FC<{ message: string }> = ({ message }) => (
  <div class="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
    {message}
  </div>
);

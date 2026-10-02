import { CalendarIcon } from "@phosphor-icons/react/dist/csr/Calendar";
import type { ReactNode } from "react";

import { formatRelative } from "~/lib/date-format";
import { Row } from "~/ui/layout";

/** `by {manufacturer}` — the standard product-card subtitle. */
export function byManufacturer(manufacturer: string): string {
  return `by ${manufacturer}`;
}

/** Muted "Created N ago" detail row, keyed for use in a `details` array. */
export function createdAgoDetail(createdAt: Date | string | number): ReactNode {
  return (
    <Row
      key="created"
      align="center"
      gap="xs"
      className="text-sm text-muted-foreground"
    >
      <CalendarIcon className="size-3" />
      Created {formatRelative(createdAt)}
    </Row>
  );
}

/** Muted location detail row with the location entity icon. */
/** Inline monospace chip used for UPCs and raw amounts in badge rows. */
export function CodeChip({ children }: { children: ReactNode }) {
  return <code className="bg-muted px-2 py-1 text-sm">{children}</code>;
}

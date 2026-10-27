import { fieldEnvelopeFor } from "@cubby/schemas/field-envelope";
import type { ReactNode } from "react";

import { FieldValueMark } from "./value-mark";

export function FieldRecordValue({
  record,
  field,
  children,
}: {
  record: unknown;
  field: string;
  children: ReactNode;
}) {
  const envelope =
    fieldEnvelopeFor(record, field) ?? fieldEnvelopeFor(record, `${field}Id`);
  return <FieldValueMark envelope={envelope}>{children}</FieldValueMark>;
}

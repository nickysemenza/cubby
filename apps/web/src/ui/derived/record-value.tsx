import {
  fieldEnvelopeFor,
  fieldValueOf,
  type ReadableFieldEnvelope,
} from "@cubby/schemas/field-envelope";
import { parseShortcode } from "@cubby/shared";
import { type ReactNode, useContext } from "react";

import {
  ChangedValue,
  type ValueChange,
  ValueChangeScope,
} from "./value-change";
import { FieldValueMark } from "./value-mark";

/** Compare the field's semantic value, never the record or its work/provenance envelope. */
function semanticChangeValue(value: unknown): ValueChange["value"] {
  if (value === null || value === undefined || typeof value !== "object")
    return typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
      ? value
      : value == null
        ? value
        : undefined;
  let nodes = 0;
  const tooLarge = new Error("Value exceeds change-feedback budget");
  try {
    return JSON.stringify(value, (_key, member: unknown) => {
      if (++nodes > 256 || (typeof member === "string" && member.length > 4096))
        throw tooLarge;
      return member;
    });
  } catch (error) {
    // SILENT: Oversized or cyclic presentation values remain readable without
    // feedback; change detection must not add unbounded work to a cell render.
    if (error === tooLarge || error instanceof TypeError) return undefined;
    throw error;
  }
}

export function FieldRecordValue({
  record,
  field,
  resolution,
  children,
}: {
  record: unknown;
  field: string;
  resolution?: ReadableFieldEnvelope | null;
  children: ReactNode;
}) {
  const scope = useContext(ValueChangeScope);
  const envelope =
    resolution ??
    fieldEnvelopeFor(record, field) ??
    fieldEnvelopeFor(record, `${field}Id`);
  const property = (key: string) => {
    if (typeof record !== "object" || record === null || Array.isArray(record))
      return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor?.get ? descriptor.get.call(record) : descriptor?.value;
  };
  const id: unknown = property("id");
  const value = envelope
    ? envelope.result.kind === "missing"
      ? undefined
      : fieldValueOf(envelope)
    : property(field);
  const parsedId = typeof id === "string" ? parseShortcode(id) : null;
  const change: ValueChange | undefined = parsedId
    ? {
        identity: `${scope}:${parsedId.type}:${parsedId.shortcode}:${field}`,
        value: semanticChangeValue(value),
      }
    : undefined;
  return (
    <FieldValueMark envelope={envelope}>
      <ChangedValue change={change}>{children}</ChangedValue>
    </FieldValueMark>
  );
}

import type { DerivedSidecar } from "@cubby/schemas/derived-value";
import { createContext, useContext, type ReactNode } from "react";
import { z } from "zod";

import { derivedMetaFor } from "./meta";
import { DerivedValue } from "./value-mark";

const Sidecars = createContext<Readonly<Record<string, DerivedSidecar>>>({});
const rowIdentity = z.object({ id: z.string() });
export const DerivedSidecarProvider = Sidecars.Provider;

export function DerivedRecordValue({
  record,
  field,
  children,
}: {
  record: unknown;
  field: string;
  children: ReactNode;
}) {
  const sidecars = useContext(Sidecars);
  const identity = rowIdentity.safeParse(record);
  const sidecar = identity.success ? sidecars[identity.data.id] : undefined;
  const meta = derivedMetaFor(record, field, sidecar);
  return <DerivedValue meta={meta}>{children}</DerivedValue>;
}

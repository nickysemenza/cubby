import { createContext } from "react";

/** Keep the owning virtual row mounted for the lifetime of its editor. */
export const CellEditorRetentionContext = createContext<() => () => void>(
  () => () => undefined,
);

import type { collectionMatrixOut } from "@cubby/schemas/collection";
import type { z } from "zod";

export type CollectionMatrixRow = z.output<
  typeof collectionMatrixOut
>["rows"][number];

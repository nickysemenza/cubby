import type {
  productCreateManyInput,
  productMarkUsdaUnavailableManyInput,
} from "@cubby/schemas/product";
import type { z } from "zod";

import { productStreams } from "~/integrations/tanstack-query/generated/product.gen";

export const createManyProductsStream = (
  input: z.input<typeof productCreateManyInput>,
  signal?: AbortSignal,
) => productStreams.createMany.open(input, { signal });
export const markProductsUsdaUnavailableStream = (
  input: z.input<typeof productMarkUsdaUnavailableManyInput>,
  signal?: AbortSignal,
) => productStreams.markUsdaUnavailableMany.open(input, { signal });
export const backfillProductUpcImagesStream = (signal?: AbortSignal) =>
  productStreams.backfillUPCImages.open(undefined, { signal });

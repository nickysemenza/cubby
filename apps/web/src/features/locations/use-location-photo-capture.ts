import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { scheduleDeferredInvalidation } from "~/lib/deferred-invalidation";

import {
  useEntityPhotoCapture,
  type UseEntityPhotoCaptureOptions,
} from "../photos/use-entity-photo-capture";

/**
 * Location-specific thin wrapper over the generic `useEntityPhotoCapture`. The
 * three step upload→attach→cover sequence (and why its ordering is
 * load-bearing) is documented once, on the generic hook.
 *
 * The only thing location adds: its AI description lands later, off the
 * queue, so a capture also schedules a fixed-delay re-invalidation to pick up
 * the description once it fills in, without a reload. `transport`/
 * `uploadImageOperation` are the same test-only injection seams the generic
 * hook takes — its three production callers never pass them.
 */
export function useLocationPhotoCapture(
  options: Pick<
    UseEntityPhotoCaptureOptions,
    "transport" | "uploadImageOperation"
  > = {},
) {
  const queryClient = useQueryClient();
  const onInvalidated = useCallback(() => {
    scheduleDeferredInvalidation(queryClient, ripple.location);
  }, [queryClient]);

  return useEntityPhotoCapture("location", { ...options, onInvalidated });
}

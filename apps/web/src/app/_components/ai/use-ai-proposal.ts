import { useCallback, useEffect, useRef, useState } from "react";

import { showErrorToast } from "~/components/feedback/error-details";
import type { UnparsedError } from "~/lib/error-utils";

interface AiProposal<T> {
  result: T;
  /** The `basisKey` this result was requested against. */
  basisKey: string;
  /** When the result arrived. */
  at: Date;
}

export interface UseAiProposalResult<T> {
  proposal: AiProposal<T> | null;
  isLoading: boolean;
  request: () => Promise<void>;
  /** Returns the pending result and clears the proposal; null if there is none. */
  accept: () => T | null;
  dismiss: () => void;
}

/**
 * The canonical "request → loading → proposal → accept/dismiss" state
 * machine behind every AI-suggestion surface.
 *
 * A proposal is tied to the `basisKey` it was requested against: a response
 * that arrives after `basisKey` has moved on is dropped rather than shown
 * (the model answered a question nobody is asking anymore), and an existing
 * proposal is cleared the moment `basisKey` itself changes. A `run` that
 * throws surfaces via `showErrorToast` by default.
 *
 * The hook only knows about `basisKey`. A caller that also needs to
 * invalidate on something outside it — e.g. the field the proposal would
 * write to being hand-edited while the proposal sits there — layers that on
 * top with its own effect calling `dismiss()`; see `FieldWithAISuggest`.
 */
export function useAiProposal<T>({
  basisKey,
  run,
  onError,
}: {
  /** Stable serialization of the inputs the model will inspect. */
  basisKey: string;
  run: () => Promise<T>;
  /** Defaults to `showErrorToast(error)`. */
  onError?: (error: UnparsedError) => void;
}): UseAiProposalResult<T> {
  const [proposal, setProposal] = useState<AiProposal<T> | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const basisRef = useRef(basisKey);
  basisRef.current = basisKey;

  // A response is only ever compared against a snapshot taken at request
  // time (see `request` below); this effect covers the case where the basis
  // moves on while no request is in flight — the shown proposal is now an
  // answer to a stale question even though nothing rejected it.
  useEffect(() => {
    setProposal((prior) =>
      prior && prior.basisKey !== basisKey ? null : prior,
    );
  }, [basisKey]);

  const request = useCallback(async () => {
    const requestBasis = basisRef.current;
    setIsLoading(true);
    try {
      const result = await run();
      // A response for a basis that's since moved on is not a proposal
      // anymore.
      if (basisRef.current !== requestBasis) return;
      setProposal({ result, basisKey: requestBasis, at: new Date() });
    } catch (error) {
      if (onError) onError(error);
      else showErrorToast(error);
    } finally {
      setIsLoading(false);
    }
  }, [run, onError]);

  const accept = useCallback((): T | null => {
    if (!proposal) return null;
    setProposal(null);
    return proposal.result;
  }, [proposal]);

  const dismiss = useCallback(() => {
    setProposal(null);
  }, []);

  return { proposal, isLoading, request, accept, dismiss };
}

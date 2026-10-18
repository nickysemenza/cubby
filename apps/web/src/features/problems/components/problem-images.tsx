import type { EntityRef } from "@cubby/schemas/entity";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";

import {
  entityDisplayImageKey,
  EntityDisplayImagesProvider,
} from "~/entity/entity-media/entity-display-images";

type Register = (owner: string, refs: readonly EntityRef[]) => void;

const RegisterContext = createContext<Register | null>(null);

/**
 * One display-image batch for the whole Problems page. Every section mounts at
 * once, so a provider per section would issue one request each; sections
 * register their visible refs here instead and share ⌈refs/50⌉ requests.
 */
export function ProblemImagesProvider({ children }: { children: ReactNode }) {
  const [byOwner, setByOwner] = useState<
    ReadonlyMap<string, readonly EntityRef[]>
  >(() => new Map());
  const register = useCallback<Register>((owner, refs) => {
    setByOwner((previous) => {
      if (!refs.length && !previous.has(owner)) return previous;
      const next = new Map(previous);
      if (refs.length) next.set(owner, refs);
      else next.delete(owner);
      return next;
    });
  }, []);
  const refs = useMemo(() => [...byOwner.values()].flat(), [byOwner]);
  return (
    <RegisterContext.Provider value={register}>
      <EntityDisplayImagesProvider refs={refs}>
        {children}
      </EntityDisplayImagesProvider>
    </RegisterContext.Provider>
  );
}

/** Add a section's rows to the page batch; a no-op outside the provider. */
export function useProblemImageRefs(refs: readonly EntityRef[]) {
  const register = useContext(RegisterContext);
  const owner = useId();
  const key = refs.map(entityDisplayImageKey).join(",");
  useEffect(() => {
    if (!register) return;
    register(owner, refs);
    return () => register(owner, []);
    // `key` is the logical identity of `refs`; a freshly mapped array with the
    // same records must not re-register.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [register, owner, key]);
}

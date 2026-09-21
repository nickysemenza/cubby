import {
  SMART_COLLECTION_STARTERS,
  smartCollectionDefinition,
  smartCollectionKey,
  type SmartCollectionDefinition,
  type SmartCollectionKey,
  type SmartCollectionRule,
} from "@cubby/schemas/collection";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type SmartCollectionRuleDraft = {
  id: string;
  kind: SmartCollectionRule["kind"];
  value: string;
};

export type SmartCollectionDraft = {
  key: SmartCollectionKey;
  name: string;
  rules: SmartCollectionRuleDraft[];
};

type SmartCollectionState = {
  drafts: Record<SmartCollectionKey, SmartCollectionDraft>;
  validDefinitions: Record<SmartCollectionKey, SmartCollectionDefinition>;
  updateDraft: (
    key: SmartCollectionKey,
    update: (draft: SmartCollectionDraft) => SmartCollectionDraft,
  ) => void;
  reset: (key: SmartCollectionKey) => void;
};

function findStarter(key: SmartCollectionKey): SmartCollectionDefinition {
  const starter = SMART_COLLECTION_STARTERS.find(
    (definition) => definition.key === key,
  );
  if (!starter) throw new Error(`Missing smart Collection starter: ${key}`);
  return starter;
}

const starterByKey = {
  painting: findStarter("painting"),
  measuring: findStarter("measuring"),
  festool: findStarter("festool"),
} satisfies Record<SmartCollectionKey, SmartCollectionDefinition>;

function cloneDefinition(
  definition: SmartCollectionDefinition,
): SmartCollectionDefinition {
  return {
    ...definition,
    rules: definition.rules.map((rule) => ({ ...rule })),
  };
}

function toDraft(definition: SmartCollectionDefinition): SmartCollectionDraft {
  return {
    key: smartCollectionKey.parse(definition.key),
    name: definition.name,
    rules: definition.rules.map((rule, index) => ({
      id: `starter-${definition.key}-${index}`,
      kind: rule.kind,
      value: rule.value,
    })),
  };
}

function starterDrafts() {
  return {
    painting: toDraft(starterByKey.painting),
    measuring: toDraft(starterByKey.measuring),
    festool: toDraft(starterByKey.festool),
  } satisfies Record<SmartCollectionKey, SmartCollectionDraft>;
}

function starterDefinitions() {
  return {
    painting: cloneDefinition(starterByKey.painting),
    measuring: cloneDefinition(starterByKey.measuring),
    festool: cloneDefinition(starterByKey.festool),
  } satisfies Record<SmartCollectionKey, SmartCollectionDefinition>;
}

export function parseSmartCollectionDraft(draft: SmartCollectionDraft) {
  return smartCollectionDefinition.safeParse({
    key: draft.key,
    name: draft.name,
    rules: draft.rules.map(({ kind, value }) => ({ kind, value })),
  });
}

const SmartCollectionContext = createContext<SmartCollectionState | null>(null);

export function SmartCollectionProvider({ children }: { children: ReactNode }) {
  const [drafts, setDrafts] = useState(starterDrafts);
  const [validDefinitions, setValidDefinitions] = useState(starterDefinitions);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setValidDefinitions((current) => {
        let changed = false;
        const next = { ...current };
        for (const key of smartCollectionKey.options) {
          const parsed = parseSmartCollectionDraft(drafts[key]);
          if (!parsed.success) continue;
          if (JSON.stringify(current[key]) === JSON.stringify(parsed.data)) {
            continue;
          }
          next[key] = cloneDefinition(parsed.data);
          changed = true;
        }
        return changed ? next : current;
      });
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [drafts]);

  const updateDraft = useCallback<SmartCollectionState["updateDraft"]>(
    (key, update) => {
      setDrafts((current) => ({
        ...current,
        [key]: update(current[key]),
      }));
    },
    [],
  );

  const reset = useCallback((key: SmartCollectionKey) => {
    const starter = starterByKey[key];
    setDrafts((current) => ({ ...current, [key]: toDraft(starter) }));
    setValidDefinitions((current) => ({
      ...current,
      [key]: cloneDefinition(starter),
    }));
  }, []);

  const value = useMemo(
    () => ({ drafts, validDefinitions, updateDraft, reset }),
    [drafts, reset, updateDraft, validDefinitions],
  );

  return (
    <SmartCollectionContext value={value}>{children}</SmartCollectionContext>
  );
}

export function useSmartCollections(): SmartCollectionState {
  const value = useContext(SmartCollectionContext);
  if (!value) {
    throw new Error("useSmartCollections requires SmartCollectionProvider");
  }
  return value;
}

export function getSmartCollectionStarter(
  key: SmartCollectionKey,
): SmartCollectionDefinition {
  return starterByKey[key];
}

export function isStarterDefinition(draft: SmartCollectionDraft): boolean {
  return (
    JSON.stringify(draft) === JSON.stringify(toDraft(starterByKey[draft.key]))
  );
}

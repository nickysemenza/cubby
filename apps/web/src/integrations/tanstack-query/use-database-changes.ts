import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { useHydrated } from "~/ui/hooks/use-hydrated";

import { subscribeDatabaseChanges } from "./database-changes";

export function useDatabaseChanges() {
  const client = useQueryClient();
  const hydrated = useHydrated();
  useEffect(() => {
    if (hydrated) return subscribeDatabaseChanges(client);
  }, [client, hydrated]);
}

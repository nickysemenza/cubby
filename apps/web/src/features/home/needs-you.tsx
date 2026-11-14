import { useQuery } from "@tanstack/react-query";

import { machinery } from "~/integrations/tanstack-query/generated/domains/machinery.gen";
export { NeedsYou } from "~/entity/machinery/needs-you";

/** Home, Work and navigation share the member-gap read. */
export function useNeedsYou() {
  return useQuery(machinery.needsYou.queryOptions({}));
}

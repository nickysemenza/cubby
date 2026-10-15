import { EMAIL_LINK_STATE_LABEL } from "@cubby/schemas/email-fields";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { cn } from "~/lib/utils";
import { createCubbyColumnCollection } from "~/ui/data-table/table-features";
import { NoneValue } from "~/ui/primitives/none-value";
import { TruncatedList } from "~/ui/truncated-list";

import type { ListRenderer } from "../list-renderer-types";

const STATE_CLASS = {
  linked: "text-positive",
  suggested: "text-warning-ink",
  dismissed:
    "text-muted-foreground line-through decoration-muted-foreground/50",
} as const;

/**
 * Each related Purchase with its own link state: on a Vendor page one Email
 * can be linked to one order and dismissed for another.
 */
const purchaseLinks: ListRenderer<"email"> = (helper) =>
  createCubbyColumnCollection((add) => {
    add(
      helper.accessor("purchaseLinks", {
        id: "purchaseLinks",
        header: "Purchases",
        enableSorting: false,
        meta: { className: "w-56", mobile: { slot: "meta", priority: 40 } },
        cell: (info) => {
          const links = info.getValue();
          if (!links.length) return <NoneValue />;
          return (
            <TruncatedList
              items={links}
              maxItems={2}
              renderItem={(link) => (
                <span
                  key={link.purchaseId}
                  className="inline-flex items-center gap-1"
                >
                  <EntityRefLink
                    variant="chip"
                    entity="purchase"
                    id={link.purchaseId}
                    name={link.purchaseId}
                    displayImage={null}
                    compact
                  />
                  <span className={cn("text-2xs", STATE_CLASS[link.state])}>
                    {EMAIL_LINK_STATE_LABEL[link.state]}
                  </span>
                </span>
              )}
            />
          );
        },
      }),
    );
  });

export const emailListRenderers = {
  "purchase-links": purchaseLinks,
};

import type { VendorShortcode } from "@cubby/schemas/identifiers";
import type { SenderAttribution } from "@cubby/schemas/mail-coverage";
import { humanize } from "@cubby/shared";
import { useState } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { useActionMutation } from "~/entity/hooks/use-action-mutation";
import { Picker } from "~/entity/picker/picker";
import { vendor } from "~/integrations/tanstack-query/generated/domains/vendor.gen";
import { broadcastSender } from "~/lib/vendor/domains";
import type { ComboboxItem } from "~/ui/combobox/combobox-types";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";

/** Evidence remains on the original records; this control edits only the exact-address decision. */
export function SenderAttributionDetails({
  attribution,
  onSaved,
  vendors,
}: {
  attribution: SenderAttribution;
  vendors: SenderAttribution["vendors"];
  onSaved?: () => void;
}) {
  const owner = attribution.vendors.find(
    (row) => row.id === attribution.vendorId,
  );
  const [selected, setSelected] =
    useState<ComboboxItem<VendorShortcode> | null>(
      owner ? { id: owner.id, name: owner.name } : null,
    );
  const save = useActionMutation({
    mutationFn: vendor.setSender.mutationOptions,
    success: "Sender attribution saved",
    onSuccess: onSaved,
  });
  const submit = (vendorId: VendorShortcode | null) =>
    save.mutate({
      sender: attribution.sender,
      vendorId,
      expectedVendorIds: attribution.vendors.map((row) => row.id),
    });
  return (
    <section className="space-y-3" aria-label="Sender attribution">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">Seller attribution</h3>
        <Badge variant="outline">{humanize(attribution.state)}</Badge>
      </div>
      <p className="text-sm break-all select-text">{attribution.sender}</p>
      {attribution.vendors.length > 0 ? (
        <p className="text-xs">
          Saved on{" "}
          {attribution.vendors.map((row) => (
            <EntityRefLink
              key={row.id}
              entity="vendor"
              id={row.id}
              name={row.name}
            />
          ))}{" "}
          ·{" "}
          {attribution.origin === "learned"
            ? "Learned from accepted receipt evidence"
            : "Member address decision"}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        An assigned address identifies one seller and is searched for that
        Vendor. A shared domain alone never identifies a seller.
      </p>
      {attribution.state === "disputed" ? (
        <p className="text-xs">
          Sender proof is suspended. Review the conflicting originals and
          Purchases below; confirming a Vendor does not erase conflicting source
          evidence.
        </p>
      ) : null}
      {broadcastSender(attribution.sender) ? (
        <p className="text-xs">
          This is a known generic address. Each receipt must establish its own
          seller.
        </p>
      ) : (
        <>
          <Picker<VendorShortcode>
            entity="vendor"
            label="Seller Vendor"
            items={vendors}
            value={selected}
            setValue={setSelected}
          />
          <Button
            size="sm"
            disabled={!selected || save.isPending}
            onClick={() => selected && submit(selected.id)}
          >
            Confirm Vendor
          </Button>
        </>
      )}
      {attribution.vendors.length > 0 ? (
        <Button
          size="sm"
          variant="outline"
          disabled={save.isPending}
          onClick={() => submit(null)}
        >
          Remove attribution · use receipt sellers
        </Button>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Saved decisions apply to future and eligible unresolved retained mail.
        Paused, excluded or previously blocked imports keep their existing Run
        controls. Previously imported Purchases are never rewritten here.
      </p>
      <h3 className="text-sm font-semibold">
        Accepted receipt evidence · {attribution.evidenceCount}
      </h3>
      {attribution.evidence.length ? (
        <>
          <p className="text-xs text-muted-foreground">
            Showing {attribution.evidence.length} of {attribution.evidenceCount}{" "}
            accepted source links. These are local retained records, not Gmail
            coverage totals.
          </p>
          <ul className="space-y-2 text-xs">
            {attribution.evidence.map((row) => (
              <li
                key={`${row.emailId}/${row.purchaseId}`}
                className="flex flex-wrap gap-2"
              >
                <EntityRefLink entity="email" id={row.emailId} />
                <EntityRefLink entity="purchase" id={row.purchaseId} />
                <EntityRefLink
                  entity="vendor"
                  id={row.vendorId}
                  name={row.vendorName}
                />
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          No current accepted receipt evidence is recorded for this exact
          address.
        </p>
      )}
    </section>
  );
}

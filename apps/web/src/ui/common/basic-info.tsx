import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { type FC, type ReactNode, useId, useState } from "react";

import { Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";

import { Ledger, LedgerCell, LedgerRow } from "./ledger";

export interface BasicInfoField {
  label: string;
  value: ReactNode;
  /** Secondary browse/filter action kept outside editable values and links. */
  filterAction?: ReactNode;
  /** Quiet provenance beside the value; wraps within the value slot when needed. */
  caption?: ReactNode;
  hide?: boolean;
  explanation?: ReactNode;
  quality?: ReactNode;
  anchor?: string;
  /** Prose gets the full fact-grid width instead of a narrow value column. */
  fullWidth?: boolean;
}

interface BasicInfoProps {
  fields: BasicInfoField[];
  header?: ReactNode;
  footer?: ReactNode;
  actions?: ReactNode;
}

export const BasicInfo: FC<BasicInfoProps> = ({
  fields,
  header,
  footer,
  actions,
}) => {
  const visibleFields = fields.filter((f) => !f.hide && f.value !== undefined);

  return (
    <Stack gap="sm">
      {header}
      <Ledger as="dl" variant="facts">
        {visibleFields.map((field) => (
          <BasicInfoRow key={field.label} field={field} />
        ))}
      </Ledger>
      {footer}
      {actions && <div className="pt-2">{actions}</div>}
    </Stack>
  );
};

function BasicInfoRow({ field }: { field: BasicInfoField }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <LedgerRow as="div" id={field.anchor} data-full-width={field.fullWidth}>
      <LedgerCell
        as="dt"
        slot="primary"
        data-slot="basic-info-label"
        className="text-muted-foreground"
      >
        {field.label}
      </LedgerCell>
      <LedgerCell as="dd" slot="secondary" data-slot="basic-info-value">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 break-words [&>*]:max-w-full [&>*]:min-w-0">
          {field.value}
          {field.caption && (
            <span className="min-w-0 text-xs text-muted-foreground">
              {field.caption}
            </span>
          )}
        </div>
        {field.quality ? <div className="mt-0.5">{field.quality}</div> : null}
      </LedgerCell>
      {(field.filterAction || field.explanation) && (
        <LedgerCell as="dd" slot="actions">
          <div className="flex flex-wrap items-center justify-end gap-2">
            {field.filterAction}
            {field.explanation ? (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`How ${field.label.toLowerCase()} is determined`}
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => setOpen(!open)}
              >
                <InfoIcon className="size-3.5" />
              </Button>
            ) : null}
          </div>
        </LedgerCell>
      )}
      {field.explanation && open ? (
        <LedgerCell
          as="dd"
          slot="detail"
          id={panelId}
          className="border-t border-border py-2"
        >
          {field.explanation}
        </LedgerCell>
      ) : null}
    </LedgerRow>
  );
}

import type { PersonOut } from "@cubby/schemas/person";
import { Clock, Info } from "lucide-react";
import { useState } from "react";
import { AuditLogList } from "~/app/_components/audit-log/audit-log-list";
import { DetailSections } from "~/app/_components/data-table/detail-page";
import { useEntityDelete } from "~/app/_components/hooks/useEntityDelete";
import { BasicInfo } from "~/components/common/basic-info";
import { Page } from "~/components/page/Page";
import { DetailEditAction } from "~/components/ui/detail-edit-action";
import { personEditRequest } from "~/entities/editing/editor-requests";
import { EntityEditDialog } from "~/entities/editing/entity-edit-dialog";
import { useTRPC } from "~/integrations/trpc/react";
import { personMutationInvalidateKeys } from "~/lib/query-keys";

export function PersonDetail({ person }: { person: PersonOut }) {
  const api = useTRPC();
  const [editOpen, setEditOpen] = useState(false);
  const { deleteButton, deleteDialog } = useEntityDelete({
    id: person.id,
    name: person.name,
    entity: "person",
    entityLabel: "Person",
    mutationOptions: api.person.delete.mutationOptions,
    invalidateKeys: personMutationInvalidateKeys,
    redirectTo: "/people",
  });
  return (
    <Page
      variant="detail"
      entity="person"
      title={person.name}
      rawData={person}
      heroActions={{
        primary: <DetailEditAction onClick={() => setEditOpen(true)} />,
        secondary: deleteButton,
      }}
    >
      <DetailSections
        rawData={person}
        sections={[
          {
            id: "overview",
            title: "Overview",
            icon: Info,
            placement: "primary",
            content: (
              <BasicInfo
                fields={[
                  { label: "Name", value: person.name },
                  { label: "Kind", value: person.kind },
                  {
                    label: "Linked login",
                    value: person.linkedUser
                      ? `${person.linkedUser.name} · ${person.linkedUser.email}`
                      : "—",
                  },
                  { label: "Notes", value: person.notes ?? "—" },
                ]}
              />
            ),
          },
          {
            id: "history",
            title: "History",
            icon: Clock,
            placement: "supporting",
            content: (
              <AuditLogList
                entityType="person"
                entityId={person.id}
                showEntityLink={false}
              />
            ),
          },
        ]}
      />
      <EntityEditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        request={personEditRequest(person)}
      />
      {deleteDialog}
    </Page>
  );
}

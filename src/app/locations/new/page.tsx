import { NewLocation } from "~/app/_components/locations/new-location";
import { PageWrapper } from "~/components/ui/page-wrapper";

export const metadata = {
  title: "Create New Location",
};

export default function NewLocationPage() {
  return (
    <PageWrapper>
      <NewLocation />
    </PageWrapper>
  );
}

import { NewLocation } from "~/app/_components/locations/new-location";
import { PageWrapper } from "~/components/layout/page-wrapper";

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

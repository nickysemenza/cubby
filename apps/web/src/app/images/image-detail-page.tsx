import { useQuery } from "@tanstack/react-query";
import { ImageDetail } from "~/app/_components/images/image-detail";
import { Row, Stack } from "~/components/layout";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { useTRPC } from "~/trpc/react";

interface ImageDetailPageProps {
  id: string;
}

export default function ImageDetailPage({ id }: ImageDetailPageProps) {
  const api = useTRPC();

  const {
    data: imageDetails,
    isLoading,
    error,
  } = useQuery(api.image.getImageById.queryOptions({ id }));

  if (isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Row align="center" gap="sm">
          <div className="h-4 w-4 animate-spin rounded-full border-foreground border-t-2 border-b-2"></div>
          <span>Loading image details...</span>
        </Row>
      </div>
    );
  }

  if (error || !imageDetails) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="text-center">
          <h2 className="font-semibold text-xl">Image Not Found</h2>
          <p className="mt-2 text-muted-foreground">
            The image you are looking for does not exist.
          </p>
        </div>
      </div>
    );
  }

  return (
    <PageWrapper>
      <Stack gap="lg">
        <div className="flex items-center justify-between">
          <h1 className="font-bold text-3xl tracking-tight">Image Details</h1>
        </div>
        <ImageDetail image={imageDetails} />
      </Stack>
    </PageWrapper>
  );
}

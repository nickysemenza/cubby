import { useQuery } from "@tanstack/react-query";
import { ImageDetail } from "~/app/_components/images/image-detail";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { image } from "~/entities/image.functions";

interface ImageDetailPageProps {
  shortcode: string;
}

export default function ImageDetailPage({ shortcode }: ImageDetailPageProps) {
  const {
    data: imageDetails,
    isLoading,
    error,
  } = useQuery(image.detail.queryOptions({ id: shortcode }));

  if (isLoading) {
    return (
      <Page variant="list" title="Image details" entity="image" compact>
        <SimpleLoading text="Loading image details..." />
      </Page>
    );
  }

  if (error || !imageDetails) {
    return (
      <Page variant="list" title="Image not found" entity="image" compact>
        <div className="flex min-h-[40vh] items-center justify-center">
          <Stack gap="xs" className="text-center">
            <h2 className="font-semibold text-xl">Image not found</h2>
            <p className="mt-2 text-muted-foreground">
              The image you are looking for does not exist.
            </p>
          </Stack>
        </div>
      </Page>
    );
  }

  return (
    <Page
      variant="detail"
      entity="image"
      title={imageDetails.filename || "Image"}
      rawData={imageDetails}
    >
      <ImageDetail image={imageDetails} />
    </Page>
  );
}

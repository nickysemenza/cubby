import CubbyKit
import SwiftUI

#if os(iOS)
    import UIKit
#endif

/// An image ready for presentation. Local selections deliberately have no Image-record link.
struct PhotoAttachment: Identifiable {
    enum Source { case local(CGImage), remote(URL) }
    let id: String
    let filename: String
    let source: Source
    var imageID: String? = nil
    var status: String? = nil
}

struct PhotoAttachmentImage: View {
    let photo: PhotoAttachment
    /// The box's point width this image renders at, or nil for an unbounded original (the
    /// full-size preview). Forwarded to `ImageTransform.transformed` so a given rendered size
    /// always requests the same CF-transformed rung as the web client.
    let renderedWidth: CGFloat?
    @State private var retry = 0

    var body: some View {
        switch photo.source {
        case .local(let image):
            Image(image, scale: 1, label: Text(photo.filename)).resizable().scaledToFit()
        case .remote(let url):
            let displayURL = renderedWidth.map { ImageTransform.transformed(url, renderedWidth: $0) } ?? url
            AsyncImage(url: displayURL) { phase in
                switch phase {
                case .success(let image): image.resizable().scaledToFit()
                case .failure:
                    VStack {
                        Image(systemName: "photo.badge.exclamationmark")
                        Button("Retry photo") { retry += 1 }
                    }
                default: LoadingIndicator(label: "Loading photo")
                }
            }
            .id(retry)
            .accessibilityLabel(photo.filename)
        }
    }
}

struct PhotoBatch: View {
    let photos: [PhotoAttachment]
    var onRemove: ((String) -> Void)? = nil
    @State private var selection: Selection?
    private struct Selection: Identifiable { let id: String }

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 110), spacing: 8)], spacing: 8) {
            ForEach(photos) { photo in
                VStack(alignment: .leading, spacing: 4) {
                    Button {
                        selection = Selection(id: photo.id)
                    } label: {
                        PhotoAttachmentImage(photo: photo, renderedWidth: 160)
                            .frame(maxWidth: .infinity).frame(height: 110)
                            .background(PorcelainTokens.inset)
                            .clipShape(RoundedRectangle(cornerRadius: PorcelainTokens.radiusPanel))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Preview \(photo.filename)")
                    if let status = photo.status { Text(status).font(.caption).foregroundStyle(.secondary) }
                    if let onRemove {
                        Button("Remove", role: .destructive) { onRemove(photo.id) }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("Remove \(photo.filename)")
                    }
                }
            }
        }
        .photoPreviewPresentation(item: $selection) {
            PhotoPreview(photos: photos, selectedID: $0.id)
        }
    }
}

struct PhotoPreview: View {
    let photos: [PhotoAttachment]
    @State private var index: Int
    @Environment(\.dismiss) private var dismiss

    init(photos: [PhotoAttachment], selectedID: String) {
        self.photos = photos
        // Presented via `.photoPreviewPresentation(item:)`, whose item id IS `selectedID` — the
        // presentation identity and the value seeding `index` are the same value, so they can't
        // diverge across a re-presentation.
        _index = State(initialValue: photos.firstIndex(where: { $0.id == selectedID }) ?? 0)  // state-init-ok
    }

    var body: some View {
        NavigationStack {
            if photos.indices.contains(index) {
                let photo = photos[index]
                VStack(spacing: 12) {
                    PhotoAttachmentImage(photo: photo, renderedWidth: nil)
                        .id(photo.id)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    HStack {
                        Button {
                            index -= 1
                        } label: {
                            Label("Previous", systemImage: "chevron.left")
                        }
                        .disabled(index == 0)
                        .accessibilityIdentifier("photo.preview.previous")
                        Spacer()
                        Text("\(index + 1) of \(photos.count)").foregroundStyle(.secondary)
                        Spacer()
                        Button {
                            index += 1
                        } label: {
                            Label("Next", systemImage: "chevron.right")
                        }
                        .disabled(index + 1 == photos.count)
                        .accessibilityIdentifier("photo.preview.next")
                    }
                    if let imageID = photo.imageID {
                        NavigationLink {
                            ImageEntityDetailView(id: ImageCode(imageID))
                        } label: {
                            Label("View Image details", systemImage: "info.circle")
                        }
                        .accessibilityIdentifier("photo.preview.details")
                    }
                }
                .padding()
                .navigationTitle(photo.filename)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") { dismiss() }
                            .accessibilityIdentifier("photo.preview.close")
                    }
                }
            }
        }
    }
}

extension View {
    /// Photo viewing fills an iPhone and remains a bounded page on larger Apple platforms.
    func photoPreviewPresentation<Destination: View>(
        isPresented: Binding<Bool>,
        @ViewBuilder content: @escaping () -> Destination
    ) -> some View {
        modifier(PhotoPreviewBooleanPresentation(isPresented: isPresented, destination: content))
    }

    func photoPreviewPresentation<Item: Identifiable, Destination: View>(
        item: Binding<Item?>,
        @ViewBuilder content: @escaping (Item) -> Destination
    ) -> some View {
        modifier(PhotoPreviewItemPresentation(item: item, destination: content))
    }
}

private struct PhotoPreviewBooleanPresentation<Destination: View>: ViewModifier {
    @Binding var isPresented: Bool
    let destination: () -> Destination

    @ViewBuilder
    func body(content: Content) -> some View {
        #if os(iOS)
            if UIDevice.current.userInterfaceIdiom == .phone {
                content.fullScreenCover(isPresented: $isPresented, content: destination)
            } else {
                content.sheet(isPresented: $isPresented) { destination().nativeSheet(.preview) }
            }
        #else
            content.sheet(isPresented: $isPresented) { destination().nativeSheet(.preview) }
        #endif
    }
}

private struct PhotoPreviewItemPresentation<Item: Identifiable, Destination: View>: ViewModifier {
    @Binding var item: Item?
    let destination: (Item) -> Destination

    @ViewBuilder
    func body(content: Content) -> some View {
        #if os(iOS)
            if UIDevice.current.userInterfaceIdiom == .phone {
                content.fullScreenCover(item: $item, content: destination)
            } else {
                content.sheet(item: $item) { destination($0).nativeSheet(.preview) }
            }
        #else
            content.sheet(item: $item) { destination($0).nativeSheet(.preview) }
        #endif
    }
}

#Preview {
    PhotoBatch(photos: [])
        .padding()
        .porcelainScreen()
}

import CubbyKit
import SwiftUI

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
    @State private var retry = 0

    var body: some View {
        switch photo.source {
        case .local(let image):
            Image(decorative: image, scale: 1).resizable().scaledToFit()
                .accessibilityLabel(photo.filename)
        case .remote(let url):
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image): image.resizable().scaledToFit()
                case .failure:
                    VStack {
                        Image(systemName: "photo.badge.exclamationmark")
                        Button("Retry photo") { retry += 1 }
                    }
                default: ProgressView()
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
                        PhotoAttachmentImage(photo: photo)
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
        .sheet(item: $selection) { PhotoPreview(photos: photos, selectedID: $0.id) }
    }
}

struct PhotoPreview: View {
    let photos: [PhotoAttachment]
    @State private var index: Int
    @Environment(\.dismiss) private var dismiss

    init(photos: [PhotoAttachment], selectedID: String) {
        self.photos = photos
        _index = State(initialValue: photos.firstIndex(where: { $0.id == selectedID }) ?? 0)
    }

    var body: some View {
        NavigationStack {
            if photos.indices.contains(index) {
                let photo = photos[index]
                VStack(spacing: 12) {
                    PhotoAttachmentImage(photo: photo)
                        .id(photo.id)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    HStack {
                        Button {
                            index -= 1
                        } label: {
                            Label("Previous", systemImage: "chevron.left")
                        }
                        .disabled(index == 0)
                        Spacer()
                        Text("\(index + 1) of \(photos.count)").foregroundStyle(.secondary)
                        Spacer()
                        Button {
                            index += 1
                        } label: {
                            Label("Next", systemImage: "chevron.right")
                        }
                        .disabled(index + 1 == photos.count)
                    }
                    if let imageID = photo.imageID {
                        NavigationLink {
                            EntityDetailView(key: .image, id: imageID)
                        } label: {
                            Label("View Image details", systemImage: "info.circle")
                        }
                    }
                }
                .padding()
                .navigationTitle(photo.filename)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            }
        }
        #if os(macOS)
            .frame(minWidth: 520, idealWidth: 800, minHeight: 440, idealHeight: 680)
        #endif
    }
}

#Preview {
    PhotoBatch(photos: [])
        .padding()
        .porcelainScreen()
}

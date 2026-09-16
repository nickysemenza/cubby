import CubbyKit
import SwiftUI

/// The editor's photo section: the record's existing images in `model.imageOrder` (drag to
/// reorder, swipe to remove), the photos picked this session, and the shared camera/library
/// buttons. Picked photos upload on save (`PendingImageUploader`), so create mode carries them
/// too. Selection keeps capture dates, which the host reads for its `observedOn` suggestion.
struct EntityImageBlock: View {
    @Bindable var model: GenericEntityEditModel
    @Binding var selections: [PhotoSelectionItem]
    let uploadStatus: String?
    let disabled: Bool

    private static let maxPhotos = 20

    private var existing: [ImageCode: (url: URL?, filename: String)] {
        var map: [ImageCode: (URL?, String)] = [:]
        for attachment in model.original?["attachments"]?.arrayValue ?? [] {
            guard let id = attachment["id"]?.stringValue else { continue }
            map[ImageCode(id)] = (
                attachment["url"]?.stringValue.flatMap(URL.init(string:)),
                attachment["filename"]?.stringValue ?? id
            )
        }
        return map
    }

    var body: some View {
        Section {
            let existing = existing
            ForEach(model.imageOrder, id: \.rawValue) { id in
                HStack(spacing: PorcelainTokens.Space.md) {
                    Thumb(url: existing[id]?.url, size: 48)
                    Text(existing[id]?.filename ?? id.rawValue).lineLimit(1)
                    Spacer()
                }
                .frame(minHeight: PorcelainTokens.touchTarget)
                .swipeActions(edge: .trailing) {
                    Button("Remove", role: .destructive) { remove(id) }
                }
                .contextMenu {
                    Button("Remove", role: .destructive) { remove(id) }
                }
                .accessibilityLabel("Photo \(existing[id]?.filename ?? id.rawValue)")
                .accessibilityHint("Drag to reorder; swipe to remove")
            }
            .onMove { offsets, destination in
                model.imageOrder.move(fromOffsets: offsets, toOffset: destination)
            }
            .onDelete { offsets in
                for id in offsets.map({ model.imageOrder[$0] }) { remove(id) }
            }
            .disabled(disabled)
            ForEach(selections) { item in
                HStack(spacing: PorcelainTokens.Space.md) {
                    Image(item.preview, scale: 1, label: Text("New photo"))
                        .resizable()
                        .scaledToFill()
                        .frame(width: 48, height: 48)
                        .clipShape(RoundedRectangle(cornerRadius: PorcelainTokens.radiusControl))
                    VStack(alignment: .leading) {
                        Text("New photo")
                        if let day = item.capturedAt {
                            Text(day.formatted(date: .abbreviated, time: .omitted))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    Button("Remove", systemImage: "xmark.circle.fill") {
                        selections.removeAll { $0.id == item.id }
                    }
                    .labelStyle(.iconOnly)
                    .foregroundStyle(.secondary)
                    .buttonStyle(.borderless)
                    .disabled(disabled)
                    .accessibilityLabel("Remove new photo")
                }
                .frame(minHeight: PorcelainTokens.touchTarget)
            }
            if remainingCapacity > 0 {
                PhotoSourceButtons(maxSelectionCount: remainingCapacity) { items in
                    selections.append(contentsOf: items)
                }
                .disabled(disabled)
            }
            if let uploadStatus { Text(uploadStatus).font(.porcelainLabel) }
        } header: {
            HStack {
                Text("Photos")
                Spacer()
                #if os(iOS)
                    if model.imageOrder.count > 1 { EditButton().font(.caption) }
                #endif
            }
        }
    }

    private var remainingCapacity: Int {
        max(0, Self.maxPhotos - model.imageOrder.count - selections.count)
    }

    private func remove(_ id: ImageCode) {
        model.removedImages.insert(id)
        model.imageOrder.removeAll { $0 == id }
    }
}

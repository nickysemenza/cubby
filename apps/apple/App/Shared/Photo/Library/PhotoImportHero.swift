import CoreGraphics
import CubbyKit
import SwiftUI

/// The shared photo treatment for the import workbench. The grid preview is available
/// immediately, while the selected image is decoded to a bounded hero size in a cancellable task.
/// Keeping the viewer here means route selection and creation never lose the photo context.
struct PhotoImportHero: View {
    let items: [PhotoSelectionItem]
    let selectedIDs: Set<String>
    let onToggle: ((String) -> Void)?

    @State private var focusedID: String
    @State private var showingFullScreen = false

    init(
        items: [PhotoSelectionItem], selectedIDs: Set<String> = [],
        onToggle: ((String) -> Void)? = nil
    ) {
        self.items = items
        self.selectedIDs = selectedIDs
        self.onToggle = onToggle
        _focusedID = State(initialValue: items.first?.id ?? "")
    }

    private var focusedItem: PhotoSelectionItem? {
        items.first(where: { $0.id == focusedID }) ?? items.first
    }

    var body: some View {
        if let focusedItem {
            VStack(spacing: 8) {
                Button {
                    showingFullScreen = true
                } label: {
                    ZStack(alignment: .bottomTrailing) {
                        PhotoImportProgressiveImage(item: focusedItem, maxPixelSize: 1_800)
                            .frame(maxWidth: .infinity)
                            .frame(height: 270)
                            .background(.black.opacity(0.92))
                            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                        Label("Inspect full screen", systemImage: "arrow.up.left.and.arrow.down.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 8)
                            .background(.black.opacity(0.65), in: Capsule())
                            .padding(12)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Photo preview")
                .accessibilityHint("Opens a full-screen photo viewer")
                .accessibilityIdentifier("photos.import.hero")

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(items) { item in
                            Button {
                                focusedID = item.id
                                onToggle?(item.id)
                            } label: {
                                PhotoImportProgressiveImage(
                                    item: item, maxPixelSize: 220, loadsImmediately: false
                                )
                                .frame(width: 64, height: 64)
                                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                                .overlay {
                                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                                        .stroke(
                                            item.id == focusedItem.id ? Color.accentColor : .clear,
                                            lineWidth: 3)
                                }
                                .overlay(alignment: .topTrailing) {
                                    if onToggle != nil {
                                        Image(
                                            systemName: selectedIDs.contains(item.id)
                                                ? "checkmark.circle.fill" : "circle"
                                        )
                                        .foregroundStyle(
                                            selectedIDs.contains(item.id) ? .white : .secondary,
                                            selectedIDs.contains(item.id) ? .blue : .white
                                        )
                                        .padding(3)
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(
                                "Photo \(items.firstIndex(where: { $0.id == item.id }).map { $0 + 1 } ?? 0)"
                            )
                            .accessibilityValue(
                                item.id == focusedItem.id
                                    ? (selectedIDs.contains(item.id) ? "Focused, selected" : "Focused")
                                    : (selectedIDs.contains(item.id) ? "Selected" : "Not selected")
                            )
                            .accessibilityHint(
                                onToggle == nil
                                    ? "Double tap to inspect this photo"
                                    : "Double tap to focus and change selection"
                            )
                            .accessibilityAddTraits(item.id == focusedItem.id ? .isSelected : [])
                            .accessibilityIdentifier("photos.import.filmstrip.\(item.id)")
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 4)
                }
                .frame(minHeight: 72)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(.bar)
            .photoImportViewer(
                isPresented: $showingFullScreen,
                items: items,
                initialID: focusedItem.id
            )
        }
    }
}

private struct PhotoImportProgressiveImage: View {
    let item: PhotoSelectionItem
    let maxPixelSize: Int
    let loadsImmediately: Bool
    let fullResolution: Bool
    @State private var image: CGImage?
    @State private var failed = false
    @State private var zoomScale = 1.0
    @State private var magnificationStart = 1.0

    init(
        item: PhotoSelectionItem, maxPixelSize: Int, loadsImmediately: Bool = true,
        fullResolution: Bool = false
    ) {
        self.item = item
        self.maxPixelSize = maxPixelSize
        self.loadsImmediately = loadsImmediately
        self.fullResolution = fullResolution
    }

    var body: some View {
        ZStack {
            Image(decorative: image ?? item.preview, scale: 1)
                .resizable()
                .scaledToFit()
                .scaleEffect(zoomScale)
                .accessibilityHidden(true)
            if loadsImmediately, image == nil, !failed {
                ProgressView()
                    .tint(.white)
                    .accessibilityLabel("Loading full-resolution photo")
            } else if failed {
                Label("Preview unavailable", systemImage: "photo.badge.exclamationmark")
                    .font(.caption)
                    .foregroundStyle(.white)
                    .padding(8)
                    .background(.black.opacity(0.65), in: Capsule())
            }
        }
        .task(id: "\(item.id)-\(maxPixelSize)-\(fullResolution)") {
            guard loadsImmediately else { return }
            // The task id changes with the item. Reset here as well as in
            // `onChange` so task/onChange scheduling can never preserve the
            // previous item's pixels or skip the replacement decode.
            image = nil
            failed = false
            do {
                let file = try await item.materialize()
                let decoded = try await Task.detached(priority: .userInitiated) {
                    if fullResolution {
                        return try file.decodeFullResolution()
                    }
                    return try file.thumbnail(maxPixelSize: maxPixelSize)
                }.value
                guard !Task.isCancelled else { return }
                image = decoded
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                failed = true
                Diagnostics.report(error, context: "photos.import.hero")
            }
        }
        .onChange(of: item.id) { _, _ in
            // A reused view can receive a new selection without being recreated. Do not let
            // the previous item's decoded pixels, error, or zoom leak into the new photo.
            image = nil
            failed = false
            zoomScale = 1
            magnificationStart = 1
        }
        .accessibilityLabel("Photo preview")
        .accessibilityHint(
            fullResolution
                ? "Pinch or double tap to zoom. Swipe or use the navigation buttons to inspect other photos."
                : "Opens a full-screen photo viewer"
        )
        .simultaneousGesture(
            MagnificationGesture()
                .onChanged { value in
                    zoomScale = min(4, max(1, magnificationStart * value))
                }
                .onEnded { _ in magnificationStart = zoomScale }
        )
        .onTapGesture(count: 2) {
            withAnimation(.easeInOut(duration: 0.2)) {
                zoomScale = zoomScale > 1.01 ? 1 : 2
                magnificationStart = zoomScale
            }
        }
        .id(item.id)
    }
}

private struct PhotoImportFullScreenViewer: View {
    let items: [PhotoSelectionItem]
    @Environment(\.dismiss) private var dismiss
    @State private var selection: String

    init(items: [PhotoSelectionItem], initialID: String) {
        self.items = items
        _selection = State(initialValue: initialID)
    }

    var body: some View {
        #if os(macOS)
            NavigationStack {
                VStack(spacing: 12) {
                    if let item = items.first(where: { $0.id == selection }) ?? items.first {
                        PhotoImportProgressiveImage(
                            item: item, maxPixelSize: 1_800, fullResolution: true
                        )
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .padding()
                    }
                    HStack {
                        Button("Previous", systemImage: "chevron.left") {
                            moveSelection(by: -1)
                        }
                        .disabled(selectedIndex == 0)
                        Spacer()
                        Text(title)
                        Spacer()
                        Button("Next", systemImage: "chevron.right") {
                            moveSelection(by: 1)
                        }
                        .disabled(selectedIndex >= items.count - 1)
                    }
                    .padding()
                }
                .background(.black)
                .navigationTitle(title)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") { dismiss() }
                            .keyboardShortcut(.cancelAction)
                    }
                }
            }
            .frame(minWidth: 720, minHeight: 620)
            .preferredColorScheme(.dark)
        #else
            NavigationStack {
                TabView(selection: $selection) {
                    ForEach(items) { item in
                        PhotoImportProgressiveImage(
                            item: item, maxPixelSize: 1_800, fullResolution: true
                        )
                        .tag(item.id)
                        .padding()
                        .accessibilityLabel(
                            "Photo \(items.firstIndex(where: { $0.id == item.id }).map { $0 + 1 } ?? 0) of \(items.count)"
                        )
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: .automatic))
                .background(.black)
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") { dismiss() }
                            .keyboardShortcut(.cancelAction)
                    }
                }
            }
            .preferredColorScheme(.dark)
        #endif
    }

    private var selectedIndex: Int {
        items.firstIndex(where: { $0.id == selection }) ?? 0
    }

    private var title: String {
        "Photo \(max(1, selectedIndex + 1)) of \(items.count)"
    }

    private func moveSelection(by offset: Int) {
        let index = min(max(selectedIndex + offset, 0), items.count - 1)
        guard items.indices.contains(index) else { return }
        selection = items[index].id
    }
}

private extension View {
    @ViewBuilder
    func photoImportViewer(
        isPresented: Binding<Bool>, items: [PhotoSelectionItem], initialID: String
    ) -> some View {
        #if os(macOS)
            sheet(isPresented: isPresented) {
                PhotoImportFullScreenViewer(items: items, initialID: initialID)
            }
        #else
            fullScreenCover(isPresented: isPresented) {
                PhotoImportFullScreenViewer(items: items, initialID: initialID)
            }
        #endif
    }
}

#Preview("Photo import hero") {
    PhotoImportHero(items: [])
}

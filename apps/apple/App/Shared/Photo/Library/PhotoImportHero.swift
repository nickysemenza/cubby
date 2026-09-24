import CoreGraphics
import CubbyKit
import SwiftUI

/// The shared photo treatment for the import workbench. The grid preview is available
/// immediately, while the selected image is decoded to a bounded hero size in a cancellable task.
/// Keeping the viewer here means route selection and creation never lose the photo context.
struct PhotoImportHero: View {
    let items: [PhotoSelectionItem]
    let selectedIDs: Set<String>
    /// The manifest's `focusedItemID` keeps the review preview in sync with the focused filmstrip
    /// photo. `nil` keeps focus local for callers that only display photos here.
    private let externalFocusedID: Binding<String>?
    let onToggle: ((String) -> Void)?
    let compact: Bool

    // Literal default, no init parameter: falls back to `items.first` lazily in `focusedID`
    // rather than being seeded from `items`/`focusedID` at init, so a reused view can never show
    // a stale first-photo default from an earlier `items` array. (state-init-ok pattern; nothing
    // to tag since there is nothing seeded here.)
    @State private var internalFocusedID = ""
    @State private var showingFullScreen = false

    /// Cap on the hero's height as (points, fraction of the container). The stacked phone
    /// layout keeps the photo to ~22% so the assignment list owns the screen; a side column
    /// (regular width) has the height to spare and passes a larger cap.
    let heightCap: (points: CGFloat, fraction: CGFloat)

    init(
        items: [PhotoSelectionItem], selectedIDs: Set<String> = [],
        focusedID: Binding<String>? = nil,
        heightCap: (points: CGFloat, fraction: CGFloat) = (220, 0.22),
        compact: Bool = false,
        onToggle: ((String) -> Void)? = nil
    ) {
        self.items = items
        self.selectedIDs = selectedIDs
        self.externalFocusedID = focusedID
        self.heightCap = heightCap
        self.compact = compact
        self.onToggle = onToggle
    }

    private var focusedID: String {
        externalFocusedID?.wrappedValue
            ?? (internalFocusedID.isEmpty ? items.first?.id ?? "" : internalFocusedID)
    }

    private func setFocusedID(_ id: String) {
        if let externalFocusedID { externalFocusedID.wrappedValue = id } else { internalFocusedID = id }
    }

    private var focusedItem: PhotoSelectionItem? {
        items.first(where: { $0.id == focusedID }) ?? items.first
    }

    private let thumbnailSize: CGFloat = 48

    var body: some View {
        if let focusedItem {
            VStack(spacing: 8) {
                if compact {
                    compactPreview(for: focusedItem)
                } else {
                    heroButton(for: focusedItem)
                }
                filmstrip(focused: focusedItem)
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

    private func compactPreview(for item: PhotoSelectionItem) -> some View {
        let position = (items.firstIndex(where: { $0.id == item.id }) ?? 0) + 1
        return HStack(spacing: 10) {
            PhotoImportProgressiveImage(item: item, maxPixelSize: 220)
                .frame(width: 56, height: 56)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            Text("Viewing photo \(position) of \(items.count)")
                .font(.subheadline)
            Spacer(minLength: 0)
            Button("View photo", systemImage: "arrow.up.left.and.arrow.down.right") {
                showingFullScreen = true
            }
            .labelStyle(.iconOnly)
            .accessibilityLabel("View focused photo full screen")
            .frame(minWidth: 44, minHeight: 44)
        }
    }

    private func heroButton(for item: PhotoSelectionItem) -> some View {
        ZStack(alignment: .bottomTrailing) {
            Button {
                showingFullScreen = true
            } label: {
                PhotoImportProgressiveImage(item: item, maxPixelSize: 1_800)
                    .frame(maxWidth: .infinity)
                    .containerRelativeFrame(.vertical) { length, _ in
                        min(heightCap.points, length * heightCap.fraction)
                    }
                    .background(.quaternary)
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Photo preview")
            .accessibilityHint("Opens a full-screen photo viewer")
            .accessibilityIdentifier("photos.import.hero")

            Button {
                showingFullScreen = true
            } label: {
                Image(systemName: "arrow.up.left.and.arrow.down.right")
            }
            .buttonStyle(.glass)
            .controlSize(.small)
            .padding(8)
            .accessibilityLabel("Inspect full screen")
        }
    }

    private func filmstrip(focused: PhotoSelectionItem) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                    PhotoImportFilmstripThumb(
                        item: item,
                        position: index + 1,
                        size: thumbnailSize,
                        isFocused: item.id == focused.id,
                        isSelected: selectedIDs.contains(item.id),
                        onFocus: { setFocusedID(item.id) },
                        onToggle: onToggle.map { toggle in { toggle(item.id) } })
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 4)
        }
        .frame(minHeight: 72)
    }
}

/// One filmstrip cell. Focus/selection arrive as plain `Bool`s so the accessibility strings and
/// symbol styling below are cheap for the type checker (the inline ternaries on
/// `selectedIDs.contains` pushed the parent `body` past the 200ms limit).
private struct PhotoImportFilmstripThumb: View {
    let item: PhotoSelectionItem
    let position: Int
    let size: CGFloat
    let isFocused: Bool
    let isSelected: Bool
    let onFocus: () -> Void
    let onToggle: (() -> Void)?

    var body: some View {
        HStack(spacing: 2) {
            Button(action: onFocus) {
                PhotoImportProgressiveImage(item: item, maxPixelSize: 220, loadsImmediately: false)
                    .frame(width: size, height: size)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(isFocused ? Color.accentColor : .clear, lineWidth: 3)
                    }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("View photo \(position)")
            .accessibilityValue(isFocused ? "Focused" : "")
            .accessibilityHint("Changes the preview; use Select for assignment")
            .accessibilityIdentifier("photos.import.filmstrip.\(item.id)")
            if let onToggle {
                Button(action: onToggle) { selectionMark }
                    .buttonStyle(.plain)
                    .frame(width: 44, height: 44)
                    .accessibilityLabel("Select photo \(position) for assignment")
                    .accessibilityValue(isSelected ? "Selected" : "Not selected")
                    .accessibilityAddTraits(isSelected ? .isSelected : [])
                    .accessibilityIdentifier("photos.import.select.\(item.id)")
            }
        }
    }

    private var selectionMark: some View {
        Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
            .foregroundStyle(isSelected ? .white : .secondary, isSelected ? .blue : .white)
            .padding(3)
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
                let decoded: CGImage
                if fullResolution {
                    decoded = try await FullResolutionDecodeQueue.shared.decode(file)
                } else {
                    let task = Task.detached(priority: .userInitiated) {
                        try file.thumbnail(maxPixelSize: maxPixelSize)
                    }
                    decoded = try await withTaskCancellationHandler {
                        try await task.value
                    } onCancel: {
                        task.cancel()
                    }
                }
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

/// Full-size decodes can each retain hundreds of megabytes. A canceled swipe waits for the
/// current synchronous decode to finish, then drops its queued work before starting another.
private actor FullResolutionDecodeQueue {
    static let shared = FullResolutionDecodeQueue()
    private var current: (id: UUID, task: Task<CGImage, Error>)?

    func decode(_ file: PhotoFile) async throws -> CGImage {
        while let active = current {
            _ = try? await active.task.value
            try Task.checkCancellation()
            if current?.id == active.id { await Task.yield() }
        }
        let id = UUID()
        let job = Task.detached(priority: .userInitiated) {
            try Task.checkCancellation()
            return try file.decodeFullResolution()
        }
        current = (id, job)
        defer { if current?.id == id { current = nil } }
        return try await withTaskCancellationHandler {
            try await job.value
        } onCancel: {
            job.cancel()
        }
    }
}

private struct PhotoImportFullScreenViewer: View {
    let items: [PhotoSelectionItem]
    @Environment(\.dismiss) private var dismiss
    @State private var selection: String

    init(items: [PhotoSelectionItem], initialID: String) {
        self.items = items
        // Presented via `isPresented:` (sheet/fullScreenCover), not `item:` — the whole subtree
        // is torn down and rebuilt fresh each presentation, so this can't carry a stale
        // `initialID` the way an `item:`-keyed sheet can.
        _selection = State(initialValue: initialID)  // state-init-ok
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

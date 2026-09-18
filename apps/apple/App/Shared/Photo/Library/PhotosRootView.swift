import CubbyKit
import Photos
import SwiftUI

struct PhotosRootView: View {
    @Environment(AppModel.self) private var appModel
    @State private var destination: PhotoSelectionBatch?
    var body: some View {
        PhotoLibraryBrowser(maxSelectionCount: nil, picker: false) { items in
            destination = PhotoSelectionBatch(items: items)
        }
        .sheet(item: $destination) { batch in
            PhotoDestinationSheet(items: batch.items) { committedIDs in
                // The importer reports only the identifiers that the transaction committed.
                // Leave failed or unassigned selections untouched for an immediate retry.
                appModel.photoLibrary.selectedIDs.removeAll { committedIDs.contains($0) }
                destination = nil
            }
            // The sheet seeds its manifest from `items` via `State(initialValue:)`, which SwiftUI
            // applies once per view identity; without keying on the batch, a second presentation
            // reused the first batch's manifest and showed the old photos.
            .id(batch.id)
        }
    }
}

struct LibraryPickerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let maxSelectionCount: Int
    let onSelection: ([PhotoSelectionItem]) -> Void
    var body: some View {
        NavigationStack {
            PhotoLibraryBrowser(maxSelectionCount: maxSelectionCount, picker: true) { items in
                onSelection(items)
                dismiss()
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
    }
}

struct PhotoSelectionBatch: Identifiable {
    let id = UUID()
    let items: [PhotoSelectionItem]
}

private struct PhotoLibraryBrowser: View {
    enum Filter: String, CaseIterable { case all = "All", missing = "Not in Cubby", found = "In Cubby" }
    @Environment(AppModel.self) private var appModel
    @Environment(\.scenePhase) private var scenePhase
    let maxSelectionCount: Int?
    let picker: Bool
    let onSelection: ([PhotoSelectionItem]) -> Void
    @State private var filter: Filter = .all
    @State private var pickerIDs: [String] = []
    @State private var preview: AssetPreview?
    @State private var session = UUID()
    @State private var loading: Task<Void, Never>?
    @State private var selectionError: String?
    @State private var loadingSelection = false
    private let columns = [GridItem(.adaptive(minimum: 100, maximum: 160), spacing: 3)]

    private var library: PhotoLibraryStore { appModel.photoLibrary }
    private var matches: PhotoMatchStore { appModel.photoMatches }
    private var ids: [String] { picker ? pickerIDs : library.selectedIDs }

    var body: some View {
        VStack(spacing: 0) {
            if library.hasFullAccess {
                controls
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            ForEach(library.months) { month in
                                let assets = month.assets.filter(includes)
                                if !assets.isEmpty {
                                    Text(
                                        month.id == .distantPast
                                            ? "Undated" : month.id.formatted(.dateTime.month(.wide).year())
                                    )
                                    .font(.headline).padding(.horizontal, 12).id(month.id)
                                    LazyVGrid(columns: columns, spacing: 3) {
                                        ForEach(assets, id: \.localIdentifier) { asset in
                                            PhotoLibraryCell(asset: asset, selection: selectionNumber(asset))
                                            {
                                                library.scrollID = asset.localIdentifier
                                                toggle(asset.localIdentifier)
                                            } onShowDetails: {
                                                library.scrollID = asset.localIdentifier
                                                preview = AssetPreview(asset: asset)
                                            }
                                            .id(asset.localIdentifier)
                                            .contextMenu {
                                                Button(
                                                    "View photo and Cubby matches",
                                                    systemImage: "info.circle"
                                                ) {
                                                    library.scrollID = asset.localIdentifier
                                                    preview = AssetPreview(asset: asset)
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        .padding(.vertical, 12)
                    }
                    .refreshable { await library.refresh(matches: matches, client: appModel.client) }
                    .onAppear {
                        if let id = library.scrollID { proxy.scrollTo(id, anchor: .center) }
                    }
                    .overlay {
                        if library.count == 0 {
                            ContentUnavailableView(
                                "No photos", systemImage: "photo",
                                description: Text("Photos in your accessible library will appear here."))
                        }
                    }
                    .toolbar {
                        ToolbarItem(placement: .automatic) {
                            Menu("Jump to month", systemImage: "calendar") {
                                ForEach(library.months) { month in
                                    Button(month.id.formatted(.dateTime.month(.wide).year())) {
                                        withAnimation { proxy.scrollTo(month.id, anchor: .top) }
                                    }
                                }
                            }
                        }
                    }
                }
                if !ids.isEmpty { selectionBar }
            } else {
                permissionFallback
            }
        }
        .navigationTitle("Photos")
        .porcelainScreen()
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                if library.hasFullAccess && !ids.isEmpty {
                    Button("Clear") { clearSelection() }
                }
            }
        }
        .task { await library.activate(session, matches: matches, client: appModel.client) }
        .onDisappear {
            library.deactivate(session); loading?.cancel()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await library.refresh(matches: matches, client: appModel.client) } }
        }
        .photoPreviewPresentation(item: $preview) { selected in
            PhotoLibraryPreview(asset: selected.asset) {
                toggle(selected.asset.localIdentifier)
            }
        }
        .alert(
            "Could not load photos",
            isPresented: Binding(get: { selectionError != nil }, set: { if !$0 { selectionError = nil } })
        ) {
            Button("OK") { selectionError = nil }
        } message: {
            Text(selectionError ?? "")
        }
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker("Show", selection: $filter) {
                ForEach(Filter.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("photos.filter")
            HStack(spacing: 6) {
                if library.isLoadingLibrary || library.isScanning || matches.isLoading || matches.isRepairing
                {
                    LoadingIndicator(label: "Loading photo library").controlSize(.mini)
                }
                VStack(alignment: .leading, spacing: 2) {
                    if library.hasFullAccess && (library.count > 0 || library.isLoadingLibrary) {
                        Text(library.scanStatus)
                    }
                    Text(matches.isLoading ? "Refreshing Cubby photos…" : matches.coverage)
                }.font(.caption).monospacedDigit()
                Spacer()
                Button {
                    Task { await library.refresh(matches: matches, client: appModel.client) }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .accessibilityLabel("Refresh photo matches")
                .accessibilityIdentifier("photos.refresh")
            }.foregroundStyle(.secondary)
            if filter == .missing {
                Text(
                    "Includes unchecked photos and possible matches. More matches may appear while checking continues."
                )
                .font(.caption2).foregroundStyle(.secondary)
            }
        }.padding(12)
    }

    private var selectionBar: some View {
        HStack {
            Text("\(ids.count) selected").font(.subheadline)
            Spacer()
            if loadingSelection {
                ProgressView(value: library.selectionProgress).frame(width: 70)
                    .accessibilityLabel("Downloading selected photos")
                Button("Cancel") {
                    loading?.cancel(); loadingSelection = false
                }
            } else {
                Button(picker ? "Choose photos" : "Add to…") { prepareSelection() }
                    .buttonStyle(.borderedProminent).disabled(ids.isEmpty)
                    .accessibilityIdentifier(picker ? "photos.choose" : "photos.addTo")
            }
        }.padding(12).background(.bar)
    }

    private var permissionFallback: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Image(systemName: "photo.on.rectangle.angled").font(.largeTitle)
                Text("Your Photos library, alongside Cubby").font(.title2)
                Text(
                    "Allow full Photos access to browse your camera roll and see which photos are represented in Cubby. Uploads happen only when you choose a destination and add them."
                )
                if library.authorization == .notDetermined {
                    Button("Allow Photos access") {
                        Task { await library.requestAccess(matches: matches, client: appModel.client) }
                    }.buttonStyle(.borderedProminent)
                } else {
                    Text(
                        "Whole-library browsing needs full access. You can change Photos access in Settings, or select individual photos below."
                    )
                    .foregroundStyle(.secondary)
                }
                PhotoSourceButtons(maxSelectionCount: maxSelectionCount ?? 100, onSelection: onSelection)
            }.padding(24).frame(maxWidth: 560)
        }
    }

    private func includes(_ asset: PHAsset) -> Bool {
        if filter == .all { return true }
        let represented = matches.storedCandidates(for: asset.localIdentifier).contains {
            $0.confidence == .strong
        }
        switch filter {
        case .all: return true;
        case .missing: return !represented;
        case .found: return represented
        }
    }

    private func selectionNumber(_ asset: PHAsset) -> Int? {
        ids.firstIndex(of: asset.localIdentifier).map { $0 + 1 }
    }

    private func toggle(_ id: String) {
        var selection = ids
        if selection.contains(id) {
            selection.removeAll { $0 == id }
        } else if maxSelectionCount == nil || selection.count < maxSelectionCount! {
            selection.append(id)
        } else {
            selectionError = "Choose up to \(maxSelectionCount!) photos."
        }
        if picker { pickerIDs = selection } else { library.selectedIDs = selection }
    }

    private func clearSelection() {
        if picker { pickerIDs = [] } else { library.selectedIDs = [] }
    }

    private func prepareSelection() {
        let selected = ids
        loadingSelection = true
        loading = Task {
            defer { loadingSelection = false }
            do {
                let items = try await library.selection(selected)
                try Task.checkCancellation()
                onSelection(items)
            } catch is CancellationError {} catch {
                selectionError = error.localizedDescription
                Diagnostics.report(error, context: "photos.selection")
            }
        }
    }
}

private struct AssetPreview: Identifiable {
    let asset: PHAsset
    var id: String { asset.localIdentifier }
}

private struct PhotoLibraryCell: View {
    @Environment(AppModel.self) private var appModel
    let asset: PHAsset
    let selection: Int?
    let onTap: () -> Void
    let onShowDetails: () -> Void
    @State private var image: CGImage?
    private var known: Bool {
        appModel.photoLibrary.checked.contains(asset.localIdentifier)
            && appModel.photoMatches.hasKnownResult(for: asset.localIdentifier)
    }
    private var represented: Bool {
        appModel.photoMatches.storedCandidates(for: asset.localIdentifier).contains {
            $0.confidence == .strong
        }
    }
    private var possibleMatch: Bool {
        !represented && !appModel.photoMatches.storedCandidates(for: asset.localIdentifier).isEmpty
    }
    private var ownerBadge: String? {
        appModel.photoMatches.ownerBadge(for: asset.localIdentifier)
    }
    private var ownerAccessibilityDescription: String? {
        appModel.photoMatches.ownerAccessibilityDescription(for: asset.localIdentifier)
    }
    var body: some View {
        Button(action: onTap) {
            Rectangle().fill(PorcelainTokens.inset).aspectRatio(1, contentMode: .fit)
                .overlay {
                    if let image {
                        Image(decorative: image, scale: 1).resizable().scaledToFill()
                    } else {
                        Image(systemName: "photo").foregroundStyle(.secondary)
                    }
                }.clipped()
                .overlay(alignment: .bottomTrailing) {
                    if let selection {
                        Text("\(selection)").font(.caption.bold()).padding(7).background(.blue, in: Circle())
                            .foregroundStyle(.white).padding(5)
                    } else if let ownerBadge {
                        Text(ownerBadge)
                            .font(.caption2.weight(.semibold).monospaced())
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                            .padding(.horizontal, 7)
                            .frame(minHeight: 28)
                            .foregroundStyle(.primary)
                            .background(.thinMaterial, in: Capsule())
                            .overlay { Capsule().strokeBorder(.white.opacity(0.35), lineWidth: 1) }
                            .shadow(radius: 2, y: 1)
                            .padding(5)
                    } else if possibleMatch || !known {
                        Image(systemName: "questionmark.circle").foregroundStyle(.white).shadow(radius: 2)
                            .padding(6)
                    }
                }
        }.buttonStyle(.plain)
            .overlay(alignment: .topLeading) {
                Button(action: onShowDetails) {
                    Image(systemName: "info.circle.fill")
                        .font(.system(size: 24))
                        .foregroundStyle(.white)
                        .frame(width: 32, height: 32)
                        .background(.ultraThinMaterial, in: Circle())
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .padding(4)
                .accessibilityLabel("Photo details")
                .accessibilityIdentifier("photos.grid.details")
            }
            .accessibilityLabel(
                "\(asset.creationDate?.formatted(date: .abbreviated, time: .shortened) ?? "Undated photo"), \(ownerAccessibilityDescription ?? (represented ? "In Cubby" : possibleMatch ? "Possible Cubby match" : known ? "No known match" : "Not checked"))"
            )
            .accessibilityValue(selection.map { "Selected photo \($0)" } ?? "")
            .onDisappear { image = nil }
            .task(id: asset.modificationDate) {
                do {
                    image = try await appModel.photoLibrary.thumbnail(asset, matches: appModel.photoMatches)
                } catch
                { /* Local-only grid requests can fail for cloud assets; selection retries with network access. */
                }
            }
    }
}

private struct PhotoLibraryPreview: View {
    enum Tab: String, CaseIterable { case photo = "Photo", diagnostics = "Diagnostics" }

    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    let asset: PHAsset
    let onSelect: () -> Void
    @State private var image: CGImage?
    @State private var error: String?
    @State private var tab: Tab = .photo
    @State private var diagnostics = PhotoDiagnosticsModel()

    var body: some View {
        NavigationStack {
            List {
                Picker("View", selection: $tab) {
                    ForEach(Tab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .listRowSeparator(.hidden)
                switch tab {
                case .photo: photoTab
                case .diagnostics: PhotoDiagnosticsView(model: diagnostics)
                }
            }.navigationTitle("Photo")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") { dismiss() }
                            .accessibilityIdentifier("photos.libraryPreview.close")
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Select") {
                            onSelect(); dismiss()
                        }
                        .accessibilityIdentifier("photos.libraryPreview.select")
                    }
                }
                .task {
                    do { image = try await PhotoLibraryIO.shared.thumbnail(for: asset, network: true) } catch
                    {
                        self.error = error.localizedDescription;
                        Diagnostics.report(error, context: "photos.preview")
                    }
                }
                .onChange(of: tab) { _, newValue in
                    guard newValue == .diagnostics else { return }
                    startDiagnosticsIfNeeded()
                }
                .onDisappear { diagnostics.cancel() }
        }
    }

    @ViewBuilder private var photoTab: some View {
        if let image {
            Image(decorative: image, scale: 1).resizable().scaledToFit().frame(maxHeight: 400)
        } else if let error {
            Text(error).foregroundStyle(PorcelainTokens.destructive)
        } else {
            ProgressView("Loading photo…")
        }
        if let date = asset.creationDate { Text(date.formatted(date: .complete, time: .shortened)) }
        Section("Cubby") {
            let candidates = appModel.photoMatches.storedCandidates(for: asset.localIdentifier)
            if candidates.isEmpty {
                if appModel.photoMatches.hasKnownResult(for: asset.localIdentifier) {
                    Label("Ready to add", systemImage: "plus.circle")
                    Text("No existing copy was found.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else if appModel.photoMatches.isLoading {
                    ProgressView("Checking for an existing copy…")
                } else {
                    Label("Not checked yet", systemImage: "questionmark.circle")
                        .foregroundStyle(.secondary)
                }
            }
            ForEach(Array(candidates.enumerated()), id: \.offset) { _, candidate in
                MatchCandidateView(candidate: candidate)
                NavigationLink {
                    ImageEntityDetailView(id: candidate.id)
                } label: {
                    Label("Open image in Cubby", systemImage: "arrow.up.right.square")
                }
            }
            DisclosureGroup("Match details") {
                Text(appModel.photoMatches.coverage)
                if appModel.photoMatches.repairFailures > 0 {
                    Text(
                        "\(appModel.photoMatches.repairFailures) older Cubby image\(appModel.photoMatches.repairFailures == 1 ? "" : "s") could not be checked. Pull to refresh the Photos grid to retry."
                    )
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    /// Materializing the asset and running Vision costs seconds and RAM, so it happens only once
    /// the Diagnostics tab is actually opened — never eagerly when the preview itself appears.
    private func startDiagnosticsIfNeeded() {
        guard case .idle = diagnostics.state else { return }
        Task {
            do {
                let file = try await PhotoLibraryIO.shared.file(for: asset)
                diagnostics.run(file: file)
            } catch {
                Diagnostics.report(error, context: "photos.diagnostics")
            }
        }
    }
}

#Preview(traits: .modifier(SignedInPreview())) { NavigationStack { PhotosRootView() } }

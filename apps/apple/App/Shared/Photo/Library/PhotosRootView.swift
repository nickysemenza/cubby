import CubbyKit
import Photos
import SwiftUI

struct PhotosRootView: View {
    @Environment(AppModel.self) private var appModel
    @State private var destination: PhotoSelectionBatch?
    @State private var analysisReady = false

    var body: some View {
        PhotoLibraryBrowser(
            maxSelectionCount: nil, picker: false,
            analysisStore: analysisReady ? appModel.photoAnalysisStore : nil,
            sweep: analysisReady ? appModel.photoClassificationSweep : nil
        ) { items in
            guard let analysisStore = appModel.photoAnalysisStore else { return }
            // Built here, once per batch, and owned by the batch rather than seeded into the
            // sheet's own @State: a re-presented `.sheet(item:)` is not guaranteed to reset
            // @State seeded from an init parameter when the item changes (apps/apple/AGENTS.md,
            // "Traps that cost real time"), which previously showed the prior batch's manifest.
            destination = PhotoSelectionBatch(
                items: items,
                manifest: PhotoImportManifest(items: items, analysisStore: analysisStore))
        }
        .sheet(item: $destination) { batch in
            PhotoDestinationSheet(manifest: batch.manifest) { committedIDs in
                // The importer reports only the identifiers that the transaction committed.
                // Leave failed or unassigned selections untouched for an immediate retry.
                appModel.photoLibrary.selectedIDs.removeAll { committedIDs.contains($0) }
                destination = nil
            }
        }
        .task {
            await appModel.preparePhotoSubsystem()
            analysisReady = true
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

/// Layer 7's "Copy diagnostics" payload for the grid.
private struct PhotoGridDiagnosticEntry: Encodable {
    let localIdentifier: String
    let classifyMs: Double?
    let topLabel: String?
    let categories: [String]
}

struct PhotoSelectionBatch: Identifiable {
    let id = UUID()
    let items: [PhotoSelectionItem]
    let manifest: PhotoImportManifest
}

private struct PhotoLibraryBrowser: View {
    enum Filter: String, CaseIterable { case all = "All", missing = "Not in Cubby", found = "In Cubby" }
    @Environment(AppModel.self) private var appModel
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.developerOverlays) private var developerOverlays
    let maxSelectionCount: Int?
    let picker: Bool
    let analysisStore: PhotoAnalysisStore?
    let sweep: PhotoClassificationSweep?
    let onSelection: ([PhotoSelectionItem]) -> Void

    init(
        maxSelectionCount: Int?, picker: Bool, analysisStore: PhotoAnalysisStore? = nil,
        sweep: PhotoClassificationSweep? = nil, onSelection: @escaping ([PhotoSelectionItem]) -> Void
    ) {
        self.maxSelectionCount = maxSelectionCount
        self.picker = picker
        self.analysisStore = analysisStore
        self.sweep = sweep
        self.onSelection = onSelection
    }
    @State private var filter: Filter = .all
    @State private var pickerIDs: [String] = []
    @State private var preview: AssetPreview?
    @State private var session = UUID()
    @State private var loading: Task<Void, Never>?
    @State private var selectionError: String?
    @State private var loadingSelection = false
    /// Reference-type caches held stable across renders by `@State`: mutating their contents
    /// during `body` is safe (only reassigning the `@State` binding itself would invalidate the
    /// view), and — unlike a tracked `@State` value — updating them never itself triggers a
    /// re-render, which matters since `monthCaching` mutates on every scroll frame.
    @State private var filteredAssets = FilteredMonthAssetsCache()
    @State private var monthCaching = MonthCachingCoordinator()
    @State private var selectedCategory: PhotoCategory?
    @State private var categoryMatches: Set<String> = []
    @State private var unanalysedCount = 0
    /// Bumped every time `loadCategoryFilter()` replaces `categoryMatches`, so
    /// `FilteredMonthAssetsCache` (keyed on this, not `matches.revision` — see B4/finding 2) knows
    /// to re-run `includes()` for a category filter even though no ownership match changed.
    @State private var categoryMatchesRevision = 0
    @ScaledMetric(relativeTo: .caption2) private var minimumTileWidth = 100.0
    private var columns: [GridItem] {
        [GridItem(.adaptive(minimum: minimumTileWidth, maximum: max(160, minimumTileWidth)), spacing: 3)]
    }
    /// `.bottomBar` is iOS/tvOS/watchOS-only; macOS has no equivalent placement, so this bar's
    /// items fall back to the window toolbar there.
    private static var selectionBarPlacement: ToolbarItemPlacement {
        #if os(iOS)
            .bottomBar
        #else
            .automatic
        #endif
    }

    private var library: PhotoLibraryStore { appModel.photoLibrary }
    private var matches: PhotoMatchStore { appModel.photoMatches }
    private var ids: [String] { picker ? pickerIDs : library.selectedIDs }

    var body: some View {
        VStack(spacing: 0) {
            if library.hasFullAccess {
                controls
                ScrollViewReader { proxy in
                    ScrollView {
                        // `pinnedViews: .sectionHeaders` keeps each month's label on screen while
                        // its photos scroll under it; the header's `.bar` background doubles as
                        // the divider between months, so no separate divider view is needed.
                        LazyVStack(alignment: .leading, spacing: 12, pinnedViews: .sectionHeaders) {
                            let selectionNumbers = selectionNumbers()
                            ForEach(library.months) { month in
                                MonthSection(
                                    month: month, assets: monthAssets(month),
                                    columns: columns, selectionNumbers: selectionNumbers,
                                    library: library, preview: $preview, onToggle: toggle
                                )
                                .id(month.id)
                                .onAppear {
                                    monthCaching.monthDidAppear(month.id, months: library.months)
                                    updateVisibleMonths()
                                }
                                .onDisappear {
                                    monthCaching.monthDidDisappear(month.id, months: library.months)
                                    updateVisibleMonths()
                                }
                            }
                        }
                        .padding(.vertical, 12)
                    }
                    .refreshable { await library.refresh(matches: matches, client: appModel.client) }
                    .onAppear {
                        // Scroll to the containing month first: `scrollTo` on an id nested two
                        // lazy containers deep (`LazyVStack` > `Section` > `LazyVGrid`) can miss
                        // if that content has never been laid out, so land on the (top-level,
                        // always-addressable) month section before refining to the exact photo.
                        if let id = library.scrollID {
                            if let month = library.months.first(where: { m in
                                m.assets.contains { $0.localIdentifier == id }
                            }) {
                                proxy.scrollTo(month.id, anchor: .top)
                            }
                            proxy.scrollTo(id, anchor: .center)
                        }
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
            } else {
                permissionFallback
            }
        }
        .navigationTitle("Photos")
        .porcelainScreen()
        .toolbar {
            // The `if` must gate the whole `ToolbarItem`, not sit inside its content: a
            // conditional inside `ToolbarItem` still renders the item's Liquid Glass background
            // even when the condition is false, showing an empty glass pill in the toolbar.
            if developerOverlays && library.hasFullAccess {
                ToolbarItem { CopyDiagnosticsButton { gridDiagnostics } }
            }
            if library.hasFullAccess && !ids.isEmpty {
                ToolbarItem(placement: .primaryAction) {
                    Button("Clear") { clearSelection() }
                }
                ToolbarItemGroup(placement: Self.selectionBarPlacement) {
                    Text("\(ids.count) selected").foregroundStyle(.secondary)
                    Spacer()
                    if loadingSelection {
                        ProgressView(value: library.selectionProgress).frame(width: 70)
                            .accessibilityLabel("Downloading selected photos")
                        Button("Cancel") {
                            loading?.cancel(); loadingSelection = false
                        }
                    } else {
                        Button(picker ? "Choose photos" : "Add to…") { prepareSelection() }
                            .buttonStyle(.borderedProminent)
                            .disabled(ids.isEmpty || (!picker && analysisStore == nil))
                            .accessibilityIdentifier(picker ? "photos.choose" : "photos.addTo")
                    }
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
        .photoSweepLifecycle(
            active: !picker, sweep: sweep, scenePhase: scenePhase,
            categoryFilterKey: CategoryFilterKey(
                category: selectedCategory?.key, revision: matches.classifiedRevision)
        ) {
            await loadCategoryFilter()
        }
        .onChange(of: library.monthsRevision) { _, _ in
            // The sweep's own candidate provider reads `library.months`; a fresh (or newly
            // populated, or library-changed) month list needs `reconcile()` re-run so a sweep
            // that started with zero candidates (Photos tab opened before the library loaded)
            // actually starts once photos exist, and a finished sweep re-arms for new photos.
            guard !picker, let sweep else { return }
            sweep.reconcile()
        }
        .photoPreviewPresentation(item: $preview) { selected in
            PhotoLibraryPreview(asset: selected.asset) {
                toggle(selected.asset.localIdentifier)
            }
            .id(selected.asset.localIdentifier)
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
            if !picker { categoryChipRow }
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
            if library.hasFullAccess {
                Text(library.loadingDebugStatus)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("photos.loading.debug")
            }
            if filter == .missing {
                Text(
                    "Includes unchecked photos and possible matches. More matches may appear while checking continues."
                )
                .font(.caption2).foregroundStyle(.secondary)
            }
        }.padding(12)
    }

    /// A second, single-select chip row (B4) below the ownership `Filter` picker: one chip per
    /// `PhotoImportCatalog.categories` entry (never a hardcoded category name), plus the sweep's
    /// live "Analysing… N of M" status while it runs.
    private var categoryChipRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    if let status = sweep?.statusText {
                        Text(status).font(.caption2).foregroundStyle(.secondary)
                    }
                    ForEach(PhotoImportCatalog.categories, id: \.key) { category in
                        CategoryChip(
                            category: category, selected: selectedCategory?.key == category.key
                        ) {
                            selectedCategory = selectedCategory?.key == category.key ? nil : category
                        }
                    }
                }
            }
            if selectedCategory != nil, unanalysedCount > 0 {
                Text("\(unanalysedCount) photos not analysed yet")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
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

    /// Developer overlays layer 7: every currently loaded asset's classify timing/label/categories,
    /// read from the same per-id boxes the grid cells already observe (no new whole-store read).
    private var gridDiagnostics: [PhotoGridDiagnosticEntry] {
        library.months.flatMap(\.assets).map { asset in
            let state = matches.cellStateBox(for: asset.localIdentifier).state
            let categories: [String] = {
                if case .analysed(let categories) = state.analysis { return categories }
                return []
            }()
            return PhotoGridDiagnosticEntry(
                localIdentifier: asset.localIdentifier, classifyMs: state.classifyMs,
                topLabel: state.topLabel, categories: categories)
        }
    }

    private func includes(_ asset: PHAsset) -> Bool {
        guard passesOwnershipFilter(asset) else { return false }
        guard selectedCategory != nil else { return true }
        // A category filter excludes anything not yet analysed — its category is unknown until
        // the sweep or a full analysis has actually looked at it.
        return categoryMatches.contains(asset.localIdentifier)
    }

    private func passesOwnershipFilter(_ asset: PHAsset) -> Bool {
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

    /// Built once per render instead of a per-cell `ids.firstIndex(of:)` scan, which made the
    /// whole grid's selection-number lookup O(selected count) *per cell* (O(n·m) overall).
    private func selectionNumbers() -> [String: Int] {
        Dictionary(uniqueKeysWithValues: ids.enumerated().map { ($1, $0 + 1) })
    }

    private func monthAssets(_ month: PhotoLibraryStore.Month) -> [PHAsset] {
        filteredAssets.assets(
            for: month, filter: filter, category: selectedCategory?.key, revision: matches.revision,
            categoryRevision: categoryMatchesRevision
        ) { month.assets.filter(includes) }
    }

    private func updateVisibleMonths() {
        guard !picker, let sweep else { return }
        sweep.updateVisibleMonths(monthCaching.visibleMonthIDs)
    }

    /// Batch-loads `selectedCategory`'s matching ids plus the whole library's unanalysed count,
    /// memoized per `(category, matches.classifiedRevision)` by `.task(id:)` — a category switch
    /// or the sweep's coalesced classification signal both invalidate it, nothing else re-fetches.
    private func loadCategoryFilter() async {
        guard let category = selectedCategory, let analysisStore else {
            categoryMatches = []
            unanalysedCount = 0
            return
        }
        async let matched = analysisStore.ids(
            in: category.key, newerThan: PhotoClassificationSweep.classifyVersion)
        async let analysedTotal = analysisStore.classifiedCount(
            newerThan: PhotoClassificationSweep.classifyVersion)
        categoryMatches = (try? await matched) ?? []
        unanalysedCount = max(0, library.count - ((try? await analysedTotal) ?? 0))
        categoryMatchesRevision += 1
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

/// `month.assets.filter(includes)` recomputed on every render was an O(library size) scan
/// regardless of whether anything changed. Keyed by month id, invalidated only when the filter
/// picker, the category chip selection, `PhotoMatchStore.revision` (ownership matches — never
/// bumped by a photo's classification, see `markAnalysis`), or `categoryMatchesRevision` (bumped
/// once per `loadCategoryFilter()` batch load, not once per photo) actually changes.
private final class FilteredMonthAssetsCache {
    private var entries:
        [Date: (
            filter: PhotoLibraryBrowser.Filter, category: String?, revision: Int,
            categoryRevision: Int, assets: [PHAsset]
        )] = [:]

    func assets(
        for month: PhotoLibraryStore.Month, filter: PhotoLibraryBrowser.Filter, category: String?,
        revision: Int, categoryRevision: Int, compute: () -> [PHAsset]
    ) -> [PHAsset] {
        if let cached = entries[month.id], cached.filter == filter, cached.category == category,
            cached.revision == revision, cached.categoryRevision == categoryRevision
        {
            return cached.assets
        }
        let result = compute()
        entries[month.id] = (filter, category, revision, categoryRevision, result)
        return result
    }
}

/// Tracks which months are on screen (via each `Section`'s `onAppear`/`onDisappear`) and keeps
/// `PHCachingImageManager` warm for the visible month plus one neighbor on each side, so a fling
/// past the edge of the visible window finds decoded thumbnails waiting instead of starting a
/// fresh request.
@MainActor
private final class MonthCachingCoordinator {
    private var visible: Set<Date> = []
    private var cached: Set<Date> = []

    /// Fed to `PhotoClassificationSweep.updateVisibleMonths` so the sweep orders visible months
    /// first (B3, Q4c).
    var visibleMonthIDs: [Date] { Array(visible) }

    func monthDidAppear(_ id: Date, months: [PhotoLibraryStore.Month]) {
        visible.insert(id)
        reconcile(months: months)
    }

    func monthDidDisappear(_ id: Date, months: [PhotoLibraryStore.Month]) {
        visible.remove(id)
        reconcile(months: months)
    }

    private func reconcile(months: [PhotoLibraryStore.Month]) {
        var wanted: Set<Date> = []
        for id in visible {
            guard let index = months.firstIndex(where: { $0.id == id }) else { continue }
            let lower = max(0, index - 1)
            let upper = min(months.count - 1, index + 1)
            for neighbor in lower...upper { wanted.insert(months[neighbor].id) }
        }
        let toStart = wanted.subtracting(cached)
        let toStop = cached.subtracting(wanted)
        cached = wanted
        for id in toStart {
            guard let month = months.first(where: { $0.id == id }) else { continue }
            Task { await PhotoLibraryIO.shared.startCaching(month.assets) }
        }
        for id in toStop {
            guard let month = months.first(where: { $0.id == id }) else { continue }
            Task { await PhotoLibraryIO.shared.stopCaching(month.assets) }
        }
    }
}

private struct AssetPreview: Identifiable {
    let asset: PHAsset
    var id: String { asset.localIdentifier }
}

/// `.task(id:)` key for the category filter's batch load: a category switch or a new analysis
/// batch (`revision`) both need a fresh `PhotoAnalysisStore.ids(in:newerThan:)` read.
private struct CategoryFilterKey: Equatable {
    let category: String?
    let revision: Int
}

extension View {
    /// Bundles B3's tab-visibility/scene-phase wiring and B4's category-filter reload into one
    /// modifier — kept out of `PhotoLibraryBrowser.body` (rather than four more chained calls) so
    /// that property's type-check time stays under the 200ms budget. `active` is `false` for the
    /// picker sheet's browser instance, which never drives the sweep or shows the category chips.
    fileprivate func photoSweepLifecycle(
        active: Bool, sweep: PhotoClassificationSweep?, scenePhase: ScenePhase,
        categoryFilterKey: CategoryFilterKey, loadCategoryFilter: @escaping () async -> Void
    ) -> some View {
        onAppear { if active { sweep?.setActive(true) } }
            .onDisappear { if active { sweep?.setActive(false) } }
            .onChange(of: scenePhase) { _, phase in if active { sweep?.setSceneActive(phase == .active) } }
            .task(id: categoryFilterKey) {
                guard sweep != nil else { return }
                await loadCategoryFilter()
            }
    }
}

private struct CategoryChip: View {
    let category: PhotoCategory
    let selected: Bool
    let action: () -> Void

    private var tint: Color {
        let index = PhotoImportCatalog.categories.firstIndex { $0.key == category.key } ?? 0
        return PorcelainTokens.chartRamp[index % PorcelainTokens.chartRamp.count]
    }

    var body: some View {
        Button(action: action) {
            Text("\(category.emoji) \(category.label)")
        }
        .buttonStyle(.bordered)
        .tint(selected ? tint : nil)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// One month's grid + pinned header, extracted out of `PhotoLibraryBrowser.body` (rather than
/// nesting `LazyVGrid`/`ForEach`/`contextMenu` four levels deep inline) so that property's
/// type-check time stays under the 200ms budget.
private struct MonthSection: View {
    let month: PhotoLibraryStore.Month
    let assets: [PHAsset]
    let columns: [GridItem]
    let selectionNumbers: [String: Int]
    let library: PhotoLibraryStore
    @Binding var preview: AssetPreview?
    let onToggle: (String) -> Void

    var body: some View {
        if !assets.isEmpty {
            Section {
                LazyVGrid(columns: columns, spacing: 3) {
                    ForEach(assets, id: \.localIdentifier) { asset in
                        cell(for: asset)
                    }
                }
            } header: {
                header
            }
        }
    }

    private func cell(for asset: PHAsset) -> some View {
        PhotoLibraryCell(asset: asset, selection: selectionNumbers[asset.localIdentifier]) {
            library.scrollID = asset.localIdentifier
            onToggle(asset.localIdentifier)
        } onShowDetails: {
            library.scrollID = asset.localIdentifier
            preview = AssetPreview(asset: asset)
        }
        .contextMenu {
            Button("View photo and Cubby matches", systemImage: "info.circle") {
                library.scrollID = asset.localIdentifier
                preview = AssetPreview(asset: asset)
            }
        }
    }

    private var header: some View {
        Text(month.id == .distantPast ? "Undated" : month.id.formatted(.dateTime.month(.wide).year()))
            .font(.headline)
            .padding(.horizontal, 12)
            .padding(.vertical)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.bar)
    }
}

private struct PhotoLibraryCell: View {
    @Environment(AppModel.self) private var appModel
    @Environment(\.developerOverlays) private var developerOverlays
    let asset: PHAsset
    let selection: Int?
    let onTap: () -> Void
    let onShowDetails: () -> Void
    @State private var image: CGImage?
    /// Reading this box's `state` (rather than `photoMatches.candidates`/`directOwnersByImageID`
    /// directly) is what makes this cell re-render only on its own status changes: Observation
    /// tracks whole-property access, so reading those dictionaries here would re-render every
    /// mounted cell on each scan batch, regardless of which asset it touched.
    private var cellState: PhotoGridCellState {
        appModel.photoMatches.cellStateBox(for: asset.localIdentifier).state
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
                .overlay(alignment: .bottomTrailing) { cornerBadge }
                .overlay(alignment: .topTrailing) {
                    if let selection {
                        Text("\(selection)").font(.caption.bold()).padding(7)
                            .background(.blue, in: Circle()).foregroundStyle(.white).padding(5)
                            .accessibilityHidden(true)
                    }
                }
                .overlay(alignment: .bottomLeading) { analysisDot }
        }.buttonStyle(.plain)
            .overlay(alignment: .topLeading) { detailsButton }
            .help(cellState.accessibilityStatus)
            .accessibilityLabel(cellAccessibilityLabel)
            .accessibilityValue(selection.map { "Selected photo \($0)" } ?? "")
            .onDisappear { image = nil }
            .task(id: asset.modificationDate) {
                do {
                    image = try await appModel.photoLibrary.thumbnail(
                        asset, matches: appModel.photoMatches
                    ) { frame in image = frame }
                } catch
                { /* Local-only grid requests can fail for cloud assets; selection retries with network access. */
                }
            }
    }

    /// Ownership and selection occupy different corners so selecting cannot hide a match.
    private var cornerBadge: some View {
        PhotoGridMatchIndicator(state: cellState).padding(5)
    }

    /// B4's grid dot: absent while pending, `.secondary` once analysed with no category hit,
    /// category-tinted (by ramp index, never by key) once a hit lands. Developer overlays layer 1
    /// adds the classify time and top label underneath, purely as an overlay caption — it never
    /// changes the tile's own layout.
    @ViewBuilder private var analysisDot: some View {
        VStack(alignment: .trailing, spacing: 2) {
            switch cellState.analysis {
            case .pending:
                EmptyView()
            case .analysed(let categories):
                Circle().fill(PhotoCategoryTint.color(for: categories) ?? Color.secondary)
                    .frame(width: 6, height: 6)
            }
            if developerOverlays, let classifyMs = cellState.classifyMs {
                DevOverlayText(analysisOverlayCaption(classifyMs))
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
            }
        }
        .padding(6)
    }

    private func analysisOverlayCaption(_ classifyMs: Double) -> String {
        let label = cellState.topLabel.map { " · \($0)" } ?? ""
        return "\(Int(classifyMs))ms\(label)"
    }

    private var detailsButton: some View {
        Button(action: onShowDetails) {
            Image(systemName: "info.circle.fill")
                .font(.system(size: 24))
                .foregroundStyle(.white)
                .frame(width: 32, height: 32)
                .background(.ultraThinMaterial, in: Circle())
                #if os(iOS)
                    .frame(width: 44, height: 44)
                #endif
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(4)
        .accessibilityLabel("Photo details")
        .help("Photo details")
        .accessibilityIdentifier("photos.grid.details")
    }

    private var cellAccessibilityLabel: String {
        let date = asset.creationDate?.formatted(date: .abbreviated, time: .shortened) ?? "Undated photo"
        return "\(date), \(cellState.accessibilityStatus)"
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
    @State private var matchInspection = PhotoMatchInspectionModel()

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
                case .diagnostics:
                    PhotoMatchInspectionView(model: matchInspection) {
                        matchInspection.inspect(
                            asset: asset, matches: appModel.photoMatches,
                            analysisStore: appModel.photoAnalysisStore, client: appModel.client)
                    }
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
                .onDisappear { matchInspection.cancel() }
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
                let state = appModel.photoMatches.cellStateBox(for: asset.localIdentifier).state
                HStack {
                    PhotoGridMatchIndicator(state: state).accessibilityHidden(true)
                    Text(state.accessibilityStatus)
                }
            }
            ForEach(Array(candidates.enumerated()), id: \.offset) { _, candidate in
                let owners = Set(appModel.photoMatches.directOwnerShortcodes(for: candidate.id)).sorted()
                if !owners.isEmpty {
                    Text(owners.joined(separator: ", "))
                        .font(.subheadline.monospaced())
                        .textSelection(.enabled)
                        .accessibilityLabel(
                            "\(candidate.confidence == .strong ? "Owned by" : "Possible owners") \(owners.joined(separator: ", "))"
                        )
                }
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

}

#Preview(traits: .modifier(SignedInPreview())) { NavigationStack { PhotosRootView() } }

#Preview("Developer overlays on", traits: .modifier(SignedInPreview())) {
    NavigationStack { PhotosRootView() }
        .environment(\.developerOverlays, true)
}

#Preview("Category chips") {
    HStack {
        ForEach(PhotoImportCatalog.categories, id: \.key) { category in
            CategoryChip(
                category: category, selected: category.key == PhotoImportCatalog.categories.first?.key
            ) {}
        }
    }
    .padding()
}

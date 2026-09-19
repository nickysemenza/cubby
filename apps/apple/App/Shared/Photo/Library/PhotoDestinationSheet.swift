import CubbyKit
import SwiftUI

/// One review surface for routing, staging, and atomically committing a selected photo batch.
struct PhotoDestinationSheet: View {
    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.developerOverlays) private var developerOverlays
    let manifest: PhotoImportManifest
    let onDone: ([String]) -> Void
    @State private var path: [PhotoImportNavigationDestination] = []
    @State private var replacement: ReplacementConfirmation?
    @State private var createContext: PhotoCreateContext?
    @State private var relatedContext: PhotoRelatedContext?
    @State private var createSelfContext: PhotoCreateSelfContext?
    @State private var createTargetContext: PhotoCreateTargetContext?
    /// A2: reverse-geocodes each group's representative photo so its row can add "· photo ·
    /// <city>" evidence once known.
    @State private var provenance = PhotoCaptureProvenance()

    /// `.bottomBar` is iOS/tvOS/watchOS-only; macOS has no equivalent placement, so this bar's
    /// items fall back to the window toolbar there.
    private static var commitBarPlacement: ToolbarItemPlacement {
        #if os(iOS)
            .bottomBar
        #else
            .automatic
        #endif
    }

    var body: some View {
        NavigationStack(path: $path) {
            reviewLayout
                .navigationTitle("Review photos")
                #if os(iOS)
                    .navigationBarTitleDisplayMode(.inline)
                #endif
                .navigationSubtitle("\(manifest.selectedIDs.count) of \(manifest.items.count) selected")
                .toolbar { reviewToolbar }
                .safeAreaInset(edge: .bottom, spacing: 0) { statusFooter }
                .navigationDestination(for: PhotoImportNavigationDestination.self) { destination in
                    destinationScreen(destination)
                }
        }
        .nativeSheet(.photo)
        .interactiveDismissDisabled(manifest.isCommitting)
        .task {
            manifest.startAnalysis(client: appModel.client, matches: appModel.photoMatches)
        }
        // A1: a pushed chooser/editor defers the manifest's focus/selection advance until the
        // pop back to the review list (see `PhotoImportManifest.isNavigating`).
        .onChange(of: path) { _, newPath in manifest.isNavigating = !newPath.isEmpty }
        .confirmationDialog(
            "Replace the existing image?", item: $replacement,
            titleVisibility: .visible
        ) { confirmation in
            Button("Replace", role: .destructive) {
                manifest.moveSelected(to: confirmation.option, row: confirmation.row, replace: true)
                path.removeLast()
            }
            Button("Cancel", role: .cancel) {}
        } message: { confirmation in
            Text(
                "\(confirmation.row.title) already has an image. This photo will replace it when the batch is added."
            )
        }
        .sheet(item: $createContext) { context in
            PhotoRelatedCreateEditor(
                mode: .createRelated(option: context.option, source: context.source),
                captureDate: manifest.scopedCaptureDate,
                heroItems: manifest.scopedHeroItems,
                importManifest: manifest
            ) { option, sourceRow, body in
                manifest.stageCreate(option: option, source: sourceRow, body: body)
                createContext = nil
                path.removeAll()
            }
        }
        .sheet(item: $createSelfContext) { context in
            PhotoRelatedCreateEditor(
                mode: .createSelf(option: context.option),
                captureDate: manifest.scopedCaptureDate,
                heroItems: manifest.scopedHeroItems,
                importManifest: manifest
            ) { option, _, body in
                manifest.stageCreate(option: option, source: nil, body: body)
                createSelfContext = nil
                path.removeAll()
            }
        }
        .sheet(item: $createTargetContext) { context in
            PhotoRelatedCreateEditor(
                mode: .createTarget(
                    descriptor: EntityCatalog[context.type], candidates: context.candidates,
                    fallback: context.fallback),
                captureDate: manifest.scopedCaptureDate,
                heroItems: manifest.scopedHeroItems,
                importManifest: manifest
            ) { option, sourceRow, body in
                manifest.stageCreate(option: option, source: sourceRow, body: body)
                createTargetContext = nil
                path.removeAll()
            }
        }
        .sheet(item: $relatedContext) { context in
            let captureDate = manifest.scopedCaptureDate
            PhotoRelatedDestinationChooser(
                context: context,
                createOption: manifest.createAlternative(for: context.option),
                captureDate: captureDate,
                heroItems: manifest.scopedHeroItems,
                importManifest: manifest
            ) { row in
                manifest.moveSelected(
                    to: context.option, source: context.source, destination: row,
                    captureDate: captureDate)
                relatedContext = nil
                if !path.isEmpty { path.removeLast() }
            } onCreate: { option, body in
                manifest.stageCreate(option: option, source: context.source, body: body)
                if !path.isEmpty { path.removeLast() }
            }
            .environment(appModel)
        }
    }

    /// Extracted so `body` stays under the project's 200ms type-check budget
    /// (apps/apple/AGENTS.md, "A generator must never emit…" note on long-body stalls; the same
    /// principle applies to a hand-written body this long).
    @ViewBuilder
    private var manifestListContent: some View {
        if !manifest.needsDestination.isEmpty {
            Section {
                PhotoImportGroupRows(
                    ids: manifest.needsDestination, manifest: manifest,
                    onChangeDestination: { path.append(.sourceTypes) })
            } header: {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Needs a destination").font(.headline)
                    if let caption = analysisCompleteCaption {
                        Text(caption).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        ForEach(Array(manifest.groups.enumerated()), id: \.element.id) { index, group in
            Section {
                PhotoImportGroupRows(
                    ids: group.photoIDs, manifest: manifest,
                    onChangeDestination: { path.append(.sourceTypes) })
            } header: {
                groupHeader(group, showsAnalysisCaption: manifest.needsDestination.isEmpty && index == 0)
            }
        }
        Section {
            PhotoAnalysisDisclosure(manifest: manifest)
        }
    }

    private func groupHeader(_ group: PhotoImportGroup, showsAnalysisCaption: Bool) -> some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(group.title).font(.headline)
                if let evidence = groupEvidence(group) {
                    Text(evidence).font(.caption).foregroundStyle(.secondary)
                }
                if showsAnalysisCaption, let caption = analysisCompleteCaption {
                    Text(caption).font(.caption).foregroundStyle(.secondary)
                }
                if developerOverlays {
                    DevOverlayText(group.decision.reasonLabel)
                }
            }
            Spacer()
            if let source = group.source, let sourceRow = group.sourceRow {
                Button("Change destination…") {
                    path.append(.routePicker(source: source, row: sourceRow))
                }
                .font(.caption)
                .accessibilityIdentifier("photos.manifest.changeDestination.\(group.id)")
            }
        }
        .task(id: group.photoIDs.first) {
            guard let id = group.photoIDs.first,
                let item = manifest.items.first(where: { $0.id == id })
            else { return }
            await provenance.resolve(id: item.id, location: item.location)
        }
    }

    /// `group.evidence` with "· photo · <city>" appended once the group's representative photo's
    /// location has resolved (A2) — never blocks or reflows the row while it's still pending.
    private func groupEvidence(_ group: PhotoImportGroup) -> String? {
        let city = group.photoIDs.first
            .flatMap { id in manifest.items.first(where: { $0.id == id }) }
            .flatMap { provenance.result(for: $0.id)?.city }
        let parts = [group.evidence, city.map { "photo · \($0)" }].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    @ToolbarContentBuilder
    private var reviewToolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        if developerOverlays {
            ToolbarItem { CopyDiagnosticsButton { reviewDiagnostics } }
        }
        if manifest.canUndo {
            ToolbarItem(placement: .secondaryAction) {
                Button("Undo", systemImage: "arrow.uturn.backward") {
                    manifest.undoLastMove()
                }
                .keyboardShortcut("z", modifiers: .command)
                .accessibilityIdentifier("photos.manifest.undo")
            }
        }
        // At regular width the button sits under the filmstrip in the side column (see
        // `reviewLayout`); in the toolbar it would land beside Cancel in macOS's bottom bar.
        if horizontalSizeClass != .regular {
            ToolbarItem(placement: .primaryAction) { selectAllButton }
        }
        ToolbarItemGroup(placement: Self.commitBarPlacement) {
            Text("\(manifest.items.count) photo\(manifest.items.count == 1 ? "" : "s")")
                .foregroundStyle(.secondary)
            Spacer()
            if manifest.commitRequiresReview {
                Button("Check status") {
                    Task {
                        guard let committedIDs = await manifest.checkCommitStatus(client: appModel.client)
                        else { return }
                        await finish(with: committedIDs)
                    }
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("photos.destination.checkStatus")
            } else {
                Button(manifest.commitActionTitle) {
                    Task {
                        guard let committedIDs = await manifest.commit(client: appModel.client)
                        else { return }
                        await finish(with: committedIDs)
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!manifest.canCommit)
                .accessibilityIdentifier("photos.manifest.add")
            }
        }
    }

    /// Pushed screens for the review flow. Kept out of `body` so its expression stays under the
    /// 200ms type-check budget.
    @ViewBuilder
    private func destinationScreen(_ destination: PhotoImportNavigationDestination) -> some View {
        switch destination {
        case .sourceTypes:
            List {
                PhotoImportHero(items: manifest.scopedHeroItems)
                PhotoAnalysisDisclosure(manifest: manifest)
                Section("Choose what is in the photo") {
                    ForEach(manifest.sourceTypeOptions) { type in
                        Button {
                            path.append(.sourceType(type.source))
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: entitySymbol(for: type.source))
                                    .frame(width: 24)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(type.title)
                                    Text(type.outcomeDescription)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        .accessibilityIdentifier("photos.source-type.\(type.source.rawValue)")
                    }
                }
            }
            .navigationTitle("Assign selected…")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
        case .sourceType(let source):
            if let type = manifest.sourceTypeOptions.first(where: {
                $0.source == source
            }) {
                PhotoEntityChooser(
                    key: source, captureDates: manifest.selectedItems.map(\.capturedAt),
                    heroItems: manifest.scopedHeroItems, importManifest: manifest,
                    onCreateNew: handleCreateNew
                ) { row in
                    chooseSourceRecord(type, row: row)
                }
            } else {
                ContentUnavailableView(
                    "Destination unavailable",
                    systemImage: "exclamationmark.triangle",
                    description: Text(
                        "Cubby couldn't resolve the photo routes for this type."
                    ))
            }
        case .routePicker(let source, let row):
            List {
                PhotoImportHero(items: manifest.scopedHeroItems)
                PhotoAnalysisDisclosure(manifest: manifest)
                if let type = manifest.sourceTypeOptions.first(where: {
                    $0.source == source
                }) {
                    Section(
                        "Where should this \(EntityCatalog[source].singular) store photos?"
                    ) {
                        ForEach(type.options) { option in
                            Button(option.menuTitle(for: row)) {
                                chooseRoute(option, source: row)
                            }
                            .accessibilityIdentifier("photos.route.\(option.id)")
                        }
                    }
                } else {
                    ContentUnavailableView(
                        "Destination unavailable",
                        systemImage: "exclamationmark.triangle",
                        description: Text(
                            "Cubby couldn't resolve the photo routes for \(row.id)."
                        ))
                }
            }
            .navigationTitle("Choose storage")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
        }
    }

    /// Phones stack hero → status → list. At regular width (iPad, macOS sheet) the hero, filmstrip
    /// and assign action form a fixed side column so the assignment list gets the full height —
    /// stacked, a 960pt-wide Mac sheet left the list ~40% of the height with half the width empty.
    @ViewBuilder private var reviewLayout: some View {
        if horizontalSizeClass == .regular {
            // A3: a `GeometryReader` at the sheet root gives the column a share of the actual
            // sheet width instead of a fixed 400pt that was cramped once the Mac sheet started
            // tracking the (larger) window; `.padding()` keeps the title clear of the top safe
            // area and the hero clear of the divider, both of which used to run edge-to-edge.
            GeometryReader { geometry in
                HStack(spacing: 0) {
                    sideColumn(width: max(400, geometry.size.width * 0.36))
                    Divider()
                    List { manifestListContent }
                }
            }
            #if os(macOS)
                .frame(minWidth: 960, minHeight: 620)
            #endif
        } else {
            VStack(alignment: .leading, spacing: 0) {
                hero(heightCap: (220, 0.22))
                analysisStatus
                destinationAction
                List { manifestListContent }
            }
        }
    }

    /// The regular-width hero/filmstrip/assign-action column, extracted so `reviewLayout` stays
    /// under the project's type-check budget (apps/apple/AGENTS.md).
    private func sideColumn(width: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            hero(heightCap: (480, 0.5))
            HStack {
                Text("\(manifest.selectedIDs.count) of \(manifest.items.count) selected")
                    .font(.subheadline).foregroundStyle(.secondary)
                Spacer()
                selectAllButton.buttonStyle(.borderless)
            }
            analysisStatus
            destinationAction
            Spacer(minLength: 0)
        }
        .padding()
        .frame(width: width)
    }

    private var selectAllButton: some View {
        Button(manifest.selectedIDs.count == manifest.items.count ? "Deselect all" : "Select all") {
            manifest.toggleSelectAll()
        }
        .accessibilityIdentifier("photos.manifest.selectAll")
    }

    private func hero(heightCap: (points: CGFloat, fraction: CGFloat)) -> some View {
        PhotoImportHero(
            items: manifest.items,
            selectedIDs: manifest.selectedIDs,
            focusedID: Binding(
                get: { manifest.focusedItemID ?? manifest.items.first?.id ?? "" },
                set: { manifest.focusedItemID = $0 }),
            heightCap: heightCap,
            onToggle: manifest.toggle
        )
    }

    @ViewBuilder
    private var analysisStatus: some View {
        switch manifest.analysisState {
        case .idle:
            EmptyView()
        case .running(let message):
            HStack(spacing: 10) {
                ProgressView().controlSize(.small).accessibilityHidden(true)
                Text(message)
                Spacer()
                Button("Stop") { manifest.cancelAnalysis() }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .accessibilityIdentifier("photos.analysis.cancel")
            }
            .font(.subheadline)
            .padding(.horizontal)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.bar)
            .accessibilityElement(children: .combine)
        case .complete:
            // Folded into the first list section's header (`analysisCompleteCaption`) instead of
            // its own fixed row, so it scrolls with the content rather than sitting above it.
            EmptyView()
        case .failed(let message):
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Label(message, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(PorcelainTokens.destructive)
                Spacer()
                Button("Retry") {
                    Task {
                        manifest.startAnalysis(
                            client: appModel.client, matches: appModel.photoMatches)
                    }
                }
            }
            .font(.subheadline)
            .padding(.horizontal)
            .padding(.vertical, 8)
        }
    }

    /// The former standalone "Analysis complete" row, now the first list section's header
    /// caption (see the `Section` headers in `body`) instead of a fixed row above the list.
    private var analysisCompleteCaption: String? {
        guard case .complete = manifest.analysisState else { return nil }
        return manifest.needsDestination.isEmpty
            ? "Analysis complete"
            : "Analysis complete · \(manifest.needsDestination.count) need a destination"
    }

    @ViewBuilder
    private var destinationAction: some View {
        if !manifest.selectedIDs.isEmpty {
            VStack(spacing: 6) {
                if manifest.isResolvingSourceRecord {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Finding existing…")
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("photos.manifest.resolvingSource")
                }
                if let suggested = manifest.selectedSuggestedSource {
                    Button {
                        chooseSourceRecord(suggested.type, row: suggested.row)
                    } label: {
                        Label(
                            "Choose \(suggested.row.title) · \(suggested.row.id)",
                            systemImage: entitySymbol(for: suggested.type.source)
                        )
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("photos.manifest.suggested-source")

                    Button("Choose another type…") { path.append(.sourceTypes) }
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                } else if let suggested = manifest.selectedSuggestedSourceType {
                    Button {
                        path.append(.sourceType(suggested))
                    } label: {
                        Label(
                            "Choose \(EntityCatalog[suggested].singular.lowercased())",
                            systemImage: entitySymbol(for: suggested)
                        )
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("photos.manifest.suggested-source-type")

                    Button("Choose another type…") { path.append(.sourceTypes) }
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                } else if !manifest.selectedSourceTypeSuggestionGroups.isEmpty {
                    ForEach(manifest.selectedSourceTypeSuggestionGroups) { group in
                        Button {
                            manifest.selectSuggestedPhotos(for: group.source)
                            path.append(.sourceType(group.source))
                        } label: {
                            Label(
                                "Choose \(EntityCatalog[group.source].plural) for \(group.photoIDs.count) photos",
                                systemImage: entitySymbol(for: group.source)
                            )
                            .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier(
                            "photos.manifest.suggested-group.\(group.source.rawValue)")
                    }

                    Button("Choose another type…") { path.append(.sourceTypes) }
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                } else {
                    Button {
                        path.append(.sourceTypes)
                    } label: {
                        Label("Assign selected…", systemImage: "arrow.right.circle")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }
            }
            .padding(.horizontal)
            .padding(.bottom, 8)
            .accessibilityIdentifier("photos.manifest.destination")
        }
    }

    private func chooseSourceRecord(_ type: PhotoSourceTypeOption, row: EntityRow) {
        Task {
            switch await manifest.chooseSourceRecord(type, row: row, client: appModel.client) {
            case .routePicker:
                path.append(.routePicker(source: type.source, row: row))
            case .resolved:
                path.removeAll()
            case .relatedChooser(let option, let page):
                relatedContext = PhotoRelatedContext(option: option, source: row, preloaded: page)
                path.removeAll()
            case .createEditor(let option):
                createContext = PhotoCreateContext(option: option, source: row)
            }
        }
    }

    private func chooseRoute(_ option: PhotoDestinationOption, source: EntityRow) {
        switch option.route.kind {
        case .createRelated:
            createContext = PhotoCreateContext(option: option, source: source)
        case .existingRelated:
            relatedContext = PhotoRelatedContext(option: option, source: source)
            path.removeAll()
        case .`self`:
            // Reached only via the interactive route picker (a `.prompt` route, or an ambiguous
            // fallback) — `.prompted`, distinct from a chooser row's plain `.user` pick.
            manifest.moveSelected(to: option, row: source, decision: .prompted)
            path.removeAll()
        case .createSelf:
            // Unreachable: the route picker's menu is `type.options`, which excludes `createSelf`
            // (see `destinationOptions`) — that affordance lives on `PhotoEntityChooser`'s "New
            // <entity>" row instead, which never has an existing `source` row to route from.
            break
        }
    }

    /// Opens (or, when every remaining field is optional, skips straight past) the create editor
    /// for a type's own `createSelf` route — the "New <entity>" row's plain case, with no source
    /// record and no candidate routes to choose between.
    private func stageOrOpenCreateSelfEditor(_ option: PhotoDestinationOption) {
        guard option.route.enabled else { return }
        let captureDate = manifest.scopedCaptureDate
        if PhotoRelatedCreateEditor.hasOnlyOptionalFields(
            option: option, source: nil, captureDate: captureDate)
        {
            manifest.stageCreate(
                option: option, source: nil,
                body: PhotoRelatedCreateEditor.createPrefill(
                    option: option, source: nil, captureDate: captureDate))
            path.removeAll()
        } else {
            createSelfContext = PhotoCreateSelfContext(option: option)
        }
    }

    private func handleCreateNew(_ affordance: PhotoNewRecordAffordance) {
        switch affordance {
        case .createSelf(let option):
            stageOrOpenCreateSelfEditor(option)
        case .createTarget(let candidates, let fallback):
            guard let type = candidates.first?.route.target ?? fallback?.route.target else { return }
            createTargetContext = PhotoCreateTargetContext(
                type: type, candidates: candidates, fallback: fallback)
        }
    }

    /// Error/disabled-reason banners only — the commit action itself lives in the `.bottomBar`
    /// toolbar group so it gets the system bar's Liquid Glass instead of a hand-built background.
    @ViewBuilder
    private var statusFooter: some View {
        if manifest.errorMessage != nil || (!manifest.canCommit && manifest.commitDisabledReason != nil) {
            VStack(alignment: .leading, spacing: 4) {
                if let error = manifest.errorMessage {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(PorcelainTokens.destructive)
                }
                if !manifest.canCommit, let reason = manifest.commitDisabledReason {
                    Label(reason, systemImage: "info.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 6)
        }
    }

    /// Developer overlays layer 7: every group's decision reason plus each unassigned photo's
    /// best-scoring evidence breakdown.
    private var reviewDiagnostics: PhotoReviewDiagnostics {
        PhotoReviewDiagnostics(
            groups: manifest.groups.map {
                .init(title: $0.title, photoCount: $0.photoIDs.count, decision: $0.decision.reasonLabel)
            },
            needsDestination: manifest.needsDestination.map { id in
                .init(photoID: id, suggestion: manifest.suggestions[id], score: manifest.suggestionScores[id])
            })
    }

    private func finish(with committedIDs: [String]) async {
        onDone(committedIDs)
        dismiss()
        await appModel.photoMatches.refresh(client: appModel.client, priorityIDs: Set(committedIDs))
    }
}

private struct PhotoImportGroupRows: View {
    @Environment(\.developerOverlays) private var developerOverlays
    let ids: [String]
    @Bindable var manifest: PhotoImportManifest
    /// Pulls a single wrongly grouped photo out for a fresh source-type pick without undoing the
    /// rest of the batch: the row action scopes selection to `id` first, then this navigates.
    let onChangeDestination: () -> Void

    var body: some View {
        ForEach(ids, id: \.self) { id in
            if let item = manifest.items.first(where: { $0.id == id }) {
                Button {
                    manifest.toggle(id)
                } label: {
                    HStack(spacing: 12) {
                        Image(decorative: item.preview, scale: 1).resizable().scaledToFill()
                            .frame(width: 52, height: 52).clipShape(RoundedRectangle(cornerRadius: 8))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(
                                item.capturedAt?.formatted(date: .abbreviated, time: .shortened)
                                    ?? "Undated photo")
                            if let suggestion = manifest.suggestions[id] {
                                Text(suggestion).font(.caption).foregroundStyle(.secondary)
                            } else if manifest.analysisState == .complete,
                                manifest.needsDestination.contains(id)
                            {
                                Text("No confident match")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            if developerOverlays, let score = manifest.suggestionScores[id] {
                                DevOverlayText(Self.scoreCaption(score))
                            }
                            if let candidates = manifest.duplicateCandidates[id] {
                                Menu {
                                    ForEach(candidates, id: \.id) { candidate in
                                        Button {
                                            manifest.chooseExisting(candidate.id, for: id)
                                        } label: {
                                            Label(
                                                "Use \(manifest.duplicateLabel(candidate))",
                                                systemImage: manifest.duplicateSelection(id)
                                                    == .reuse(candidate.id)
                                                    ? "checkmark.circle.fill" : "circle")
                                        }
                                    }
                                    Divider()
                                    Button {
                                        manifest.chooseNew(for: id)
                                    } label: {
                                        Label(
                                            "Add separately",
                                            systemImage: manifest.duplicateSelection(id) == .keepBoth
                                                ? "checkmark.circle.fill" : "circle")
                                    }
                                } label: {
                                    Label(
                                        manifest.duplicateSelection(id) == nil
                                            ? "Review possible duplicate" : "Duplicate reviewed",
                                        systemImage: manifest.duplicateSelection(id) == nil
                                            ? "exclamationmark.circle" : "checkmark.circle")
                                }
                                .font(.caption)
                                .accessibilityIdentifier("photos.duplicate.\(id)")
                            }
                        }
                        Spacer()
                        Image(
                            systemName: manifest.selectedIDs.contains(id) ? "checkmark.circle.fill" : "circle"
                        )
                        .foregroundStyle(manifest.selectedIDs.contains(id) ? .blue : .secondary)
                    }
                }.buttonStyle(.plain).accessibilityValue(
                    manifest.selectedIDs.contains(id) ? "Selected" : "Not selected"
                )
                .contextMenu {
                    Button("Change destination…", systemImage: "arrow.triangle.2.circlepath") {
                        changeDestination(id)
                    }
                }
                .swipeActions(edge: .trailing) {
                    Button("Change…") { changeDestination(id) }
                        .tint(.blue)
                }
            }
        }
    }

    private func changeDestination(_ id: String) {
        manifest.selectedIDs = [id]
        manifest.focusedItemID = id
        onChangeDestination()
    }

    /// "text 0.00 · date 0.88 · visual 1.00 · classifier 0.08 → 0.96" (developer overlays layer 2).
    /// `Score.identity` is shown as "visual": it is set from an authoritative-owner or visual-match
    /// hit, never from text/date/classifier evidence — see `PhotoEvidenceScorer.score`.
    private static func scoreCaption(_ score: PhotoEvidenceScorer.Score) -> String {
        let parts = [
            "text \(String(format: "%.2f", score.text))",
            "date \(String(format: "%.2f", score.date))",
            "visual \(String(format: "%.2f", score.identity))",
            "classifier \(String(format: "%.2f", score.classifier))",
        ]
        return "\(parts.joined(separator: " · ")) → \(String(format: "%.2f", score.combined))"
    }
}

/// Developer overlays layer 7's "Copy diagnostics" payload for the review sheet.
private struct PhotoReviewDiagnostics: Encodable {
    struct Group: Encodable {
        let title: String
        let photoCount: Int
        let decision: String
    }
    struct Suggestion: Encodable {
        let photoID: String
        let suggestion: String?
        let score: PhotoEvidenceScorer.Score?
    }
    let groups: [Group]
    let needsDestination: [Suggestion]
}

private struct ReplacementConfirmation: Identifiable {
    let option: PhotoDestinationOption
    let row: EntityRow
    var id: String { "\(option.id):\(row.id)" }
}

#Preview(traits: .modifier(SignedInPreview())) {
    PhotoDestinationSheetPreview()
}

private struct PhotoDestinationSheetPreview: View {
    @State private var manifest = PhotoImportManifest(items: [])

    var body: some View {
        PhotoDestinationSheet(manifest: manifest, onDone: { _ in })
    }
}

#Preview("Developer overlays on", traits: .modifier(SignedInPreview())) {
    PhotoDestinationSheet(manifest: PhotoImportManifest(items: []), onDone: { _ in })
        .environment(\.developerOverlays, true)
}

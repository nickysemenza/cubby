import CubbyKit
import SwiftUI

/// One review surface for routing, staging, and atomically committing a selected photo batch.
struct PhotoDestinationSheet: View {
    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.developerOverlays) private var developerOverlays
    @Environment(\.undoManager) private var undoManager
    let manifest: PhotoImportManifest
    let onDone: ([String]) -> Void
    @State private var path: [PhotoImportNavigationDestination] = []
    @State private var replacement: ReplacementConfirmation?
    @State private var createContext: PhotoCreateContext?
    @State private var relatedContext: PhotoRelatedContext?
    @State private var createSelfContext: PhotoCreateSelfContext?
    @State private var createTargetContext: PhotoCreateTargetContext?
    @State private var draftDismissal = DraftDismissalState()
    @State private var previewID: String?
    @State private var importBatch: PhotoImportRunBatch?
    @State private var committedIDs: [String]?
    @State private var deliveredResult = false

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
            Group {
                if committedIDs != nil {
                    completionContent
                } else {
                    reviewContent
                }
            }
            .navigationDestination(for: PhotoImportNavigationDestination.self) { destination in
                destinationScreen(destination)
            }
        }
        .nativeSheet(.photoReview)
        .onAppear { manifest.undoManager = undoManager }
        .onDisappear {
            manifest.undoManager?.removeAllActions(withTarget: manifest)
            manifest.undoManager = nil
        }
        .draftDismissal(
            $draftDismissal, isDirty: manifest.hasStagedChanges, isSaving: manifest.isCommitting
        ) { dismiss() }
        .onDisappear { deliverResult() }
        .photoImportViewer(
            isPresented: Binding(
                get: { previewID != nil }, set: { if !$0 { previewID = nil } }),
            items: manifest.items, initialID: previewID ?? manifest.items.first?.id ?? ""
        )
        .sheet(item: $importBatch) { batch in
            PhotoImportRunSheet(items: batch.items, flow: batch.flow) { _ in
                let uploadedIDs = batch.flow.session.importedPhotoIDs
                appModel.retirePhotoImport(batch.flow)
                importBatch = nil
                if !uploadedIDs.isEmpty {
                    committedIDs = Array(uploadedIDs)
                    deliverResult()
                    dismiss()
                }
            }
        }
        .task {
            manifest.startAnalysis(client: appModel.client, matches: appModel.photoMatches)
        }
        // A1: a pushed chooser/editor defers the manifest's focus/selection advance until the
        // pop back to the review list (see `PhotoImportManifest.isNavigating`).
        .onChange(of: path) { _, newPath in manifest.isNavigating = !newPath.isEmpty }
        .confirmationDialog(
            "Replace the existing image?",
            isPresented: Binding(
                get: { replacement != nil },
                set: { if !$0 { replacement = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Replace", role: .destructive) {
                guard let confirmation = replacement else { return }
                manifest.moveSelected(to: confirmation.option, row: confirmation.row, replace: true)
                path.removeAll()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            if let confirmation = replacement {
                Text(
                    "\(confirmation.row.title) already has an image. This photo will replace it when the batch is added."
                )
            }
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

    private var reviewContent: some View {
        reviewLayout
            .navigationTitle("Add photos")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar { reviewToolbar }
            .safeAreaBar(edge: .bottom) { statusFooter }

    }

    private var manifestListContent: some View {
        ForEach(manifest.items) { item in
            PhotoDestinationRow(
                item: item, manifest: manifest,
                onPreview: { previewID = item.id },
                onChangeDestination: { chooseDestination(for: [item.id]) })
        }
    }

    private func chooseDestination(for ids: [String]) {
        manifest.selectPhotos(ids)
        let currentType = manifest.groups.first {
            Set(ids).isSubset(of: Set($0.photoIDs))
        }?.source
        if let type = currentType ?? manifest.selectedSuggestedSourceType {
            path.append(.sourceType(type))
        } else {
            path.append(.sourceTypes)
        }
    }

    @ToolbarContentBuilder
    private var reviewToolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") {
                draftDismissal.request(
                    isDirty: manifest.hasStagedChanges, isSaving: manifest.isCommitting,
                    dismiss: dismiss)
            }
            .disabled(manifest.isCommitting)
        }
        ToolbarItem(placement: .primaryAction) {
            Button("Import selected belongings…", systemImage: "shippingbox") {
                manifest.cancelAnalysis()
                importBatch = PhotoImportRunBatch(
                    items: manifest.selectedItems, flow: appModel.makePhotoImportFlow())
            }
            .disabled(manifest.selectedIDs.isEmpty || manifest.isCommitting || manifest.commitRequiresReview)
            .labelStyle(.iconOnly)
            .help("Import selected belongings")
            .accessibilityIdentifier("photos.destination.import")
        }
        if developerOverlays {
            ToolbarItem { CopyDiagnosticsButton { reviewDiagnostics } }
        }
        if manifest.canUndo {
            ToolbarItem(placement: .secondaryAction) {
                Button("Undo", systemImage: "arrow.uturn.backward") {
                    manifest.undoLastMove()
                }
                .accessibilityIdentifier("photos.manifest.undo")
            }
        }
        // The list header owns the photo and selection count; the commit title repeats its scope.
        ToolbarItemGroup(placement: Self.commitBarPlacement) {
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
        case .record(let key, let id):
            EntityDetailView(key: key, id: id)
        case .sourceTypes:
            List {
                PhotoImportHero(items: manifest.scopedHeroItems, heightCap: (120, 0.14))
                if developerOverlays { PhotoAnalysisDisclosure(manifest: manifest) }
                Section("Choose what is in the photo") {
                    ForEach(manifest.sourceTypeOptions) { type in
                        Button {
                            path.append(.sourceType(type.source))
                        } label: {
                            HStack(spacing: FieldGuideTokens.Space.md) {
                                Image(systemName: entitySymbol(for: type.source))
                                    .fieldGuideIconSlot(width: 24)
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
                .toolbar {
                    ToolbarItem(placement: .secondaryAction) {
                        Menu("Change type", systemImage: "arrow.triangle.2.circlepath") {
                            ForEach(manifest.sourceTypeOptions) { option in
                                Button(option.title) {
                                    path = [.sourceType(option.source)]
                                }
                            }
                        }
                        .accessibilityIdentifier("photos.destination.changeType")
                    }
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
                PhotoImportHero(items: manifest.scopedHeroItems, heightCap: (120, 0.14))
                if developerOverlays { PhotoAnalysisDisclosure(manifest: manifest) }
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

    private var reviewLayout: some View {
        List {
            Section {
                HStack {
                    Text(selectionSummary)
                        .foregroundStyle(.secondary)
                    Spacer()
                    selectAllButton
                }
                .font(.subheadline)
                analysisStatus
                manifestListContent
                if manifest.selectedIDs.count > 1 {
                    Button("Change destination for \(manifest.selectedIDs.count) selected photos…") {
                        chooseDestination(for: Array(manifest.selectedIDs))
                    }
                    .accessibilityIdentifier("photos.manifest.destination")
                }
            }
            if developerOverlays {
                Section { PhotoAnalysisDisclosure(manifest: manifest) }
            }
        }
        .fieldGuideSectionStyle()
        .disabled(manifest.isCommitting || manifest.commitRequiresReview)
    }

    private var selectionSummary: String {
        let total = "\(manifest.items.count) photo\(manifest.items.count == 1 ? "" : "s")"
        let selected = manifest.selectedIDs.count
        return selected == 0 ? total : "\(selected) of \(total) selected"
    }

    /// Deselect all only once every photo, and at least one, is selected.
    private var selectAllButton: some View {
        let allSelected = !manifest.items.isEmpty && manifest.selectedIDs.count == manifest.items.count
        return Button(allSelected ? "Deselect all" : "Select all") {
            manifest.toggleSelectAll()
        }
        .buttonStyle(.borderless)
        .disabled(manifest.isCommitting || manifest.items.isEmpty)
        .accessibilityIdentifier("photos.manifest.selectAll")
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
            .padding(.horizontal, FieldGuideTokens.Space.md)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
        case .complete:
            // Folded into the first list section's header (`analysisCompleteCaption`) instead of
            // its own fixed row, so it scrolls with the content rather than sitting above it.
            EmptyView()
        case .failed(let message):
            InlineLoadFailure(message: message) {
                manifest.startAnalysis(client: appModel.client, matches: appModel.photoMatches)
            }
            .padding(.horizontal, FieldGuideTokens.Space.md)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func chooseSourceRecord(_ type: PhotoSourceTypeOption, row: EntityRow) {
        Task {
            switch await manifest.chooseSourceRecord(type, row: row, client: appModel.client) {
            case .replaceConfirmation(let option):
                replacement = ReplacementConfirmation(option: option, row: row)
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
            if option.route.requiresReplaceConfirmation && source.imageURL != nil {
                replacement = ReplacementConfirmation(option: option, row: source)
            } else {
                manifest.moveSelected(to: option, row: source, decision: .prompted)
                path.removeAll()
            }
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
        if manifest.errorMessage != nil
            || (!manifest.canCommit && !manifest.isCommitting && manifest.commitDisabledReason != nil)
        {
            VStack(alignment: .leading, spacing: 4) {
                if let error = manifest.errorMessage {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(FieldGuideTokens.destructive)
                }
                if !manifest.canCommit, !manifest.isCommitting,
                    let reason = manifest.commitDisabledReason
                {
                    Label(reason, systemImage: "info.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, FieldGuideTokens.Space.md)
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

    private var completionContent: some View {
        List {
            Section {
                Label(
                    "Added \(committedIDs?.count ?? 0) photo\(committedIDs?.count == 1 ? "" : "s")",
                    systemImage: "checkmark.circle"
                )
                .font(.headline)
                ForEach(Array(manifest.committedDestinations.enumerated()), id: \.offset) { _, destination in
                    if let id = destination.id {
                        NavigationLink(
                            value: PhotoImportNavigationDestination.record(destination.entity, id: id)
                        ) {
                            completionLabel(title: destination.title, count: destination.photoCount)
                        }
                    } else {
                        completionLabel(title: destination.title, count: destination.photoCount)
                    }
                }
            }
        }
        .navigationTitle("Photos added")
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") {
                    deliverResult(); dismiss()
                }
            }
        }
    }

    private func completionLabel(title: String, count: Int) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
            Text("\(count) photo\(count == 1 ? "" : "s")")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func deliverResult() {
        guard let committedIDs, !deliveredResult else { return }
        deliveredResult = true
        onDone(committedIDs)
    }

    private func finish(with committedIDs: [String]) async {
        self.committedIDs = committedIDs
        await appModel.photoMatches.refresh(client: appModel.client, priorityIDs: Set(committedIDs))
    }
}

private struct PhotoDestinationRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let item: PhotoSelectionItem
    @Bindable var manifest: PhotoImportManifest
    let onPreview: () -> Void
    let onChangeDestination: () -> Void

    private var group: PhotoImportGroup? {
        manifest.groups.first { $0.photoIDs.contains(item.id) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 8) {
                Button(action: onPreview) {
                    PhotoImportProgressiveImage(item: item, maxPixelSize: 320)
                        .frame(width: dynamicTypeSize.isAccessibilitySize ? 88 : 112, height: 112)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Preview photo")
                VStack(alignment: .leading, spacing: 4) {
                    if let capturedAt = item.capturedAt {
                        DateDisplay(date: capturedAt).font(.subheadline)
                    } else {
                        Text("Undated photo").font(.subheadline)
                    }
                    if group == nil {
                        Text(manifest.suggestions[item.id] ?? "Choose a destination")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if manifest.duplicateCandidates[item.id] == nil {
                        Text(manifest.matchStatus(item.id))
                            .font(.caption).foregroundStyle(.secondary)
                            .accessibilityIdentifier("photos.manifest.matchStatus.\(item.id)")
                    }
                }
                Spacer(minLength: 0)
                Button {
                    manifest.toggle(item.id)
                } label: {
                    Image(
                        systemName: manifest.selectedIDs.contains(item.id)
                            ? "checkmark.circle.fill" : "circle"
                    )
                    .frame(minWidth: 44, minHeight: 44)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Select photo")
                .accessibilityValue(manifest.selectedIDs.contains(item.id) ? "Selected" : "Not selected")
                .accessibilityIdentifier("photos.manifest.select.\(item.id)")
            }
            Button(action: onChangeDestination) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(group.map { "Add to \($0.title)" } ?? "Choose destination…")
                            .font(.subheadline.weight(.semibold))
                        if let evidence = group?.evidence {
                            Text(evidence).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary)
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .accessibilityIdentifier("photos.manifest.changeDestination.\(item.id)")
            if let candidates = manifest.duplicateCandidates[item.id] {
                Menu {
                    ForEach(candidates, id: \.id) { candidate in
                        Button("Use \(manifest.duplicateLabel(candidate))") {
                            manifest.chooseExisting(candidate.id, for: item.id)
                        }
                    }
                    Button("Add separately") { manifest.chooseNew(for: item.id) }
                } label: {
                    // The decision sits beside its own candidate; the label states the match or choice.
                    Label(
                        manifest.duplicateSelection(item.id) == nil
                            ? "\(manifest.matchStatus(item.id)) · Review" : manifest.matchStatus(item.id),
                        systemImage: "photo.on.rectangle")
                }
                .font(.caption)
                .accessibilityIdentifier("photos.duplicate.\(item.id)")
            }
        }
        .padding(.vertical, 4)
        .listRowInsets(EdgeInsets(top: 4, leading: 8, bottom: 4, trailing: 8))
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

import CubbyKit
import SwiftUI

/// One entity's detail screen, rendered from the catalog's `presentation`: hero, the declared
/// sections in order (`fields`, `relation`, `timeline`, `slot`), then the derived Relationships
/// graph and the raw record. Owns a `GenericEntityDetailModel` created per host, mirroring
/// `EntityListView`.
struct EntityDetailView: View {
    let key: EntityKey
    let id: String

    @Environment(AppModel.self) private var appModel
    @Environment(\.developerOverlays) private var developerOverlays
    @Environment(\.dismiss) private var dismiss
    @State private var model: GenericEntityDetailModel?
    @State private var relationSections: [RelationSectionModel] = []
    @State private var connectedRecords: ConnectedRecordsPreviewModel?
    @State private var suggestions: DetailSuggestionsModel?
    @State private var photoCapture: PhotoCaptureModel?
    @State private var editing = false
    @State private var creatingRelation: RelationSectionModel?
    @State private var actions: RecordActionPresenter?
    @State private var quickField: InlineEditSession?
    @State private var showingRunEvidence = false

    private var descriptor: EntityDescriptor { EntityCatalog[key] }

    var body: some View {
        let model = model
        let titled =
            content
            .fieldGuideScreen()
            #if os(iOS)
                .navigationTitle(descriptor.singular)
                .navigationBarTitleDisplayMode(.inline)
            #else
                // The window title, Window menu and Back history name the record; the kind is the
                // subtitle. The cramped iPhone bar keeps the kind alone.
                .navigationTitle(model?.row?.title ?? descriptor.singular)
                .navigationSubtitle(model?.row == nil ? "" : descriptor.singular)
                .copyable(
                    model?.row.map { [RecordCopyText.text(key: key, id: $0.id, title: $0.title)] } ?? []
                )
                .focusedSceneValue(\.recordCommands, model?.row.map(recordCommands))
            #endif
            .toolbar { detailToolbar }
        sheets(on: lifecycle(on: titled, model: model))
    }

    /// Extracted so `body` stays under the project's 200ms type-check budget: the load/refresh
    /// `.task`s, pull-to-refresh, and the Handoff `.userActivity`.
    private func lifecycle<V: View>(on view: V, model: GenericEntityDetailModel?) -> some View {
        view
            .task(id: id) { await setup() }
            .task(id: appModel.entityMutationRevision) {
                guard appModel.entityMutationRevision > 0,
                    appModel.entityMutationKeys.contains(key),
                    model?.phase == .loaded
                else { return }
                await refresh()
            }
            .refreshControl { await refresh() }
            .userActivity(NSUserActivityTypeBrowsingWeb, isActive: model?.row != nil) { activity in
                guard let row = model?.row else { return }
                activity.webpageURL = appModel.webHandoff.url(.record(key: key, id: row.id))
                activity.title = row.title
                activity.isEligibleForHandoff = true
                // Spotlight indexing is a separate path (`SpotlightIndexer`); this activity is
                // Handoff-only.
                activity.isEligibleForSearch = false
            }
    }

    /// Extracted so `body` stays under the project's 200ms type-check budget: the sheets.
    private func sheets<V: View>(on view: V) -> some View {
        view
            .sheet(item: $photoCapture) { capture in
                AddPhotoSheet(capture: capture) { _ in
                    Task { await model?.refresh(id: model?.row?.id ?? id) }
                }
            }
            .sheet(isPresented: $editing) {
                EntityEditorSheet(
                    key: key, mode: .update(id: model?.row?.id ?? id), original: model?.row?.raw
                ) { _ in
                    Task { await refresh() }
                }
                .environment(appModel)
            }
            .sheet(item: $quickField) { session in
                InlineFieldEditorSheet(session: session).environment(appModel)
            }
            .recordActionPresentation(
                actions, onFinished: finishAction, onEditorSaved: { Task { await refresh() } }
            )
            .sheet(isPresented: $showingRunEvidence) {
                NavigationStack { RunEvidenceView(runID: model?.row?.id ?? id) }
            }
            .sheet(item: $creatingRelation) { section in
                EntityEditorSheet(
                    key: section.target.key, mode: .create(prefill: section.createPrefill),
                    createFields: section.createFields
                ) { _ in
                    Task {
                        await section.list.refresh()
                        await section.loadConnectionEvidence()
                    }
                }
                .environment(appModel)
            }
    }

    @ToolbarContentBuilder
    private var detailToolbar: some ToolbarContent {
        if developerOverlays, let row = model?.row {
            ToolbarItem { copyDiagnosticsButton(row: row, fetchedAt: model?.fetchedAt) }
        }
        if let row = model?.row {
            if key.nativeActions.contains(.update) {
                ToolbarItem(placement: .primaryAction) {
                    Button("Edit") { editing = true }
                        .accessibilityIdentifier("detail.\(key.rawValue).edit")
                }
            }
            #if os(iOS)
                ToolbarItem {
                    ShareLink(item: appModel.webHandoff.url(.record(key: key, id: row.id))) {
                        Label("Share", systemImage: "square.and.arrow.up")
                    }
                }
            #endif
            ToolbarItem {
                Menu {
                    moreMenu(row: row)
                } label: {
                    Label("More", systemImage: "ellipsis.circle")
                }
                .accessibilityIdentifier("detail.\(key.rawValue).more")
            }
        }
    }

    /// More renders `ActionPlacement.more` in its groups: declared verbs (unavailable ones dimmed
    /// with the server's reason), flows and Add photo with Create related, Copy and Share, Open on
    /// web with every handoff, then Delete and other destructive verbs last.
    @ViewBuilder private func moreMenu(row: EntityRow) -> some View {
        let groups = ActionPlacement(entity: descriptor, row: row).more
        let createGroup = groups.firstIndex { group in
            group.contains { action in
                switch action.kind {
                case .addPhoto: true
                case .plan(let plan): if case .flow = plan.kind { true } else { false }
                default: false
                }
            }
        }
        ForEach(Array(groups.enumerated()), id: \.offset) { index, group in
            let isShare = group.contains { $0.kind == .copyLink }
            if isShare, createGroup == nil {
                Section { createItems(row: row) }
            }
            Section {
                ForEach(group) { action in moreItem(action, row: row) }
                if index == createGroup { createItems(row: row) }
                if isShare {
                    Button {
                        Clipboard.copy(row.id)
                    } label: {
                        Label("Copy shortcode", systemImage: "number")
                    }
                }
                if group.contains(where: { $0.kind == .openOnWeb }) {
                    ForEach(NativePresentationCoverage.recordHandoffs(descriptor, row: row), id: \.label) {
                        handoff in
                        OpenOnWebButton(target: handoff.target(key: key, id: row.id), label: handoff.label)
                    }
                }
            }
        }
    }

    @ViewBuilder private func moreItem(_ action: PlacedAction, row: EntityRow) -> some View {
        switch action.kind {
        case .share:
            ShareLink(item: appModel.webHandoff.url(.record(key: key, id: row.id))) {
                Label(action.label, systemImage: action.symbol)
            }
        case .openOnWeb:
            OpenOnWebButton(target: .record(key: key, id: row.id), label: action.label)
        default:
            PlacedActionMenuItem(entity: key, action: action, perform: perform)
        }
    }

    /// Create related records, the Run's evidence, and Connections: beside Add photo in More.
    @ViewBuilder private func createItems(row: EntityRow) -> some View {
        relationCreationMenuItems
        if key == .run {
            // The evidence sheet is presented from this view: a sheet owned by a menu item is
            // torn down with the menu.
            Button("Transcript, logs and AI usage", systemImage: "doc.text.magnifyingglass") {
                showingRunEvidence = true
            }
        }
        ConnectionsWorkspaceLink(entity: key.rawValue, recordID: row.id)
    }

    @ViewBuilder private var relationCreationMenuItems: some View {
        let declared = relationSections.filter { section in
            descriptor.presentation.detailSections.contains(where: { $0.id == section.id })
                && section.target.key.nativeActions.contains(.create)
                && section.spec.plan.seed != nil
        }
        ForEach(Self.relationCreationGroups(declared), id: \.first!.target.key) { group in
            if let first = group.first {
                if group.count == 1 {
                    Button(
                        first.id == journalRelationID ? "Log entry" : "New \(first.target.singular)",
                        systemImage: "plus"
                    ) { creatingRelation = first }
                } else {
                    Menu("New \(first.target.singular)", systemImage: "plus") {
                        ForEach(group) { section in
                            Button(section.section.title ?? section.target.plural) {
                                creatingRelation = section
                            }
                        }
                    }
                }
            }
        }
    }

    /// Identical create drafts appear once; distinct prefills share a target submenu in declaration order.
    static func relationCreationGroups(_ sections: [RelationSectionModel]) -> [[RelationSectionModel]] {
        var groups: [[RelationSectionModel]] = []
        for section in sections {
            if let index = groups.firstIndex(where: { $0.first?.target.key == section.target.key }) {
                if !groups[index].contains(where: {
                    $0.createPrefill == section.createPrefill && $0.createFields == section.createFields
                }) {
                    groups[index].append(section)
                }
            } else {
                groups.append([section])
            }
        }
        return groups
    }

    private var journalRelationID: String? {
        guard descriptor.presentation.detailVariant == .journal else { return nil }
        return descriptor.presentation.detailSections.first {
            if case .relation = $0.kind { return true }
            return false
        }?.id
    }

    @ViewBuilder
    private var content: some View {
        if let model, let row = model.row {
            VStack(spacing: 0) {
                if let error = model.refreshError {
                    InlineLoadFailure(message: error) { await model.refresh(id: row.id) }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(FieldGuideTokens.Space.md)
                }
                EntityDetailContent(
                    descriptor: descriptor, row: row,
                    relationSections: relationSections,
                    connectedRecords: connectedRecords,
                    onChanged: { Task { await refresh() } },
                    onAction: perform,
                    actionsBusy: actions?.isBusy ?? false
                )
                .environment(\.detailSuggestions, suggestions)
            }
        } else if let model {
            switch model.phase {
            case .idle, .loading:
                LoadingIndicator.screen(label: "Loading \(descriptor.singular)")
            case .unavailable(let message):
                missingRecord(message, systemImage: entitySymbol(for: key))
            case .failed(let message):
                LoadFailureView(title: "Couldn't load \(descriptor.singular)", message: message) {
                    await setup()
                }
            case .loaded:
                missingRecord("Not found", systemImage: "questionmark.folder")
            }
        } else {
            LoadingIndicator.screen(label: "Loading \(descriptor.singular)")
        }
    }

    /// A record this app cannot show still has two ways forward: search for it, or open the web
    /// record, which may render what native does not.
    private func missingRecord(_ title: String, systemImage: String) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } actions: {
            Button("Search Cubby", systemImage: "magnifyingglass") {
                appModel.navigator.pendingSearchQuery = id
                appModel.navigator.open(.search)
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("detail.\(key.rawValue).missing.search")
            OpenOnWebButton(target: .record(key: key, id: id), label: "Open on web")
                .accessibilityIdentifier("detail.\(key.rawValue).missing.web")
        }
    }

    /// Extracted so `body`'s toolbar closure stays under the project's 200ms type-check budget.
    private func copyDiagnosticsButton(row: EntityRow, fetchedAt: Date?) -> some View {
        CopyDiagnosticsButton { EntityDetailDiagnostics(shortcode: row.id, fetchedAt: fetchedAt) }
    }

    private func setup() async {
        if model == nil { model = GenericEntityDetailModel(descriptor: descriptor, client: appModel.client) }
        if actions == nil { actions = RecordActionPresenter(entity: key) }
        guard let model else { return }
        await model.loadInitial(id: id)
        guard let row = model.row else { return }
        let survivorID = row.id
        if relationSections.isEmpty {
            relationSections = RelationSectionModel.sections(
                of: descriptor, recordID: survivorID, client: appModel.client)
        }
        if connectedRecords == nil && !descriptor.presentation.connectedViews.isEmpty {
            connectedRecords = ConnectedRecordsPreviewModel(
                source: EntityRef(entity: key, id: survivorID), client: appModel.client)
        }
        if suggestions == nil, DetailSuggestionsModel.applies(to: descriptor) {
            suggestions = DetailSuggestionsModel(
                entity: key, recordID: survivorID, client: appModel.client,
                onChanged: { [appModel, key] in appModel.recordEntityMutation(keys: [key]) })
        }
        await connectedRecords?.loadInitial()
        await suggestions?.load()
    }

    private func refresh() async {
        guard let model else { return }
        let survivorID = model.row?.id ?? id
        await model.refresh(id: survivorID)
        for section in relationSections {
            await section.list.refresh()
            await section.loadConnectionEvidence()
        }
        await connectedRecords?.refresh()
        await suggestions?.load()
    }

    /// Runs one placed action from the action bar, More or a menu command.
    private func perform(_ action: PlacedAction) {
        guard let row = model?.row else { return }
        switch action.kind {
        case .plan(let plan):
            actions?.start(plan, row: row, appModel: appModel, onFinished: finishAction)
        case .edit:
            editing = true
        case .quickField(let fieldKey):
            // A field native cannot edit in place still opens the whole-record editor.
            guard let field = descriptor.field(fieldKey), field.editsInline(on: key),
                field.applicabilityRefusal(in: row.raw) == nil
            else {
                editing = key.nativeActions.contains(.update)
                return
            }
            quickField = InlineEditSession(
                field: field, row: row, descriptor: descriptor, client: appModel.client)
        case .copyLink:
            Clipboard.copy(appModel.webHandoff.url(.record(key: key, id: row.id)).absoluteString)
        case .openOnWeb, .share:
            RecordActionPresenter.open(appModel.webHandoff.url(.record(key: key, id: row.id)))
        case .addPhoto:
            photoCapture = PhotoCaptureModel(
                client: appModel.client, entity: key, entityID: row.id, entityTitle: row.title,
                featurePrints: appModel.featurePrints)
        case .select, .bulkEdit, .merge, .more:
            // List and selection actions; detail never places them.
            break
        }
    }

    /// A deleted record leaves its screen; anything else re-reads it.
    private func finishAction(_ plan: HeroActionPlan, _ outcome: HeroActionOutcome) {
        if case .completed = outcome, plan.kind == .delete {
            dismiss()
        } else if case .completed = outcome {
            Task { await refresh() }
        }
    }

    /// The menu bar's view of this record: Edit, confirmed Delete, and the Actions menu.
    private func recordCommands(_ row: EntityRow) -> RecordCommandActions {
        let placed = ActionPlacement(entity: descriptor, row: row).more.joined()
        return RecordCommandActions(
            title: row.title,
            edit: key.nativeActions.contains(.update) ? { editing = true } : nil,
            delete: placed.first { $0.id == "delete" },
            actions: placed.filter { action in
                guard action.id != "delete", case .plan = action.kind else { return false }
                return true
            },
            perform: perform)
    }
}

/// Plain-data detail rendering, shared by the real screen and `#Preview`s so neither needs a
/// network round trip to render: the hero, then the declared sections in order.
struct EntityDetailContent: View {
    let descriptor: EntityDescriptor
    let row: EntityRow
    var relationSections: [RelationSectionModel] = []
    var connectedRecords: ConnectedRecordsPreviewModel? = nil
    var onChanged: () -> Void = {}
    /// Runs a placed action (action bar, section handoff); nil (previews) draws no action bar.
    var onAction: ((PlacedAction) -> Void)? = nil
    var actionsBusy = false

    @Environment(AppModel.self) private var appModel
    @Environment(\.developerOverlays) private var developerOverlays
    @Environment(\.detailSuggestions) private var suggestions
    @State private var timeline: EntityTimelineOut?
    @State private var timelineError: String?
    @State private var activityEvents: [DetailActivityEvent] = []
    @State private var activityCursor: String?
    @State private var activityError: String?
    @State private var activityLoaded = false
    @State private var loadingOlderActivity = false
    @State private var connectedExpanded = false
    @State private var rawExpanded = false
    @State private var collapsedMacSections: Set<String> = []
    @State private var reportBatches = ReportBatchStore()

    private var presentation: EntityPresentation { descriptor.presentation }

    private var activityInsertionSectionID: String? {
        let sections = presentation.detailSections.filter { $0.id != journalSection?.id }
        return sections.first(where: {
            $0.title?.localizedCaseInsensitiveCompare("Record") == .orderedSame
        })?.id ?? sections.first?.id
    }

    private var shouldShowActivity: Bool {
        !presentation.activityRelations.isEmpty
            && (!activityLoaded || activityError != nil || !activityEvents.isEmpty || activityCursor != nil)
    }

    /// The journal variant's leading section: the first declared relation.
    private var journalSection: RelationSectionModel? {
        guard presentation.detailVariant == .journal else { return nil }
        let firstRelation = presentation.detailSections.first {
            if case .relation = $0.kind { return true }
            return false
        }
        return firstRelation.flatMap { section in relationSections.first { $0.id == section.id } }
    }

    var body: some View {
        #if os(macOS)
            macBody
        #else
            phoneBody
        #endif
    }

    private var placement: ActionPlacement { ActionPlacement(entity: descriptor, row: row) }

    /// The action bar under the hero (`ActionPlacement.actionBar`, at most four tiles).
    @ViewBuilder private var actionBar: some View {
        if let onAction {
            DetailActionBar(
                entity: descriptor.key, actions: placement.actionBar, busy: actionsBusy, perform: onAction)
        }
    }

    /// "N suggestions" near the glance when there are several, or when the one pending Suggestion
    /// has no field row to carry its marker.
    private var groupedSuggestions: DetailSuggestionsModel? {
        guard let suggestions, !suggestions.items.isEmpty else { return nil }
        let several = suggestions.items.count > 1 || suggestions.error != nil
        return several || !suggestions.items.allSatisfy({ visibleFieldKeys.contains($0.field) })
            ? suggestions : nil
    }

    /// Fields drawn as rows in a declared fields section (summary cells carry no marker).
    private var visibleFieldKeys: Set<String> {
        var keys = Set<String>()
        for section in presentation.detailSections {
            if case .fields(let sectionKeys) = section.kind {
                for field in FieldsSectionView(descriptor: descriptor, row: row, keys: sectionKeys)
                    .visibleFields
                {
                    keys.insert(field.key)
                    if let readKey = field.readKey { keys.insert(readKey) }
                }
            }
        }
        return keys
    }

    /// A record handoff declared for `section`: one inline web row in that section.
    @ViewBuilder private func sectionHandoffs(_ section: DetailSection) -> some View {
        if let onAction {
            ForEach(placement.sectionHandoffs[section.id] ?? []) { action in
                Button {
                    onAction(action)
                } label: {
                    HStack {
                        Label(action.label, systemImage: action.symbol)
                        Spacer(minLength: FieldGuideTokens.Space.sm)
                        Image(systemName: "arrow.up.right").foregroundStyle(.secondary).accessibilityHidden(
                            true)
                    }
                    .frame(minHeight: FieldGuideTokens.touchTarget)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens in your browser")
                .accessibilityIdentifier("detail.handoff.\(action.id)")
            }
        }
    }

    #if os(macOS)
        private var macBody: some View {
            ScrollView {
                VStack(alignment: .leading, spacing: FieldGuideTokens.Space.lg) {
                    EntityHeroView(descriptor: descriptor, row: row) { EmptyView() }
                    actionBar.frame(maxWidth: 560, alignment: .leading)
                    if let groupedSuggestions {
                        DetailSuggestionsRow(descriptor: descriptor, model: groupedSuggestions)
                            .frame(maxWidth: 560, alignment: .leading)
                    }
                    DetailSummaryGrid(descriptor: descriptor, row: row)
                    HStack(alignment: .top, spacing: FieldGuideTokens.Space.lg) {
                        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.lg) {
                            if let journal = journalSection,
                                !(journal.list.phase == .loaded && journal.list.rows.isEmpty)
                            {
                                DisclosureGroup(isExpanded: macSectionBinding(journal.id)) {
                                    EntityJournalSectionView(model: journal, macLayout: true)
                                } label: {
                                    Text(journal.section.title ?? "Journal").font(.headline)
                                }
                            }
                            ForEach(presentation.detailSections) { section in
                                if section.id != journalSection?.id { macDeclared(section) }
                            }
                            if descriptor.hasRelatedness {
                                macDisclosure("Related records", id: "related-records") {
                                    RelatedRecordsDetailSlot(
                                        source: .init(entity: descriptor.key, id: row.id))
                                }
                            }
                            if let connectedRecords, connectedHasRows || connectedRecords.error != nil {
                                DisclosureGroup(isExpanded: $connectedExpanded) {
                                    ConnectedRecordsSection(model: connectedRecords)
                                } label: {
                                    Text("Connected records").font(.headline)
                                }
                            }
                            if developerOverlays {
                                DisclosureGroup(isExpanded: $rawExpanded) {
                                    RawRecordDisclosure(raw: row.raw)
                                } label: {
                                    Text("Raw record").font(.headline)
                                }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        if shouldShowActivity {
                            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
                                if let activityError {
                                    InlineLoadFailure(message: activityError) { await loadActivity() }
                                } else if activityLoaded {
                                    DetailActivitySection(
                                        events: activityEvents, isLoadingMore: loadingOlderActivity,
                                        hasMore: activityCursor != nil,
                                        onLoadMore: { Task { await loadOlderActivity() } })
                                } else {
                                    Text("Activity").font(.headline)
                                    LoadingIndicator(label: "Loading activity")
                                }
                            }
                            .frame(width: 320, alignment: .leading)
                        }
                    }
                }
                .frame(maxWidth: 1_160, alignment: .topLeading)
                .padding(FieldGuideTokens.Space.lg)
                .frame(maxWidth: .infinity, alignment: .top)
            }
            .accessibilityIdentifier("detail.\(descriptor.key.rawValue)")
            .task(id: row.id) {
                await loadTimelineIfDeclared()
                await loadActivity()
            }
            .modifier(DetailContentsNavigation(entries: contentsEntries))
            .environment(\.detailInlineEdit, true)
            .environment(\.reportBatchStore, reportBatches)
            .task { reportBatches.onRecordStale = onChanged }
        }

        @ViewBuilder
        private func macDeclared(_ section: DetailSection) -> some View {
            switch section.kind {
            case .fields(let keys):
                let fields = FieldsSectionView(descriptor: descriptor, row: row, keys: keys, macGrid: true)
                if fields.hasVisibleRows {
                    DisclosureGroup(isExpanded: macSectionBinding(section.id)) {
                        fields
                        sectionHandoffs(section)
                    } label: {
                        Text(section.title ?? "Details").font(.headline)
                    }
                }
            case .relation:
                if let model = relationSections.first(where: { $0.id == section.id }) {
                    if model.isLoadedEmpty {
                        RelationSectionView(model: model, row: row, macLayout: true)
                    } else {
                        DisclosureGroup(isExpanded: macSectionBinding(section.id)) {
                            RelationSectionView(model: model, row: row, macLayout: true)
                        } label: {
                            Text(model.countedTitle).font(.headline)
                        }
                    }
                }
            case .timeline:
                if !timelineIsEmpty {
                    VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
                        Text(section.title ?? "Timeline").font(.headline)
                        if let timelineError {
                            InlineLoadFailure(message: timelineError) { await loadTimelineIfDeclared() }
                        } else if let timeline {
                            EntityTimelineView(timeline: timeline)
                        } else {
                            LoadingIndicator(label: "Loading timeline")
                        }
                    }
                }
            case .slot:
                if let view = DetailSlotRegistry.view(slot: section.id, row: row) {
                    DisclosureGroup(isExpanded: macSectionBinding(section.id)) {
                        view
                    } label: {
                        if let key = section.explanationField, let field = descriptor.field(key) {
                            FieldExplanationLabel(
                                field: field, subject: EntityRef(entity: descriptor.key, id: row.id),
                                labelOverride: section.title
                            )
                            .font(.headline)
                        } else {
                            Text(section.title ?? section.id).font(.headline)
                        }
                    }
                }
            }
        }

        private func macDisclosure<Content: View>(
            _ title: String, id: String, @ViewBuilder content: @escaping () -> Content
        ) -> some View {
            DisclosureGroup(isExpanded: macSectionBinding(id)) {
                content()
            } label: {
                Text(title).font(.headline)
            }
        }

        private func macSectionBinding(_ id: String) -> Binding<Bool> {
            Binding(
                get: { !collapsedMacSections.contains(id) },
                set: { expanded in
                    if expanded { collapsedMacSections.remove(id) } else { collapsedMacSections.insert(id) }
                })
        }
    #endif

    private var phoneBody: some View {
        List {
            Section {
                EntityHeroView(descriptor: descriptor, row: row) { EmptyView() }
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                actionBar
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            if let groupedSuggestions {
                Section { DetailSuggestionsRow(descriptor: descriptor, model: groupedSuggestions) }
            }
            if !presentation.summarySlots.isEmpty {
                Section {
                    DetailSummaryGrid(descriptor: descriptor, row: row)
                }
            }
            if let journal = journalSection {
                if !(journal.list.phase == .loaded && journal.list.rows.isEmpty) {
                    EntityJournalSectionView(model: journal)
                        .detailContentsAnchor(journal.id)
                }
            }
            ForEach(presentation.detailSections) { section in
                if section.id != journalSection?.id {
                    declared(section).detailContentsAnchor(section.id)
                    if section.id == activityInsertionSectionID {
                        phoneActivitySection
                    }
                }
            }
            if activityInsertionSectionID == nil {
                phoneActivitySection
            }
            if descriptor.hasRelatedness {
                Section("Related records") {
                    RelatedRecordsDetailSlot(source: .init(entity: descriptor.key, id: row.id))
                }
                .detailContentsAnchor("related-records")
            }
            if let connectedRecords {
                if connectedHasRows || connectedRecords.error != nil {
                    DisclosureGroup("Connected records", isExpanded: $connectedExpanded) {
                        ConnectedRecordsSection(model: connectedRecords)
                    }
                    .detailContentsAnchor("connected-records")
                }
            }
            if developerOverlays {
                DisclosureGroup("Raw record", isExpanded: $rawExpanded) {
                    RawRecordDisclosure(raw: row.raw)
                }
                .detailContentsAnchor("raw-record")
            }
        }
        #if os(iOS)
            .listStyle(.insetGrouped)
            .contentMargins(.top, 0, for: .scrollContent)
            .listSectionMargins(.top, 0)
        #else
            .listStyle(.plain)
        #endif
        .fieldGuideDetailDensity()
        .frame(maxWidth: 900)
        .frame(maxWidth: .infinity, alignment: .top)
        .accessibilityIdentifier("detail.\(descriptor.key.rawValue)")
        .task(id: row.id) {
            await loadTimelineIfDeclared()
            await loadActivity()
        }
        .modifier(DetailContentsNavigation(entries: contentsEntries))
        .environment(\.detailInlineEdit, true)
        .environment(\.reportBatchStore, reportBatches)
        .task { reportBatches.onRecordStale = onChanged }
    }

    @ViewBuilder
    private var phoneActivitySection: some View {
        if shouldShowActivity {
            Section("Activity") {
                if let activityError {
                    InlineLoadFailure(message: activityError) { await loadActivity() }
                } else if !activityLoaded {
                    LoadingIndicator(label: "Loading activity")
                } else {
                    DetailActivitySection(
                        events: activityEvents, isLoadingMore: loadingOlderActivity,
                        hasMore: activityCursor != nil,
                        onLoadMore: { Task { await loadOlderActivity() } }, showsTitle: false)
                }
            }
        }
    }

    @ViewBuilder
    private func declared(_ section: DetailSection) -> some View {
        switch section.kind {
        case .fields(let keys):
            let fields = FieldsSectionView(descriptor: descriptor, row: row, keys: keys)
            if fields.hasVisibleRows {
                ContinuousDetailSection(title: section.title ?? "") {
                    fields
                    sectionHandoffs(section)
                }
            }
        case .relation:
            if let model = relationSections.first(where: { $0.id == section.id }) {
                RelationSectionView(model: model, row: row)
            }
        case .timeline:
            if !timelineIsEmpty {
                ContinuousDetailSection(title: section.title ?? "Timeline") {
                    if let timelineError {
                        InlineLoadFailure(message: timelineError) { await loadTimelineIfDeclared() }
                    } else if timeline == nil {
                        LoadingIndicator(label: "Loading timeline")
                    }
                }
                if let timeline { EntityTimelineView(timeline: timeline) }
            }
        case .slot:
            if let view = DetailSlotRegistry.view(slot: section.id, row: row) {
                if let explanationField = section.explanationField,
                    let field = descriptor.field(explanationField)
                {
                    ExplainedDetailSection {
                        view
                    } header: { empty in
                        FieldExplanationLabel(
                            field: field,
                            subject: EntityRef(entity: descriptor.key, id: row.id),
                            labelOverride: section.title, emptyLabel: empty
                        )
                    }
                } else {
                    ContinuousDetailSection(title: section.title ?? "") { view }
                }
            }
        }
    }

    private var timelineIsEmpty: Bool {
        guard let timeline else { return false }
        return timeline.groups.isEmpty && (timeline.rows ?? []).isEmpty && timelineError == nil
    }

    // Native declarations have no workspace grouping; preserve the detail's reading order.
    private var contentsEntries: [DetailContentsEntry] {
        let sections = presentation.detailSections.compactMap { section -> DetailContentsEntry? in
            switch section.kind {
            case .fields(let keys):
                guard FieldsSectionView(descriptor: descriptor, row: row, keys: keys).hasVisibleRows else {
                    return nil
                }
            case .relation:
                guard let relation = relationSections.first(where: { $0.id == section.id }),
                    !relation.isLoadedEmpty
                else { return nil }
            case .timeline:
                guard !timelineIsEmpty else { return nil }
            case .slot:
                guard DetailSlotRegistry.view(slot: section.id, row: row) != nil else { return nil }
            }
            return DetailContentsEntry(id: section.id, title: section.title ?? section.id, group: "Record")
        }
        return sections
            + (descriptor.hasRelatedness
                ? [DetailContentsEntry(id: "related-records", title: "Related records", group: "Relations")]
                : [])
            + (connectedHasRows
                ? [
                    DetailContentsEntry(
                        id: "connected-records", title: "Connected records", group: "Relations")
                ]
                : [])
            + (developerOverlays
                ? [DetailContentsEntry(id: "raw-record", title: "Raw record", group: "Provenance")] : [])
    }

    private func loadTimelineIfDeclared() async {
        let declares = presentation.detailSections.contains {
            if case .timeline = $0.kind { return true }
            return false
        }
        guard declares, descriptor.key.nativeActions.contains(.timeline) else { return }
        timelineError = nil
        do {
            timeline = try await appModel.client.timeline(
                descriptor, filters: EntityFilterState(["ids": [row.id]]))
        } catch {
            timelineError = error.userMessage
            Diagnostics.report(error, context: "detail.timeline")
        }
    }

    private var connectedHasRows: Bool {
        connectedRecords?.preview?.views.contains(where: { $0.totalCount > 0 }) ?? false
    }

    private func loadActivity() async {
        guard !presentation.activityRelations.isEmpty else { return }
        activityError = nil
        activityLoaded = false
        do {
            let output = try await appModel.client.detailActivity(
                .init(
                    source: EntityGraphRootInput(entityKind: descriptor.key, entityId: row.id), limit: 30))
            activityEvents = output.items
            activityCursor = output.nextCursor
            activityLoaded = true
        } catch {
            activityError = error.userMessage
        }
    }

    private func loadOlderActivity() async {
        guard let cursor = activityCursor, !loadingOlderActivity else { return }
        loadingOlderActivity = true
        defer { loadingOlderActivity = false }
        do {
            let output = try await appModel.client.detailActivity(
                .init(
                    source: EntityGraphRootInput(entityKind: descriptor.key, entityId: row.id),
                    limit: 30, cursor: cursor))
            activityEvents.append(contentsOf: output.items)
            activityCursor = output.nextCursor
        } catch {
            activityError = error.userMessage
        }
    }

}

/// Developer overlays layer 4/7: shortcode plus fetched-at/age. No `uuid` field — the generic
/// entity API never exposes the underlying uuid, only the public shortcode (`row.id`).
private struct EntityDetailDiagnostics: Encodable {
    let shortcode: String
    let fetchedAt: Date?

    var caption: String {
        guard let fetchedAt else { return shortcode }
        let age = Date().timeIntervalSince(fetchedAt)
        return "\(shortcode) · fetched \(Self.ageFormatter.string(from: age) ?? "0s") ago"
    }

    private static let ageFormatter: DateComponentsFormatter = {
        let formatter = DateComponentsFormatter()
        formatter.allowedUnits = [.hour, .minute, .second]
        formatter.unitsStyle = .abbreviated
        formatter.maximumUnitCount = 1
        return formatter
    }()
}

#Preview {
    NavigationStack {
        EntityDetailContent(
            descriptor: EntityCatalog[.product], row: PreviewFixtures.sampleDetailRow
        )
        .navigationTitle("Cast Iron Skillet")
    }
    .environment(PreviewFixtures.signedInModel())
}

#Preview("Developer overlays on") {
    NavigationStack {
        EntityDetailContent(
            descriptor: EntityCatalog[.product], row: PreviewFixtures.sampleDetailRow
        )
        .navigationTitle("Cast Iron Skillet")
    }
    .environment(PreviewFixtures.signedInModel())
    .environment(\.developerOverlays, true)
}

#Preview("Connections entry") {
    NavigationStack {
        EntityDetailContent(descriptor: EntityCatalog[.product], row: PreviewFixtures.sampleDetailRow)
    }.environment(PreviewFixtures.signedInModel())
}

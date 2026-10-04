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
    @State private var relationshipsModel: EntityRelationshipsModel?
    @State private var relationSections: [RelationSectionModel] = []
    @State private var connectedSections: [ConnectedSectionModel] = []
    @State private var photoCapture: PhotoCaptureModel?
    @State private var editing = false
    @State private var creatingRelation: RelationSectionModel?
    @State private var physicalConnections: EntityConnectionsOut?
    @State private var physicalError: String?
    @State private var heroAction: HeroActionModel?
    @State private var heroEditor: HeroEditorRequest?
    @State private var heroNotice: String?
    @State private var heroBusy = false
    /// Set when a delete finished: the record is gone, so leave its screen once the sheet that
    /// ran the delete has actually dismissed (dismissing both at once only closes the sheet).
    @State private var leaveAfterHeroSheet = false

    private var descriptor: EntityDescriptor { EntityCatalog[key] }

    var body: some View {
        let model = model
        let titled =
            content
            .fieldGuideScreen()
            .navigationTitle(model?.row?.title ?? descriptor.singular)
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
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
                    appModel.relationshipMutationReplacement?.recommendation.subject
                        != EntityRef(entity: key, id: model?.row?.id ?? id),
                    model?.phase == .loaded
                else { return }
                await refresh()
            }
            .refreshControl { await refresh() }
            .userActivity(NSUserActivityTypeBrowsingWeb, isActive: model?.row != nil) { activity in
                guard let row = model?.row else { return }
                activity.webpageURL = appModel.webURL(for: key, id: row.id)
                activity.title = row.title
                activity.isEligibleForHandoff = true
                // Spotlight indexing is a separate path (`SpotlightIndexer`); this activity is
                // Handoff-only.
                activity.isEligibleForSearch = false
            }
    }

    /// Extracted so `body` stays under the project's 200ms type-check budget: the four sheets.
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
            .sheet(
                item: $heroAction,
                onDismiss: {
                    if leaveAfterHeroSheet {
                        leaveAfterHeroSheet = false
                        dismiss()
                    }
                }
            ) { action in
                HeroActionSheet(model: action) { outcome in finishHeroAction(action.plan, outcome) }
                    .environment(appModel)
            }
            .sheet(item: $heroEditor) { request in
                EntityEditorSheet(
                    key: request.entity, mode: .create(prefill: request.prefill), context: request.context
                ) { _ in
                    Task { await refresh() }
                }
                .environment(appModel)
            }
            .alert(heroNotice ?? "", isPresented: heroNoticeBinding) { Button("OK") {} }
            .sheet(item: $creatingRelation) { section in
                EntityEditorSheet(
                    key: section.target.key, mode: .create(prefill: section.createPrefill)
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
            ToolbarItem {
                ShareLink(item: appModel.webURL(for: key, id: row.id)) {
                    Label("Share", systemImage: "square.and.arrow.up")
                }
            }
            ToolbarItem {
                Menu {
                    Button {
                        Clipboard.copy(appModel.webURL(for: key, id: row.id).absoluteString)
                    } label: {
                        Label("Copy link", systemImage: "link")
                    }
                    Button {
                        Clipboard.copy(row.id)
                    } label: {
                        Label("Copy shortcode", systemImage: "number")
                    }
                    heroActionButtons
                } label: {
                    Label("More", systemImage: "ellipsis.circle")
                }
            }
        }
        // Any entity whose update takes pendingImageIds can take a photo; the cover
        // choice inside the sheet is product-only.
        if descriptor.acceptsImages, let row = model?.row {
            ToolbarItem {
                Button {
                    photoCapture = PhotoCaptureModel(
                        client: appModel.client, entity: key, entityID: row.id,
                        entityTitle: row.title,
                        featurePrints: appModel.featurePrints
                    )
                } label: {
                    Label("Add photo", systemImage: "camera.badge.ellipsis")
                }
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let model, let row = model.row {
            VStack(spacing: 0) {
                if let error = model.refreshError {
                    HStack {
                        Text(error).font(.callout)
                        Button("Retry") { Task { await model.refresh(id: row.id) } }
                    }.padding()
                }
                EntityDetailContent(
                    descriptor: descriptor, row: row,
                    relationSections: relationSections,
                    connectedSections: connectedSections,
                    relationshipsModel: relationshipsModel,
                    physicalConnections: physicalConnections,
                    physicalError: physicalError,
                    fetchedAt: model.fetchedAt,
                    onRelationshipAccepted: appModel.recordRelationshipMutation,
                    onCreateRelation: { creatingRelation = $0 },
                    onChanged: { Task { await refresh() } }
                )
            }
        } else if let model {
            switch model.phase {
            case .idle, .loading:
                LoadingIndicator.screen(label: "Loading \(descriptor.singular)")
            case .unavailable(let message):
                ContentUnavailableView(message, systemImage: entitySymbol(for: key))
            case .failed(let message):
                ContentUnavailableView {
                    Label("Couldn't load \(descriptor.singular)", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Retry") { Task { await setup() } }
                }
            case .loaded:
                ContentUnavailableView("Not found", systemImage: "questionmark.folder")
            }
        } else {
            LoadingIndicator.screen(label: "Loading \(descriptor.singular)")
        }
    }

    /// Extracted so `body`'s toolbar closure stays under the project's 200ms type-check budget.
    private func copyDiagnosticsButton(row: EntityRow, fetchedAt: Date?) -> some View {
        CopyDiagnosticsButton { EntityDetailDiagnostics(shortcode: row.id, fetchedAt: fetchedAt) }
    }

    private func setup() async {
        if model == nil { model = GenericEntityDetailModel(descriptor: descriptor, client: appModel.client) }
        if relationshipsModel == nil {
            relationshipsModel = EntityRelationshipsModel(client: appModel.client)
        }
        guard let model, let relationshipsModel else { return }
        await model.loadInitial(id: id)
        guard let row = model.row else { return }
        let survivorID = row.id
        if relationSections.isEmpty {
            relationSections = RelationSectionModel.sections(
                of: descriptor, recordID: survivorID, client: appModel.client)
        }
        if connectedSections.isEmpty {
            connectedSections = descriptor.presentation.connectedViews.map {
                ConnectedSectionModel(
                    spec: $0, source: EntityRef(entity: key, id: survivorID), client: appModel.client)
            }
        }
        async let relationshipLoad: Void = relationshipsModel.loadInitial(
            source: EntityRef(entity: key, id: survivorID))
        async let physicalLoad: Void = loadPhysicalConnections(id: survivorID)
        _ = await (relationshipLoad, physicalLoad)
    }

    private func refresh() async {
        guard let model, let relationshipsModel else { return }
        let survivorID = model.row?.id ?? id
        async let detailRefresh: Void = model.refresh(id: survivorID)
        async let relationshipRefresh: Void = relationshipsModel.refresh()
        async let physicalRefresh: Void = loadPhysicalConnections(id: survivorID)
        _ = await (detailRefresh, relationshipRefresh, physicalRefresh)
        for section in relationSections {
            await section.list.refresh()
            await section.loadConnectionEvidence()
        }
        for section in connectedSections { await section.refresh() }
    }

    private func loadPhysicalConnections(id: String) async {
        do {
            physicalConnections = try await appModel.client.physicalConnections(id: id)
            physicalError = nil
        } catch {
            physicalError = String(describing: error)
        }
    }

    /// The manifest's hero actions this entity declares and native implements, from the one
    /// generic runner (`edit` stays the toolbar's Edit; `bulkEdit` is a list verb).
    @ViewBuilder private var heroActionButtons: some View {
        let plans = descriptor.presentation.heroActions.compactMap { verb in
            HeroActionRunner.plan(for: verb, on: key).map { (verb, $0) }
        }
        if !plans.isEmpty {
            Divider()
            ForEach(plans, id: \.0) { verb, plan in
                Button(
                    plan.label, systemImage: plan.symbol,
                    role: plan.confirmation == .destructive ? .destructive : nil
                ) {
                    startHeroAction(plan)
                }
                .accessibilityIdentifier("detail.\(key.rawValue).hero.\(verb.rawValue)")
            }
        }
    }

    private var heroNoticeBinding: Binding<Bool> {
        Binding(get: { heroNotice != nil }, set: { if !$0 { heroNotice = nil } })
    }

    private func startHeroAction(_ plan: HeroActionPlan) {
        guard let row = model?.row else { return }
        let runner = HeroActionRunner(client: appModel.client)
        switch plan.kind {
        case .toggleField, .create:
            // No input and nothing destructive: one explicit tap runs it. The flag flips before
            // the task is scheduled so a second tap cannot start a second write.
            guard !heroBusy else { return }
            heroBusy = true
            Task {
                defer { heroBusy = false }
                do {
                    finishHeroAction(
                        plan, try await runner.perform(plan, on: key, row: row, values: [:], confirmed: false)
                    )
                } catch {
                    Diagnostics.report(error, context: "detail.heroAction")
                    appModel.handle(error)
                }
            }
        case .delete, .operation, .setField:
            heroAction = HeroActionModel(plan: plan, entity: key, row: row, runner: runner)
        }
    }

    private func finishHeroAction(_ plan: HeroActionPlan, _ outcome: HeroActionOutcome) {
        switch outcome {
        case .completed(let message, let changed):
            appModel.recordEntityMutation(keys: changed)
            if case .delete = plan.kind {
                leaveAfterHeroSheet = true
                if heroAction == nil {
                    leaveAfterHeroSheet = false
                    dismiss()
                }
            } else {
                heroNotice = message
                Task { await refresh() }
            }
        case .editor(let entity, let prefill, let context):
            heroEditor = HeroEditorRequest(entity: entity, prefill: prefill, context: context)
        case .editRecord:
            // Only a report `records` verb stages an edit (`RecordsBlockView` opens it); no hero
            // verb has such a plan.
            break
        }
    }

}

/// Plain-data detail rendering, shared by the real screen and `#Preview`s so neither needs a
/// network round trip to render: the hero, then the declared sections in order.
struct EntityDetailContent: View {
    let descriptor: EntityDescriptor
    let row: EntityRow
    var relationSections: [RelationSectionModel] = []
    var connectedSections: [ConnectedSectionModel] = []
    var relationshipsModel: EntityRelationshipsModel? = nil
    var physicalConnections: EntityConnectionsOut? = nil
    var physicalError: String? = nil
    /// Developer overlays layer 4: when this row was fetched. `nil` in previews/fixtures that
    /// never went through `GenericEntityDetailModel`.
    var fetchedAt: Date? = nil
    var onRelationshipAccepted: (RelationshipAcceptance) -> Void = { _ in }
    var onCreateRelation: (RelationSectionModel) -> Void = { _ in }
    var onChanged: () -> Void = {}

    @Environment(AppModel.self) private var appModel
    @Environment(\.developerOverlays) private var developerOverlays
    @State private var timeline: EntityTimelineOut?
    @State private var timelineError: String?
    @State private var selectedSection = "overview"
    @State private var reviewedRelationship: RelationshipRecommendationReview?
    @State private var reportBatches = ReportBatchStore()

    private var presentation: EntityPresentation { descriptor.presentation }

    private var hasUnsupportedPresentation: Bool {
        let unsupportedField = descriptor.fields.contains {
            $0.showInDetail && NativePresentationCoverage.unsupportedDetail($0) != nil
        }
        let unsupportedSlot = presentation.detailSections.contains { section in
            guard case .slot = section.kind else { return false }
            return NativePresentationCoverage.unsupportedSlot(section.id) != nil
        }
        let unsupportedHero = presentation.heroActions.contains {
            NativePresentationCoverage.unsupportedHeroAction($0) != nil
        }
        return unsupportedField || unsupportedSlot || unsupportedHero
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
        Form {
            if let redirectedFrom = row.redirectedFrom {
                Section {
                    Label("\(redirectedFrom) was merged into \(row.id)", systemImage: "arrow.triangle.branch")
                    Text("You are viewing the surviving record.").foregroundStyle(.secondary)
                }
            }
            Section {
                EntityHeroView(descriptor: descriptor, row: row) {
                    if let supplement = DetailSlotRegistry.supplement(
                        for: descriptor.key, row: row, onChanged: onChanged)
                    {
                        supplement
                    }
                }
                // Layer 4: shortcode + fetched-at/age. The generic entity API never exposes the
                // underlying uuid (only shortcodes cross the wire — see apps/apple/AGENTS.md), so
                // there is nothing to show beyond the shortcode already in `row.id`.
                if developerOverlays {
                    DevOverlayText(EntityDetailDiagnostics(shortcode: row.id, fetchedAt: fetchedAt).caption)
                }
                if !row.previousShortcodes.isEmpty {
                    LabeledContent(
                        "Previous shortcodes", value: row.previousShortcodes.joined(separator: ", "))
                }
            }
            if descriptor.key == .location {
                Section("Fieldwork") {
                    NavigationLink(value: Route.locationPhotoPass(scope: LocationCode(row.id))) {
                        Label("Photo pass from this location", systemImage: "camera.on.rectangle")
                    }
                }
            }
            if presentation.detailSections.contains(where: { !$0.overview }) {
                Section {
                    Picker("Record view", selection: $selectedSection) {
                        Text("Overview").tag("overview")
                        ForEach(presentation.detailSections.filter { !$0.overview }) { section in
                            Text(section.title ?? section.id).tag(section.id)
                        }
                    }
                    .pickerStyle(.menu)
                }
            }
            if selectedSection == "overview", let journal = journalSection {
                EntityJournalSectionView(model: journal) { onCreateRelation(journal) }
            }
            ForEach(presentation.detailSections) { section in
                if section.id != journalSection?.id,
                    (selectedSection == "overview" ? section.overview : section.id == selectedSection)
                {
                    declared(section)
                }
            }
            ForEach(connectedSections) { section in
                ConnectedSectionView(model: section)
            }
            if let physicalConnections {
                Section("Physical connections") {
                    if physicalConnections.groups.isEmpty {
                        Text("No physical connections").foregroundStyle(.secondary)
                    }
                    ForEach(Array(physicalConnections.groups.enumerated()), id: \.offset) { indexed in
                        let group = indexed.element
                        DisclosureGroup("\(group.label) · \(group.count)") {
                            ForEach(group.items, id: \.id) { item in
                                if let key = EntityKey(rawValue: item.kind.rawValue) {
                                    NavigationLink(
                                        value: Route.entityDetail(key, id: item.id)
                                    ) {
                                        Text(item.name ?? item.id)
                                    }
                                } else {
                                    Text(item.name ?? item.id)
                                }
                            }
                        }
                    }
                }
            } else if let physicalError {
                Section("Physical connections") { Text(physicalError).foregroundStyle(.secondary) }
            }
            if hasUnsupportedPresentation {
                Section("More details") {
                    Text("Additional details are available on web.")
                        .foregroundStyle(.secondary)
                    Link("Open on web", destination: appModel.webURL(for: descriptor.key, id: row.id))
                }
            }
            if let relationshipsModel {
                Section("Relationships") {
                    EntityRelationshipsSection(model: relationshipsModel, onAccepted: onRelationshipAccepted)
                }
            }
            Section { RawRecordDisclosure(raw: row.raw) }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
        .background(FieldGuideTokens.canvas)
        .frame(maxWidth: 900)
        .frame(maxWidth: .infinity, alignment: .top)
        .accessibilityIdentifier("detail.\(descriptor.key.rawValue)")
        .task(id: row.id) { await loadTimelineIfDeclared() }
        .sheet(item: $reviewedRelationship) { review in
            if let relationshipsModel {
                #if os(iOS)
                    RelationshipRecommendationReviewSheet(
                        review: review, model: relationshipsModel, onAccepted: onRelationshipAccepted
                    )
                    .presentationDetents([.medium, .large])
                #else
                    RelationshipRecommendationReviewSheet(
                        review: review, model: relationshipsModel, onAccepted: onRelationshipAccepted
                    )
                    .frame(minWidth: 440, minHeight: 420)
                #endif
            }
        }
        .modifier(FieldGuideRecordInspector(descriptor: descriptor, row: row))
        .environment(\.reportBatchStore, reportBatches)
        .task { reportBatches.onRecordStale = onChanged }
    }

    @ViewBuilder
    private func declared(_ section: DetailSection) -> some View {
        switch section.kind {
        case .fields(let keys):
            Section(section.title ?? "") {
                FieldsSectionView(
                    descriptor: descriptor, row: row, keys: keys, inlineFieldKey: inlineRelationshipFieldKey
                ) {
                    inlineRelationshipAlternatives
                }
            }
        case .relation:
            if let model = relationSections.first(where: { $0.id == section.id }) {
                RelationSectionView(model: model) { onCreateRelation(model) }
            }
        case .timeline:
            Section(section.title ?? "Timeline") {
                if let timelineError {
                    Text(timelineError).foregroundStyle(.secondary)
                    Button("Retry") { Task { await loadTimelineIfDeclared() } }
                } else if let timeline {
                    if timeline.groups.isEmpty && (timeline.rows ?? []).isEmpty {
                        Text("No events").foregroundStyle(.secondary)
                    }
                } else {
                    LoadingIndicator(label: "Loading timeline")
                }
            }
            if let timeline, !(timeline.groups.isEmpty && (timeline.rows ?? []).isEmpty) {
                EntityTimelineView(timeline: timeline)
            }
        case .slot:
            if let view = DetailSlotRegistry.view(slot: section.id, row: row) {
                if let explanationField = section.explanationField,
                    let field = descriptor.field(explanationField)
                {
                    Section {
                        view
                    } header: {
                        FieldExplanationLabel(
                            field: field,
                            subject: EntityRef(entity: descriptor.key, id: row.id),
                            labelOverride: section.title
                        )
                    }
                } else {
                    Section(section.title ?? "") { view }
                }
            }
        }
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
                descriptor, filters: EntityFilterState(["ids": .many([row.id])]))
        } catch {
            timelineError = error.userMessage
            Diagnostics.report(error, context: "detail.timeline")
        }
    }

    // MARK: - Inline relationship alternatives

    /// The field a recommendation group proposes a new value for, by the group's kind: the
    /// expense-project group edits `projectId`, the inventory-placement group `locationId`.
    private var inlineRelationshipFieldKey: String? {
        guard let groups = relationshipsModel?.recommendationDocument?.groups else { return nil }
        for group in groups {
            switch group {
            case .expenseProject(let group) where !group.proposals.isEmpty: return "projectId"
            case .inventoryPlacement(let group) where !group.proposals.isEmpty: return "locationId"
            default: continue
            }
        }
        return nil
    }

    @ViewBuilder
    private var inlineRelationshipAlternatives: some View {
        if let basisKey = relationshipsModel?.recommendationDocument?.basisKey {
            ForEach(inlineRelationshipProposals) { proposal in
                InlineRelationshipAlternativeView(
                    proposal: proposal,
                    hasCurrentTarget: inlineRelationshipCurrentTarget != nil,
                    review: {
                        reviewedRelationship = .init(
                            proposal: proposal,
                            basisKey: basisKey,
                            source: relationshipsModel?.source
                                ?? EntityRef(entity: descriptor.key, id: row.id),
                            currentTarget: inlineRelationshipCurrentTarget
                        )
                    }
                )
            }
        }
    }

    private var inlineRelationshipCurrentTarget: String? {
        guard let groups = relationshipsModel?.recommendationDocument?.groups else { return nil }
        for group in groups {
            switch group {
            case .expenseProject(let group): return group.currentTarget?.name
            case .inventoryPlacement(let group): return group.currentTarget?.name
            default: continue
            }
        }
        return nil
    }

    private var inlineRelationshipProposals: [ActionableRelationshipRecommendation] {
        guard let groups = relationshipsModel?.recommendationDocument?.groups else { return [] }
        return groups.flatMap { group -> [ActionableRelationshipRecommendation] in
            switch group {
            case .expenseProject(let group):
                group.proposals.map(ActionableRelationshipRecommendation.expenseProject)
            case .inventoryPlacement(let group):
                group.proposals.map(ActionableRelationshipRecommendation.inventoryPlacement)
            default:
                []
            }
        }
    }
}

#if os(macOS)
    /// Uses the loaded generic row; the inspector never starts a second record query.
    private struct FieldGuideRecordInspector: ViewModifier {
        let descriptor: EntityDescriptor
        let row: EntityRow
        @State private var isPresented = false

        func body(content: Content) -> some View {
            content
                .toolbar {
                    Button {
                        isPresented.toggle()
                    } label: {
                        Label("Inspector", systemImage: "sidebar.right")
                    }
                    .help(isPresented ? "Hide inspector" : "Show inspector")
                    .accessibilityIdentifier("detail.inspectorToggle")
                }
                .inspector(isPresented: $isPresented) {
                    ScrollView {
                        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.lg) {
                            Text("Record notes")
                                .font(.fieldGuideHeadline)
                            Divider()
                            LabeledContent("Type", value: descriptor.singular)
                            LabeledContent("Code", value: row.id)
                            ForEach(descriptor.presentation.heroStats, id: \.self) { key in
                                if let field = descriptor.field(key),
                                    let value = EntityFieldValue.text(
                                        in: row.raw, field: field, surface: "detail")
                                {
                                    LabeledContent(field.label, value: value)
                                }
                            }
                        }
                        .padding(FieldGuideTokens.Space.lg)
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                    }
                    .background(FieldGuideTokens.surface)
                    .inspectorColumnWidth(min: 240, ideal: 280, max: 360)
                }
        }
    }
#else
    private struct FieldGuideRecordInspector: ViewModifier {
        let descriptor: EntityDescriptor
        let row: EntityRow

        func body(content: Content) -> some View { content }
    }
#endif

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

/// A create editor the hero action opens, seeded from its plan.
private struct HeroEditorRequest: Identifiable {
    let id = UUID()
    let entity: EntityKey
    let prefill: [String: JSONValue]
    let context: HeroEditorContext?
}

#Preview {
    NavigationStack {
        EntityDetailContent(
            descriptor: EntityCatalog[.product], row: PreviewFixtures.sampleDetailRow,
            fetchedAt: Date()
        )
        .navigationTitle("Cast Iron Skillet")
    }
    .environment(PreviewFixtures.signedInModel())
}

#Preview("Developer overlays on") {
    NavigationStack {
        EntityDetailContent(
            descriptor: EntityCatalog[.product], row: PreviewFixtures.sampleDetailRow,
            fetchedAt: Date()
        )
        .navigationTitle("Cast Iron Skillet")
    }
    .environment(PreviewFixtures.signedInModel())
    .environment(\.developerOverlays, true)
}

#Preview("Expense project alternative") {
    let appModel = PreviewFixtures.signedInModel()
    let source = EntityRef(entity: .expense, id: "EXP-2345")
    let row = EntityRow(
        id: source.id,
        title: "Hardware store receipt",
        subtitle: "$84.20",
        imageURL: nil,
        raw: .object([
            "id": .string(source.id),
            "name": .string("Hardware store receipt"),
            "cost": .number(84.20),
            "date": .string("2026-09-12"),
            "projectId": .string("PRJ-1001"),
            "projectName": .string("General maintenance"),
        ])
    )
    let relationships = EntityRelationshipsModel(
        client: appModel.client,
        initialRecommendations: .init(
            source: .init(source),
            basisKey: "expense-preview",
            groups: [
                .expenseProject(
                    .init(
                        kind: .expenseProject,
                        status: .ready,
                        currentTarget: .init(id: "PRJ-1001", name: "General maintenance"),
                        proposals: [
                            .init(
                                kind: .expenseProject,
                                expenseId: source.id,
                                target: .init(id: "PRJ-2001", name: "Workshop shelves"),
                                effectiveStart: "2026-09-01",
                                effectiveEnd: "2026-09-30",
                                sameTradeCount: 2,
                                exactProductCount: 1,
                                supportingExpenses: [
                                    .init(id: "EXP-3456", name: "Shelf brackets")
                                ],
                                reasons: ["Matches recent carpentry expenses"]
                            )
                        ]
                    )
                )
            ]
        )
    )
    return NavigationStack {
        EntityDetailContent(
            descriptor: EntityCatalog[.expense],
            row: row,
            relationshipsModel: relationships
        )
        .navigationTitle(row.title)
    }
    .environment(appModel)
}

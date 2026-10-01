import CubbyKit
import SwiftUI

/// The renderers for a detail screen's declared parts: the hero, a `fields` section, a
/// `relation` section, and the journal variant's entry cards. Every value is read off
/// `EntityRow.raw` by `FieldDescriptor.key`; nothing here knows an entity by name.

// MARK: - Hero

struct EntityHeroView<Actions: View>: View {
    let descriptor: EntityDescriptor
    let row: EntityRow
    @ViewBuilder let actions: Actions

    @State private var showingPhoto = false

    private let heroMaxHeight: CGFloat = 280

    private var presentation: EntityPresentation { descriptor.presentation }

    var body: some View {
        if let photo = heroPhoto {
            Button {
                showingPhoto = true
            } label: {
                RoundedRectangle(cornerRadius: FieldGuideTokens.radiusPanel)
                    .fill(FieldGuideTokens.inset)
                    .aspectRatio(4.0 / 3.0, contentMode: .fit)
                    .frame(maxWidth: .infinity, maxHeight: heroMaxHeight)
                    .overlay {
                        PhotoAttachmentImage(photo: photo, renderedWidth: FieldGuideTokens.readingWidth)
                    }
                    .clipShape(RoundedRectangle(cornerRadius: FieldGuideTokens.radiusPanel))
                    .overlay(
                        RoundedRectangle(cornerRadius: FieldGuideTokens.radiusPanel)
                            .strokeBorder(
                                FieldGuideTokens.hairline, lineWidth: FieldGuideTokens.hairlineWidth)
                    )
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Preview \(photo.filename)")
            .photoPreviewPresentation(isPresented: $showingPhoto) {
                PhotoPreview(photos: [photo], selectedID: photo.id)
            }
        }
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            if let breadcrumb = presentation.heroBreadcrumb, let field = descriptor.field(breadcrumb),
                let reference = EntityFieldValue.reference(in: row.raw, field: field)
            {
                NavigationLink(value: Route.entityDetail(reference.entity, id: reference.id)) {
                    HStack(spacing: FieldGuideTokens.Space.xs) {
                        Image(systemName: "chevron.left").font(.fieldGuideLabel.weight(.semibold))
                        Text(reference.name ?? reference.id).font(.fieldGuideLabel)
                    }
                    .foregroundStyle(FieldGuideTokens.interaction)
                }
                .buttonStyle(.plain)
            }
            HStack(alignment: .firstTextBaseline, spacing: FieldGuideTokens.Space.sm) {
                Text(row.title)
                    .font(.fieldGuideDisplay)
                    .tracking(-0.4)
                    .foregroundStyle(FieldGuideTokens.graphite)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                if let chip = presentation.heroChip, let field = descriptor.field(chip),
                    let text = EntityFieldValue.text(in: row.raw, field: field, surface: "detail")
                {
                    StatusChip(
                        text: text,
                        tone: Self.tone(
                            for: FieldResolutionPresentation.readValue(
                                in: row.raw, field: field, surface: "detail")?.stringValue))
                }
            }
            if let subtitle = row.subtitle, !subtitle.isEmpty {
                Text(subtitle)
                    .font(.fieldGuideBody)
                    .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: FieldGuideTokens.Space.sm) {
                DomainMark(descriptor.key)
                Text(row.id)
                    .font(.fieldGuideCode)
                    .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                    .textSelection(.enabled)
                Text(descriptor.singular)
                    .font(.fieldGuideLabel)
                    .foregroundStyle(FieldGuideTokens.graphiteSecondary)
            }
        }
        let stats = heroStats
        if !stats.isEmpty {
            HStack(spacing: FieldGuideTokens.Space.lg) {
                ForEach(stats, id: \.label) { stat in
                    VStack(alignment: .leading, spacing: 2) {
                        FieldExplanationLabel(
                            field: stat.field,
                            subject: EntityRef(entity: descriptor.key, id: row.id)
                        )
                        .font(.fieldGuideLabel)
                        .foregroundStyle(.secondary)
                        Text(stat.value).font(.fieldGuideData.weight(.semibold))
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
        actions
    }

    private var heroStats: [(label: String, value: String, field: FieldDescriptor)] {
        presentation.heroStats.compactMap { key in
            guard let field = descriptor.field(key),
                let value = EntityFieldValue.text(in: row.raw, field: field, surface: "detail")
            else { return nil }
            return (field.label, value, field)
        }
    }

    private var heroPhoto: PhotoAttachment? {
        guard presentation.heroImages, let url = row.imageURL else { return nil }
        return PhotoAttachment(
            id: row.id, filename: row.title, source: .remote(url),
            imageID: descriptor.key == .image ? nil : row.raw["coverImageId"]?.stringValue)
    }

    /// A status word's tone: the few lifecycle spellings the enums share; everything else neutral.
    static func tone(for raw: String?) -> StatusChip.Tone {
        switch raw {
        case "growing", "in_progress", "done", "active", "purchased": .positive
        case "planned", "planning", "not_started", "pending": .neutral
        case "finished", "archived", "cancelled", "blocked": .warning
        default: .neutral
        }
    }
}

#Preview("Entity hero") {
    List {
        EntityHeroView(descriptor: EntityCatalog[.product], row: PreviewFixtures.sampleDetailRow) {
            EmptyView()
        }
    }
    .listStyle(.plain)
    .environment(PreviewFixtures.signedInModel())
}

// MARK: - Fields

/// The `fields` section: one `LabeledContent` per declared key that carries a value. A
/// `reference` field links to its target (showing the projected name); an `identifier` is mono.
/// `inlineFieldKey` names the field beneath which the relationship alternatives render.
struct FieldsSectionView<Inline: View>: View {
    let descriptor: EntityDescriptor
    let row: EntityRow
    let keys: [String]
    var inlineFieldKey: String? = nil
    @ViewBuilder let inline: Inline
    @Environment(AppModel.self) private var appModel
    @State private var resetReview: ResetReview?

    private struct ResetReview: Identifiable {
        let field: String
        var id: String { field }
    }

    var body: some View {
        let rows = rows
        ForEach(rows, id: \.key) { field in
            fieldRow(field)
            if let resolved = FieldResolutionPresentation(raw: row.raw, field: field) {
                EntityFieldResolutionLabel(resolved: resolved)
                if resolved.resetPayload(field: field) != nil, descriptor.key.nativeActions.contains(.update)
                {
                    Button("Review reset: \(resolved.resetLabel.lowercased())") {
                        resetReview = ResetReview(field: field.key)
                    }
                }
            }
            if field.key == inlineFieldKey { inline }
        }
        .sheet(item: $resetReview) { review in
            EntityEditorSheet(
                key: descriptor.key, mode: .update(id: row.id), original: row.raw,
                resolutionResetField: review.field,
                onSaved: { _ in
                    appModel.recordEntityMutation(keys: [descriptor.key])
                })
        }
        if rows.isEmpty { Text("Nothing recorded").foregroundStyle(.secondary) }
    }

    private var rows: [FieldDescriptor] {
        keys.compactMap { key in
            // The hero is the title's and the id's home; repeating them here is a form, not a record.
            guard let field = descriptor.field(key), key != descriptor.titleField, key != "id" else {
                return nil
            }
            if NativePresentationCoverage.unsupportedDetail(field) != nil { return nil }
            if field.detailRenderer == .expenseSpendingCategory
                || field.detailRenderer == .spendingCategorySummary
            {
                return field
            }
            if field.detailRenderer == .recipeSource {
                return RecipeSourcePresentation.parse(row.raw[field.key]) == nil ? nil : field
            }
            if EntityFieldValue.reference(in: row.raw, field: field) != nil {
                return field
            }
            guard
                EntityFieldValue.text(in: row.raw, field: field, surface: "detail") != nil
                    || FieldResolutionPresentation(raw: row.raw, field: field) != nil
            else { return nil }
            return field
        }
    }

    @ViewBuilder
    private func fieldRow(_ field: FieldDescriptor) -> some View {
        if field.detailRenderer == .spendingCategorySummary {
            if let value = row.raw[field.key],
                let summary = try? JSONDecoder.cubby().decode(
                    SpendingCategorySummary.self, from: JSONEncoder.cubby().encode(value))
            {
                SpendingCategorySummaryView(
                    summary: summary, contextOnly: descriptor.key == .financialTransaction)
            }
        } else if field.detailRenderer == .expenseSpendingCategory {
            ExpenseSpendingCategoryView(row: row)
        } else if field.detailRenderer == .recipeSource,
            let source = RecipeSourcePresentation.parse(row.raw[field.key])
        {
            recipeSourceRow(field, source: source)
        } else if let reference = EntityFieldValue.reference(in: row.raw, field: field) {
            let value = reference.name ?? reference.id
            NavigationLink(value: Route.entityDetail(reference.entity, id: reference.id)) {
                LabeledContent {
                    Text(value)
                } label: {
                    FieldExplanationLabel(
                        field: field,
                        subject: EntityRef(entity: descriptor.key, id: row.id))
                }
            }
        } else if let value = EntityFieldValue.text(in: row.raw, field: field, surface: "detail")
            ?? (FieldResolutionPresentation(raw: row.raw, field: field) == nil ? nil : "None")
        {
            LabeledContent {
                Text(value)
                    .font(field.kind == .identifier ? .fieldGuideCode : .fieldGuideBody)
                    .textSelection(.enabled)
                    .multilineTextAlignment(.trailing)
            } label: {
                FieldExplanationLabel(
                    field: field,
                    subject: EntityRef(entity: descriptor.key, id: row.id))
            }
        }
    }

    @ViewBuilder
    private func recipeSourceRow(
        _ field: FieldDescriptor, source: RecipeSourcePresentation
    ) -> some View {
        LabeledContent {
            switch source {
            case .book(let title, let cookbookID):
                if let cookbookID {
                    NavigationLink(value: Route.entityDetail(.cookbook, id: cookbookID)) {
                        Label(title, systemImage: "book.closed")
                    }
                } else {
                    Label(title, systemImage: "book.closed")
                }
            case .external(let host, let url):
                Link(destination: url) {
                    Label(host, systemImage: "arrow.up.right.square")
                }
            }
        } label: {
            FieldExplanationLabel(
                field: field,
                subject: EntityRef(entity: descriptor.key, id: row.id))
        }
    }
}

/// A manifest-owned explanation affordance shared by every generated detail field. The popover
/// presents product language from the descriptor and keeps resolver/read-path internals out of UI.
struct FieldExplanationLabel: View {
    let field: FieldDescriptor
    let subject: EntityRef
    var labelOverride: String? = nil
    var surface = "detail"
    @Environment(AppModel.self) private var appModel
    @State private var showingExplanation = false
    @State private var resolved: FieldExplanationOutput?
    @State private var loadError: String?

    var body: some View {
        if let explanation = field.explanation {
            Button {
                showingExplanation = true
            } label: {
                HStack(spacing: FieldGuideTokens.Space.xs) {
                    Text(labelOverride ?? field.label)
                        .fixedSize(horizontal: false, vertical: true)
                    Image(systemName: "info.circle")
                        .accessibilityHidden(true)
                }
                .frame(
                    minWidth: FieldGuideTokens.touchTarget,
                    minHeight: FieldGuideTokens.touchTarget, alignment: .leading
                )
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier(
                "field.explanation.\(subject.entity.rawValue).\(subject.id).\(field.key)"
            )
            .accessibilityLabel("About \(labelOverride ?? field.label)")
            .accessibilityHint("Shows the value, its source, and the rule used.")
            .onChange(of: subject) { _, _ in
                showingExplanation = false
                resolved = nil
                loadError = nil
            }
            .popover(isPresented: $showingExplanation) {
                explanationPopover(fallback: explanation.description)
                    .task(id: showingExplanation) { await loadExplanation() }
            }
        } else {
            Text(labelOverride ?? field.label)
        }
    }

    @ViewBuilder
    private func explanationPopover(fallback: String) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
                HStack {
                    Text(resolved?.label ?? field.label).font(.headline)
                    Spacer()
                    Button {
                        showingExplanation = false
                    } label: {
                        Image(systemName: "xmark")
                            .frame(
                                minWidth: FieldGuideTokens.touchTarget,
                                minHeight: FieldGuideTokens.touchTarget
                            )
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Close field explanation")
                    .accessibilityIdentifier("field.explanation.close")
                }
                Text(resolved?.rule.description ?? fallback)
                    .font(.fieldGuideBody)
                    .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                if let resolved {
                    if let resolution = resolved.resolution {
                        Divider()
                        Text("In effect").font(.fieldGuideLabel.weight(.semibold))
                        Text(display(resolution.value) ?? "None").font(.fieldGuideData)
                            .accessibilityIdentifier("field.explanation.effective-value")
                        Text(
                            resolution.mode == .explicit
                                ? "Override on this \(EntityCatalog[subject.entity].singular.lowercased())"
                                : resolution.source
                        )
                        .font(.caption).foregroundStyle(.secondary)
                        if let source = resolution.sourceEntity,
                            let entity = EntityKey(rawValue: source.entityKind.rawValue)
                        {
                            NavigationLink(
                                source.name ?? source.entityId,
                                value: Route.entityDetail(entity, id: source.entityId))
                        }
                        if resolution.mode == .explicit || resolution.mode == .none {
                            Text("Without the override").font(.fieldGuideLabel.weight(.semibold))
                            Text(display(resolution.fallbackValue) ?? "Nothing to inherit").font(
                                .fieldGuideData
                            )
                            .accessibilityIdentifier("field.explanation.fallback-value")
                            if let source = resolved.resolutionEvidence?.fallbackSource,
                                let entity = EntityKey(rawValue: source.entityKind.rawValue)
                            {
                                NavigationLink(
                                    source.name ?? source.entityId,
                                    value: Route.entityDetail(entity, id: source.entityId))
                            }
                            if resolution.matchesFallback {
                                Text("Same value — the override is redundant.").font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    if let evidence = resolved.resolutionEvidence, !evidence.hierarchy.isEmpty {
                        Divider()
                        Text("Hierarchy").font(.fieldGuideLabel.weight(.semibold))
                        ForEach(Array(evidence.hierarchy.enumerated()), id: \.offset) { index, source in
                            let value = try? JSONValue(encoding: source.value)
                            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                                Text("\(index + 1). \(source.label)")
                                    .font(.caption).foregroundStyle(.secondary)
                                if let reference = source.entity,
                                    let entity = EntityKey(rawValue: reference.entityKind.rawValue)
                                {
                                    NavigationLink(
                                        value?["name"]?.stringValue ?? reference.entityId,
                                        value: Route.entityDetail(entity, id: reference.entityId)
                                    )
                                    .font(.fieldGuideBody.weight(.medium))
                                    .frame(minHeight: FieldGuideTokens.touchTarget, alignment: .leading)
                                }
                                if value?["assigned"]?.boolValue == false {
                                    Text("No assignment here")
                                        .font(.fieldGuideLabel).foregroundStyle(.secondary)
                                } else if let nested = value?["value"], let text = displayJSON(nested) {
                                    Text(text).font(.fieldGuideData)
                                        .fixedSize(horizontal: false, vertical: true)
                                } else if let text = display(source.value) {
                                    Text(text).font(.fieldGuideData)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(FieldGuideTokens.Space.sm)
                            .background(
                                FieldGuideTokens.inset,
                                in: RoundedRectangle(cornerRadius: FieldGuideTokens.radiusControl))
                        }
                    }
                    if !resolved.sources.isEmpty {
                        Divider()
                        Text("Based on").font(.fieldGuideLabel.weight(.semibold))
                        ForEach(Array(resolved.sources.enumerated()), id: \.offset) { _, source in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(source.label).font(.fieldGuideLabel)
                                if let value = display(source.value), !value.isEmpty {
                                    Text(value)
                                        .font(.fieldGuideData)
                                        .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                                }
                            }
                        }
                    }
                    if resolved.truncated {
                        Text("Showing the most relevant evidence.")
                            .font(.caption)
                            .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                    }
                } else if let loadError {
                    Text(loadError).font(.caption).foregroundStyle(.secondary)
                    Button("Retry explanation") { Task { await loadExplanation() } }
                } else {
                    ProgressView().controlSize(.small)
                }
            }
            .padding(FieldGuideTokens.Space.md)
            .frame(idealWidth: 340, alignment: .leading)
        }
        .accessibilityIdentifier("field.explanation.popover")
        .presentationCompactAdaptation(.popover)
    }

    private func loadExplanation() async {
        guard showingExplanation, resolved == nil else { return }
        do {
            let result = try await appModel.client.fieldExplanation(
                subject: subject, field: field.key, surface: surface)
            try Task.checkCancellation()
            resolved = result
            loadError = nil
        } catch is CancellationError {
        } catch {
            guard !Task.isCancelled else { return }
            loadError = String(describing: error)
            appModel.handle(error)
        }
    }

    private func display(_ value: JsonValue) -> String? {
        guard let value = try? JSONValue(encoding: value) else { return nil }
        return displayJSON(value)
    }

    private func displayJSON(_ value: JSONValue) -> String? {
        if let text = EntityFieldValue.text(value, field: field) { return text }
        if let mode = value["mode"]?.stringValue {
            if let category = value["category"]?.stringValue { return "Category · \(category)" }
            return mode == "none" ? "No category" : mode.capitalized
        }
        switch value {
        case .null: return nil
        case .bool(let value): return value ? "Yes" : "No"
        case .number(let value): return value.formatted()
        case .string(let value): return value
        case .array, .object:
            guard let data = try? JSONEncoder().encode(value) else { return nil }
            return String(data: data, encoding: .utf8)
        }
    }
}

// MARK: - Relation

/// A `relation` section: the target's filtered rows as links, capped at the declared `limit`
/// with "See all" opening the target's list under the same filter; a header create button
/// opens the generic editor prefilled with this record's id.
struct RelationSectionView: View {
    let model: RelationSectionModel
    let onCreate: (() -> Void)?

    @Environment(AppModel.self) private var appModel
    @State private var context: [String: RelationFinancialEvidence] = [:]
    @State private var contextError: String?
    @State private var contextRevision = 0

    private struct RelationFinancialEvidence {
        let movementKinds: [ProductMovementKind]
        let hasPlanned: Bool
        let hasLink: Bool
    }

    private var hasFinancialContext: Bool {
        (model.source.key == .product && model.target.key == .purchase)
            || (model.source.key == .purchase && model.target.key == .product)
    }

    /// `spec.hideWhenEmpty` skips the whole section — header, create button, and all — once the
    /// first page has loaded with no rows and no error; a still-loading or failed section always
    /// renders so its own loading/retry state stays visible.
    private var isHiddenEmpty: Bool {
        model.spec.hideWhenEmpty && model.list.phase == .loaded && model.list.rows.isEmpty
    }

    var body: some View {
        Group {
            if !isHiddenEmpty {
                Section {
                    content
                } header: {
                    HStack {
                        Text(model.section.title ?? model.target.plural)
                        if let range = model.hopRange {
                            Text(recordHopLabel(min: range.min, max: range.max))
                                .font(.caption.monospaced()).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if let onCreate, model.target.key.nativeActions.contains(.create) {
                            Button("New \(model.target.singular)", systemImage: "plus", action: onCreate)
                                .labelStyle(.iconOnly)
                                .font(.body)
                                .frame(
                                    minWidth: FieldGuideTokens.touchTarget,
                                    minHeight: FieldGuideTokens.touchTarget)
                        }
                    }
                }
            }
        }
        .task(id: "\(model.source.key.rawValue):\(model.recordID):\(model.id)") {
            await model.list.loadInitial()
            await model.loadConnectionEvidence()
        }
        .task(id: "\(model.source.key.rawValue):\(model.recordID):\(contextRevision)") {
            context = [:]
            contextError = nil
            await loadFinancialContext()
        }
        .onChange(of: model.list.activity) { previous, current in
            if previous == .refreshing, current == .idle { contextRevision += 1 }
        }
    }

    private func loadFinancialContext() async {
        guard hasFinancialContext else { return }
        do {
            var evidence: [String: RelationFinancialEvidence] = [:]
            if model.source.key == .product {
                let rows = try await appModel.client.productPurchases(
                    .init(productId: model.recordID))
                for row in rows {
                    evidence[row.purchaseId] = RelationFinancialEvidence(
                        movementKinds: row.movementKinds, hasPlanned: row.hasPlanned,
                        hasLink: row.source == .link || row.source == .both)
                }
            } else {
                let rows = try await appModel.client.purchaseProducts(
                    .init(purchaseId: model.recordID))
                for row in rows {
                    evidence[row.productId.rawValue] = RelationFinancialEvidence(
                        movementKinds: row.movementKinds, hasPlanned: row.hasPlanned,
                        hasLink: row.source == .link || row.source == .both)
                }
            }
            try Task.checkCancellation()
            context = evidence
            contextError = nil
        } catch is CancellationError {
        } catch {
            guard !Task.isCancelled else { return }
            contextError = String(describing: error)
            appModel.handle(error)
        }
    }

    @ViewBuilder
    private func financialBadges(_ evidence: RelationFinancialEvidence, rowID: String) -> some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            ForEach(evidence.movementKinds, id: \.rawValue) { kind in
                StatusChip(text: "Movement · \(kind.rawValue.capitalized)")
                    .accessibilityIdentifier(
                        "relation.evidence.\(model.target.key.rawValue).\(rowID).movement.\(kind.rawValue)")
            }
            if evidence.hasPlanned {
                StatusChip(text: "Planned", tone: .warning)
                    .accessibilityIdentifier(
                        "relation.evidence.\(model.target.key.rawValue).\(rowID).planned")
            }
            if evidence.hasLink {
                StatusChip(text: "Linked")
                    .accessibilityIdentifier("relation.evidence.\(model.target.key.rawValue).\(rowID).linked")
            }
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var content: some View {
        let list = model.list
        switch list.phase {
        case .idle, .loading:
            LoadingIndicator(label: "Loading \(model.target.plural)")
        case .unavailable(let message), .failed(let message):
            Text(message).foregroundStyle(.secondary)
            Button("Retry") { Task { await list.loadInitial() } }
        case .loaded:
            // `collapseWhenEmpty` folds an empty section down to its header and create button.
            if list.rows.isEmpty && !model.spec.collapseWhenEmpty {
                Text(model.spec.empty ?? "None").foregroundStyle(.secondary)
            }
            ForEach(list.rows) { row in
                VStack(alignment: .leading, spacing: 5) {
                    NavigationLink(value: Route.entityDetail(model.target.key, id: row.id)) {
                        EntityRowView(key: model.target.key, row: row, columns: model.spec.columns)
                    }
                    .accessibilityIdentifier("relation.row.\(model.target.key.rawValue).\(row.id)")
                    if let evidence = context[row.id] { financialBadges(evidence, rowID: row.id) }
                    if let evidence = model.connectionEvidence[row.id] {
                        RecordPathView(paths: evidence.paths)
                    }
                }
            }
            if let error = contextError {
                Text(error).font(.caption).foregroundStyle(.secondary)
                Button("Retry relation evidence") { Task { await loadFinancialContext() } }
                    .frame(minHeight: FieldGuideTokens.touchTarget)
            }
            if let error = model.connectionError {
                Text(error).font(.caption).foregroundStyle(.secondary)
                Button("Retry paths") { Task { await model.loadConnectionEvidence() } }
            }
            if list.hasMore {
                Button("Open all · \(list.meta.map { "\($0.totalCount)" } ?? "")") {
                    Task {
                        await list.loadNextPage()
                        await model.loadConnectionEvidence()
                    }
                }
            }
        }
    }
}

// MARK: - Journal

/// The journal variant's leading section: the first relation's rows as entry cards, newest
/// first, with the "Log entry" create button in the header.
struct EntityJournalSectionView: View {
    let model: RelationSectionModel
    let onLogEntry: () -> Void

    var body: some View {
        Section {
            let list = model.list
            switch list.phase {
            case .idle, .loading:
                LoadingIndicator(label: "Loading journal")
            case .unavailable(let message), .failed(let message):
                Text(message).foregroundStyle(.secondary)
                Button("Retry") { Task { await list.loadInitial() } }
            case .loaded:
                if list.rows.isEmpty { Text("No entries yet.").foregroundStyle(.secondary) }
                ForEach(list.rows) { row in
                    VStack(alignment: .leading, spacing: 5) {
                        EntityJournalEntryRow(descriptor: model.target, row: row)
                        if let evidence = model.connectionEvidence[row.id] {
                            RecordPathView(paths: evidence.paths)
                        }
                    }
                }
                if list.hasMore {
                    Button("Load more") {
                        Task {
                            await list.loadNextPage()
                            await model.loadConnectionEvidence()
                        }
                    }
                    .disabled(list.activity != .idle)
                }
            }
        } header: {
            HStack {
                Text(model.section.title ?? "Journal")
                if let range = model.hopRange {
                    Text(recordHopLabel(min: range.min, max: range.max))
                        .font(.caption.monospaced()).foregroundStyle(.secondary)
                }
                Spacer()
                if model.target.key.nativeActions.contains(.create) {
                    Button("Log entry", systemImage: "square.and.pencil", action: onLogEntry)
                        .font(.body)
                        .frame(minHeight: FieldGuideTokens.touchTarget)
                        .accessibilityIdentifier("detail.journal.logEntry")
                }
            }
        }
        .task {
            await model.list.loadInitial()
            await model.loadConnectionEvidence()
        }
    }
}

/// One journal entry: title, observed day, kind chip, note, and the entry's image strip.
struct EntityJournalEntryRow: View {
    let descriptor: EntityDescriptor
    let row: EntityRow

    private var images: [URL] {
        row.raw["displayImages"]?.arrayValue?.compactMap { image in
            let value =
                image["representations"]?["preferred"]?.stringValue
                ?? image["url"]?.stringValue
            return value.flatMap(URL.init(string:))
        } ?? []
    }

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            NavigationLink(value: Route.entityDetail(descriptor.key, id: row.id)) {
                HStack(alignment: .firstTextBaseline, spacing: FieldGuideTokens.Space.sm) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.title).font(.fieldGuideBody.weight(.semibold))
                        if let field = descriptor.field("observedOn"),
                            let day = EntityFieldValue.text(row.raw["observedOn"], field: field)
                        {
                            Text(day).font(.fieldGuideLabel).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    if let field = descriptor.field("kind"),
                        let kind = EntityFieldValue.text(row.raw["kind"], field: field)
                    {
                        StatusChip(text: kind)
                    }
                }
            }
            if let note = row.raw["notes"]?.stringValue, !note.isEmpty {
                Text(note).font(.fieldGuideBody).fixedSize(horizontal: false, vertical: true)
            }
            if let amount = row.raw["harvestAmount"]?.stringValue, !amount.isEmpty {
                Text("Harvest: \(amount)").font(.fieldGuideLabel)
            }
            if !images.isEmpty {
                ScrollView(.horizontal) {
                    HStack(spacing: FieldGuideTokens.Space.sm) {
                        ForEach(images, id: \.self) { url in
                            Thumb(url: url, size: 88)
                        }
                    }
                }
                .scrollIndicators(.hidden)
            }
        }
        .padding(.vertical, FieldGuideTokens.Space.xs)
    }
}

// MARK: - Inline relationship alternatives

struct InlineRelationshipAlternativeView: View {
    let proposal: ActionableRelationshipRecommendation
    let hasCurrentTarget: Bool
    let review: () -> Void

    var body: some View {
        Button(action: review) {
            HStack(alignment: .top, spacing: FieldGuideTokens.Space.sm) {
                Image(systemName: "sparkles")
                    .foregroundStyle(FieldGuideTokens.interaction)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                    Text("\(hasCurrentTarget ? "Alternative" : "Suggested") \(field): \(targetName)")
                        .font(.fieldGuideLabel)
                        .foregroundStyle(FieldGuideTokens.graphite)
                        .fixedSize(horizontal: false, vertical: true)
                    if let reason {
                        Text(reason)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: FieldGuideTokens.Space.sm)
                Image(systemName: "chevron.right")
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            .frame(minHeight: FieldGuideTokens.touchTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Opens supporting evidence and the accept action")
    }

    private var field: String {
        switch proposal {
        case .expenseProject: "project"
        case .inventoryPlacement: "location"
        }
    }

    private var targetName: String {
        switch proposal {
        case .expenseProject(let proposal): proposal.target.name
        case .inventoryPlacement(let proposal): proposal.target.name
        }
    }

    private var reason: String? {
        switch proposal {
        case .expenseProject(let proposal):
            proposal.reasons.first
                ?? "\(proposal.sameTradeCount) same-trade and \(proposal.exactProductCount) exact-product matches"
        case .inventoryPlacement(let proposal):
            proposal.reasons.first
        }
    }
}

// MARK: - Raw record

struct RawRecordDisclosure: View {
    let raw: JSONValue
    @State private var showingRaw = false

    var body: some View {
        Panel(padding: FieldGuideTokens.Space.md) {
            DisclosureGroup(isExpanded: $showingRaw) {
                Text(prettyJSON)
                    .font(.fieldGuideCode)
                    .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, FieldGuideTokens.Space.sm)
            } label: {
                Eyebrow("Raw record")
            }
            .tint(FieldGuideTokens.graphiteSecondary)
        }
    }

    private var prettyJSON: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(raw), let string = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return string
    }
}

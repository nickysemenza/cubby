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
                    let text = EntityFieldValue.text(row.raw[chip], field: field)
                {
                    StatusChip(text: text, tone: Self.tone(for: row.raw[chip]?.stringValue))
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
                let value = EntityFieldValue.text(row.raw[key], field: field)
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

    var body: some View {
        let rows = rows
        ForEach(rows, id: \.key) { field in
            fieldRow(field)
            if field.key == inlineFieldKey { inline }
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
            if field.detailRenderer == .recipeSource {
                return RecipeSourcePresentation.parse(row.raw[field.key]) == nil ? nil : field
            }
            if EntityFieldValue.reference(in: row.raw, field: field) != nil {
                return field
            }
            guard EntityFieldValue.text(row.raw[key], field: field) != nil else { return nil }
            return field
        }
    }

    @ViewBuilder
    private func fieldRow(_ field: FieldDescriptor) -> some View {
        if field.detailRenderer == .recipeSource,
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
        } else if let value = EntityFieldValue.text(row.raw[field.key], field: field) {
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
    @Environment(AppModel.self) private var appModel
    @State private var showingExplanation = false
    @State private var resolved: FieldExplanationOutput?
    @State private var loadError: String?

    var body: some View {
        HStack(spacing: FieldGuideTokens.Space.xs) {
            Text(labelOverride ?? field.label)
            if let explanation = field.explanation {
                Button {
                    showingExplanation = true
                } label: {
                    Image(systemName: "info.circle")
                }
                .buttonStyle(.plain)
                .accessibilityLabel("About \(labelOverride ?? field.label)")
                .popover(isPresented: $showingExplanation) {
                    explanationPopover(fallback: explanation.description)
                        .task(id: showingExplanation) { await loadExplanation() }
                }
            }
        }
    }

    @ViewBuilder
    private func explanationPopover(fallback: String) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
                Text(resolved?.label ?? field.label).font(.headline)
                Text(resolved?.rule.description ?? fallback)
                    .font(.fieldGuideBody)
                    .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                if let resolved {
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
                } else {
                    ProgressView().controlSize(.small)
                }
            }
            .padding(FieldGuideTokens.Space.md)
            .frame(idealWidth: 340, alignment: .leading)
        }
        .presentationCompactAdaptation(.popover)
    }

    private func loadExplanation() async {
        guard showingExplanation, resolved == nil else { return }
        do {
            resolved = try await appModel.client.fieldExplanation(
                subject: subject, field: field.key)
            loadError = nil
        } catch {
            loadError = "Current evidence couldn’t be loaded."
            appModel.handle(error)
        }
    }

    private func display(_ value: JsonValue) -> String? {
        guard let value = try? JSONValue(encoding: value) else { return nil }
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
        .task {
            await model.list.loadInitial(); await model.loadConnectionEvidence()
        }
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
                    if let evidence = model.connectionEvidence[row.id] {
                        RecordPathView(paths: evidence.paths)
                    }
                }
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
            if let note = row.raw["note"]?.stringValue, !note.isEmpty {
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

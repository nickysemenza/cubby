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
                if let emoji = descriptor.recordEmoji(in: row) {
                    Text(emoji).font(.fieldGuideDisplay).accessibilityHidden(true)
                }
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
                        color: FieldGuideMetrics.optionColor(
                            EntityFieldValue.optionColor(in: row.raw, field: field, surface: "detail")))
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
            if field.itemsPath != nil {
                return field.detailItems(in: row.raw).isEmpty ? nil : field
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
        if field.reference?.multiple == true {
            RecordReferenceList(field: field, row: row)
        } else if field.itemsPath != nil {
            DetailDisplayRows(label: field.label, rows: field.detailItems(in: row.raw))
        } else if field.detailRenderer == .spendingCategorySummary {
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
                    HStack {
                        if let emoji = reference.emoji { Text(emoji).accessibilityHidden(true) }
                        Text(value)
                    }
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
                if let color = FieldGuideMetrics.optionColor(
                    EntityFieldValue.optionColor(in: row.raw, field: field, surface: "detail"))
                {
                    StatusChip(text: value, color: color)
                        .textSelection(.enabled)
                } else {
                    Text(value)
                        .font(field.kind == .identifier ? .fieldGuideCode : .fieldGuideBody)
                        .textSelection(.enabled)
                        .multilineTextAlignment(.trailing)
                }
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
        if field.explanation != nil {
            Button {
                resolved = nil
                loadError = nil
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
            .accessibilityLabel(labelOverride.map { "\(field.label): \($0)" } ?? "About \(field.label)")
            .accessibilityHint("Shows the value, its source, and the rule used.")
            .onChange(of: subject) { _, _ in
                showingExplanation = false
                resolved = nil
                loadError = nil
            }
            .popover(isPresented: $showingExplanation) {
                explanationPopover()
                    .task(id: showingExplanation) { await loadExplanation() }
            }
        } else {
            Text(labelOverride ?? field.label)
        }
    }

    @ViewBuilder
    private func explanationPopover() -> some View {
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
                if field.key == "dataQuality", field.readKey == nil {
                    explanationSectionLabel("What this means")
                    Text("Not assessed").font(.title3.weight(.semibold))
                    Text(
                        "No quality checks are defined for this entity. Review its fields and supporting records directly."
                    )
                    if EntityCatalog.descriptor(forShortcode: subject.id)?.key == subject.entity {
                        NavigationLink(
                            "Open record", value: Route.entityDetail(subject.entity, id: subject.id))
                    }
                    Divider()
                    explanationSectionLabel("Technical details")
                    if let rule = field.explanation {
                        Text("Rule: \(rule.ruleId) · r\(rule.version)").font(.caption.monospaced())
                    }
                    Text("Evaluation: not performed; no checks are defined.").font(.caption)
                    Text(
                        "There is no score, calculation, or check evaluation for this entity. Not assessed is not a score of zero or a guarantee of completeness."
                    )
                    .font(.callout)
                } else if let resolved {
                    explanationSectionLabel("What this means")
                    if let interpretation = resolved.interpretation {
                        Text(interpretation.result).font(.title3.weight(.semibold))
                        Text(interpretation.summary).font(.body)
                        ForEach(interpretation.caveats, id: \.self) { caveat in
                            Text(caveat).font(.callout).foregroundStyle(.secondary)
                        }
                        if !interpretation.nextSteps.isEmpty {
                            Text("Next steps").font(.headline)
                            ForEach(interpretation.nextSteps, id: \.self) { step in
                                Text(step).font(.callout)
                            }
                        }
                    } else if let value = try? JSONValue(encoding: resolved.value) {
                        if let code = value.stringValue,
                            let option = field.valueOptions?.first(where: { $0.value == code })
                        {
                            Text(option.label).font(.title3.weight(.semibold))
                        } else {
                            ExplanationEvidenceValue(value: value)
                        }
                    }
                    if let resolution = resolved.resolution {
                        let hasFallback = display(resolution.fallbackValue) != nil
                        let state = FieldResolutionState(resolution, hasFallback: hasFallback)
                        HStack(alignment: .firstTextBaseline, spacing: FieldGuideTokens.Space.sm) {
                            Text(display(resolution.value) ?? "None")
                                .font(.fieldGuideData.weight(.semibold))
                                .accessibilityIdentifier("field.explanation.effective-value")
                            Spacer(minLength: FieldGuideTokens.Space.sm)
                            Label(state.label, systemImage: state.systemImage)
                                .font(.caption.weight(.medium))
                                .foregroundStyle(
                                    state.tone == .redundant
                                        ? FieldGuideTokens.warning : FieldGuideTokens.graphiteSecondary
                                )
                                .accessibilityIdentifier("field.explanation.state")
                        }
                        if resolution.mode == .inherit || resolution.mode == .allocated,
                            let source = resolution.sourceEntity,
                            let entity = EntityKey(rawValue: source.entityKind.rawValue)
                        {
                            explanationFact("From") {
                                NavigationLink(
                                    source.name ?? source.entityId,
                                    value: Route.entityDetail(entity, id: source.entityId))
                            }
                        }
                        if resolution.mode == .explicit || resolution.mode == .none,
                            let fallbackText = display(resolution.fallbackValue)
                        {
                            explanationFact("Fallback") {
                                Text(fallbackText).font(.fieldGuideData)
                                    .accessibilityIdentifier("field.explanation.fallback-value")
                                if let source = resolved.resolutionEvidence?.fallbackSource,
                                    let entity = EntityKey(rawValue: source.entityKind.rawValue)
                                {
                                    NavigationLink(
                                        source.name ?? source.entityId,
                                        value: Route.entityDetail(entity, id: source.entityId))
                                }
                            }
                        }
                    }
                    Divider()
                    explanationSectionLabel("Technical details")
                    Text(resolved.rule.description).font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("Rule: \(resolved.rule.id) · r\(resolved.rule.revision)")
                        .font(.caption.monospaced()).textSelection(.enabled)
                    Text("Evaluated: \(resolved.evaluatedAt.formatted())").font(.caption).foregroundStyle(
                        .secondary)
                    if resolved.resolution == nil, let value = try? JSONValue(encoding: resolved.value) {
                        if value.objectValue != nil || value.arrayValue != nil {
                            ExplanationEvidenceValue(value: value)
                        } else if let code = value.stringValue, code != resolved.interpretation?.result {
                            Text("Result code: \(code)").font(.caption.monospaced())
                        }
                    }
                    ForEach(Array(resolved.actions.enumerated()), id: \.offset) { _, action in
                        if action.kind.rawValue == "editSource",
                            let entity = EntityKey(rawValue: action.target.entityKind.rawValue)
                        {
                            NavigationLink(
                                action.label, value: Route.entityDetail(entity, id: action.target.entityId))
                        }
                    }
                    if let breakdown = resolved.qualityBreakdown {
                        Text("Score calculation").font(.headline)
                        Text(breakdown.summary).font(.callout.monospacedDigit())
                        ForEach(breakdown.checks, id: \.check) { check in
                            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                                Text(check.label).font(.callout.weight(.semibold))
                                Text("\(check.stateLabel) · \(check.weightLabel)")
                                    .font(.caption).foregroundStyle(.secondary)
                                if check.state.rawValue == "gap" { Text(check.description).font(.callout) }
                                DataExceptionControl(
                                    draft: .init(entityID: subject.id, check: check.check),
                                    isGap: check.state.rawValue == "gap",
                                    options: check.exceptionReasons.map {
                                        .init(reason: $0.reason, label: $0.label)
                                    },
                                    recorded: check.exception.map {
                                        ($0.reason, $0.note, $0.state.rawValue == "stale")
                                    },
                                    onChanged: reloadExplanation
                                )
                                Text("\(check.facet) · \(check.check)").font(.caption.monospaced())
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    if let evidence = resolved.resolutionEvidence, !evidence.hierarchy.isEmpty {
                        Divider()
                        explanationSectionLabel("Resolution order")
                        let winner = ladderWinner(resolved)
                        ForEach(Array(evidence.hierarchy.enumerated()), id: \.offset) { _, source in
                            ladderRow(source, winner: winner)
                        }
                    }
                    if !resolved.sources.isEmpty {
                        Divider()
                        explanationSectionLabel("Evidence")
                        ForEach(Array(resolved.sources.prefix(6).enumerated()), id: \.offset) { _, source in
                            explanationSource(source)
                        }
                        if resolved.sources.count > 6 {
                            DisclosureGroup("Show \(resolved.sources.count - 6) more evidence entries") {
                                ForEach(Array(resolved.sources.dropFirst(6).enumerated()), id: \.offset) {
                                    _, source in
                                    explanationSource(source)
                                }
                            }
                        }
                    }
                    if resolved.truncated {
                        Text("Evidence is bounded; the displayed sources are not an exhaustive list.")
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
        #if os(macOS)
            .frame(
                minWidth: 360, idealWidth: 480, maxWidth: 560, minHeight: 320, idealHeight: 620,
                maxHeight: 760
            )
            .accessibilityElement(children: .contain)
        #endif
        .accessibilityIdentifier("field.explanation.popover")
        .presentationCompactAdaptation(.sheet)
    }

    /// Re-explains after an exception changed; `resolved` is shadowed inside the popover body.
    private func reloadExplanation() {
        resolved = nil
        Task { await loadExplanation() }
    }

    private func loadExplanation() async {
        guard showingExplanation, resolved == nil,
            !(field.key == "dataQuality" && field.readKey == nil)
        else { return }
        loadError = nil
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

    @ViewBuilder
    private func explanationSectionLabel(_ text: String) -> some View {
        Text(text.uppercased()).font(.caption2.weight(.semibold)).tracking(0.6)
            .foregroundStyle(FieldGuideTokens.graphiteSecondary)
    }

    private func explanationFact<Content: View>(
        _ label: String, @ViewBuilder content: () -> Content
    ) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: FieldGuideTokens.Space.sm) {
            Text(label).font(.caption).foregroundStyle(FieldGuideTokens.graphiteSecondary)
            content()
        }
    }

    /// The ladder level that supplies the value: the inherited source, else the subject itself.
    private func ladderWinner(_ resolved: FieldExplanationOutput) -> String? {
        guard let resolution = resolved.resolution else { return nil }
        switch resolution.mode {
        case .inherit, .allocated: return resolution.sourceEntity?.entityId
        case .explicit, .none: return subject.id
        }
    }

    /// One level of the resolution ladder: its own assignment and whether it wins.
    @ViewBuilder
    private func ladderRow(_ source: FieldExplanationSource, winner: String?) -> some View {
        let value = try? JSONValue(encoding: source.value)
        let assigned = value?["assigned"]?.boolValue ?? (value != .null)
        let wins = winner != nil && source.entity?.entityId == winner
        let isSubject = source.entity?.entityId == subject.id
        HStack(alignment: .firstTextBaseline, spacing: FieldGuideTokens.Space.sm) {
            if !isSubject, let reference = source.entity,
                let entity = EntityKey(rawValue: reference.entityKind.rawValue)
            {
                NavigationLink(
                    value?["name"]?.stringValue ?? reference.entityId,
                    value: Route.entityDetail(entity, id: reference.entityId)
                )
                .font(.fieldGuideBody.weight(.medium))
                .lineLimit(1)
            } else {
                Text(value?["name"]?.stringValue ?? source.label)
                    .font(.fieldGuideBody.weight(.medium))
                    .lineLimit(1)
                if isSubject {
                    Text("THIS").font(.caption2).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: FieldGuideTokens.Space.sm)
            Text(
                assigned
                    ? (value?["value"].flatMap(displayJSON) ?? display(source.value) ?? "—")
                    : "—"
            )
            .font(.fieldGuideData)
            .strikethrough(assigned && !wins)
            .lineLimit(1)
            Text(wins ? "WINS" : assigned ? "SHADOWED" : "NOT SET")
                .font(.caption2.weight(wins ? .semibold : .regular))
                .foregroundStyle(wins ? FieldGuideTokens.interaction : .secondary)
        }
        .foregroundStyle(wins ? FieldGuideTokens.graphite : FieldGuideTokens.graphiteSecondary)
        .frame(minHeight: FieldGuideTokens.touchTarget)
        .padding(.horizontal, FieldGuideTokens.Space.sm)
        .background(
            wins ? FieldGuideTokens.inset : .clear,
            in: RoundedRectangle(cornerRadius: FieldGuideTokens.radiusControl))
    }

    @ViewBuilder
    private func explanationSource(_ source: FieldExplanationSource) -> some View {
        let value = try? JSONValue(encoding: source.value)
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            Text(source.label).font(.caption).foregroundStyle(.secondary)
            if let reference = source.entity, let entity = EntityKey(rawValue: reference.entityKind.rawValue)
            {
                NavigationLink(
                    value?["name"]?.stringValue ?? reference.entityId,
                    value: Route.entityDetail(entity, id: reference.entityId))
            }
            if let value {
                ExplanationEvidenceValue(value: sourceFacts(value, reference: source.entity?.entityId))
            }
        }
    }

    private func sourceFacts(_ value: JSONValue, reference: String?) -> JSONValue {
        guard let reference, let facts = value.objectValue else { return value }
        return .object(facts.filter { $0.key != "name" && $0.value.stringValue != reference })
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

/// Structured evidence remains readable at accessibility text sizes.
private struct ExplanationEvidenceValue: View {
    let value: JSONValue
    var property: String? = nil

    var body: some View { content(value) }

    private func content(_ value: JSONValue) -> AnyView {
        switch value {
        case .null: return AnyView(Text("None").foregroundStyle(.secondary))
        case .bool(let value): return AnyView(Text(value ? "Yes" : "No"))
        case .number(let value):
            return AnyView(
                Text(property == "amount" ? value.formatted(.currency(code: "USD")) : value.formatted())
                    .monospacedDigit())
        case .string(let value):
            if let entity = EntityCatalog.descriptor(forShortcode: value) {
                return AnyView(NavigationLink(value, value: Route.entityDetail(entity.key, id: value)))
            }
            return AnyView(Text(value.replacingOccurrences(of: "_", with: " ")).textSelection(.enabled))
        case .array(let values):
            return AnyView(
                VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
                    ForEach(Array(values.enumerated()), id: \.offset) { _, item in
                        ExplanationEvidenceValue(value: item)
                    }
                })
        case .object(let values):
            let identifier = values["id"]?.stringValue
            let entity = identifier.flatMap { EntityCatalog.descriptor(forShortcode: $0) }
            return AnyView(
                VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                    if let identifier, let entity {
                        NavigationLink(
                            values["name"]?.stringValue ?? identifier,
                            value: Route.entityDetail(entity.key, id: identifier))
                    }
                    ForEach(
                        values.keys.filter { entity == nil || ($0 != "id" && $0 != "name") }.sorted(),
                        id: \.self
                    ) { key in
                        if let item = values[key] {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(
                                    key.replacingOccurrences(
                                        of: "([a-z0-9])([A-Z])", with: "$1 $2", options: .regularExpression
                                    ).replacingOccurrences(of: "_", with: " ").capitalized
                                )
                                .font(.caption).foregroundStyle(.secondary)
                                ExplanationEvidenceValue(value: item, property: key).font(.callout)
                            }
                        }
                    }
                })
        }
    }

}

#Preview("Structured explanation evidence") {
    ExplanationEvidenceValue(value: .object(["amount": .number(15), "complete": .bool(true)]))
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
            InlineLoadFailure(message: message) { await list.loadInitial() }
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
                InlineLoadFailure(message: message) { await list.loadInitial() }
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
                        StatusChip(
                            text: kind,
                            color: FieldGuideMetrics.optionColor(
                                EntityFieldValue.optionColor(in: row.raw, field: field, surface: "detail")))
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

/// A field's server-composed display rows (`display.itemsPath`): the title, second line, and
/// trailing figure are the server's words; a row that names a record opens it.
private struct DetailDisplayRows: View {
    let label: String
    let rows: [DetailDisplayRow]

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            Text(label).font(.fieldGuideLabel)
            ForEach(Array(rows.enumerated()), id: \.offset) { _, item in
                if let entity = item.entity, let id = item.id {
                    NavigationLink(value: Route.entityDetail(entity, id: id)) { content(item) }
                } else {
                    content(item)
                }
            }
        }
    }

    private func content(_ item: DetailDisplayRow) -> some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title)
                if let subtitle = item.subtitle, !subtitle.isEmpty {
                    Text(subtitle).font(.fieldGuideLabel).foregroundStyle(.secondary)
                }
            }
            if let trailing = item.trailing, !trailing.isEmpty {
                Spacer(minLength: FieldGuideTokens.Space.sm)
                Text(trailing).font(.fieldGuideLabel).foregroundStyle(.secondary)
                    .multilineTextAlignment(.trailing)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// Bounded reference presentation and its scoped browse link share the declaration.
private struct RecordReferenceList: View {
    let field: FieldDescriptor
    let row: EntityRow
    @State private var expanded = false
    private var items: [JSONValue] { row.raw[field.readKey ?? field.key]?.arrayValue ?? [] }
    private var target: EntityKey? { field.reference?.entity }
    private var filters: EntityFilterState {
        var result = EntityFilterState()
        guard let target else { return result }
        for binding in field.reference?.scope ?? [] {
            if let descriptor = EntityCatalog[target].filters.first(where: {
                $0.wire.names.contains(binding.targetField) || $0.columnId == binding.targetField
            }),
                let value = row.raw[binding.sourceField]?.stringValue, let name = descriptor.wire.names.first
            {
                result.set(.single(value), for: name)
            }
        }
        return result
    }
    var body: some View {
        if let target {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
                Text(field.label).font(.fieldGuideLabel)
                ForEach(
                    Array(
                        (expanded ? items : Array(items.prefix(field.referencePreviewLimit ?? items.count)))
                            .enumerated()), id: \.offset
                ) { _, item in
                    if let id = item["id"]?.stringValue ?? item.stringValue {
                        NavigationLink(value: Route.entityDetail(target, id: id)) {
                            HStack {
                                if let emoji = item["emoji"]?.stringValue {
                                    Text(emoji).accessibilityHidden(true)
                                }
                                Text(item["name"]?.stringValue ?? id)
                            }
                        }
                    }
                }
                if let limit = field.referencePreviewLimit, items.count > limit {
                    Button(expanded ? "Show less" : "+\(items.count - limit) more") { expanded.toggle() }
                }
                if !filters.isEmpty {
                    NavigationLink("View all", value: Route.entityList(target, filters: filters))
                }
            }
        }
    }
}

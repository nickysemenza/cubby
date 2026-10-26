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

    private var presentation: EntityPresentation { descriptor.presentation }
    let showsTitle: Bool

    init(
        descriptor: EntityDescriptor, row: EntityRow, showsTitle: Bool? = nil,
        @ViewBuilder actions: () -> Actions
    ) {
        self.descriptor = descriptor
        self.row = row
        self.showsTitle = showsTitle ?? true
        self.actions = actions()
    }

    var body: some View {
        HStack(alignment: .center, spacing: FieldGuideTokens.Space.md) {
            if let photo = heroPhoto {
                photoButton(photo)
            } else {
                Thumb(
                    url: row.imageURL, size: 56, symbol: descriptor.recordSymbol(in: row),
                    emoji: descriptor.recordEmoji(in: row)
                )
                .accessibilityHidden(true)
            }
            summary
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        actions
    }

    private func photoButton(_ photo: PhotoAttachment) -> some View {
        Button {
            showingPhoto = true
        } label: {
            PhotoAttachmentImage(photo: photo, renderedWidth: 56)
                .frame(width: 56, height: 56)
                .clipShape(RoundedRectangle(cornerRadius: FieldGuideTokens.radiusControl))
                .background(FieldGuideTokens.inset)
                .clipped()
                .overlay {
                    Rectangle().strokeBorder(
                        FieldGuideTokens.hairline, lineWidth: FieldGuideTokens.hairlineWidth)
                }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Preview \(photo.filename)")
        .photoPreviewPresentation(isPresented: $showingPhoto) {
            PhotoPreview(photos: [photo], selectedID: photo.id)
        }
    }

    private var summary: some View {
        VStack(alignment: .leading, spacing: 3) {
            if showsTitle {
                Text(row.title)
                    .font(.headline)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            headerMetadata
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var headerMetadata: some View {
        let fact =
            row.subtitle.flatMap { $0.isEmpty ? nil : $0 }
            ?? presentation.summaryFieldKeys.lazy.compactMap { key in
                descriptor.field(key).flatMap {
                    EntityFieldValue.text(in: row.raw, field: $0, surface: "detail")
                }
            }.first
        return Text(
            "\(descriptor.singular) · \(Text(row.id).font(.fieldGuideCode))\(fact.map { " · \($0)" } ?? "")"
        )
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(2)
        .textSelection(.enabled)
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

#Preview("Entity hero · accessibility") {
    Form {
        EntityHeroView(descriptor: EntityCatalog[.product], row: PreviewFixtures.sampleDetailRow) {
            EmptyView()
        }
    }
    .dynamicTypeSize(.accessibility3)
    .environment(PreviewFixtures.signedInModel())
}

#Preview("Entity hero · wide") {
    Form {
        EntityHeroView(descriptor: EntityCatalog[.product], row: PreviewFixtures.sampleDetailRow) {
            EmptyView()
        }
    }
    .frame(width: 760)
    .environment(PreviewFixtures.signedInModel())
}

// MARK: - Fields

/// The `fields` section: one `LabeledContent` per declared key that carries a value. A
/// `reference` field links to its target (showing the projected name); an `identifier` is mono.
struct FieldsSectionView: View {
    let descriptor: EntityDescriptor
    let row: EntityRow
    let keys: [String]
    var macGrid = false
    var summary = false
    @Environment(AppModel.self) private var appModel
    @State private var resolutionReview: ResolutionActionRequest?

    var hasVisibleRows: Bool { !rows.isEmpty }

    var body: some View {
        let rows = rows
        Group {
            if macGrid {
                Grid(alignment: .leading, horizontalSpacing: FieldGuideTokens.Space.md, verticalSpacing: 0) {
                    ForEach(rows, id: \.key) { field in
                        if isWide(field) {
                            GridRow { macWideField(field) }
                                .gridCellColumns(2)
                        } else {
                            GridRow(alignment: .firstTextBaseline) {
                                FieldExplanationLabel(
                                    field: field, subject: EntityRef(entity: descriptor.key, id: row.id)
                                )
                                .font(.caption)
                                .multilineTextAlignment(.trailing)
                                .frame(width: 118, alignment: .trailing)
                                .frame(minHeight: 20)
                                VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                                    HStack(spacing: FieldGuideTokens.Space.xs) {
                                        macGridValue(field)
                                        DerivedValueStatus(raw: row.raw, field: field.key)
                                    }
                                    DerivedProvenanceCaption(
                                        raw: row.raw, field: field.key,
                                        includeInherited: row.raw["fieldResolutions"]?[field.key] == nil)
                                }.frame(minHeight: 20)
                            }
                        }
                    }
                }
                .navigationLinkIndicatorVisibility(.hidden)
            } else {
                ForEach(fieldGroups(rows)) { group in
                    if group.compact {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(group.fields, id: \.key) { field in
                                if field.key != group.id { Divider() }
                                dossierField(field)
                            }
                        }
                        .font(.subheadline)
                        .navigationLinkIndicatorVisibility(.hidden)
                        .listRowInsets(
                            EdgeInsets(
                                top: 0, leading: FieldGuideTokens.Space.md,
                                bottom: 0, trailing: FieldGuideTokens.Space.md))
                    } else {
                        ForEach(group.fields, id: \.key) { field in
                            fieldRowWithResolutionActions(field)
                        }
                    }
                }
            }
        }
        .sheet(item: $resolutionReview) { review in
            EntityEditorSheet(
                key: descriptor.key, mode: .update(id: row.id), original: row.raw,
                resolutionAction: review,
                onSaved: { _ in
                    appModel.recordEntityMutation(keys: [descriptor.key])
                })
        }
        if rows.isEmpty {
            Text("Nothing recorded").foregroundStyle(.secondary)
                .preference(key: DetailSectionEmpty.self, value: true)
        }
    }

    private struct FieldGroup: Identifiable {
        var fields: [FieldDescriptor]
        let compact: Bool
        var id: String { fields[0].key }
    }

    /// Ordinary facts and their evidence share a Form child. Specialist/prose layouts keep
    /// their own row, and grouping preserves manifest order.
    private func fieldGroups(_ rows: [FieldDescriptor]) -> [FieldGroup] {
        var groups: [FieldGroup] = []
        for field in rows {
            let compact =
                field.itemsPath == nil && field.controlKind != .textarea
                && field.detailRenderer != .expenseSpendingCategory
                && field.detailRenderer != .spendingCategorySummary
                && field.detailRenderer != .recipeSource
            if compact, groups.last?.compact == true {
                groups[groups.count - 1].fields.append(field)
            } else {
                groups.append(FieldGroup(fields: [field], compact: compact))
            }
        }
        return groups
    }

    @ViewBuilder
    private func dossierField(_ field: FieldDescriptor) -> some View {
        fieldRowWithResolutionActions(field)
            .frame(minHeight: isInteractive(field) ? FieldGuideTokens.touchTarget : 34)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func fieldRowWithResolutionActions(_ field: FieldDescriptor) -> some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            HStack(spacing: FieldGuideTokens.Space.xs) {
                fieldRow(field)
                DerivedValueStatus(raw: row.raw, field: field.key)
            }
            DerivedProvenanceCaption(
                raw: row.raw, field: field.key,
                includeInherited: row.raw["fieldResolutions"]?[field.key] == nil)
        }
        .frame(minHeight: isInteractive(field) ? FieldGuideTokens.touchTarget : listRowMinimumHeight)
        .contextMenu {
            resolutionActions(field)
        }
    }

    private var listRowMinimumHeight: CGFloat {
        #if os(iOS)
            30
        #else
            20
        #endif
    }

    @ViewBuilder
    private func resolutionActions(_ field: FieldDescriptor) -> some View {
        if field.applicabilityRefusal(in: row.raw) == nil,
            let resolved = FieldResolutionPresentation(raw: row.raw, field: field),
            descriptor.key.nativeActions.contains(.update)
        {
            ForEach(resolved.actions(field: field)) { action in
                Button(action.kind == .confirm ? "Set here" : action.label) {
                    resolutionReview = ResolutionActionRequest(field: field.key, kind: action.kind)
                }
                .accessibilityIdentifier(
                    "detail.\(descriptor.key.rawValue).\(field.key).resolution.\(action.kind.rawValue)"
                )
            }
        }
    }

    private func isInteractive(_ field: FieldDescriptor) -> Bool {
        guard field.displayApplicabilityRefusal(in: row.raw) == nil else { return false }
        return field.reference != nil || field.detailRenderer == .recipeSource
            || field.format == "external-link"
            || FieldResolutionPresentation(raw: row.raw, field: field)?.isInherited == true
    }

    private func isWide(_ field: FieldDescriptor) -> Bool {
        field.reference?.multiple == true || field.itemsPath != nil || field.controlKind == .textarea
            || field.detailRenderer == .expenseSpendingCategory
            || field.detailRenderer == .spendingCategorySummary
            || field.detailRenderer == .recipeSource
    }

    @ViewBuilder
    private func macWideField(_ field: FieldDescriptor) -> some View {
        if field.displayApplicabilityRefusal(in: row.raw) != nil {
            fieldRowWithResolutionActions(field)
        } else if field.controlKind == .textarea,
            let value = EntityFieldValue.text(in: row.raw, field: field, surface: "detail")
        {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                FieldExplanationLabel(
                    field: field, subject: EntityRef(entity: descriptor.key, id: row.id)
                )
                .font(.caption)
                DerivedValueStatus(raw: row.raw, field: field.key)
                DerivedProvenanceCaption(
                    raw: row.raw, field: field.key,
                    includeInherited: row.raw["fieldResolutions"]?[field.key] == nil)
                Text(value).font(.body).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let resolved = FieldResolutionPresentation(raw: row.raw, field: field),
                    resolved.isInherited
                {
                    EntityFieldResolutionLabel(resolved: resolved, field: field)
                }
            }
            .contextMenu { resolutionActions(field) }
        } else {
            fieldRowWithResolutionActions(field)
        }
    }

    @ViewBuilder
    private func macGridValue(_ field: FieldDescriptor) -> some View {
        if let reason = field.displayApplicabilityRefusal(in: row.raw) {
            inapplicableValue(field, reason: reason)
        } else if let reference = EntityFieldValue.reference(in: row.raw, field: field) {
            VStack(alignment: .leading, spacing: 2) {
                NavigationLink(value: Route.entityDetail(reference.entity, id: reference.id)) {
                    Text(reference.name ?? reference.id).foregroundStyle(.tint)
                }
                .buttonStyle(.plain)
                if let resolved = FieldResolutionPresentation(raw: row.raw, field: field),
                    resolved.isInherited
                {
                    EntityFieldResolutionLabel(resolved: resolved, field: field)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contextMenu { resolutionActions(field) }
        } else if let value = displayText(field) {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                HStack(spacing: 6) {
                    if let url = externalURL(field, value: value) {
                        Link(value, destination: url).foregroundStyle(.tint)
                    } else if let option = EntityFieldValue.option(
                        in: row.raw, field: field, surface: "detail"),
                        let chip = StatusChip(text: value, option: option)
                    {
                        chip.textSelection(.enabled)
                    } else if let date = EntityFieldValue.dateValue(
                        in: row.raw, field: field, surface: "detail")
                    {
                        DateDisplay(date)
                    } else {
                        Text(value)
                            .font(field.kind == .identifier ? .fieldGuideCode : .subheadline)
                            .textSelection(.enabled)
                    }
                }
                if let resolved = FieldResolutionPresentation(raw: row.raw, field: field),
                    resolved.isInherited
                {
                    EntityFieldResolutionLabel(resolved: resolved, field: field)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contextMenu { resolutionActions(field) }
        }
    }

    private func inapplicableValue(_ field: FieldDescriptor, reason: String) -> some View {
        Text("—").foregroundStyle(.tertiary)
            .help(reason)
            .focusable()
            .accessibilityLabel("\(field.label): Not applicable. \(reason)")
    }

    private func displayText(_ field: FieldDescriptor) -> String? {
        let value =
            FieldResolutionPresentation.allocatedReferenceLabel(in: row.raw, field: field)
            ?? EntityFieldValue.text(in: row.raw, field: field, surface: "detail")
        if summary, value == nil,
            FieldResolutionPresentation.readValue(in: row.raw, field: field, surface: "detail") == .null
        {
            return "Unknown"
        }
        guard let value else { return nil }
        return value.trimmingCharacters(in: .whitespacesAndNewlines)
            .localizedCaseInsensitiveCompare("Not recorded") == .orderedSame ? nil : value
    }

    private func externalURL(_ field: FieldDescriptor, value: String) -> URL? {
        guard field.format == "external-link", let url = URL(string: value),
            ["http", "https"].contains(url.scheme?.lowercased() ?? "")
        else { return nil }
        return url
    }

    private var rows: [FieldDescriptor] {
        keys.compactMap { key in
            // The hero is the title's and the id's home; repeating them here is a form, not a record.
            guard let field = descriptor.field(key), key != descriptor.titleField, key != "id" else {
                return nil
            }
            if field.displayApplicabilityRefusal(in: row.raw) != nil { return field }
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
            guard displayText(field) != nil else { return nil }
            return field
        }
    }

    @ViewBuilder
    private func fieldRow(_ field: FieldDescriptor) -> some View {
        if let reason = field.displayApplicabilityRefusal(in: row.raw) {
            LabeledContent(field.label) { inapplicableValue(field, reason: reason) }
        } else if field.reference?.multiple == true {
            RecordReferenceList(
                field: field, row: row, subject: EntityRef(entity: descriptor.key, id: row.id))
        } else if field.itemsPath != nil {
            DetailDisplayRows(label: field.label, rows: field.detailItems(in: row.raw))
        } else if field.detailRenderer?.rawValue == "product-external-ids" {
            let identifiers = IdentifierPresentation.grouped(
                field.surfaceValue(in: row.raw, surface: "detail") ?? .null)
            ForEach(Array(identifiers.enumerated()), id: \.offset) { _, identifier in
                if let url = identifier.url {
                    Link(identifier.text, destination: url)
                        .font(.fieldGuideBody).fixedSize(horizontal: false, vertical: true)
                        .frame(minHeight: FieldGuideTokens.touchTarget)
                } else {
                    Text(identifier.text).font(.fieldGuideBody).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        } else if field.detailRenderer == .spendingCategorySummary {
            if let value = row.raw[field.key],
                let summary = try? value.decoded(SpendingCategorySummary.self)
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
        } else if let items = EntityFieldValue.resolvedItems(in: row.raw, field: field, surface: "detail") {
            ResolvedListRows(
                field: field, subject: EntityRef(entity: descriptor.key, id: row.id), items: items)
        } else if let reference = EntityFieldValue.reference(in: row.raw, field: field) {
            let value = reference.name ?? reference.id
            LabeledContent {
                VStack(alignment: .trailing, spacing: FieldGuideTokens.Space.xs) {
                    NavigationLink(value: Route.entityDetail(reference.entity, id: reference.id)) {
                        HStack(spacing: FieldGuideTokens.Space.xs) {
                            if let emoji = reference.emoji { Text(emoji).accessibilityHidden(true) }
                            Text(value).multilineTextAlignment(.trailing)
                        }
                        .foregroundStyle(.tint)
                    }
                    .buttonStyle(.plain)
                    if let resolved = FieldResolutionPresentation(raw: row.raw, field: field),
                        resolved.isInherited
                    {
                        EntityFieldResolutionLabel(resolved: resolved, field: field)
                    }
                }
            } label: {
                FieldExplanationLabel(
                    field: field,
                    subject: EntityRef(entity: descriptor.key, id: row.id))
            }
        } else if let value = displayText(field) {
            LabeledContent {
                VStack(alignment: .trailing, spacing: FieldGuideTokens.Space.xs) {
                    HStack(alignment: .firstTextBaseline, spacing: FieldGuideTokens.Space.xs) {
                        if let url = externalURL(field, value: value) {
                            Link(value, destination: url)
                                .foregroundStyle(.tint)
                                .multilineTextAlignment(.trailing)
                        } else if let option = EntityFieldValue.option(
                            in: row.raw, field: field, surface: "detail"),
                            let chip = StatusChip(text: value, option: option)
                        {
                            chip.textSelection(.enabled)
                        } else if let date = EntityFieldValue.dateValue(
                            in: row.raw, field: field, surface: "detail")
                        {
                            DateDisplay(date, compact: true)
                                .textSelection(.enabled)
                                .multilineTextAlignment(.trailing)
                                .foregroundStyle(.secondary)
                        } else {
                            Text(value)
                                .font(
                                    field.kind == .identifier
                                        ? .fieldGuideCode
                                        : field.controlKind == .textarea ? .body : .subheadline
                                )
                                .textSelection(.enabled)
                                .multilineTextAlignment(.trailing)
                                .foregroundStyle(.secondary)
                        }
                    }
                    if let resolved = FieldResolutionPresentation(raw: row.raw, field: field),
                        resolved.isInherited
                    {
                        EntityFieldResolutionLabel(resolved: resolved, field: field)
                    }
                }
                // The marker reads as part of the value, not as a separate VoiceOver stop.
                .accessibilityElement(children: .combine)
            } label: {
                FieldExplanationLabel(
                    field: field,
                    subject: EntityRef(entity: descriptor.key, id: row.id))
            }
        }
    }

    private func isInherited(_ field: FieldDescriptor) -> Bool {
        FieldResolutionPresentation(raw: row.raw, field: field)?.isInherited ?? false
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
    var emptyLabel = false
    var surface = "detail"
    var iconOnly = false
    @Environment(AppModel.self) private var appModel
    @State private var showingExplanation = false
    @State private var resolved: FieldExplanationOutput?
    @State private var loadError: String?

    var body: some View {
        Text(iconOnly ? "" : (labelOverride ?? field.label))
            .foregroundStyle(emptyLabel ? .secondary : .primary)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier(
                "field.explanation.\(subject.entity.rawValue).\(subject.id).\(field.key)"
            )
            .accessibilityAction(named: Text("Explain")) { presentExplanation() }
            .contextMenu {
                if field.explanation != nil {
                    #if os(macOS)
                        Button("Explain “\(field.label)”") { presentExplanation() }
                    #else
                        Button("Explain") { presentExplanation() }
                    #endif
                }
            }
            #if os(macOS)
                .help(field.explanation?.description ?? field.label)
            #endif
            .onChange(of: subject) { _, _ in
                showingExplanation = false
                resolved = nil
                loadError = nil
            }
            .popover(isPresented: $showingExplanation) {
                explanationPopover()
                    .task(id: showingExplanation) { await loadExplanation() }
            }
    }

    private func presentExplanation() {
        guard field.explanation != nil else { return }
        resolved = nil
        loadError = nil
        showingExplanation = true
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
                    Text("Not assessed").font(.headline)
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
                    if let derived = resolved.derived {
                        DerivedExplanationSummary(explanation: derived, field: field)
                        Divider()
                    }
                    explanationSectionLabel("What this means")
                    if let interpretation = resolved.interpretation {
                        if resolved.resolution == nil {
                            Text(interpretation.result).font(.headline)
                        }
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
                    } else if resolved.resolution == nil, let value = try? JSONValue(encoding: resolved.value)
                    {
                        if let code = value.stringValue,
                            let option = field.valueOptions?.first(where: { $0.value == code })
                        {
                            Text(option.label).font(.headline)
                        } else {
                            ExplanationEvidenceValue(value: value)
                        }
                    }
                    if let resolution = resolved.resolution {
                        let hasFallback = display(resolution.fallbackValue) != nil
                        let state = FieldResolutionState(
                            resolution, hasFallback: hasFallback,
                            intentional: field.resolution?.redundancy == "intentional")
                        HStack(alignment: .firstTextBaseline, spacing: FieldGuideTokens.Space.sm) {
                            Text(
                                resolutionValueLabel(resolved)
                            )
                            .font(.fieldGuideData.weight(.semibold))
                            .accessibilityIdentifier("field.explanation.effective-value")
                            Spacer(minLength: FieldGuideTokens.Space.sm)
                            Label(
                                state.label,
                                systemImage: state.systemImage
                            )
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
                                if let source = resolved.resolutionEvidence.valueIfPresent??.fallbackSource,
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
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Evaluated:")
                        DateDisplay(date: resolved.evaluatedAt)
                    }.font(.caption).foregroundStyle(.secondary)
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
                    if case .value(.some(let evidence)) = resolved.resolutionEvidence {
                        Divider()
                        explanationSectionLabel(evidence.chain.title ?? "Resolution order")
                        explanationCoverage(evidence.coverage, noun: "evaluation rows")
                        explanationCoverage(evidence.branches, noun: "inventory entries")
                        resolutionSteps(evidence.chain)
                            .accessibilityIdentifier("field.explanation.chain")
                        if let contributors = evidence.contributors, !contributors.isEmpty {
                            if !evidence.chain.rows.isEmpty || !evidence.chain.empty.isEmpty {
                                explanationSectionLabel("Contributing records")
                            }
                            ForEach(Array(contributors.prefix(6).enumerated()), id: \.offset) {
                                _, contributor in
                                resolutionContributor(
                                    contributor.chain, steps: contributor.steps,
                                    coverage: contributor.coverage)
                            }
                            if contributors.count > 6 {
                                DisclosureGroup("Show \(contributors.count - 6) more contributors") {
                                    ForEach(Array(contributors.dropFirst(6).enumerated()), id: \.offset) {
                                        _, contributor in
                                        resolutionContributor(
                                            contributor.chain, steps: contributor.steps,
                                            coverage: contributor.coverage)
                                    }
                                }
                            }
                        }
                    }
                    if let steps = resolved.resolutionEvidence.valueIfPresent??.steps, !steps.isEmpty {
                        DisclosureGroup("Inputs and source settings") {
                            ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                                ForEach(Array(step.observed.enumerated()), id: \.offset) { _, observation in
                                    explanationSource(observation)
                                }
                                explanationCoverage(step.coverage, noun: "inputs")
                            }
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
            if let reference = source.entity, let entity = EntityKey(rawValue: reference.entityKind.rawValue)
            {
                ForEach(source.fields ?? [], id: \.self) { key in
                    if let sourceField = EntityCatalog[entity].field(key) {
                        FieldExplanationLabel(
                            field: sourceField, subject: EntityRef(entity: entity, id: reference.entityId))
                    }
                }
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

    private func resolutionOutcomeLabel(_ explanation: FieldExplanationOutput) -> String? {
        switch explanation.resolutionEvidence.valueIfPresent??.outcome?.rawValue {
        case "mixed": "Mixed"
        case "unset": field.resolution?.labels?.unresolved ?? "Not set"
        case "blocked": "Blocked"
        default: nil
        }
    }

    private func resolutionValueLabel(_ explanation: FieldExplanationOutput) -> String {
        guard let resolution = explanation.resolution else { return "Not set" }
        if explanation.resolutionEvidence.valueIfPresent??.outcome?.rawValue == "mixed" { return "Mixed" }
        if resolution.mode == .allocated, display(resolution.value) == nil,
            explanation.resolutionEvidence.valueIfPresent??.outcome?.rawValue == "resolved"
        {
            return "Allocated"
        }
        return display(resolution.value)
            ?? resolutionOutcomeLabel(explanation)
            ?? FieldResolutionPresentation.emptyLabel(resolution, field: field)
    }

    @ViewBuilder
    private func resolutionSteps(_ block: ReportRecordsBlock) -> some View {
        if !block.rows.isEmpty || !block.empty.isEmpty {
            let first = resolutionBlock(block, rows: 0..<min(6, block.rows.count))
            RecordsBlockView(records: ReportPresentation.records(first), host: nil)
            if block.rows.count > 6 {
                DisclosureGroup("Show \(block.rows.count - 6) more resolution steps") {
                    RecordsBlockView(
                        records: ReportPresentation.records(
                            resolutionBlock(block, rows: 6..<block.rows.count)),
                        host: nil)
                }
            }
        }
    }

    private func resolutionBlock(_ block: ReportRecordsBlock, rows: Range<Int>) -> ReportRecordsBlock {
        var result = block
        result.title = nil
        if rows.lowerBound > 0 { result.footer = nil }
        result.rows = Array(block.rows[rows])
        return result
    }

    @ViewBuilder
    private func explanationCoverage(_ coverage: FieldEvidenceCoverage?, noun: String) -> some View {
        if let coverage, coverage.omitted > 0 {
            Text("Showing \(coverage.shown) of \(coverage.total) \(noun).")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func resolutionContributor(
        _ block: ReportRecordsBlock, steps: [FieldDecisionStep]? = nil, coverage: FieldEvidenceCoverage? = nil
    )
        -> some View
    {
        DisclosureGroup {
            resolutionSteps(block)
            explanationCoverage(coverage, noun: "evaluation rows")
            if let steps, !steps.isEmpty {
                DisclosureGroup("Inputs and source settings") {
                    ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                        ForEach(Array(step.observed.enumerated()), id: \.offset) { _, observation in
                            explanationSource(observation)
                        }
                        explanationCoverage(step.coverage, noun: "inputs")
                    }
                }
            }
        } label: {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                Text(block.title ?? block.rows.first?.title ?? "Contributor")
                    .font(.callout.weight(.medium))
                if let trailing = block.rows.first?.trailing {
                    Text(trailing).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func display(_ value: JSONValue) -> String? {
        displayJSON(value)
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
struct ExplanationEvidenceValue: View {
    let value: JSONValue
    var property: String? = nil
    var hidesByteIdentity = false

    var body: some View { content(value) }

    private func content(_ value: JSONValue) -> AnyView {
        switch value {
        case .null: return AnyView(Text("None").foregroundStyle(.secondary))
        case .bool(let value): return AnyView(Text(value ? "Yes" : "No"))
        case .number(let value):
            return AnyView(
                Text(property == "amount" ? value.usd : value.formatted())
                    .monospacedDigit())
        case .string(let value):
            if let entity = EntityCatalog.descriptor(forShortcode: value) {
                return AnyView(NavigationLink(value, value: Route.entityDetail(entity.key, id: value)))
            }
            if let url = URL(string: value), ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                return AnyView(Link(value, destination: url))
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
                        values.keys.filter {
                            (!hidesByteIdentity || $0 != "contentHash")
                                && (entity == nil || ($0 != "id" && $0 != "name"))
                        }.sorted(),
                        id: \.self
                    ) { key in
                        if let item = values[key] {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(FieldKeyWords.spaced(key).capitalized)
                                    .font(.caption).foregroundStyle(.secondary)
                                ExplanationEvidenceValue(value: item, property: key).font(.callout)
                            }
                        }
                    }
                })
        }
    }

}

#Preview("Verified member evidence") {
    NavigationStack {
        ExplanationEvidenceValue(
            value: .object([
                "imageId": .string("IMG-4K7M"),
                "sourceAssetUrl": .string("https://maker.example.test/blue.jpg"),
                "contentHash": .string(String(repeating: "a", count: 64)),
            ]), hidesByteIdentity: true
        )
        .padding()
    }
}

// MARK: - Relation

/// A `relation` section: the target's filtered rows as links, capped at the declared `limit`
/// with "See all" opening the target's list under the same filter. Creation lives in the detail menu.
struct RelationSectionView: View {
    let model: RelationSectionModel
    let row: EntityRow
    var macLayout = false

    @Environment(AppModel.self) private var appModel
    @State private var context: [String: RelationFinancialEvidence] = [:]
    @State private var contextError: String?
    @State private var contextRevision = 0

    private struct RelationFinancialEvidence {
        let movementKinds: [String]
        let hasPlanned: Bool
        let hasLink: Bool
    }

    private var hasFinancialContext: Bool {
        (model.source.key == .product && model.target.key == .purchase)
            || (model.source.key == .purchase && model.target.key == .product)
    }

    var body: some View {
        Group {
            if macLayout {
                VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
                    let fields = FieldsSectionView(
                        descriptor: model.source, row: row, keys: model.spec.contextFields,
                        macGrid: true)
                    if fields.hasVisibleRows { fields }
                    content
                }
            } else {
                Section {
                    let fields = FieldsSectionView(
                        descriptor: model.source, row: row, keys: model.spec.contextFields)
                    if fields.hasVisibleRows { fields }
                    content
                } header: {
                    Text(model.section.title ?? model.target.plural).detailContentsHeader(empty: false)
                }
            }
        }
        .task(id: "\(model.source.key.rawValue):\(model.recordID):\(model.id)") {
            await model.list.loadInitial()
            await model.loadConnectionEvidence()
        }
        .task(
            id:
                "\(model.source.key.rawValue):\(model.recordID):\(contextRevision):\(model.list.rows.map(\.id).joined(separator: ","))"
        ) {
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
            let ids = model.list.rows.map(\.id)
            for start in stride(from: 0, to: ids.count, by: 50) {
                let page = try await appModel.client.relationRows(
                    source: EntityRef(entity: model.source.key, id: model.recordID),
                    relation: model.spec.relation,
                    targetIDs: Array(ids[start..<min(start + 50, ids.count)]))
                guard let rows = page["items"]?.arrayValue else {
                    throw DecodingError.dataCorrupted(
                        .init(
                            codingPath: [], debugDescription: "Relation page is missing items: \(page)"))
                }
                guard page["totalCount"]?.doubleValue == Double(rows.count) else {
                    throw DecodingError.dataCorrupted(
                        .init(
                            codingPath: [], debugDescription: "Incomplete targeted relation page: \(page)"))
                }
                for row in rows {
                    guard let id = row["productId"]?.stringValue ?? row["purchaseId"]?.stringValue,
                        let kinds = row["movementKinds"]?.arrayValue,
                        kinds.allSatisfy({ $0.stringValue != nil }),
                        let planned = row["hasPlanned"]?.boolValue,
                        let source = row["source"]?.stringValue,
                        ["expense", "link", "both"].contains(source)
                    else {
                        throw DecodingError.dataCorrupted(
                            .init(
                                codingPath: [], debugDescription: "Invalid relation movement row: \(row)"))
                    }
                    evidence[id] = RelationFinancialEvidence(
                        movementKinds: kinds.compactMap(\.stringValue), hasPlanned: planned,
                        hasLink: source == "link" || source == "both")
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
            ForEach(evidence.movementKinds, id: \.self) { kind in
                StatusChip(text: "Movement · \(kind.capitalized)")
                    .accessibilityIdentifier(
                        "relation.evidence.\(model.target.key.rawValue).\(rowID).movement.\(kind)")
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
            if list.rows.isEmpty {
                Text(model.spec.empty ?? "No items").foregroundStyle(.secondary)
                    .preference(key: DetailSectionEmpty.self, value: true)
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

/// The journal variant's leading section: the first relation's rows as entry cards, newest first.
struct EntityJournalSectionView: View {
    let model: RelationSectionModel
    var macLayout = false

    var body: some View {
        Group {
            if macLayout {
                journalContent
            } else {
                Section {
                    journalContent
                } header: {
                    Text(model.section.title ?? "Journal").detailContentsHeader(empty: false)
                }
            }
        }
        .task {
            await model.list.loadInitial()
            await model.loadConnectionEvidence()
        }
    }

    @ViewBuilder
    private var journalContent: some View {
        let list = model.list
        switch list.phase {
        case .idle, .loading:
            LoadingIndicator(label: "Loading journal")
        case .unavailable(let message), .failed(let message):
            InlineLoadFailure(message: message) { await list.loadInitial() }
        case .loaded:
            ForEach(list.rows) { row in
                VStack(alignment: .leading, spacing: 5) {
                    EntityJournalEntryRow(descriptor: model.target, row: row, columns: model.spec.columns)
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
                .frame(minHeight: FieldGuideTokens.touchTarget, alignment: .leading)
                .disabled(list.activity != .idle)
            }
        }
    }
}

/// One journal entry: title, observed day, kind chip, note, and the entry's image strip.
struct EntityJournalEntryRow: View {
    let descriptor: EntityDescriptor
    let row: EntityRow
    var columns: [String]? = nil

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
                EntityRowView(key: descriptor.key, row: row, columns: columns)
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

// MARK: - Raw record

struct RawRecordDisclosure: View {
    let raw: JSONValue

    var body: some View {
        Panel(padding: FieldGuideTokens.Space.md) {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
                Eyebrow("Raw record")
                Text(prettyJSON)
                    .font(.fieldGuideCode)
                    .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, FieldGuideTokens.Space.sm)
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
/// A `resolvedList` value on a detail page (a Product's owners): each item opens the record it
/// names, and an item that is only inherited carries the shared marker.
private struct ResolvedListRows: View {
    let field: FieldDescriptor
    let subject: EntityRef
    let items: [EntityFieldValue.ResolvedItem]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            FieldExplanationLabel(field: field, subject: subject).font(.subheadline)
            if items.isEmpty, let emptyLabel = field.emptyLabel {
                Text(emptyLabel).foregroundStyle(.secondary)
            }
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                if let reference = item.reference {
                    NavigationLink(value: Route.entityDetail(reference.entity, id: reference.id)) {
                        HStack(spacing: FieldGuideTokens.Space.xs) {
                            label(item)
                            Image(systemName: "chevron.right").font(.caption).accessibilityHidden(true)
                        }
                        .frame(minHeight: FieldGuideTokens.touchTarget, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                } else {
                    label(item).frame(minHeight: FieldGuideTokens.touchTarget, alignment: .leading)
                }
            }
        }
    }

    private func label(_ item: EntityFieldValue.ResolvedItem) -> some View {
        HStack(spacing: FieldGuideTokens.Space.xs) {
            Text(item.label).fixedSize(horizontal: false, vertical: true)
                .foregroundStyle(
                    item.inherited ? FieldGuideTokens.graphiteSecondary : FieldGuideTokens.graphite)
            if item.inherited { InheritedMarker() }
        }
        .accessibilityElement(children: .combine)
    }
}

private struct RecordReferenceList: View {
    let field: FieldDescriptor
    let row: EntityRow
    let subject: EntityRef
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
                result.set([value], for: name)
            }
        }
        return result
    }
    var body: some View {
        if let target {
            VStack(alignment: .leading, spacing: 0) {
                FieldExplanationLabel(field: field, subject: subject).font(.subheadline)
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
                                    .fixedSize(horizontal: false, vertical: true)
                                Image(systemName: "chevron.right").font(.caption).accessibilityHidden(true)
                            }
                            .frame(minHeight: FieldGuideTokens.touchTarget, alignment: .leading)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                if let limit = field.referencePreviewLimit, items.count > limit {
                    Button {
                        expanded.toggle()
                    } label: {
                        Text(expanded ? "Show less" : "+\(items.count - limit) more")
                            .frame(minHeight: FieldGuideTokens.touchTarget)
                    }
                    .buttonStyle(.plain)
                }
                if !filters.isEmpty {
                    NavigationLink(value: Route.entityList(target, filters: filters)) {
                        Label("View all", systemImage: "chevron.right")
                            .frame(minHeight: FieldGuideTokens.touchTarget)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

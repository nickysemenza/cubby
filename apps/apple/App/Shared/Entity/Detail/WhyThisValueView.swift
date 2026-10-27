import CubbyKit
import SwiftUI

// MARK: - Value marks

/// The envelope's refresh state beside a value: a pulsing dot while work is queued or the cached
/// result is stale, the raw refresh error, and a visible diagnostic for an unknown state.
struct FieldValueStatus: View {
    let raw: JSONValue
    /// `nil` summarizes every envelope the row carries.
    var field: FieldDescriptor? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static func envelopes(in raw: JSONValue, field: FieldDescriptor? = nil) -> [FieldEnvelope] {
        if let field { return FieldEnvelope.of(raw, field: field).map { [$0] } ?? [] }
        return raw["fields"]?.objectValue?.values.compactMap(FieldEnvelope.init) ?? []
    }

    static func isUpdating(in raw: JSONValue, field: FieldDescriptor? = nil) -> Bool {
        envelopes(in: raw, field: field).contains(where: \.isUpdating)
    }

    var body: some View {
        let envelopes = Self.envelopes(in: raw, field: field)
        if envelopes.contains(where: \.isUpdating) {
            Image(systemName: "circle.fill")
                .font(.system(size: 6))
                .foregroundStyle(FieldGuideTokens.info)
                .symbolEffect(.pulse, options: .repeating, isActive: !reduceMotion)
                .accessibilityLabel("Updating")
                .help("Updating")
        }
        if let failure = envelopes.lazy.compactMap(\.failure).first {
            Image(systemName: "exclamationmark.circle")
                .font(.caption)
                .foregroundStyle(FieldGuideTokens.destructive)
                .help(failure)
                .accessibilityLabel("Refresh failed: \(failure)")
        }
        let unsupported = envelopes.flatMap(\.unsupportedKinds)
        if !unsupported.isEmpty {
            Image(systemName: "questionmark.diamond")
                .font(.caption)
                .foregroundStyle(FieldGuideTokens.warning)
                .help("Unsupported field state: \(unsupported.joined(separator: ", "))")
                .accessibilityLabel("Unsupported field state: \(unsupported.joined(separator: ", "))")
        }
    }
}

/// Where the shown value came from, per the result's own provenance: an automatic own value, or
/// the inherited/default source as a link when the server names one.
struct FieldProvenanceCaption: View {
    let raw: JSONValue
    let field: FieldDescriptor

    var body: some View {
        if let envelope = FieldEnvelope.of(raw, field: field) {
            if envelope.isAutomatic {
                Text("Automatic").font(.caption).foregroundStyle(.secondary)
            } else {
                switch envelope.decision?.provenance {
                case .inherited(let source)?:
                    sourceLine("Inherited from", source: source)
                case .default(let source)?:
                    if let source {
                        sourceLine("Default from", source: source)
                    } else {
                        Text("Default").font(.caption).foregroundStyle(.secondary)
                    }
                default:
                    EmptyView()
                }
            }
        }
    }

    private func sourceLine(_ prefix: String, source: FieldEnvelope.Source) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 3) {
            Text(prefix).foregroundStyle(.secondary)
            if let entity = source.entity {
                NavigationLink(value: Route.entityDetail(entity, id: source.entityID)) {
                    Text(source.name ?? source.entityID).foregroundStyle(.tint)
                }
                .buttonStyle(.plain)
            } else {
                Text(source.name ?? source.entityID).foregroundStyle(.secondary)
            }
        }
        .font(.caption)
    }
}

// MARK: - Presenter

extension EnvironmentValues {
    @Entry var fieldExplanationListFilters = EntityFilterState()
}

/// One row menu owns Explain and the assignment actions; a parent menu masks a nested label's
/// context menu on iOS. Explain opens the one Why this value surface.
struct FieldExplanationPresenter: ViewModifier {
    let field: FieldDescriptor
    let subject: EntityRef
    var surface = "detail"
    var menuActions: AnyView? = nil
    /// The editor already owns staging; its explanation is read-only.
    var allowsActions = true
    @Environment(\.fieldExplanationListFilters) private var listFilters
    @State private var showingExplanation = false

    /// Only an unambiguous declared list scope can explain a contextual value.
    private var explanationScope: EntityRef? {
        guard surface == "list", let bindings = field.explanation?.scopeFilters else { return nil }
        let candidates = bindings.flatMap { entity, filter -> [EntityRef] in
            guard let key = EntityKey(rawValue: entity) else { return [] }
            return (listFilters[filter] ?? []).map { EntityRef(entity: key, id: $0) }
        }
        return candidates.count == 1 ? candidates.first : nil
    }

    func body(content: Content) -> some View {
        content
            .accessibilityAction(named: Text("Explain")) { presentExplanation() }
            .contextMenu {
                if field.explanation != nil {
                    #if os(macOS)
                        Button("Explain “\(field.label)”") { presentExplanation() }
                    #else
                        Button("Explain") { presentExplanation() }
                    #endif
                }
                menuActions
            }
            .onChange(of: subject) { _, _ in showingExplanation = false }
            .onChange(of: explanationScope) { _, _ in showingExplanation = false }
            .popover(isPresented: $showingExplanation) {
                NavigationStack {
                    WhyThisValueView(
                        field: field, subject: subject, surface: surface,
                        scope: explanationScope, allowsActions: allowsActions
                    ) {
                        showingExplanation = false
                    }
                    .id(subject.stableKey + field.key + (explanationScope?.stableKey ?? ""))
                    .navigationDestination(for: Route.self) { RouteDestinationView(route: $0) }
                }
            }
    }

    private func presentExplanation() {
        guard field.explanation != nil else { return }
        showingExplanation = true
    }
}

// MARK: - Why this value

/// The unified explanation (web `WhyValueContents`): the effective result, the record's own
/// choice and the actions its current controls allow, the source stack, interpretation, quality
/// checks and technical details. Actions open the ordinary editor with the declared patch
/// staged; Save remains the only write, and the editor re-reads the record first.
struct WhyThisValueView: View {
    let field: FieldDescriptor
    let subject: EntityRef
    var surface = "detail"
    var scope: EntityRef? = nil
    var allowsActions = true
    let onClose: () -> Void

    @Environment(AppModel.self) private var appModel
    @State private var resolved: FieldExplanationOutput?
    @State private var loadError: String?
    @State private var editor: EditorRequest?

    private struct EditorRequest: Identifiable, Hashable {
        let action: ResolutionActionRequest?
        var id: String { action?.id ?? "set" }
    }

    private var notAssessed: Bool { field.key == "dataQuality" && field.readKey == nil }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
                header
                if notAssessed {
                    notAssessedContent
                } else if let resolved {
                    content(resolved)
                } else if let loadError {
                    Text(loadError).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                    Button("Retry explanation") { Task { await load() } }
                        .frame(minHeight: FieldGuideTokens.touchTarget)
                } else {
                    ProgressView().controlSize(.small)
                        .accessibilityLabel("Loading explanation")
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
        .task { await load() }
        .sheet(item: $editor) { request in
            EntityEditorSheet(
                key: subject.entity, mode: .update(id: subject.id), resolutionAction: request.action,
                onSaved: { _ in
                    appModel.recordEntityMutation(keys: [subject.entity])
                    reload()
                })
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("Why this value · \(resolved?.label ?? field.label)").font(.headline)
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .frame(minWidth: FieldGuideTokens.touchTarget, minHeight: FieldGuideTokens.touchTarget)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.cancelAction)
            .accessibilityLabel("Close field explanation")
            .accessibilityIdentifier("field.explanation.close")
        }
    }

    // MARK: Content

    @ViewBuilder
    private func content(_ explanation: FieldExplanationOutput) -> some View {
        let envelope = (try? JSONValue(encoding: explanation.envelope)).flatMap(FieldEnvelope.init)
        if let envelope {
            effectiveResult(envelope)
            choice(envelope)
            if case .cached = envelope.result {
                Text(
                    "Sources below describe current inputs. The cached result keeps its recorded provenance until it is recalculated."
                )
                .font(.caption).foregroundStyle(.secondary)
            }
        } else {
            Text("Unsupported field state").font(.headline).foregroundStyle(FieldGuideTokens.warning)
            ExplanationEvidenceValue(value: (try? JSONValue(encoding: explanation.envelope)) ?? .null)
        }
        if let interpretation = explanation.interpretation {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                if !hasEvidence(explanation) {
                    Text(interpretation.result).font(.callout.weight(.semibold))
                }
                Text(interpretation.summary).font(.callout)
                if explanation.qualityBreakdown == nil {
                    ForEach(interpretation.caveats, id: \.self) { caveat in
                        Text(caveat).font(.caption).foregroundStyle(.secondary)
                    }
                    ForEach(interpretation.nextSteps, id: \.self) { step in
                        Text(step).font(.caption)
                    }
                }
            }
            .fixedSize(horizontal: false, vertical: true)
        }
        if case .value(.some(let evidence)) = explanation.resolutionEvidence {
            Divider()
            sectionLabel("Current source evidence")
            coverage(evidence.coverage, noun: "evaluation rows")
            coverage(evidence.branches, noun: "inventory entries")
            chain(evidence.chain, steps: evidence.steps)
                .accessibilityIdentifier("field.explanation.chain")
            inputs(evidence.steps)
            if let contributors = evidence.contributors, !contributors.isEmpty {
                if !evidence.chain.rows.isEmpty || !evidence.chain.empty.isEmpty {
                    sectionLabel("Contributing records")
                }
                ForEach(Array(contributors.prefix(6).enumerated()), id: \.offset) { _, contributor in
                    contributorView(
                        contributor.chain, steps: contributor.steps, coverage: contributor.coverage)
                }
                if contributors.count > 6 {
                    DisclosureGroup("Show \(contributors.count - 6) more contributors") {
                        ForEach(Array(contributors.dropFirst(6).enumerated()), id: \.offset) {
                            _, contributor in
                            contributorView(
                                contributor.chain, steps: contributor.steps, coverage: contributor.coverage)
                        }
                    }
                }
            }
        }
        if !explanation.sources.isEmpty {
            Divider()
            sectionLabel("Sources")
            let levels = SourceStack.levels(sources: explanation.sources, envelope: envelope)
            SourceStackView(label: "Value sources", levels: Array(levels.prefix(6))) { level in
                sourceContent(explanation.sources[level.index])
            }
            if levels.count > 6 {
                DisclosureGroup("Show \(levels.count - 6) more sources") {
                    SourceStackView(label: "More value sources", levels: Array(levels.dropFirst(6))) {
                        level in
                        sourceContent(explanation.sources[level.index])
                    }
                }
            }
        }
        if let imageChain = explanation.imageChain {
            Divider()
            sectionLabel("Display image sources")
            DisplayImageChainStack(chain: imageChain)
        }
        if let breakdown = explanation.qualityBreakdown {
            qualityBreakdown(breakdown)
        }
        if explanation.truncated {
            Text("Evidence is bounded; the displayed sources are not an exhaustive list.")
                .font(.caption)
                .foregroundStyle(FieldGuideTokens.graphiteSecondary)
        }
        ForEach(Array(explanation.actions.enumerated()), id: \.offset) { _, action in
            if action.kind.rawValue == "editSource" {
                NavigationLink(
                    action.label,
                    value: Route.entityDetail(action.target.entityKind, id: action.target.entityId))
            }
        }
        technicalDetails(explanation, envelope: envelope)
        if let envelope { freshness(envelope, comparison: explanation.comparison) }
    }

    private func effectiveResult(_ envelope: FieldEnvelope) -> some View {
        let state = envelope.state(field: field)
        return VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            sectionLabel("Effective result")
            HStack(alignment: .firstTextBaseline, spacing: FieldGuideTokens.Space.sm) {
                resultText(envelope.result, failure: envelope.failure)
                    .font(.fieldGuideData.weight(.semibold))
                    .accessibilityIdentifier("field.explanation.effective-value")
                Spacer(minLength: FieldGuideTokens.Space.sm)
                Label(state.label, systemImage: state.systemImage)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(
                        state.tone == .redundant || state.tone == .unsupported
                            ? FieldGuideTokens.warning : FieldGuideTokens.graphiteSecondary
                    )
                    .accessibilityIdentifier("field.explanation.state")
            }
            if !envelope.unsupportedKinds.isEmpty {
                Text("Unsupported field state: \(envelope.unsupportedKinds.joined(separator: ", "))")
                    .font(.caption).foregroundStyle(FieldGuideTokens.warning)
            }
        }
    }

    /// The record's own choice (S), kept apart from the effective result (V), and the actions
    /// the current controls allow.
    @ViewBuilder
    private func choice(_ envelope: FieldEnvelope) -> some View {
        let actions =
            allowsActions && subject.entity.nativeActions.contains(.update)
            ? envelope.actions(field: field) : []
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            sectionLabel("Your choice")
            Text(assignmentText(envelope)).font(.callout)
                .accessibilityIdentifier("field.explanation.assignment")
            switch envelope.controls {
            case .readonly(let reason):
                Text(readonlyText(reason)).font(.caption).foregroundStyle(.secondary)
            case .unsupported(let kind):
                Text("Unsupported controls: \(kind)").font(.caption).foregroundStyle(FieldGuideTokens.warning)
            case .editable:
                if envelope.resetIsAvailable { resetPreview(envelope) }
            }
            if allowsActions, subject.entity.nativeActions.contains(.update), envelope.currentIsUnderstood,
                case .editable = envelope.controls
            {
                HStack(spacing: FieldGuideTokens.Space.md) {
                    Button("Set value…") { editor = EditorRequest(action: nil) }
                        .accessibilityIdentifier("field.explanation.action.set")
                    ForEach(actions) { action in
                        Button(action.label) {
                            editor = EditorRequest(
                                action: ResolutionActionRequest(field: field.key, kind: action.kind))
                        }
                        .accessibilityIdentifier("field.explanation.action.\(action.kind.rawValue)")
                    }
                }
                .buttonStyle(.borderless)
                .font(.callout)
                .frame(minHeight: FieldGuideTokens.touchTarget)
            }
        }
    }

    /// Use inherited shows only the server's ready preview; otherwise the value is still updating.
    /// The removed override's value is never presented as the inherited fallback.
    private func resetPreview(_ envelope: FieldEnvelope) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: FieldGuideTokens.Space.xs) {
            Text("With inherited values:").foregroundStyle(.secondary)
            Group {
                if let preview = envelope.resetPreview {
                    resultText(preview, failure: nil)
                } else if case .editable(_, _, .available(.unsupported(let kind))) = envelope.controls {
                    Text("Unsupported preview: \(kind)").foregroundStyle(FieldGuideTokens.warning)
                } else {
                    Text("Updating…").foregroundStyle(.secondary)
                }
            }
            .accessibilityIdentifier("field.explanation.fallback-value")
        }
        .font(.caption)
    }

    private func assignmentText(_ envelope: FieldEnvelope) -> String {
        switch envelope.assignment {
        case nil: return "Nothing stored on this record"
        case .inherit?: return "Follow the source"
        case .explicitNone?: return field.resolution?.labels?.none ?? "None"
        case .value(let value, let ownership)?:
            let text = valueText(value) ?? "Set here"
            switch ownership {
            case .record: return text
            case .automatic(_, let confidence):
                return "\(text) · Automatic, \(Int((confidence * 100).rounded()))% confidence"
            case .unsupported(let kind): return "\(text) · Unsupported ownership: \(kind)"
            }
        case .unsupported(let kind)?: return "Unsupported choice: \(kind)"
        }
    }

    private func readonlyText(_ reason: FieldEnvelope.ReadonlyReason) -> String {
        switch reason {
        case .computed: "Calculated from other records; not set directly."
        case .allocated: "Allocated across contributing records; not set directly."
        case .notAllowed: "Not applicable to this record."
        case .unsupported(let kind): "Unsupported controls: \(kind)"
        }
    }

    @ViewBuilder
    private func resultText(_ result: FieldEnvelope.Result, failure: String?) -> some View {
        if let value = result.value {
            if let text = valueText(value) {
                Text(text).textSelection(.enabled)
            } else {
                ExplanationEvidenceValue(value: value)
            }
        } else {
            Text(FieldEnvelope.label(for: result, field: field, failure: failure))
                .foregroundStyle(.secondary)
        }
    }

    private func valueText(_ value: JSONValue) -> String? {
        if field.reference != nil, let id = value.stringValue { return resolvedSourceName(id) ?? id }
        // Explanation values are field-root values; restore that root so the declaration's
        // display projection applies just as it does in the ordinary detail row.
        if let text = EntityFieldValue.text(
            in: .object([field.key: value]), field: field, surface: surface)
            ?? EntityFieldValue.text(value, field: field)
        {
            return text
        }
        switch value {
        case .bool(let flag): return flag ? "Yes" : "No"
        case .number(let number): return DisplayFormat.number(number)
        case .string(let string): return string
        default: return nil
        }
    }

    /// A reference id's name only when the explanation names that same record.
    private func resolvedSourceName(_ id: String) -> String? {
        guard let resolved else { return nil }
        for source in resolved.sources where source.entity?.entityId == id {
            if let name = (try? JSONValue(encoding: source.value))?["name"]?.stringValue { return name }
            return source.label
        }
        return nil
    }

    private func hasEvidence(_ explanation: FieldExplanationOutput) -> Bool {
        if case .value(.some) = explanation.resolutionEvidence { return true }
        return false
    }

    // MARK: Sources

    @ViewBuilder
    private func sourceContent(_ source: FieldExplanationSource) -> some View {
        let value = try? JSONValue(encoding: source.value)
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            if let reference = source.entity {
                ForEach(source.fields ?? [], id: \.self) { key in
                    if let sourceField = EntityCatalog[reference.entityKind].field(key) {
                        FieldExplanationLabel(
                            field: sourceField,
                            subject: EntityRef(entity: reference.entityKind, id: reference.entityId)
                        )
                        .font(.caption)
                    }
                }
            }
            if let value, value != .null || source.entity == nil {
                ExplanationEvidenceValue(value: sourceFacts(value, reference: source.entity?.entityId))
                    .font(.caption)
            }
        }
    }

    private func sourceFacts(_ value: JSONValue, reference: String?) -> JSONValue {
        guard let reference, let facts = value.objectValue else { return value }
        return .object(facts.filter { $0.key != "name" && $0.value.stringValue != reference })
    }

    @ViewBuilder
    private func chain(_ block: ReportRecordsBlock, steps: [FieldDecisionStep]?) -> some View {
        if block.rows.isEmpty {
            RecordsBlockView(records: ReportPresentation.records(untitled(block)), host: nil)
        } else {
            SourceStackView(
                label: block.title ?? "Resolution order",
                levels: SourceStack.levels(chain: block, steps: steps),
                showsTitles: false
            ) { level in
                RecordsBlockView(
                    records: ReportPresentation.records(untitled(block, row: level.index)), host: nil)
            }
        }
        if let footer = block.footer {
            Text(footer).font(.caption).foregroundStyle(.secondary)
        }
    }

    /// The report row owns its linked title; the chain owns the block footer.
    private func untitled(_ block: ReportRecordsBlock, row: Int? = nil) -> ReportRecordsBlock {
        var result = block
        result.title = nil
        result.footer = nil
        if let row { result.rows = [block.rows[row]] }
        return result
    }

    @ViewBuilder
    private func inputs(_ steps: [FieldDecisionStep]?) -> some View {
        if let steps, steps.contains(where: { !$0.observed.isEmpty }) {
            DisclosureGroup("Inputs and source settings") {
                ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                    VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                        Text(step.source).font(.caption.weight(.semibold))
                        ForEach(Array(step.observed.enumerated()), id: \.offset) { _, observation in
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: FieldGuideTokens.Space.xs) {
                                    Text(observation.label).font(.caption).foregroundStyle(.secondary)
                                    if let reference = observation.entity {
                                        NavigationLink(
                                            reference.entityId,
                                            value: Route.entityDetail(
                                                reference.entityKind, id: reference.entityId)
                                        )
                                        .font(.caption)
                                    }
                                }
                                sourceContent(observation)
                            }
                        }
                        coverage(step.coverage, noun: "inputs")
                    }
                }
            }
        }
    }

    private func contributorView(
        _ block: ReportRecordsBlock, steps: [FieldDecisionStep]?, coverage evidence: FieldEvidenceCoverage?
    ) -> some View {
        DisclosureGroup {
            chain(block, steps: steps)
            coverage(evidence, noun: "evaluation rows")
            inputs(steps)
        } label: {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                Text(block.title ?? "Contributor").font(.callout.weight(.medium))
                if let trailing = block.rows.first?.trailing {
                    Text(trailing).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder
    private func coverage(_ coverage: FieldEvidenceCoverage?, noun: String) -> some View {
        if let coverage, coverage.omitted > 0 {
            Text("Showing \(coverage.shown) of \(coverage.total) \(noun).")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    // MARK: Quality, details, freshness

    @ViewBuilder
    private func qualityBreakdown(_ breakdown: QualityBreakdown) -> some View {
        Divider()
        sectionLabel("Score calculation")
        Text(breakdown.summary).font(.callout.monospacedDigit())
        ForEach(breakdown.checks, id: \.check) { check in
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                Text(check.label).font(.callout.weight(.semibold))
                Text("\(check.stateLabel) · \(check.weightLabel)")
                    .font(.caption).foregroundStyle(.secondary)
                if check.state.rawValue == "gap" { Text(check.description).font(.callout) }
                DataExceptionControl(
                    draft: .init(entityID: subject.id, check: DataCheck(rawValue: check.check)),
                    isGap: check.state.rawValue == "gap",
                    options: check.exceptionReasons.map { .init(reason: $0.reason, label: $0.label) },
                    recorded: check.exception.map { ($0.reason, $0.note, $0.state.rawValue == "stale") },
                    onChanged: reload
                )
                Text("\(check.facet) · \(check.check)").font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func technicalDetails(_ explanation: FieldExplanationOutput, envelope: FieldEnvelope?)
        -> some View
    {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                Text(explanation.rule.description).font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Rule: \(explanation.rule.id) · r\(explanation.rule.revision)")
                    .font(.caption.monospaced()).textSelection(.enabled)
                if let code = envelope?.effectiveValue?.stringValue,
                    code != explanation.interpretation?.result
                {
                    Text("Result code: \(code)").font(.caption.monospaced()).textSelection(.enabled)
                }
                HStack(spacing: FieldGuideTokens.Space.xs) {
                    Text("Evaluated:")
                    DateDisplay(date: explanation.evaluatedAt)
                }
                .font(.caption).foregroundStyle(.secondary)
                if explanation.qualityBreakdown != nil {
                    ForEach(explanation.interpretation?.caveats ?? [], id: \.self) { caveat in
                        Text(caveat).font(.caption).foregroundStyle(.secondary)
                    }
                }
                DisclosureGroup("Raw evidence and check identifiers") {
                    RawRecordDisclosure(raw: (try? JSONValue(encoding: explanation)) ?? .null)
                }
                .font(.caption)
            }
        } label: {
            sectionLabel("Technical details")
        }
    }

    /// The result's own age and the refresh work, kept apart from the live comparison: a cached
    /// result's recorded provenance is never restated as a current observation.
    private func freshness(_ envelope: FieldEnvelope, comparison: FieldLiveComparison) -> some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            switch envelope.result {
            case .cached(_, let computedAt, let freshness):
                HStack(spacing: FieldGuideTokens.Space.xs) {
                    switch freshness {
                    case .fresh: Text("Cached result ·")
                    case .stale: Text("Stale result ·")
                    case .unsupported(let kind): Text("Cached result (unsupported freshness: \(kind)) ·")
                    }
                    DateDisplay(computedAt)
                }
                switch comparison {
                case .available(let available):
                    if let live = (try? JSONValue(encoding: available.result)).flatMap(
                        FieldEnvelope.parseResult)
                    {
                        HStack(alignment: .firstTextBaseline, spacing: FieldGuideTokens.Space.xs) {
                            Text("Live now:")
                            resultText(live, failure: nil)
                        }
                    }
                case .unavailable(let unavailable):
                    Text("Live comparison unavailable: \(unavailable.reason)")
                case .unrecognized(let raw):
                    Text("Unsupported live comparison: \(raw["kind"]?.stringValue ?? "unknown")")
                        .foregroundStyle(FieldGuideTokens.warning)
                }
            case .live:
                Text("Live result")
            default:
                EmptyView()
            }
            switch envelope.work {
            case .pending:
                Label("Updating", systemImage: "circle.fill").foregroundStyle(FieldGuideTokens.info)
            case .waiting(let reason):
                Text(reason)
            case .failed(let error, _):
                Text(error).foregroundStyle(FieldGuideTokens.destructive).textSelection(.enabled)
            case .unsupported(let kind):
                Text("Unsupported refresh state: \(kind)").foregroundStyle(FieldGuideTokens.warning)
            case .idle:
                EmptyView()
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("field.explanation.derived")
    }

    @ViewBuilder
    private var notAssessedContent: some View {
        sectionLabel("What this means")
        Text("Not assessed").font(.headline)
        Text(
            "No quality checks are defined for this entity. Review its fields and supporting records directly."
        )
        if EntityCatalog.descriptor(forShortcode: subject.id)?.key == subject.entity {
            NavigationLink("Open record", value: Route.entityDetail(subject.entity, id: subject.id))
        }
        Divider()
        sectionLabel("Technical details")
        if let rule = field.explanation {
            Text("Rule: \(rule.ruleId) · r\(rule.version)").font(.caption.monospaced())
        }
        Text("Evaluation: not performed; no checks are defined.").font(.caption)
        Text(
            "There is no score, calculation, or check evaluation for this entity. Not assessed is not a score of zero or a guarantee of completeness."
        )
        .font(.callout)
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text.uppercased()).font(.caption2.weight(.semibold)).tracking(0.6)
            .foregroundStyle(FieldGuideTokens.graphiteSecondary)
            .accessibilityAddTraits(.isHeader)
    }

    // MARK: Loading

    private func reload() {
        resolved = nil
        Task { await load() }
    }

    private func load() async {
        guard !notAssessed, resolved == nil else { return }
        loadError = nil
        do {
            let result = try await appModel.client.fieldExplanation(
                subject: subject, field: field.key, surface: surface, scope: scope)
            try Task.checkCancellation()
            resolved = result
        } catch is CancellationError {
        } catch {
            guard !Task.isCancelled else { return }
            loadError = String(describing: error)
            appModel.handle(error)
        }
    }
}

/// Quality exceptions use the existing server commands; failed saves retain the person's draft.
private struct DataExceptionControl: View {
    struct Draft {
        let entityID: String
        let check: DataCheck
    }

    struct Option {
        let reason: DataExceptionReason
        let label: String
    }

    let draft: Draft
    let isGap: Bool
    let options: [Option]
    let recorded: (DataExceptionReason, String, Bool)?
    let onChanged: () -> Void
    @Environment(AppModel.self) private var appModel
    @State private var editing = false
    @State private var reason: DataExceptionReason?
    @State private var note = ""
    @State private var saving = false
    @State private var saveError: String?

    private var knownCheck: Bool { DataCheck.allCases.contains(draft.check) }
    private var permittedOptions: [Option] {
        options.filter { DataExceptionReason.allCases.contains($0.reason) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            if let recorded {
                Text(recorded.2 ? "Exception needs review" : "Recorded exception")
                    .font(.caption.weight(.medium))
                Text("\(recorded.0.rawValue): \(recorded.1)").font(.caption)
            }
            if editing {
                Picker("Exception reason", selection: $reason) {
                    Text("Choose a reason").tag(DataExceptionReason?.none)
                    ForEach(permittedOptions, id: \.reason) { option in
                        Text(option.label).tag(Optional(option.reason))
                    }
                }
                TextField("Exception note", text: $note, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel("Exception note")
                HStack {
                    Button("Save exception") { Task { await save() } }
                        .disabled(
                            saving || reason == nil
                                || note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button("Cancel") { editing = false }
                        .disabled(saving)
                }
            } else if knownCheck && (isGap || recorded != nil) && !permittedOptions.isEmpty {
                Button(recorded == nil ? "Record exception" : "Edit exception") {
                    reason = recorded.flatMap { value in
                        permittedOptions.contains(where: { $0.reason == value.0 }) ? value.0 : nil
                    }
                    note = recorded?.1 ?? ""
                    saveError = nil
                    editing = true
                }
            }
            if knownCheck && recorded != nil {
                Button("Clear exception") { Task { await clear() } }.disabled(saving)
            }
            if let saveError {
                Text(saveError).font(.caption).foregroundStyle(FieldGuideTokens.destructive)
                    .textSelection(.enabled)
            }
            if saving { ProgressView().controlSize(.small).accessibilityLabel("Saving exception") }
        }
        .buttonStyle(.borderless)
    }

    private func save() async {
        guard knownCheck, let reason, permittedOptions.contains(where: { $0.reason == reason }) else {
            return
        }
        saving = true
        saveError = nil
        defer { saving = false }
        do {
            _ = try await appModel.client.setDataException(
                .init(entityId: draft.entityID, check: draft.check, reason: reason, note: note))
            editing = false
            onChanged()
        } catch {
            saveError = String(describing: error)
            appModel.handle(error)
        }
    }

    private func clear() async {
        guard knownCheck else { return }
        saving = true
        saveError = nil
        defer { saving = false }
        do {
            _ = try await appModel.client.clearDataException(
                .init(entityId: draft.entityID, check: draft.check))
            editing = false
            onChanged()
        } catch {
            saveError = String(describing: error)
            appModel.handle(error)
        }
    }
}

#Preview("Quality exception") {
    if let check = DataCheck.allCases.first {
        DataExceptionControl(
            draft: .init(entityID: "PRD-4K7M", check: check), isGap: true,
            options: [], recorded: nil, onChanged: {}
        ).environment(PreviewFixtures.signedInModel())
    }
}

// MARK: - Display image chain

/// A display image's precedence chain, through the shared source stack; images are view only.
struct DisplayImageChainStack: View {
    let chain: ImageChainExplanation

    var body: some View {
        if chain.levels.isEmpty {
            Text("No display images").font(.caption).foregroundStyle(.secondary)
        } else {
            SourceStackView(label: "Display image chain", levels: SourceStack.levels(imageChain: chain)) {
                level in
                let images = chain.levels[level.index].images
                SourceStackImageStrip(
                    label: level.title,
                    images: images.map { .init(id: $0.id, url: URL(string: $0.url), chosen: $0.chosen) })
            }
        }
    }
}

/// Why this image: loads the record's display-image chain when opened.
struct DisplayImageChainView: View {
    let subject: EntityRef
    let onClose: () -> Void
    @Environment(AppModel.self) private var appModel
    @State private var chain: ImageChainExplanation?
    @State private var loadError: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
                HStack {
                    Text("Display image sources").font(.headline)
                    Spacer()
                    Button(action: onClose) {
                        Image(systemName: "xmark")
                            .frame(
                                minWidth: FieldGuideTokens.touchTarget,
                                minHeight: FieldGuideTokens.touchTarget
                            )
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .keyboardShortcut(.cancelAction)
                    .accessibilityLabel("Close image sources")
                }
                if let chain {
                    DisplayImageChainStack(chain: chain)
                } else if let loadError {
                    Text(loadError).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                    Button("Retry") { Task { await load() } }
                        .frame(minHeight: FieldGuideTokens.touchTarget)
                } else {
                    ProgressView().controlSize(.small).accessibilityLabel("Loading image sources")
                }
            }
            .padding(FieldGuideTokens.Space.md)
            .frame(idealWidth: 360, alignment: .leading)
        }
        #if os(macOS)
            .frame(minWidth: 360, idealWidth: 440, maxWidth: 560, minHeight: 240, maxHeight: 640)
        #endif
        .accessibilityIdentifier("image.chain.popover")
        .presentationCompactAdaptation(.sheet)
        .task { await load() }
    }

    private func load() async {
        guard chain == nil else { return }
        loadError = nil
        do {
            let result = try await appModel.client.displayImageChain(
                .init(entityKind: subject.entity, entityId: subject.id))
            try Task.checkCancellation()
            chain = result
        } catch is CancellationError {
        } catch {
            guard !Task.isCancelled else { return }
            loadError = String(describing: error)
            appModel.handle(error)
        }
    }
}

// MARK: - Previews

private enum WhyThisValuePreviewData {
    static let inheritedOwner: JSONValue = [
        "id": "INV-4K7M",
        "fields": [
            "ownerLedgerPartyId": [
                "current": [
                    "assignment": ["kind": "inherit"],
                    "controls": [
                        "kind": "editable", "canSetNone": true, "canConfirm": true,
                        "reset": ["kind": "unavailable"],
                    ],
                ],
                "result": [
                    "kind": "cached", "computedAt": "2026-01-01T12:00:00.000Z", "freshness": "stale",
                    "decision": [
                        "outcome": ["kind": "value", "value": "LPY-4K7M"],
                        "provenance": [
                            "kind": "inherited",
                            "source": [
                                "entityKind": "product", "entityId": "PRD-4K7M", "name": "Fixture lamp",
                            ],
                        ],
                    ],
                ],
                "work": ["kind": "failed", "error": "Synthetic refresh failure", "retryAt": .null],
            ]
        ],
    ]
}

#Preview("Value marks") {
    if let field = EntityCatalog[.inventory].field("ownerLedgerPartyId") {
        NavigationStack {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
                HStack {
                    Text("Alex")
                    FieldValueStatus(raw: WhyThisValuePreviewData.inheritedOwner, field: field)
                }
                FieldProvenanceCaption(raw: WhyThisValuePreviewData.inheritedOwner, field: field)
            }
            .padding()
        }
        .environment(PreviewFixtures.signedInModel())
    }
}

#Preview("Why this value") {
    if let field = EntityCatalog[.product].field("price") {
        NavigationStack {
            WhyThisValueView(field: field, subject: EntityRef(entity: .product, id: "PRD-4K7M")) {}
        }
        .environment(PreviewFixtures.signedInModel())
    }
}

#Preview("Display image chain") {
    let json: JSONValue = [
        "levels": [
            ["label": "Own", "source": .null, "images": []],
            [
                "label": "From product PRD-4K7M",
                "source": ["entityKind": "product", "entityId": "PRD-4K7M"],
                "images": [
                    ["id": "IMG-4K7M", "url": "https://images.example.test/a.jpg", "chosen": true],
                    ["id": "IMG-7M4K", "url": "https://images.example.test/b.jpg", "chosen": false],
                ],
            ],
        ]
    ]
    if let chain = try? json.decoded(ImageChainExplanation.self) {
        NavigationStack {
            DisplayImageChainStack(chain: chain).padding()
        }
    }
}

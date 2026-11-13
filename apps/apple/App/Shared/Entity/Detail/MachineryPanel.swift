import CubbyKit
import SwiftUI

/// One snapshot owns the header and its panel, including decisions and read errors.
@MainActor @Observable
final class MachineryModel {
    var output: MachineryReadOutput?
    var error: String?
    var pending = false
    var decided = false
    var read: Machinery? { output?.machinery }

    func load(_ app: AppModel, subject: EntityRef, field: String? = nil) async {
        error = nil
        do {
            let output = try await app.client.readMachinery(.init(entity: subject.entity, id: subject.id, field: field))
            try Task.checkCancellation()
            self.output = output
        } catch is CancellationError {
        } catch {
            self.error = String(describing: error)
            app.handle(error)
        }
    }

    func decide(_ app: AppModel, subject: EntityRef, field: String?, decision: MachineryDecideInputDecisionsItem) async {
        guard !pending else { return }
        pending = true
        error = nil
        defer { pending = false }
        do {
            _ = try await app.client.decideMachinery(.init(entity: subject.entity, id: subject.id, decisions: [decision]))
            decided = true
            app.recordEntityMutation(keys: [subject.entity])
            await load(app, subject: subject, field: field)
        } catch {
            self.error = String(describing: error)
            app.handle(error)
        }
    }

    func act(_ app: AppModel, subject: EntityRef, field: String?, action: MachineryGapsItemsItemActionsItem) async {
        do {
            // The generated action and write input have distinct structural JSON names.
            let json = try JSONValue(encoding: action)
            let decision = try json.decoded(MachineryDecideInputDecisionsItem.self)
            await decide(app, subject: subject, field: field, decision: decision)
        } catch {
            self.error = String(describing: error)
            app.handle(error)
        }
    }

    func approve(_ app: AppModel, subject: EntityRef, field: String?, scope: MachineryApproveDriftInputScope) async {
        guard !pending, let drift = read?.drift else { return }
        pending = true
        error = nil
        defer { pending = false }
        do {
            _ = try await app.client.approveMachineryDrift(.init(entity: subject.entity, id: subject.id, proposalHash: drift.proposalHash, scope: scope))
            decided = true
            app.recordEntityMutation(keys: [subject.entity])
            await load(app, subject: subject, field: field)
        } catch {
            self.error = String(describing: error)
            app.handle(error)
        }
    }
}

struct MachineryPanel: View {
    let model: MachineryModel
    let subject: EntityRef
    var field: String? = nil
    var allowsActions = true
    @Environment(AppModel.self) private var app
    private typealias Words = FieldEnvelopePresentation

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let read = model.read {
                if read.gaps.total == 0 && read.inputs.total == 0 && read.drift == nil {
                    Text(Words.emptyMachineryLabel)
                }
                if read.gaps.total > 0 {
                    heading("Gaps", shown: read.gaps.shown, total: read.gaps.total)
                    ForEach(Array(read.gaps.items.enumerated()), id: \.offset) { _, gap in
                        gapRow(gap)
                    }
                }
                if read.inputs.total > 0 {
                    heading("Inputs in the order Cubby used them", shown: read.inputs.shown, total: read.inputs.total)
                    ForEach(Array(read.inputs.items.enumerated()), id: \.offset) { _, input in
                        inputRow(input)
                    }
                }
                if let drift = read.drift {
                    Text("Drift").font(.headline)
                    Text("The current rules would change this record. Approving issues \(drift.askCount) \(drift.askCount == 1 ? "ask" : "asks") for about \(Words.costLabel(drift.estimatedCostMicros)).")
                    MachineryRaw(label: "Exact difference", value: raw(drift.difference))
                    if allowsActions {
                        Button("Approve") { Task { await model.approve(app, subject: subject, field: field, scope: .item) } }
                        Button("Approve every change like this") { Task { await model.approve(app, subject: subject, field: field, scope: .class) } }
                    }
                    DisclosureGroup("Proposal") {
                        MachineryRaw(label: "Proposal hash", value: drift.proposalHash)
                        MachineryRaw(label: "Inputs hash", value: drift.inputsHash)
                    }
                }
                ForEach(Array((read.passes ?? []).enumerated()), id: \.offset) { _, pass in
                    DisclosureGroup("\(Words.stageLabel(pass.stage.rawValue)) · \(pass.name)") {
                        Text(Words.attemptsLabel(n: pass.attempts, max: pass.maxAttempts, nextAt: Words.instant(pass.availableAt)))
                        if let error = pass.lastError { MachineryRaw(label: "Raw error", value: error) }
                    }
                }
                ForEach(Array(read.scopes.enumerated()), id: \.offset) { _, scope in
                    if let error = scope.error {
                        DisclosureGroup("Scope errors") { MachineryRaw(label: "\(scope.kind) · \(error.class)", value: error.raw) }
                    }
                }
                if read.truncated { Text("This read was cut at its size limit; later rows are not shown.") }
                Text("Total cost \(Words.costLabel(read.totalCostMicros))")
            } else if model.output == nil && model.error == nil {
                ProgressView("Loading machinery")
            }
            if model.decided { Text(Words.decidedNote).accessibilityAddTraits(.updatesFrequently) }
            if let error = model.error {
                MachineryRaw(label: "Raw error", value: error)
                Button("Retry") { Task { await model.load(app, subject: subject, field: field) } }
            }
        }
        .font(.callout)
        .monospacedDigit()
        .fixedSize(horizontal: false, vertical: true)
        .buttonStyle(.borderless)
        .disabled(model.pending)
        .accessibilityElement(children: .contain)
    }

    private func heading(_ label: String, shown: Int, total: Int) -> some View {
        VStack(alignment: .leading) {
            Text(label).font(.headline)
            if let coverage = Words.coverageLabel(shown: shown, total: total) { Text(coverage).foregroundStyle(.secondary) }
        }
    }

    private func gapRow(_ gap: MachineryGapsItemsItem) -> some View {
        let unknown = gap.actions.contains { $0.subject.hasPrefix("ask:") }
        let failed = gap.lastError != nil && gap.attempts.map { $0.n >= $0.max } == true
        let status = unknown ? "blocked" : failed ? "failed" : "gap"
        return VStack(alignment: .leading, spacing: 6) {
            Text("\(Words.rowStatusLabel(status)) · \(gap.input)").fontWeight(.medium)
            Text("from \(Words.actorLabel(gap.actor))")
            if let since = gap.since { Text("Since \(Words.instant(since))") }
            if let queue = gap.queue {
                Text("\(queue.position) of \(queue.of) in line · \(Words.etaLabel(queue.eta.map(Words.instant)))")
            }
            if let attempts = gap.attempts {
                Text(Words.attemptsLabel(n: attempts.n, max: attempts.max, nextAt: attempts.nextAt.map(Words.instant)))
            }
            if unknown { Text(Words.unknownCallNote) }
            if allowsActions {
                ForEach(Array(gap.actions.enumerated()), id: \.offset) { _, action in
                    Button(action.label) { Task { await model.act(app, subject: subject, field: field, action: action) } }
                }
            }
            if let error = gap.lastError {
                DisclosureGroup("Raw error") { MachineryRaw(label: error.class, value: error.raw) }
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .contain)
    }

    private func inputRow(_ input: MachineryInputsItemsItem) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("\(Words.rowStatusLabel(Words.inputRowStatus(input))) · \(Words.inputKindLabel(input.kind.rawValue))")
                .fontWeight(.medium)
            if let source = input.source { sourceLink(source) }
            if let decision = input.decision {
                Text("\(Words.decisionChannelLabel(decision.channel.rawValue)) · \(Words.decisionKindLabel(decision.kind.rawValue))")
                if let superseded = decision.supersededBy { Text("Superseded by \(superseded)") }
            }
            if let by = input.by { Text("by \(by)") }
            if let at = input.at { Text(Words.instant(at)) }
            if let answer = input.answer {
                DisclosureGroup("Raw") {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Model · \(answer.model ?? "None")")
                        Text("Tier · \(answer.tier ?? "None")")
                        Text("Cost · \(answer.costMicros.map(Words.costLabel) ?? "None")")
                        MachineryRaw(label: "Input hash", value: answer.inputHash)
                        if let error = answer.rawError { MachineryRaw(label: "Raw error", value: error) }
                    }
                }
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private func sourceLink(_ code: String) -> some View {
        if let entity = EntityCatalog.all.first(where: { $0.shortcodePrefix == code.components(separatedBy: "-").first })?.key {
            NavigationLink(code, value: Route.entityDetail(entity, id: code))
        } else { Text(code).monospaced() }
    }

    private func raw(_ value: some Encodable) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return (try? encoder.encode(value)).flatMap { String(data: $0, encoding: .utf8) } ?? "Unsupported value"
    }
}

struct MachineryRaw: View {
    let label: String
    let value: String
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.caption.monospaced()).textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            Button("Copy \(label)") { Clipboard.copy(value) }
        }
    }
}

#Preview("Empty machinery", traits: .modifier(SignedInPreview())) {
    MachineryPanel(model: MachineryModel(), subject: .init(entity: .product, id: "PRD-4K7M"))
        .padding()
}
#Preview("Raw machinery") { MachineryRaw(label: "Raw error", value: "Synthetic error").padding() }

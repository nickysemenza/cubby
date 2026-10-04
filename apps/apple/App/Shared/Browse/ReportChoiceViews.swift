import CubbyKit
import SwiftUI

/// One server-worded decision on a `records` block: its ranked suggestions, an option picker, and
/// whatever the chosen option asks for (a record from the entity picker, a written reason). The
/// answers live with the block (`ReportChoiceAnswers`); nothing is preselected, even for a single
/// exact suggestion, so the person's tap is what answers.
struct ReportChoiceView: View {
    let choice: ReportPresentation.Choice
    @Binding var answers: ReportChoiceAnswers
    var disabled = false
    @State private var picking = false

    private var option: ReportPresentation.Choice.Option? {
        choice.options.first { $0.id == answers.answer(for: choice.id)?.optionID }
    }

    private var optionBinding: Binding<String?> {
        Binding(
            get: { answers.answer(for: choice.id)?.optionID },
            set: { answers.choose(choice, optionID: $0) })
    }

    private var textBinding: Binding<String> {
        Binding(
            get: { answers.answer(for: choice.id)?.text ?? "" },
            set: { answers.write(choice, text: $0) })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            ForEach(choice.suggestions) { suggestion in
                HStack(alignment: .firstTextBaseline, spacing: FieldGuideTokens.Space.xs) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(suggestion.name)
                        if let subtitle = suggestion.subtitle {
                            Text(subtitle).font(.fieldGuideLabel).foregroundStyle(.secondary)
                        }
                    }
                    ForEach(suggestion.badges, id: \.self) { badge in
                        StatusChip(text: badge, tone: .neutral)
                    }
                    Spacer(minLength: FieldGuideTokens.Space.xs)
                    Button(suggestion.label) {
                        answers.pick(
                            choice, optionID: suggestion.optionID, id: suggestion.recordID,
                            title: suggestion.name)
                    }
                    .buttonStyle(.bordered)
                    .disabled(disabled)
                    .accessibilityIdentifier("report.choice.suggest.\(choice.id).\(suggestion.recordID)")
                }
            }
            Picker(choice.label, selection: optionBinding) {
                Text("Choose…").tag(String?.none)
                ForEach(choice.options) { option in
                    Text(option.label).tag(Optional(option.id))
                }
            }
            .disabled(disabled)
            .accessibilityIdentifier("report.choice.\(choice.id)")
            if let pick = option?.pick, let entity = EntityKey(rawValue: pick.entity) {
                Button {
                    picking = true
                } label: {
                    LabeledContent(pick.label) {
                        Text(answers.answer(for: choice.id)?.pickTitle ?? "None")
                            .foregroundStyle(
                                answers.answer(for: choice.id)?.pickID == nil
                                    ? Color.secondary : FieldGuideTokens.graphite
                            )
                            .lineLimit(1)
                    }
                    .frame(minHeight: FieldGuideTokens.touchTarget)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(disabled)
                .accessibilityIdentifier("report.choice.pick.\(choice.id)")
                .sheet(isPresented: $picking) {
                    EntityPickerSheet(
                        target: entity, selected: [answers.answer(for: choice.id)?.pickID].compactMap { $0 }
                    ) { picks in
                        guard let picked = picks.first, let optionID = self.option?.id else { return }
                        answers.pick(choice, optionID: optionID, id: picked.id, title: picked.title)
                    }
                }
            }
            if let hint = option?.hint {
                Text(hint).font(.fieldGuideLabel).foregroundStyle(.secondary)
            }
            if let label = option?.text {
                TextField(label, text: textBinding, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .disabled(disabled)
                    .accessibilityIdentifier("report.choice.text.\(choice.id)")
            }
        }
    }
}

/// A block's own choices, its progress sentence and its one command. The command asks the
/// server's confirmation first, is available only while every required choice is answered and the
/// server allows it, and sends exactly the body the answers assemble.
struct ReportFormFooterView: View {
    let form: ReportPresentation.Form
    let rowChoices: [ReportPresentation.Choice]
    @Binding var answers: ReportChoiceAnswers
    let model: ReportSlotModel
    @State private var confirming = false

    private var busy: Bool { model.busyActionID != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            if let reason = form.disabledReason {
                Text(reason).font(.footnote).foregroundStyle(.secondary)
            } else {
                ForEach(form.choices) { choice in
                    ReportChoiceView(choice: choice, answers: $answers, disabled: busy)
                }
                Text(answers.progressText(form: form, rowChoices: rowChoices))
                    .font(.footnote).foregroundStyle(.secondary)
                Button(busy ? "Importing…" : form.command.label) {
                    if form.command.confirm == nil {
                        Task { await model.approve(form, answers: answers, confirmed: false) }
                    } else {
                        confirming = true
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy || !answers.canSubmit(form: form, rowChoices: rowChoices))
                .accessibilityIdentifier("report.form.\(form.command.id)")
            }
        }
        .confirmationDialog(
            form.command.label, isPresented: $confirming, titleVisibility: .visible
        ) {
            Button(form.command.label) {
                Task { await model.approve(form, answers: answers, confirmed: true) }
            }
        } message: {
            Text(form.command.confirm ?? "")
        }
    }
}

// MARK: - Previews

#if DEBUG
    private func previewRecords() -> ReportPresentation.Records? {
        let json = #"""
            {"blocks": [{"kind": "records", "empty": "", "rows": [
              {"entity": null, "id": null, "title": "Sample item", "subtitle": null, "trailing": "$12.50",
               "key": "line:1", "statuses": [], "lines": [], "commands": [],
               "choice": {"id": "o1/l1", "label": "Product decision for Sample item", "required": true,
                 "options": [
                   {"id": "existing", "label": "Use an existing Product",
                    "pick": {"entity": "product", "label": "Product for Sample item"}},
                   {"id": "new", "label": "Create a new Product"},
                   {"id": "unresolved", "label": "Leave Product unresolved",
                    "text": {"label": "Reason for leaving Sample item unresolved"}}],
                 "suggestions": [{"optionId": "existing", "entity": "product", "id": "PRD-4K7M",
                   "name": "Sample product", "label": "Use Sample product", "badges": ["Exact identifier"]}]}}],
              "form": {"choices": [], "note": "Approval imports the prepared orders and expenses.",
                       "noun": "Product decision", "completeText": "All Product decisions reviewed.",
                       "disabledReason": null,
                       "command": {"id": "commit:1", "label": "Approve and import", "prominent": true,
                                   "confirm": "Import 1 prepared order?",
                                   "request": {"kind": "commit-prepared", "runId": "RUN-4K7M",
                                               "prepareOperationId": "prepare-1", "tradeChoiceId": null,
                                               "lines": [{"choiceId": "o1/l1", "stableOrderId": "o1", "stableLineId": "l1"}]}}}}]}
            """#
        guard let report = try? JSONDecoder.cubby().decode(EntityReportOut.self, from: Data(json.utf8)),
            case .records(let records) = ReportPresentation(report).blocks.first
        else { return nil }
        return records
    }

    #Preview("Choice") {
        if let choice = previewRecords()?.rowChoices.first {
            @Previewable @State var answers = ReportChoiceAnswers()
            ReportChoiceView(choice: choice, answers: $answers).padding()
        }
    }
#endif

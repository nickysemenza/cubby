import CubbyKit
import SwiftUI

/// Three logical lines; text wraps at accessibility sizes instead of clipping.
struct RecordMachineryHeader: View {
    let model: MachineryModel
    let subject: EntityRef
    @Environment(AppModel.self) private var app
    @State private var showingPanel = false
    private typealias Words = FieldEnvelopePresentation

    static func inlineAction<Action>(_ actions: [Action]) -> Action? {
        actions.count == 1 ? actions.first : nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let read = model.read {
                Text(Words.stageLine(read)).font(.subheadline.weight(.medium))
                WrappingFactsLayout(spacing: 4) {
                    if let gap = read.gaps.items.first {
                        if let since = gap.since { Text("Since \(Words.instant(since))") }
                        if let action = Self.inlineAction(gap.actions) {
                            Button(action.label) {
                                Task { await model.act(app, subject: subject, field: nil, action: action) }
                            }
                            .disabled(model.pending)
                        } else if gap.since == nil {
                            Text(Words.gapSentence(gap))
                        }
                    } else {
                        Text(Words.noGapLabel)
                    }
                }
                .font(.caption)
                Button(Words.countLine(read)) { showingPanel = true }
                    .font(.caption.monospaced()).monospacedDigit()
                    .accessibilityHint("Opens machinery")
                    .popover(isPresented: $showingPanel) {
                        NavigationStack {
                            ScrollView {
                                MachineryPanel(model: model, subject: subject).padding()
                            }
                            .navigationTitle("Machinery")
                            .toolbar {
                                ToolbarItem(placement: .confirmationAction) {
                                    Button("Done") { showingPanel = false }.keyboardShortcut(.cancelAction)
                                }
                            }
                        }
                        #if os(macOS)
                            .frame(minWidth: 360, idealWidth: 480, minHeight: 320, idealHeight: 600)
                        #endif
                        .presentationCompactAdaptation(.sheet)
                    }
            } else if model.output == nil && model.error == nil {
                ProgressView("Loading machinery").controlSize(.small)
            }
            if let absorbed = model.output?.absorbed {
                Text(Words.absorbedRecordNotice(absorbed.requested))
                NavigationLink(
                    "Open \(absorbed.survivor)",
                    value: Route.entityDetail(subject.entity, id: absorbed.survivor))
            }
            if let notice = model.notice {
                Text(notice).font(.caption).accessibilityAddTraits(.updatesFrequently)
            }
            if let error = model.error {
                MachineryRaw(label: "Raw error", value: error)
                Button("Retry") { Task { await model.load(app, subject: subject) } }
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .buttonStyle(.borderless)
    }
}

struct MachineryListLine: View {
    let raw: JSONValue
    static func text(_ raw: JSONValue) -> String? {
        guard let value = raw["machinery"], value != .null,
            let read = try? value.decoded(MachineryListFields.self)
        else { return nil }
        var words = [FieldEnvelopePresentation.stageLabel(read.stage.rawValue)]
        if let actor = read.nextActor {
            words.append(FieldEnvelopePresentation.actorLabel(actor.rawValue))
        }
        if let gap = read.firstGap {
            words.append(gap.split(whereSeparator: \.isWhitespace).prefix(6).joined(separator: " "))
        }
        return words.joined(separator: " · ")
    }
    var body: some View {
        if let line = Self.text(raw) {
            Text(line).font(.caption).fixedSize(horizontal: false, vertical: true)
        }
    }
}

#Preview("Machinery header", traits: .modifier(SignedInPreview())) {
    RecordMachineryHeader(model: MachineryModel(), subject: .init(entity: .product, id: "PRD-4K7M"))
}
#Preview("Machinery list line") {
    MachineryListLine(raw: ["machinery": ["stage": "needs_you", "nextActor": "you", "firstGap": "a receipt", "attempts": 0, "costMicros": 0, "eta": .null]])
}

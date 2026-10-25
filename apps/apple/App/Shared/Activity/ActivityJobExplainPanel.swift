import CubbyKit
import SwiftUI

struct ActivityJobExplainPanel: View {
    let code: String
    let overview: HouseholdQueueOverview
    @Environment(AppModel.self) private var appModel
    @State private var model = ActivityJobExplanation()

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let explanation = model.explanation {
                ForEach(Array(explanation.steps.enumerated()), id: \.offset) { _, step in
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(step.label) · \(step.state)").font(.subheadline)
                        if let detail = step.detail {
                            Text(detail).font(.caption.monospaced()).textSelection(.enabled)
                        }
                    }
                }
            } else if model.error == nil {
                ProgressView()
            }
            Button("Retry now") { Task { await overview.retry(codes: [code]) } }
                .buttonStyle(.borderless)
                .disabled(overview.isRetrying)
            if let logs = model.logs {
                logsView(logs)
            }
            if let error = model.error {
                Text(error.localizedDescription).foregroundStyle(FieldGuideTokens.warning)
            }
        }
        .task(id: code) {
            await model.load(client: appModel.client, code: code)
            if let error = model.error { Diagnostics.report(error, context: "activity.job.explain") }
        }
    }

    @ViewBuilder private func logsView(_ logs: JobLogsOutput) -> some View {
        switch logs {
        case .ok(let value):
            if value.lines.isEmpty { Text("No Worker log lines in this Job's window.").font(.caption) }
            ForEach(value.lines, id: \.id) { line in
                Text("\(line.level) · \(line.message)")
                    .font(.caption.monospaced()).textSelection(.enabled)
            }
        case .notConfigured: Text("Worker logs are not configured.").font(.caption)
        case .expired: Text("This Job's logs are outside retention.").font(.caption)
        case .error(let value): Text(value.message).font(.caption).textSelection(.enabled)
        case .unrecognized: Text("Unsupported Worker log response").font(.caption)
        }
    }
}

#Preview("Job explanation", traits: .modifier(SignedInPreview())) {
    ActivityJobExplainPanel(
        code: "JOB-4K7MN4K7MN",
        overview: HouseholdQueueOverview(client: PreviewFixtures.signedInModel().client))
}

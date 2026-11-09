import CubbyKit
import SwiftUI

/// Ranks a photo against the household's own product covers using on-device Vision feature
/// prints (`FeaturePrintIndex`). This is closed-set matching only — "which of MY products is
/// this" — never an open-world guess, so results are always shown as a raw distance, never a
/// percentage or "confidence".
struct IdentifyView: View {
    @Environment(AppModel.self) private var model
    @State private var identify: IdentifyModel?

    var body: some View {
        Group {
            if let identify {
                IdentifyContent(identify: identify)
            } else {
                LoadingIndicator.screen(label: "Loading Identify")
            }
        }
        .fieldGuideScreen()
        .navigationTitle("Identify")
        .task(id: model.host) {
            let identify = IdentifyModel(client: model.client, index: model.featurePrints)
            self.identify = identify
            await identify.prepare()
        }
    }
}

/// The real screen's content: owns the picker state and drives `IdentifyModel`. Split from
/// `IdentifyView` so the model is guaranteed non-nil here, matching `CaptureView`/`CaptureContent`.
private struct IdentifyContent: View {
    @Bindable var identify: IdentifyModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xl) {
                statusPanel
                photoSection
                IdentifyResultsSection(
                    matches: identify.candidates,
                    probe: identify.probe,
                    failure: failureMessage
                )
            }
            .padding(FieldGuideTokens.Space.lg)
            .frame(maxWidth: FieldGuideTokens.readingWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .fieldGuideScreen()
        .toolbar {
            ToolbarItem {
                Button("Rebuild index") {
                    Task { await identify.rebuild() }
                }
                .disabled(identify.isIndexing)
            }
        }
    }

    /// `phase` covers both the index build and the last ranking attempt, so a failure here might
    /// describe either — the results section shows it either way since it is the only place a
    /// failure is otherwise visible.
    private var failureMessage: String? {
        if case .failed(let message) = identify.phase { return message }
        return nil
    }

    private var statusPanel: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            Eyebrow("On-device index")
            Panel {
                HStack(spacing: FieldGuideTokens.Space.md) {
                    statusText
                    Spacer(minLength: FieldGuideTokens.Space.sm)
                    if case .indexing = identify.phase {
                        LoadingIndicator(label: "Indexing photos").controlSize(.small)
                    }
                }
                .frame(minHeight: FieldGuideTokens.touchTarget - 20)
            }
        }
    }

    @ViewBuilder
    private var statusText: some View {
        switch identify.phase {
        case .idle:
            Text("Starting…")
                .font(.fieldGuideBody)
                .foregroundStyle(FieldGuideTokens.graphiteSecondary)
        case .indexing(let done, let total):
            Text(total == 0 ? "Loading product covers…" : "Indexing \(done) of \(total)")
                .font(.fieldGuideData)
                .foregroundStyle(FieldGuideTokens.graphite)
        case .ready(let count):
            Text("\(count) covers indexed")
                .font(.fieldGuideData)
                .foregroundStyle(FieldGuideTokens.graphite)
        case .failed:
            Text("Index unavailable")
                .font(.fieldGuideBody)
                .foregroundStyle(FieldGuideTokens.destructive)
        }
    }

    private var photoSection: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            Eyebrow("Photo")
            PhotoSourceButtons { image in
                Task { await identify.identify(image) }
            }
            .disabled(!identify.canIdentify)
        }
    }
}

/// The probe thumbnail and the ranked list, shared by the real screen and `#Preview`s so neither
/// needs a network round trip or a live `FeaturePrintIndex` to render.
///
/// This is closed-set matching — "which of MY products is this" — so the number shown is the raw
/// feature-print distance. It is never dressed up as a percentage or a confidence.
struct IdentifyResultsSection: View {
    let matches: [IdentificationCandidate]
    let probe: CGImage?
    var failure: String?

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xl) {
            if let probe {
                VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
                    Eyebrow("Probe")
                    Image(decorative: probe, scale: 1)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 88, height: 88)
                        .clipShape(RoundedRectangle(cornerRadius: FieldGuideTokens.radiusPanel))
                        .overlay(
                            RoundedRectangle(cornerRadius: FieldGuideTokens.radiusPanel)
                                .strokeBorder(
                                    FieldGuideTokens.hairline,
                                    lineWidth: FieldGuideTokens.hairlineWidth
                                )
                        )
                }
            }
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
                Eyebrow("Matches")
                if let failure {
                    Panel {
                        Text("Couldn't identify this photo")
                            .font(.fieldGuideTitle)
                            .foregroundStyle(FieldGuideTokens.graphite)
                        DiagnosticMessage(message: failure)
                            .font(.fieldGuideBody)
                            .foregroundStyle(FieldGuideTokens.destructive)
                    }
                } else if matches.isEmpty {
                    Panel {
                        Text("No matches yet")
                            .font(.fieldGuideTitle)
                            .foregroundStyle(FieldGuideTokens.graphite)
                        Text("Choose or take a photo to rank it against your own product covers.")
                            .font(.fieldGuideBody)
                            .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } else {
                    Panel(padding: 0, spacing: 0) {
                        ForEach(Array(matches.enumerated()), id: \.element.id) { position, match in
                            if position > 0 {
                                PanelDivider(inset: FieldGuideTokens.Space.md + RecordRowMetrics.thumbnail)
                            }
                            NavigationLink(value: Route.entityDetail(.product, id: match.productID.rawValue))
                            {
                                CandidateRow(match: match, best: position == 0)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
    }
}

private struct CandidateRow: View {
    let match: IdentificationCandidate
    let best: Bool

    var body: some View {
        RecordListRow(title: match.name, imageURL: match.imageURL, symbol: "shippingbox") {
            if best { Text("Best match") }
        } rail: {
            Text("Distance \(String(format: "%.3f", match.distance))")
                .monospacedDigit()
        } supplement: {
            EmptyView()
        }
        .padding(.horizontal, FieldGuideTokens.Space.md)
    }
}

#Preview("Empty") {
    NavigationStack {
        ScrollView {
            IdentifyResultsSection(matches: [], probe: nil)
                .padding(FieldGuideTokens.Space.lg)
        }
        .fieldGuideScreen()
        .navigationTitle("Identify")
    }
}

#Preview("Matches") {
    NavigationStack {
        ScrollView {
            IdentifyResultsSection(
                matches: PreviewFixtures.sampleCandidates,
                probe: PreviewFixtures.sampleProbeImage
            )
            .padding(FieldGuideTokens.Space.lg)
        }
        .fieldGuideScreen()
        .navigationTitle("Identify")
    }
}

#Preview("Failed") {
    NavigationStack {
        ScrollView {
            IdentifyResultsSection(
                matches: [],
                probe: PreviewFixtures.sampleProbeImage,
                failure: "Vision feature print request failed."
            )
            .padding(FieldGuideTokens.Space.lg)
        }
        .fieldGuideScreen()
        .navigationTitle("Identify")
    }
}

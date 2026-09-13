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
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .porcelainScreen()
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
            VStack(alignment: .leading, spacing: PorcelainTokens.Space.xl) {
                statusPanel
                photoSection
                IdentifyResultsSection(
                    matches: identify.candidates,
                    probe: identify.probe,
                    failure: failureMessage
                )
            }
            .padding(PorcelainTokens.Space.lg)
            .frame(maxWidth: PorcelainTokens.readingWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .porcelainScreen()
        .toolbar {
            ToolbarItem {
                Button("Rebuild index") {
                    Task { await identify.rebuild() }
                }
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
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            Eyebrow("On-device index")
            Panel {
                HStack(spacing: PorcelainTokens.Space.md) {
                    statusText
                    Spacer(minLength: PorcelainTokens.Space.sm)
                    if case .indexing = identify.phase {
                        ProgressView().controlSize(.small)
                    }
                }
                .frame(minHeight: PorcelainTokens.touchTarget - 20)
            }
        }
    }

    @ViewBuilder
    private var statusText: some View {
        switch identify.phase {
        case .idle:
            Text("Starting…")
                .font(.porcelainBody)
                .foregroundStyle(PorcelainTokens.graphiteSecondary)
        case .indexing(let done, let total):
            Text("Indexing \(done) of \(total)")
                .font(.porcelainData)
                .foregroundStyle(PorcelainTokens.graphite)
        case .ready(let count):
            Text("\(count) covers indexed")
                .font(.porcelainData)
                .foregroundStyle(PorcelainTokens.graphite)
        case .failed:
            Text("Index unavailable")
                .font(.porcelainBody)
                .foregroundStyle(PorcelainTokens.destructive)
        }
    }

    private var photoSection: some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            Eyebrow("Photo")
            PhotoSourceButtons { image in
                Task { await identify.identify(image) }
            }
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
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.xl) {
            if let probe {
                VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
                    Eyebrow("Probe")
                    Image(decorative: probe, scale: 1)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 160, height: 160)
                        .clipShape(RoundedRectangle(cornerRadius: PorcelainTokens.radiusPanel))
                        .overlay(
                            RoundedRectangle(cornerRadius: PorcelainTokens.radiusPanel)
                                .strokeBorder(
                                    PorcelainTokens.hairline,
                                    lineWidth: PorcelainTokens.hairlineWidth
                                )
                        )
                }
            }
            VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
                Eyebrow("Matches")
                if let failure {
                    Panel {
                        Text("Couldn't identify this photo")
                            .font(.porcelainTitle)
                            .foregroundStyle(PorcelainTokens.graphite)
                        Text(failure)
                            .font(.porcelainBody)
                            .foregroundStyle(PorcelainTokens.destructive)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } else if matches.isEmpty {
                    Panel {
                        Text("No matches yet")
                            .font(.porcelainTitle)
                            .foregroundStyle(PorcelainTokens.graphite)
                        Text("Choose or take a photo to rank it against your own product covers.")
                            .font(.porcelainBody)
                            .foregroundStyle(PorcelainTokens.graphiteSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } else {
                    Panel(padding: 0, spacing: 0) {
                        ForEach(Array(matches.enumerated()), id: \.element.id) { position, match in
                            if position > 0 { PanelDivider(inset: PorcelainTokens.Space.lg + 56) }
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
        HStack(spacing: PorcelainTokens.Space.md) {
            Thumb(url: match.imageURL, size: 56, symbol: "shippingbox")
            VStack(alignment: .leading, spacing: PorcelainTokens.Space.xs) {
                Text(match.name)
                    .font(.body.weight(best ? .semibold : .regular))
                    .foregroundStyle(PorcelainTokens.graphite)
                    .lineLimit(2)
                HStack(spacing: PorcelainTokens.Space.sm) {
                    Text("distance \(String(format: "%.3f", match.distance))")
                        .font(.porcelainData)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                    if best {
                        StatusChip(text: "Best match")
                    }
                }
            }
            Spacer(minLength: PorcelainTokens.Space.sm)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(PorcelainTokens.graphiteSecondary)
        }
        .padding(.horizontal, PorcelainTokens.Space.md)
        .padding(.vertical, PorcelainTokens.Space.md)
        .contentShape(Rectangle())
    }
}

#Preview("Empty") {
    NavigationStack {
        ScrollView {
            IdentifyResultsSection(matches: [], probe: nil)
                .padding(PorcelainTokens.Space.lg)
        }
        .porcelainScreen()
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
            .padding(PorcelainTokens.Space.lg)
        }
        .porcelainScreen()
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
            .padding(PorcelainTokens.Space.lg)
        }
        .porcelainScreen()
        .navigationTitle("Identify")
    }
}

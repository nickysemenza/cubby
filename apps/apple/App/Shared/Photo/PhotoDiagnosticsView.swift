import CubbyKit
import SwiftUI

#if os(macOS)
    import AppKit
#else
    import UIKit
#endif

/// Runs the same six-section debug report `cubby photo analyze` prints, on-device, for a single
/// photo already shown elsewhere in the app. Cancellation-safe: a stale run's result is dropped
/// by generation token rather than raced against a newer one.
@MainActor
@Observable
final class PhotoDiagnosticsModel {
    enum State {
        case idle
        case running(String)
        case ready(PhotoDiagnosticsReport)
        case failed(String)
    }

    private(set) var state: State = .idle
    private var generation = 0
    private var task: Task<Void, Never>?

    /// `localIdentifier`/`analysisStore` are passed only when this is a Photos-library asset (the
    /// library preview): the resulting full analysis is written into `PhotoAnalysisStore` so a
    /// later Diagnostics open is instant and the classification sweep skips this photo. A Files
    /// import (no `localIdentifier`) never persists anything here.
    func run(file: PhotoFile, localIdentifier: String? = nil, analysisStore: PhotoAnalysisStore? = nil) {
        task?.cancel()
        generation += 1
        let generation = self.generation
        state = .running("Analyzing photo…")
        task = Task { [weak self] in
            guard let self else { return }
            do {
                let start = Date()
                let analysis = try await LocalPhotoAnalyzer().analyze(
                    PhotoAnalysisInput(
                        id: file.filename, file: file,
                        provenance: PhotoAnalysisProvenance(source: .files, filename: file.filename)))
                let analyzeMs = Date().timeIntervalSince(start) * 1000
                try Task.checkCancellation()
                let report = await PhotoDiagnostics.report(
                    analysis: analysis, file: file, includeFeaturePrintData: false, runSemantic: true,
                    analyzeMs: analyzeMs)
                try Task.checkCancellation()
                guard generation == self.generation else { return }
                self.state = .ready(report)
                if let localIdentifier, let analysisStore,
                    let data = try? JSONEncoder.cubby().encode(analysis)
                {
                    try? await analysisStore.upsertFullAnalysis(
                        localIdentifier: localIdentifier, analysis: data,
                        version: PhotoLocalAnalysis.currentVersion,
                        categories: PhotoCategoryHit.matchedCategories(for: analysis.classifications),
                        topLabels: PhotoCategoryHit.topLabels(for: analysis.classifications),
                        classifyVersion: PhotoClassificationSweep.classifyVersion)
                }
            } catch is CancellationError {
                // A newer run (or the view disappearing) owns the visible state.
            } catch {
                guard generation == self.generation else { return }
                Diagnostics.report(error, context: "photos.diagnostics")
                self.state = .failed(error.localizedDescription)
            }
        }
    }

    func cancel() {
        task?.cancel()
        task = nil
    }
}

/// Renders as `Section`s meant to sit directly inside a caller's `List` (library preview, R2
/// image detail) — never its own `List`/`ScrollView`, so it composes with whatever navigation
/// chrome the host already has.
struct PhotoDiagnosticsView: View {
    let model: PhotoDiagnosticsModel
    var photo: PhotoAttachment? = nil

    var body: some View {
        switch model.state {
        case .idle:
            EmptyView()
        case .running(let stage):
            Section { LoadingIndicator(label: stage) }
        case .failed(let message):
            Section {
                Text(message).foregroundStyle(PorcelainTokens.destructive)
            }
        case .ready(let report):
            if let photo {
                Section("Analyzed image") {
                    DiagnosticPhotoPreview(photo: photo, caption: "Preview of the image analyzed below.")
                }
            }
            PhotoDiagnosticsReportSections(report: report)
        }
    }
}

private struct PhotoDiagnosticsReportSections: View {
    let report: PhotoDiagnosticsReport

    var body: some View {
        IdentitySection(report: report)
        EvidenceSection(
            title: "Classifications", items: report.classifications.map { ($0.identifier, $0.confidence) })
        EvidenceSection(
            title: "Recognized text", items: report.recognizedText.map { ($0.text, $0.confidence) })
        RoutingSection(report: report)
        FoundationModelsSection(report: report)
        TimingsSection(timings: report.timings)
        ExportSection(report: report)
    }
}

private struct IdentitySection: View {
    let report: PhotoDiagnosticsReport

    var body: some View {
        Section("Identity") {
            LabeledContent("Dimensions") {
                Text("\(report.file.width)×\(report.file.height) \(report.file.contentType)")
                    .font(Font.porcelainData)
            }
            LabeledContent("Captured") {
                Text(report.file.capturedAt?.formatted(date: .abbreviated, time: .shortened) ?? "Unknown")
            }
            LabeledContent("SHA-256") {
                Text(report.identity.sha256).font(Font.porcelainCode).lineLimit(1)
                    .truncationMode(.middle)
            }
            if let perceptualHash = report.identity.perceptualHash {
                LabeledContent("Perceptual hash") {
                    Text(perceptualHash).font(Font.porcelainCode)
                }
            }
            if let fingerprint = report.identity.sourceFingerprint {
                LabeledContent(
                    "Fingerprint aspect", value: String(format: "%.4f", fingerprint.aspectRatio))
            }
            LabeledContent("Feature print") {
                Text("\(report.featurePrint.revision) · \(report.featurePrint.bytes) bytes")
            }
        }
    }
}

/// Classifications and recognized text share this shape: a label plus a Vision confidence to
/// visualize as a thin bar, so a routing miss traced to weak evidence is obvious at a glance.
private struct EvidenceSection: View {
    let title: String
    let items: [(label: String, confidence: Double)]

    var body: some View {
        Section(title) {
            if items.isEmpty {
                Text("None").foregroundStyle(.secondary)
            }
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                EvidenceRow(label: item.label, confidence: item.confidence)
            }
        }
    }
}

private struct EvidenceRow: View {
    let label: String
    let confidence: Double

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).lineLimit(2)
            ConfidenceBar(value: confidence)
        }
    }
}

/// A thin filled capsule standing in for a `Gauge` — reads at a glance in a narrow row, and its
/// fill color doubles as the confidence label so no extra text is needed.
private struct ConfidenceBar: View {
    let value: Double

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(PorcelainTokens.inset)
                Capsule().fill(PorcelainTokens.cobalt)
                    .frame(width: proxy.size.width * max(0, min(1, value)))
            }
        }
        .frame(height: 4)
        .accessibilityLabel("Confidence \(Int(value * 100)) percent")
    }
}

private struct RoutingSection: View {
    let report: PhotoDiagnosticsReport

    var body: some View {
        Section("Routing policies") {
            ForEach(report.routing, id: \.entity) { verdict in
                RoutingVerdictRow(verdict: verdict)
            }
            LabeledContent("Suggested source") {
                if let key = report.suggestedSource {
                    Text("\(EntityCatalog[key].emoji) \(EntityCatalog[key].singular)")
                } else {
                    Text("None").foregroundStyle(.secondary)
                }
            }
        }
    }
}

private struct RoutingVerdictRow: View {
    let verdict: PhotoDiagnosticsReport.RoutingVerdict

    private var matchLine: String {
        guard let identifier = verdict.classifierIdentifier, let confidence = verdict.classifierConfidence
        else { return "no label matched" }
        return
            "\(identifier)  \(String(format: "%.3f", confidence)) ≥ \(String(format: "%.2f", verdict.minimumScore))"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text("\(verdict.emoji) \(EntityCatalog[verdict.entity].singular)")
                Spacer()
                if verdict.meetsMinimumScore {
                    Label("PASS", systemImage: "checkmark.circle.fill")
                        .labelStyle(.iconOnly)
                        .foregroundStyle(PorcelainTokens.positive)
                        .accessibilityLabel("Meets minimum score")
                }
            }
            Text(matchLine).font(.caption).foregroundStyle(.secondary)
            Text("wants: \(verdict.wantedLabels.joined(separator: ", "))")
                .font(.caption2).foregroundStyle(.secondary)
        }
    }
}

private struct FoundationModelsSection: View {
    let report: PhotoDiagnosticsReport

    var body: some View {
        Section("Foundation Models reranker") {
            LabeledContent("Availability", value: report.semanticModel)
            if let semantic = report.semantic {
                LabeledContent("Status", value: semantic.status)
                ForEach(Array(semantic.decisions.enumerated()), id: \.offset) { _, decision in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(decision.routeID ?? "No route").font(.subheadline)
                        Text(decision.explanation).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }
}

private struct TimingsSection: View {
    let timings: PhotoDiagnosticsReport.Timings

    var body: some View {
        Section("Timings") {
            LabeledContent("Analyze", value: "\(Int(timings.analyzeMs)) ms")
            if let semanticMs = timings.semanticMs {
                LabeledContent("Semantic", value: "\(Int(semanticMs)) ms")
            }
        }
    }
}

private struct ExportSection: View {
    let report: PhotoDiagnosticsReport

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder.cubby()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()

    private var json: String? {
        (try? Self.encoder.encode(report)).flatMap { String(data: $0, encoding: .utf8) }
    }

    var body: some View {
        Section {
            Button("Copy JSON") { copyToPasteboard() }
                .disabled(json == nil)
            if let json {
                ShareLink(item: json, preview: SharePreview("Photo diagnostics"))
            }
        }
    }

    private func copyToPasteboard() {
        guard let json else { return }
        #if os(macOS)
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(json, forType: .string)
        #else
            UIPasteboard.general.string = json
        #endif
    }
}

#Preview(traits: .modifier(SignedInPreview())) {
    let model = PhotoDiagnosticsModel()
    model.set(PreviewFixtures.samplePhotoDiagnosticsReport)
    return List { PhotoDiagnosticsView(model: model) }
}

extension PhotoDiagnosticsModel {
    /// Test/preview seam: sets `state` directly without running the analyzer.
    func set(_ report: PhotoDiagnosticsReport) {
        state = .ready(report)
    }
}

// MARK: - R2 image detail: server vs. device comparison

/// Downloads and re-analyzes an already-uploaded image's bytes on-device, then compares that
/// fresh run against whatever `photo-local-analysis` the server persisted at import time. A
/// backfill (recording the device run) is derived data, not a user decision — it runs
/// automatically whenever the server's stored analysis is missing or stale and the bytes still
/// match, never on a prompt.
@MainActor
@Observable
final class ImageDiagnosticsCompareModel {
    enum ServerNote: Equatable {
        case storedAtImport
        case savedJustNow
        case bytesDiffer

        var label: String {
            switch self {
            case .storedAtImport: "server (at import)"
            case .savedJustNow: "saved from this device just now"
            case .bytesDiffer: "bytes differ from the stored original"
            }
        }
    }

    private(set) var server: PhotoDiagnosticsReport?
    private(set) var device: PhotoDiagnosticsReport?
    private(set) var serverNote: ServerNote?
    private(set) var loading = false
    private(set) var error: String?
    private var task: Task<Void, Never>?

    func run(id: ImageCode, detail: ImageWithEntity, client: CubbyClient) {
        guard server == nil, device == nil, !loading else { return }
        loading = true
        task = Task { [weak self] in
            guard let self else { return }
            async let storedTask = Self.fetchStored(id: id, client: client)
            async let deviceTask = Self.analyzeDevice(detail: detail)
            let stored = await storedTask
            let deviceResult = await deviceTask
            guard !Task.isCancelled else { return }
            self.loading = false
            if let stored,
                let file = Self.syntheticFile(
                    contentType: stored.contentType, size: detail.size, width: stored.width,
                    height: stored.height, capturedAt: stored.capturedAt, filename: detail.filename)
            {
                self.server = await PhotoDiagnostics.report(
                    analysis: PhotoLocalAnalysis(payload: stored), file: file,
                    includeFeaturePrintData: false, runSemantic: false)
            }
            guard let (deviceAnalysis, deviceReport) = deviceResult else {
                if self.server == nil { self.error = "Could not download this photo's bytes." }
                return
            }
            self.device = deviceReport
            await self.reconcile(
                id: id, detail: detail, stored: stored, deviceAnalysis: deviceAnalysis, client: client)
        }
    }

    func cancel() {
        task?.cancel()
    }

    private static func fetchStored(id: ImageCode, client: CubbyClient) async -> ImageAnalysisOutput? {
        try? await client.imageAnalysis(id)
    }

    private static func analyzeDevice(detail: ImageWithEntity) async -> (
        PhotoLocalAnalysis, PhotoDiagnosticsReport
    )? {
        guard let url = detail.imageURL else { return nil }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            let file = try PhotoFile.materialize(
                data: data, filename: detail.filename, contentType: detail.contentType)
            let analysis = try await LocalPhotoAnalyzer().analyze(
                PhotoAnalysisInput(
                    id: detail.filename, file: file,
                    provenance: PhotoAnalysisProvenance(source: .files, filename: detail.filename)))
            try Task.checkCancellation()
            let report = await PhotoDiagnostics.report(
                analysis: analysis, file: file, includeFeaturePrintData: true, runSemantic: false)
            return (analysis, report)
        } catch {
            return nil
        }
    }

    /// A `PhotoFile` describing the server's stored metadata rather than real bytes on disk — the
    /// URL is never read (`PhotoDiagnostics.report` only reads `PhotoFile`'s metadata fields), so a
    /// placeholder is safe here. `nil` on the rare stored metadata that fails `PhotoFile`'s own
    /// validation (e.g. a content type no longer supported); the caller then skips that column.
    private static func syntheticFile(
        contentType: String, size: Int, width: Int, height: Int, capturedAt: Date?, filename: String
    ) -> PhotoFile? {
        try? PhotoFile(
            url: URL(fileURLWithPath: "/dev/null"), filename: filename, contentType: contentType,
            size: size, width: width, height: height, capturedAt: capturedAt)
    }

    private func reconcile(
        id: ImageCode, detail: ImageWithEntity, stored: ImageAnalysisOutput?,
        deviceAnalysis: PhotoLocalAnalysis, client: CubbyClient
    ) async {
        let isStale = stored.map { $0.analysisVersion < PhotoLocalAnalysis.currentVersion } ?? true
        guard isStale else {
            serverNote = .storedAtImport
            return
        }
        guard let detailSha = detail.sha256, deviceAnalysis.sha256 == detailSha,
            detail.status == .uploaded
        else {
            if let detailSha = detail.sha256, deviceAnalysis.sha256 != detailSha {
                serverNote = .bytesDiffer
            }
            return
        }
        let payload = ImageAnalysisOutput(
            analysisVersion: PhotoLocalAnalysis.currentVersion, analyzedAt: deviceAnalysis.analyzedAt,
            sha256: deviceAnalysis.sha256, capturedAt: deviceAnalysis.capturedAt,
            contentType: deviceAnalysis.contentType, width: deviceAnalysis.width,
            height: deviceAnalysis.height,
            classifications: deviceAnalysis.classifications.map {
                .init(identifier: $0.identifier, confidence: $0.confidence)
            },
            recognizedText: deviceAnalysis.recognizedText.map {
                .init(text: $0.text, confidence: $0.confidence)
            },
            featurePrint: .init(
                revision: deviceAnalysis.featurePrint.revision,
                data: deviceAnalysis.featurePrint.data.base64EncodedString()),
            provenance: .init(
                source: .init(rawValue: deviceAnalysis.provenance.source.rawValue) ?? .files,
                localIdentifier: deviceAnalysis.provenance.localIdentifier,
                filename: deviceAnalysis.provenance.filename))
        do {
            let saved = try await client.recordImageAnalysis(id, payload)
            guard saved else { return }
            // The just-submitted payload is exactly what the device already analyzed — no need to
            // round-trip through a synthetic file to re-derive an identical report.
            self.server = self.device
            serverNote = .savedJustNow
        } catch {
            Diagnostics.report(error, context: "photos.diagnostics")
        }
    }
}

struct ImageDiagnosticsCompareView: View {
    let model: ImageDiagnosticsCompareModel

    var body: some View {
        if model.loading {
            Section { LoadingIndicator(label: "Analyzing photo…") }
        }
        if let error = model.error {
            Section { Text(error).foregroundStyle(PorcelainTokens.destructive) }
        }
        if model.server != nil || model.device != nil {
            Section("Server vs. device") {
                CompareRow(
                    label: "SHA-256", server: model.server?.identity.sha256,
                    device: model.device?.identity.sha256)
                CompareRow(
                    label: "Classifications",
                    server: model.server?.classifications.map(\.identifier).joined(separator: ", "),
                    device: model.device?.classifications.map(\.identifier).joined(separator: ", "))
                CompareRow(
                    label: "Recognized text",
                    server: model.server?.recognizedText.map(\.text).joined(separator: ", "),
                    device: model.device?.recognizedText.map(\.text).joined(separator: ", "))
                CompareRow(
                    label: "Suggested source", server: Self.sourceLabel(model.server),
                    device: Self.sourceLabel(model.device))
            }
            if let note = model.serverNote {
                Section {
                    Text(note.label).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private static func sourceLabel(_ report: PhotoDiagnosticsReport?) -> String? {
        guard let key = report?.suggestedSource else { return nil }
        return "\(EntityCatalog[key].emoji) \(EntityCatalog[key].singular)"
    }
}

private struct CompareRow: View {
    let label: String
    let server: String?
    let device: String?

    private var differs: Bool {
        guard let server, let device else { return false }
        return server != device
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(Font.porcelainLabel).foregroundStyle(.secondary)
            HStack(alignment: .top, spacing: 12) {
                CompareColumn(title: "Server (at import)", value: server)
                CompareColumn(title: "Device (now)", value: device)
            }
        }
        .foregroundStyle(differs ? PorcelainTokens.warning : PorcelainTokens.graphite)
    }
}

private struct CompareColumn: View {
    let title: String
    let value: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption2).foregroundStyle(.secondary)
            Text(value?.isEmpty == false ? value! : "—")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

extension ImageDiagnosticsCompareModel {
    /// Test/preview seam: sets the compared reports directly without a network call or a Vision run.
    func set(server: PhotoDiagnosticsReport?, device: PhotoDiagnosticsReport?, note: ServerNote?) {
        self.server = server
        self.device = device
        self.serverNote = note
    }
}

#Preview("Server vs. device", traits: .modifier(SignedInPreview())) {
    let model = ImageDiagnosticsCompareModel()
    model.set(
        server: PreviewFixtures.samplePhotoDiagnosticsReport,
        device: PreviewFixtures.samplePhotoDiagnosticsReport, note: .storedAtImport)
    return List { ImageDiagnosticsCompareView(model: model) }
}

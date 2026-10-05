import CoreLocation
import CubbyKit
import MapKit
import SwiftUI

/// Images use image.detail; they do not have the generic resources.image.get route.
struct ImageEntityDetailView: View {
    enum Tab: String, CaseIterable { case photo = "Photo", diagnostics = "Diagnostics" }

    let id: ImageCode
    @Environment(AppModel.self) private var appModel
    @Environment(\.developerOverlays) private var developerOverlays
    @State private var detail: ImageWithEntity?
    @State private var error: String?
    @State private var tab: Tab = .photo
    @State private var diagnostics = ImageDiagnosticsCompareModel()
    @State private var processing = ImageProcessingHistoryModel()
    @State private var jobs = ImageJobHistoryModel()
    @State private var showingAllAnalyses = false
    @State private var showingAllJobs = false

    var body: some View {
        List {
            if let detail {
                Picker("View", selection: $tab) {
                    ForEach(Tab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .listRowSeparator(.hidden)
                switch tab {
                case .photo:
                    PhotoTab(
                        detail: detail, appModel: appModel, onChanged: { Task { await load() } },
                        preferredAnalysis: processing.preferred,
                        history: processing.entries,
                        totalAnalyses: processing.total, jobs: jobs.runs, totalJobs: jobs.total,
                        showingAllAnalyses: $showingAllAnalyses, showingAllJobs: $showingAllJobs)
                    if developerOverlays {
                        Section("Developer overlays") {
                            DevOverlayText(ImageDiagnostics.compareCaption(diagnostics))
                        }
                    }
                case .diagnostics:
                    if let url = detail.imageURL {
                        Section("Image being compared") {
                            DiagnosticPhotoPreview(
                                photo: .init(
                                    id: id.rawValue, filename: detail.filename, source: .remote(url)),
                                caption:
                                    "Local Vision comparison of Cubby's display rendition. This is separate from cloud and companion image processing."
                            )
                        }
                    }
                    ImageDiagnosticsCompareView(model: diagnostics)
                }
            } else if let error {
                InlineLoadFailure(message: error) { await load() }
            } else {
                ProgressView("Loading image…")
            }
        }
        .navigationTitle(detail?.filename ?? "Image")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
        .navigationDestination(for: Route.self) { route in
            RouteDestinationView(route: route)
        }
        .toolbar {
            ToolbarItem { ShareLink(item: appModel.webURL(for: id.rawValue)) }
            ToolbarItem {
                CopyDiagnosticsButton {
                    ImageDetailDiagnostics(
                        id: id.rawValue, preferredRepresentation: detail?.representations?.preferred,
                        preferredDescription: processing.preferred?.result.description,
                        serverSha256: diagnostics.server?.identity.sha256,
                        deviceSha256: diagnostics.device?.identity.sha256,
                        serverPerceptualHash: diagnostics.server?.identity.perceptualHash,
                        devicePerceptualHash: diagnostics.device?.identity.perceptualHash)
                }
            }
        }
        .task(id: "\(appModel.host):\(id.rawValue)") { await load() }
        .sheet(isPresented: $showingAllAnalyses) {
            NavigationStack {
                ImageAnalysisHistoryView(id: id, model: processing, client: appModel.client)
                    .navigationTitle("Description history")
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { showingAllAnalyses = false }
                        }
                    }
            }
        }
        .sheet(isPresented: $showingAllJobs) {
            NavigationStack {
                ImageJobHistoryView(id: id, model: jobs, client: appModel.client)
                    .navigationTitle("Processing jobs")
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { showingAllJobs = false }
                        }
                    }
            }
        }
        .onChange(of: tab) { _, newValue in
            guard newValue == .diagnostics, let detail else { return }
            diagnostics.run(id: id, detail: detail, client: appModel.client)
        }
        .onDisappear { diagnostics.cancel() }
    }

    private func load() async {
        error = nil
        do {
            async let detail = appModel.client.imageDetail(.init(id: id.rawValue))
            async let analyses = processing.load(id: id, client: appModel.client)
            async let jobLoad = jobs.load(id: id, client: appModel.client)
            self.detail = try await detail
            await analyses
            await jobLoad
        } catch {
            self.error = error.localizedDescription
            Diagnostics.report(error, context: "photos.imageDetail")
        }
    }
}

private struct PhotoTab: View {
    let detail: ImageWithEntity
    let appModel: AppModel
    /// Reloads the image after a verb on its sections changed it.
    let onChanged: () -> Void
    let preferredAnalysis: ImageDescriptionAnalysis?
    let history: [ImageAnalysisHistoryEntry]
    let totalAnalyses: Int
    let jobs: [ActivityRun]
    let totalJobs: Int
    @Binding var showingAllAnalyses: Bool
    @Binding var showingAllJobs: Bool

    var body: some View {
        if let url = detail.imageURL {
            Section("Preferred representation") {
                ZoomablePhoto(
                    url: url, id: detail.id.rawValue, filename: detail.filename
                )
                LabeledContent(
                    "Showing",
                    value: detail.representations?.preferredKind.rawValue.capitalized ?? "Original")
            }
        }
        if let original = detail.originalImageURL, let transparent = detail.transparentImageURL {
            Section("Compare representations") {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .top, spacing: 12) {
                        representation(title: "Original", url: original)
                        representation(title: "Cutout", url: transparent)
                    }
                    VStack(spacing: 12) {
                        representation(title: "Original", url: original)
                        representation(title: "Cutout", url: transparent)
                    }
                }
            }
        }
        LabeledContent("Image", value: detail.id.rawValue)
        Section("Preferred description") {
            if let analysis = preferredAnalysis {
                Text(analysis.result.description)
                LabeledContent("Provider", value: "\(analysis.provider) · \(analysis.model)")
                    .font(.caption)
            } else {
                Text("No AI description yet").foregroundStyle(.secondary)
            }
        }
        if !history.isEmpty {
            Section("AI history") {
                ForEach(Array(history.prefix(10).enumerated()), id: \.offset) { _, entry in
                    ImageAnalysisHistoryRow(entry: entry)
                }
                if totalAnalyses > 10 {
                    Button("View all \(totalAnalyses)") { showingAllAnalyses = true }
                }
            }
        }
        if !jobs.isEmpty {
            Section("Processing jobs") {
                ForEach(jobs.prefix(10), id: \.id) { job in
                    NavigationLink(value: Route.activityDetail(job.id)) {
                        ImageJobRow(job: job)
                    }
                }
                if totalJobs > 10 {
                    Button("View all \(totalJobs)") { showingAllJobs = true }
                }
            }
        }
        Section("Provenance") {
            ProvenanceRows(detail: detail)
        }
        if let sightings = detail.sightings, !sightings.isEmpty {
            Section("In libraries") {
                ForEach(Array(sightings.enumerated()), id: \.offset) { _, sighting in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(
                            "\(sighting.ownerName ?? "Unknown owner") · \(sighting.deviceName ?? "Unknown device")"
                        )
                        Text(
                            (sighting.capturedAt ?? sighting.observedAt)
                                .formatted(date: .abbreviated, time: .omitted)
                        )
                        .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        Section("Used in") {
            ReportDetailSlot(
                slot: .image_associations, id: detail.id.rawValue,
                host: EntityCatalog[.image].row(from: (try? JSONValue(encoding: detail)) ?? .null)
                    .map { ReportHost(entity: .image, row: $0, onChanged: onChanged) })
        }
    }

    private func representation(title: String, url: URL) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            ZoomablePhoto(url: url, id: "\(detail.id.rawValue)-\(title)", filename: detail.filename)
                .frame(maxHeight: 280)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

@Observable
@MainActor
private final class ImageJobHistoryModel {
    private(set) var runs: [ActivityRun] = []
    private(set) var total = 0
    private(set) var nextCursor: String?
    private(set) var loading = false

    func load(id: ImageCode, client: CubbyClient, reset: Bool = true) async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let page = try await client.activityRuns(
                filters: .init(subjectID: id.rawValue), cursor: reset ? nil : nextCursor,
                limit: reset ? 10 : 20)
            runs = reset ? page.items : runs + page.items
            total = page.total
            nextCursor = page.nextCursor
        } catch {
            Diagnostics.report(error, context: "photos.imageJobHistory")
        }
    }
}

private struct ImageJobRow: View {
    let job: ActivityRun

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(job.kind == .subjectLift ? "Image cutout" : "Image description")
            Text(
                "\(job.state.replacingOccurrences(of: "_", with: " ").capitalized) · \(job.createdAt.formatted(.relative(presentation: .named)))"
            )
            .font(.caption).foregroundStyle(.secondary)
        }
    }
}

private struct ImageJobHistoryView: View {
    let id: ImageCode
    let model: ImageJobHistoryModel
    let client: CubbyClient

    var body: some View {
        List {
            ForEach(model.runs, id: \.id) { job in
                NavigationLink(value: Route.activityDetail(job.id)) { ImageJobRow(job: job) }
            }
            if model.nextCursor != nil {
                Button("Load more") {
                    Task { await model.load(id: id, client: client, reset: false) }
                }
            }
        }
        .navigationDestination(for: Route.self) { RouteDestinationView(route: $0) }
    }
}

@Observable
@MainActor
private final class ImageProcessingHistoryModel {
    private(set) var analyses: [ImageDescriptionAnalysis] = []
    private(set) var currentAnalyses: [ImageDescriptionAnalysis] = []
    private(set) var unparsed: [UnparsedImageAnalysis] = []
    private(set) var total = 0
    private(set) var nextCursor: String?
    private(set) var loading = false
    var preferred: ImageDescriptionAnalysis? {
        currentAnalyses.first(where: \.preferred) ?? currentAnalyses.first
    }
    var entries: [ImageAnalysisHistoryEntry] {
        (analyses.map(ImageAnalysisHistoryEntry.parsed)
            + unparsed.map(ImageAnalysisHistoryEntry.unparsed))
            .sorted { $0.createdAt > $1.createdAt }
    }

    func load(id: ImageCode, client: CubbyClient, reset: Bool = true) async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let page = try await client.imageAnalyses(
                .init(id: id.rawValue, cursor: reset ? nil : nextCursor, limit: reset ? 10 : 20))
            if reset {
                do {
                    currentAnalyses = try await client.imageProcessingStatus(.init(id: id.rawValue)).analyses
                } catch {
                    Diagnostics.report(error, context: "photos.imageProcessingStatus")
                }
            }
            analyses = reset ? page.items : analyses + page.items
            unparsed = reset ? page.unparsed : unparsed + page.unparsed
            total = page.total
            nextCursor = page.nextCursor
        } catch {
            Diagnostics.report(error, context: "photos.imageAnalysisHistory")
        }
    }
}

private typealias UnparsedImageAnalysis = ImageAnalysisHistoryOutput.UnparsedPayloadPayload

private enum ImageAnalysisHistoryEntry {
    case parsed(ImageDescriptionAnalysis)
    case unparsed(UnparsedImageAnalysis)

    var createdAt: Date {
        switch self {
        case .parsed(let analysis): analysis.createdAt
        case .unparsed(let analysis): analysis.createdAt
        }
    }
}

private struct ImageAnalysisRow: View {
    let analysis: ImageDescriptionAnalysis

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(analysis.result.description).lineLimit(3)
                if analysis.preferred { Image(systemName: "checkmark.seal.fill").foregroundStyle(.tint) }
            }
            Text(
                "\(analysis.provider) · \(analysis.model) · \(analysis.createdAt.formatted(.relative(presentation: .named)))"
            )
            .font(.caption).foregroundStyle(.secondary)
            Text("Cutout: \(analysis.result.cutoutEligibility.rawValue)")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}

private struct ImageAnalysisHistoryRow: View {
    let entry: ImageAnalysisHistoryEntry

    var body: some View {
        switch entry {
        case .parsed(let analysis):
            ImageAnalysisRow(analysis: analysis)
        case .unparsed(let analysis):
            DisclosureGroup {
                LabeledContent("Prompt version", value: analysis.promptVersion)
                if let revision = analysis.resultSchemaRevision {
                    LabeledContent("Result schema", value: String(revision))
                }
                Text(analysis.reason).foregroundStyle(FieldGuideTokens.destructive)
                Text(analysis.rawResultJson)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
            } label: {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Unsupported historical result")
                    Text(
                        "\(analysis.provider ?? "Unknown provider") · \(analysis.model ?? "Unknown model") · \(analysis.createdAt.formatted(.relative(presentation: .named)))"
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            }
        }
    }
}

private struct ImageAnalysisHistoryView: View {
    let id: ImageCode
    let model: ImageProcessingHistoryModel
    let client: CubbyClient

    var body: some View {
        List {
            ForEach(Array(model.entries.enumerated()), id: \.offset) { _, entry in
                ImageAnalysisHistoryRow(entry: entry)
            }
            if model.nextCursor != nil {
                Button("Load more") {
                    Task {
                        await model.load(id: id, client: client, reset: false)
                    }
                }
            }
        }
    }
}

private struct ZoomablePhoto: View {
    let url: URL
    let id: String
    let filename: String
    @State private var scale = 1.0

    var body: some View {
        PhotoAttachmentImage(
            photo: PhotoAttachment(id: id, filename: filename, source: .remote(url)),
            renderedWidth: nil
        )
        .scaleEffect(scale)
        .frame(maxWidth: .infinity, maxHeight: 420)
        .clipped()
        .contentShape(.rect)
        .gesture(
            MagnifyGesture().onChanged { value in
                scale = min(5, max(1, value.magnification))
            }
        )
        .onTapGesture(count: 2) { scale = scale > 1 ? 1 : 2 }
        .accessibilityLabel("\(filename), pinch to zoom")
    }
}

/// Developer overlays layer 5: server vs. device sha256/pHash, read from whichever
/// `ImageDiagnosticsCompareModel` results are already loaded (the Diagnostics tab having been
/// visited this session) — never triggers a device analysis just for this caption.
private enum ImageDiagnostics {
    static func compareCaption(_ model: ImageDiagnosticsCompareModel) -> String {
        guard model.server != nil || model.device != nil else {
            return "Local Vision comparison: not run"
        }
        let server = model.server?.identity.sha256.prefix(12) ?? "—"
        let device = model.device?.identity.sha256.prefix(12) ?? "—"
        let serverHash = model.server?.identity.perceptualHash ?? "—"
        let deviceHash = model.device?.identity.perceptualHash ?? "—"
        return
            "Local Vision: sha256 stored \(server) · current \(device) — pHash stored \(serverHash) · current \(deviceHash)"
    }
}

/// Layer 7's "Copy diagnostics" payload for the Photo tab.
private struct ImageDetailDiagnostics: Encodable {
    let id: String
    let preferredRepresentation: String?
    let preferredDescription: String?
    let serverSha256: String?
    let deviceSha256: String?
    let serverPerceptualHash: String?
    let devicePerceptualHash: String?
}

/// The "Provenance" section's rows: capture date/place/attribution, plus a small non-interactive
/// map when a location is known. Detail-only data (`ImageWithEntity`, not the list projection).
private struct ProvenanceRows: View {
    let detail: ImageWithEntity

    var body: some View {
        if let capturedAt = detail.capturedAt {
            LabeledContent(
                "Captured",
                value: Self.captureDateText(capturedAt, offsetMinutes: detail.capturedAtOffsetMinutes))
        }
        if let placeName = detail.capturePlaceName {
            LabeledContent("Place", value: placeName)
        }
        if let capturedByName = detail.capturedByName {
            LabeledContent("Captured by", value: capturedByName)
        }
        if let captureDeviceLabel = detail.captureDeviceLabel {
            LabeledContent("Device", value: captureDeviceLabel)
        }
        LabeledContent("Source") {
            HStack(spacing: FieldGuideTokens.Space.xs) {
                ProvenanceBadge(text: Self.sourceLabel(detail.source))
                ProvenanceBadge(text: Self.attributionLabel(detail.captureAttribution))
            }
        }
        // The server words the evidence (`display.detailLabelPath`); nothing here re-joins it.
        if let evidence = detail.provenanceEvidenceLabel {
            LabeledContent("Evidence", value: evidence)
        }
        if let location = detail.captureLocation {
            ProvenanceMapRow(location: location)
                .listRowInsets(EdgeInsets())
        }
    }

    private static func captureDateText(_ date: Date, offsetMinutes: Int?) -> String {
        let base = date.formatted(date: .abbreviated, time: .shortened)
        guard let offsetMinutes else { return base }
        let sign = offsetMinutes < 0 ? "-" : "+"
        let magnitude = abs(offsetMinutes)
        let offset = String(format: "%@%02d:%02d", sign, magnitude / 60, magnitude % 60)
        return "\(base) (\(offset))"
    }

    private static func sourceLabel(_ source: ImageWithEntity.SourcePayload) -> String {
        switch source {
        case .own: "Own"
        case .catalog: "Catalog"
        case .unknown: "Unknown"
        case .screenshot: "Screenshot"
        }
    }

    private static func attributionLabel(_ attribution: ImageCaptureAttribution) -> String {
        switch attribution {
        case .none: "No attribution"
        case .derived: "Derived"
        case .ambiguous: "Ambiguous"
        case .confirmed: "Confirmed"
        }
    }
}

/// A small pill label for the Provenance section's source/attribution badges.
private struct ProvenanceBadge: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.fieldGuideLabel)
            .padding(.horizontal, FieldGuideTokens.Space.sm)
            .padding(.vertical, 2)
            .background(
                RoundedRectangle(cornerRadius: FieldGuideTokens.radiusChip)
                    .fill(FieldGuideTokens.inset)
            )
            .foregroundStyle(FieldGuideTokens.graphiteSecondary)
    }
}

/// A capped-height, non-interactive map so it never fights the surrounding List's scroll gesture
/// — a tap opens the location in Maps instead. Detail output only (`ImageCaptureLocation` never
/// appears on a list projection).
private struct ProvenanceMapRow: View {
    let location: ImageCaptureLocation
    @Environment(\.openURL) private var openURL

    private var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: location.lat, longitude: location.lng)
    }

    var body: some View {
        ZStack {
            Map(initialPosition: .region(region)) {
                Marker("", coordinate: coordinate)
            }
            .allowsHitTesting(false)
            Color.clear.contentShape(.rect)
        }
        .frame(height: 110)
        .clipShape(RoundedRectangle(cornerRadius: FieldGuideTokens.radiusPanel))
        .padding(.horizontal, FieldGuideTokens.Space.md)
        .onTapGesture { openInMaps() }
        .accessibilityLabel("Capture location")
        .accessibilityAddTraits(.isButton)
    }

    private var region: MKCoordinateRegion {
        MKCoordinateRegion(center: coordinate, latitudinalMeters: 800, longitudinalMeters: 800)
    }

    private func openInMaps() {
        guard let url = URL(string: "https://maps.apple.com/?ll=\(location.lat),\(location.lng)")
        else { return }
        openURL(url)
    }
}

#Preview(traits: .modifier(SignedInPreview())) {
    NavigationStack { ImageEntityDetailView(id: ImageCode("IMG-2345")) }
}

#Preview("Developer overlays on", traits: .modifier(SignedInPreview())) {
    NavigationStack { ImageEntityDetailView(id: ImageCode("IMG-2345")) }
        .environment(\.developerOverlays, true)
}

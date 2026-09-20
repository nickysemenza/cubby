import CubbyKit
import SwiftUI

#if os(macOS)
    import AppKit
#else
    import UIKit
#endif

struct PhotoMatchInspectionView: View {
    @Bindable var model: PhotoMatchInspectionModel
    let inspect: () -> Void
    @State private var sharing = false

    var body: some View {
        Group {
            Section {
                TextField("Expected owner shortcode (optional)", text: $model.expectedOwnerShortcode)
                    .font(.body.monospaced()).autocorrectionDisabled()
                    .accessibilityIdentifier("photos.match.expectedOwner")
                HStack {
                    Button("Inspect photo match", systemImage: "magnifyingglass", action: inspect)
                        .disabled(model.stage != nil)
                        .keyboardShortcut("i", modifiers: [.command, .shift])
                        .accessibilityIdentifier("photos.match.inspect")
                    Spacer()
                }
                .accessibilityElement(children: .contain)
                if let stage = model.stage {
                    ProgressView(stage)
                    Button("Cancel inspection", role: .cancel) { model.cancel() }
                }
            } footer: {
                Text(
                    "Read-only: snapshots the current match, then requests fresh Photos images and the server index. May download from iCloud. Does not repair hashes, update caches, or upload photos."
                )
                .lineLimit(nil).fixedSize(horizontal: false, vertical: true)
            }
            if let report = model.report {
                PhotoMatchSnapshotSection(report: report)
                PhotoMatchInputSection(
                    title: "Full-frame Photos thumbnail", input: report.inputs.thumbnail,
                    cachedHash: report.cacheRead.perceptualHash, image: model.thumbnail)
                PhotoMatchInputSection(
                    title: "Materialized file hash input", input: report.inputs.materialized,
                    cachedHash: report.cacheRead.perceptualHash, image: model.materializedThumbnail)
                if let sha = report.inputs.file.sha256 {
                    Section("Materialized file bytes") {
                        Text(sha).font(.caption.monospaced()).textSelection(.enabled)
                        Text(
                            "SHA-256 describes these file bytes, not the original Cubby upload or a CDN rendition."
                        )
                        .font(.caption).foregroundStyle(.secondary)
                    }
                }
                if let distance = report.thumbnailToMaterializedDistance {
                    Section {
                        LabeledContent("Thumbnail ↔ materialized hash distance", value: String(distance))
                    }
                }
                Section("Index comparisons") {
                    if report.entries.isEmpty {
                        Text(
                            "No relevant entries in the available indexes. Enter an expected owner to include images outside the candidate threshold."
                        )
                        .foregroundStyle(.secondary)
                    }
                    ForEach(
                        report.entries.map { entry in
                            (
                                id: "entry:\(entry.indexSource.rawValue):\(entry.entry.id.rawValue)",
                                value: entry
                            )
                        }, id: \.id
                    ) { entry in
                        PhotoMatchEntryView(evaluation: entry.value)
                    }
                }
                if !report.issues.isEmpty {
                    Section("Incomplete or unavailable evidence") {
                        ForEach(
                            report.issues.enumerated().map { (id: "issue:\($0.offset)", value: $0.element) },
                            id: \.id
                        ) { item in
                            Label {
                                Text("\(item.value.stage.rawValue): \(item.value.message)")
                            } icon: {
                                Image(systemName: "exclamationmark.triangle")
                            }
                        }
                    }
                }
                exportSection
            }
            if model.file != nil {
                Section {
                    Button("Analyze image contents", systemImage: "text.viewfinder") {
                        model.analyzeContents()
                    }
                    .disabled(model.stage != nil)
                    Text(
                        "Optional classification and text diagnostics; results are not saved to the library cache."
                    )
                    .font(.caption).foregroundStyle(.secondary)
                }
                PhotoDiagnosticsView(
                    model: model.contentDiagnostics,
                    photo: model.materializedThumbnail.map {
                        PhotoAttachment(
                            id: "analyzed-file", filename: "Materialized photo", source: .local($0))
                    })
            }
        }
        .buttonStyle(.bordered)
        #if os(iOS)
            .sheet(isPresented: $sharing) {
                if let export = model.export {
                    PhotoMatchShareSheet(export: export, onError: model.shareFailed)
                }
            }
        #endif
    }

    private var exportSection: some View {
        Section {
            Button("Copy JSON", systemImage: "doc.on.doc") {
                do {
                    let json = String(decoding: try model.json(), as: UTF8.self)
                    #if os(macOS)
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(json, forType: .string)
                    #else
                        UIPasteboard.general.string = json
                    #endif
                } catch { model.shareFailed(error) }
            }
            .accessibilityIdentifier("photos.match.copyJSON")
            if let export = model.export {
                #if os(macOS)
                    PhotoMatchSaveButton(export: export, onError: model.shareFailed)
                    PhotoMatchShareButton(export: export, onError: model.shareFailed)
                        .fixedSize()
                #else
                    Button("Share diagnostic files…", systemImage: "square.and.arrow.up") { sharing = true }
                        .accessibilityIdentifier("photos.match.share")
                #endif
            }
            if let error = model.exportError {
                Label(error, systemImage: "exclamationmark.triangle")
            }
        } footer: {
            Text(
                "Exports contain private photo identifiers, index entries, and photo files. Share only with someone you trust. The PNG preserves the thumbnail used for hashing."
            )
            .lineLimit(nil).fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct PhotoMatchSnapshotSection: View {
    let report: PhotoMatchDiagnosticReport

    var body: some View {
        Section("Before inspection") {
            LabeledContent("Grid state", value: report.initial.state)
            if let coverage = report.initial.coverage { Text(coverage).foregroundStyle(.secondary) }
            LabeledContent(
                "Registered query", value: report.initial.registeredQuery?.perceptualHash.hex ?? "None")
            LabeledContent("Cached hash", value: report.cacheRead.perceptualHash?.hex ?? "None")
            LabeledContent(
                "Cached hash revision", value: report.cacheRead.revision.map(String.init) ?? "None")
            LabeledContent("Current algorithm revision", value: String(PerceptualHash64.algorithmRevision))
            LabeledContent("Grid candidates", value: String(report.candidates.count))
            LabeledContent("Loaded index entries", value: String(report.loadedServerEntries.count))
            LabeledContent("Fresh server read", value: report.freshServerIndex.status.rawValue)
            if let message = report.freshServerIndex.message { Text(message).foregroundStyle(.secondary) }
        }
        .font(.subheadline)
        .textSelection(.enabled)
    }
}

private struct PhotoMatchInputSection: View {
    let title: String
    let input: PhotoMatchDiagnosticReport.HashInput
    let cachedHash: PerceptualHash64?
    let image: CGImage?

    var body: some View {
        Section(title) {
            if let image {
                DiagnosticPhotoPreview(
                    photo: .init(id: title, filename: title, source: .local(image)),
                    caption:
                        "Exact \(image.width) × \(image.height) input used for this hash. Tap to enlarge.")
            }
            LabeledContent("Perceptual hash", value: input.actualHash?.hex ?? "Unavailable")
                .font(.body.monospaced())
            if let width = input.width, let height = input.height {
                LabeledContent("Actual hash input", value: "\(width) × \(height)")
            }
            if let width = input.originalWidth, let height = input.originalHeight {
                LabeledContent("Source dimensions", value: "\(width) × \(height)")
            }
            if let ratio = input.aspectRatio {
                LabeledContent("Input aspect ratio", value: String(format: "%.6f", ratio))
            }
            if let ratio = input.originalAspectRatio {
                LabeledContent("Source aspect ratio", value: String(format: "%.6f", ratio))
            }
            if let cachedHash, let freshHash = input.actualHash {
                LabeledContent("Distance from cached hash", value: String(cachedHash.distance(to: freshHash)))
            }
        }.textSelection(.enabled)
    }
}

private struct PhotoMatchEntryView: View {
    let evaluation: PhotoMatchDiagnosticReport.EntryEvaluation

    var body: some View {
        DiagnosticStoredPhotoPreview(id: evaluation.entry.id)
        DisclosureGroup {
            comparison("Registered content → stored content", evaluation.registeredQueryToContent)
            comparison("Registered source → stored content", evaluation.registeredSourceToContent)
            comparison("Registered source → stored source", evaluation.registeredSourceToSource)
            comparison("Registered content → stored source", evaluation.registeredQueryToSource)
            comparison("Thumbnail → stored content", evaluation.thumbnailToContent)
            comparison("Thumbnail → stored source", evaluation.thumbnailToSource)
            comparison("Materialized → stored content", evaluation.materializedToContent)
            comparison("Materialized → stored source", evaluation.materializedToSource)
        } label: {
            VStack(alignment: .leading) {
                Text(evaluation.entry.id.rawValue).font(.body.monospaced())
                Text(evaluation.indexSource == .loaded ? "Grid index snapshot" : "Fresh server index")
                    .font(.caption).foregroundStyle(.secondary)
                Text(Set(evaluation.entry.directOwnerShortcodes).sorted().joined(separator: ", "))
                    .font(.caption.monospaced())
                if evaluation.selectedBecauseExpectedOwner {
                    Text("Included by expected owner").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder private func comparison(_ title: String, _ pair: PhotoMatchDiagnosticReport.PairEvaluation?)
        -> some View
    {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.subheadline)
            if let pair {
                Text("Distance \(pair.distance) · \(pair.verdict.confidence.rawValue)")
                Text(reason(pair.verdict.reason)).font(.caption).foregroundStyle(.secondary)
            } else {
                Text("Fingerprint unavailable").font(.caption).foregroundStyle(.secondary)
            }
        }.textSelection(.enabled)
    }

    private func reason(_ reason: PhotoMatchVerdict.Reason) -> String {
        switch reason {
        case .exactDistance: "Distance 0–2 is strong; aspect-ratio agreement is not required."
        case .aspectRatiosAgree: "Distance 3–6 and aspect ratios agree within 2%."
        case .missingAspectRatio:
            "Distance 3–6, but dimensions needed for aspect-ratio comparison are missing."
        case .aspectRatiosDiffer: "Distance 3–6, but aspect ratios differ by more than 2%."
        case .distanceTooLarge: "Distance exceeds 6, outside the candidate threshold."
        }
    }
}

#Preview("Read-only match inspector") {
    List { PhotoMatchInspectionView(model: PhotoMatchInspectionModel(), inspect: {}) }
}

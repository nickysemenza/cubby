import CubbyKit
import SwiftUI

#if os(iOS)
import PhotosUI
import UIKit
#elseif os(macOS)
import UniformTypeIdentifiers
#endif

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
            let identify = IdentifyModel(client: model.client)
            self.identify = identify
            await identify.prepare()
        }
    }
}

/// The real screen's content: owns the picker state and drives `IdentifyModel`. Split from
/// `IdentifyView` so the model is guaranteed non-nil here, matching `CaptureView`/`CaptureContent`.
private struct IdentifyContent: View {
    @Bindable var identify: IdentifyModel

    #if os(iOS)
    @State private var photoItem: PhotosPickerItem?
    @State private var showingCamera = false
    #elseif os(macOS)
    @State private var showingFileImporter = false
    #endif
    @State private var pickError: String?

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
        #if os(iOS)
        .onChange(of: photoItem) { _, newItem in
            Task { await loadPicked(newItem) }
        }
        .fullScreenCover(isPresented: $showingCamera) {
            CameraPicker { image in
                Task { await identify.identify(image) }
            }
            .ignoresSafeArea()
        }
        #elseif os(macOS)
        .fileImporter(isPresented: $showingFileImporter, allowedContentTypes: [.image]) { result in
            handleFileImport(result)
        }
        #endif
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
            LazyVGrid(columns: porcelainTwoColumns, spacing: PorcelainTokens.Space.md) {
                photoSourceControls
            }
            if let pickError {
                Text(pickError)
                    .font(.porcelainLabel)
                    .foregroundStyle(PorcelainTokens.destructive)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private var photoSourceControls: some View {
        #if os(iOS)
        PhotosPicker(selection: $photoItem, matching: .images) {
            ActionTile(title: "Choose photo", symbol: "photo.on.rectangle", detail: "From your library")
        }
        .buttonStyle(.plain)
        if UIImagePickerController.isSourceTypeAvailable(.camera) {
            Button {
                showingCamera = true
            } label: {
                ActionTile(title: "Take photo", symbol: "camera", detail: "Use the camera")
            }
            .buttonStyle(.plain)
        } else {
            ActionTile(title: "Take photo", symbol: "camera", detail: "No camera here")
                .opacity(0.5)
        }
        #elseif os(macOS)
        Button {
            showingFileImporter = true
        } label: {
            ActionTile(title: "Choose image…", symbol: "photo.on.rectangle", detail: "From a file")
        }
        .buttonStyle(.plain)
        #endif
    }

    #if os(iOS)
    private func loadPicked(_ item: PhotosPickerItem?) async {
        guard let item else { return }
        pickError = nil
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else { return }
            let image = try CoverImageLoader.decode(data)
            await identify.identify(image)
        } catch {
            pickError = String(describing: error)
        }
        photoItem = nil
    }
    #elseif os(macOS)
    private func handleFileImport(_ result: Result<URL, any Error>) {
        pickError = nil
        switch result {
        case .success(let url):
            let accessing = url.startAccessingSecurityScopedResource()
            defer { if accessing { url.stopAccessingSecurityScopedResource() } }
            do {
                let data = try Data(contentsOf: url)
                let image = try CoverImageLoader.decode(data)
                Task { await identify.identify(image) }
            } catch {
                pickError = String(describing: error)
            }
        case .failure(let error):
            pickError = String(describing: error)
        }
    }
    #endif
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
                            NavigationLink(value: Route.entityDetail(.product, id: match.productID.rawValue)) {
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

#if os(iOS)
/// Wraps `UIImagePickerController`'s camera source. Only presented when
/// `isSourceTypeAvailable(.camera)` is true (never on the simulator), so `PhotosPicker` is the
/// path that always works during development.
private struct CameraPicker: UIViewControllerRepresentable {
    let onCapture: (CGImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let controller = UIImagePickerController()
        controller.sourceType = .camera
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onCapture: onCapture, dismiss: dismiss)
    }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onCapture: (CGImage) -> Void
        let dismiss: DismissAction

        init(onCapture: @escaping (CGImage) -> Void, dismiss: DismissAction) {
            self.onCapture = onCapture
            self.dismiss = dismiss
        }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage, let cgImage = image.cgImage {
                onCapture(cgImage)
            }
            dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            dismiss()
        }
    }
}
#endif

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

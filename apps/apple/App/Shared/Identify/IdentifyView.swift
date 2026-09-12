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
                ProgressView()
            }
        }
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
        List {
            Section {
                statusRow
            }
            Section("Photo") {
                photoSourceControls
                if let pickError {
                    Text(pickError)
                        .font(.footnote)
                        .foregroundStyle(PorcelainTokens.destructive)
                }
            }
            IdentifyResultsSection(
                matches: identify.candidates,
                probe: identify.probe,
                failure: failureMessage
            )
        }
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

    @ViewBuilder
    private var statusRow: some View {
        switch identify.phase {
        case .idle:
            Text("Starting…").foregroundStyle(PorcelainTokens.graphiteSecondary)
        case .indexing(let done, let total):
            HStack {
                Text("Indexing \(done)/\(total)")
                Spacer()
                ProgressView()
            }
        case .ready(let count):
            Text("\(count) products indexed")
        case .failed:
            Text("Index unavailable").foregroundStyle(PorcelainTokens.destructive)
        }
    }

    @ViewBuilder
    private var photoSourceControls: some View {
        #if os(iOS)
        PhotosPicker(selection: $photoItem, matching: .images) {
            Label("Choose photo", systemImage: "photo.on.rectangle")
        }
        if UIImagePickerController.isSourceTypeAvailable(.camera) {
            Button {
                showingCamera = true
            } label: {
                Label("Take photo", systemImage: "camera")
            }
        }
        #elseif os(macOS)
        Button {
            showingFileImporter = true
        } label: {
            Label("Choose image…", systemImage: "photo.on.rectangle")
        }
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

/// The probe thumbnail and ranked list, shared by the real screen and `#Preview`s so neither
/// needs a network round trip or a live `FeaturePrintIndex` to render.
struct IdentifyResultsSection: View {
    let matches: [IdentificationCandidate]
    let probe: CGImage?
    var failure: String? = nil

    var body: some View {
        if let probe {
            Section("Probe") {
                ProbeThumbnail(image: probe)
            }
        }
        Section("Matches") {
            if let failure {
                ContentUnavailableView(
                    "Couldn't identify this photo",
                    systemImage: "exclamationmark.triangle",
                    description: Text(failure)
                )
            } else if matches.isEmpty {
                ContentUnavailableView(
                    "No matches yet",
                    systemImage: "camera.viewfinder",
                    description: Text("Choose or take a photo to rank it against your products.")
                )
            } else {
                ForEach(Array(matches.enumerated()), id: \.element.id) { position, match in
                    NavigationLink(value: Route.entityDetail(.product, id: match.productID.rawValue)) {
                        CandidateRow(match: match, emphasized: position == 0)
                    }
                }
            }
        }
    }
}

private struct ProbeThumbnail: View {
    let image: CGImage

    var body: some View {
        Image(decorative: image, scale: 1)
            .resizable()
            .scaledToFit()
            .frame(maxWidth: 160, maxHeight: 160)
            .clipShape(RoundedRectangle(cornerRadius: PorcelainTokens.radiusMedium))
    }
}

private struct CandidateRow: View {
    let match: IdentificationCandidate
    let emphasized: Bool

    var body: some View {
        HStack(spacing: PorcelainTokens.spacing * 1.5) {
            AsyncImage(url: match.imageURL) { phase in
                if case .success(let image) = phase {
                    image.resizable().scaledToFill()
                } else {
                    placeholder
                }
            }
            .frame(width: 44, height: 44)
            .clipShape(RoundedRectangle(cornerRadius: PorcelainTokens.radiusSmall))

            VStack(alignment: .leading, spacing: 2) {
                Text(match.name)
                    .font(emphasized ? .headline : .body)
                    .lineLimit(1)
                Text("distance \(String(format: "%.3f", match.distance))")
                    .font(.footnote)
                    .foregroundStyle(emphasized ? PorcelainTokens.cobalt : PorcelainTokens.graphiteSecondary)
            }
        }
    }

    private var placeholder: some View {
        RoundedRectangle(cornerRadius: PorcelainTokens.radiusSmall)
            .fill(PorcelainTokens.inset)
            .overlay(Image(systemName: "photo").foregroundStyle(PorcelainTokens.graphiteSecondary))
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
        List {
            IdentifyResultsSection(matches: [], probe: nil)
        }
        .navigationTitle("Identify")
    }
}

#Preview("Matches") {
    NavigationStack {
        List {
            IdentifyResultsSection(matches: PreviewFixtures.sampleCandidates, probe: PreviewFixtures.sampleProbeImage)
        }
        .navigationTitle("Identify")
    }
}

#Preview("Failed") {
    NavigationStack {
        List {
            IdentifyResultsSection(matches: [], probe: PreviewFixtures.sampleProbeImage, failure: "Vision feature print request failed.")
        }
        .navigationTitle("Identify")
    }
}

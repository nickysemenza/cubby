import CubbyKit
import SwiftUI

/// Picks, previews, and uploads one photo for an entity. Shows the lifted subject next to the
/// original when Vision found one, with a cutout preview and cover choice underneath.
struct AddPhotoSheet: View {
    @Bindable var capture: PhotoCaptureModel
    var onDone: (ImageCode) -> Void
    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var previewing = false
    @State private var reviewDraft: PhotoReviewDraft?
    @State private var path: [AddPhotoRoute] = []
    @State private var preparingUpload = false
    @State private var operationTask: Task<Void, Never>?
    @State private var refreshingMatches = false
    @State private var draftDismissal = DraftDismissalState()
    @State private var keepsPendingWriteAfterDismiss = false
    @State private var deliveredResult = false

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: PorcelainTokens.Space.xl) {
                    switch capture.phase {
                    case .picking:
                        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
                            Eyebrow("Photo")
                            PhotoSourceButtons(maxSelectionCount: 1, reviewsUploads: false) { selections in
                                if let selection = selections.first {
                                    capture.receive(selection)
                                }
                            }
                        }
                    case .preparing:
                        Panel {
                            HStack(spacing: PorcelainTokens.Space.md) {
                                if let progress = capture.preparationProgress {
                                    ProgressView(value: progress, total: 1)
                                        .frame(width: 64)
                                } else {
                                    LoadingIndicator(label: "Preparing photo").controlSize(.small)
                                }
                                Text("Preparing the full-quality photo…")
                                    .font(.porcelainBody)
                                    .foregroundStyle(PorcelainTokens.graphiteSecondary)
                            }
                        }
                    case .lifting:
                        Panel {
                            HStack(spacing: PorcelainTokens.Space.md) {
                                LoadingIndicator(label: "Lifting subject").controlSize(.small)
                                Text("Lifting the subject…")
                                    .font(.porcelainBody)
                                    .foregroundStyle(PorcelainTokens.graphiteSecondary)
                            }
                        }
                    case .ready, .uploading, .failed:
                        preview
                        options
                        if case .uploading(let step) = capture.phase {
                            Panel {
                                HStack(spacing: PorcelainTokens.Space.md) {
                                    LoadingIndicator(label: Self.label(for: step)).controlSize(.small)
                                    Text(Self.label(for: step))
                                        .font(.porcelainBody)
                                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                                }
                            }
                        }
                        if preparingUpload {
                            Panel {
                                HStack(spacing: PorcelainTokens.Space.md) {
                                    LoadingIndicator(label: "Checking final photo").controlSize(.small)
                                    Text("Checking the final photo…")
                                        .font(.porcelainBody)
                                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                                }
                            }
                        }
                        if case .failed(let message) = capture.phase {
                            Text(message)
                                .font(.porcelainLabel)
                                .foregroundStyle(PorcelainTokens.destructive)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    case .done:
                        Panel {
                            HStack(spacing: PorcelainTokens.Space.md) {
                                Image(systemName: "checkmark.circle")
                                    .foregroundStyle(PorcelainTokens.cobalt)
                                Text("Added to \(capture.entityTitle)")
                                    .font(.porcelainTitle)
                                    .foregroundStyle(PorcelainTokens.graphite)
                            }
                        }
                    }
                }
                .padding(PorcelainTokens.Space.lg)
                .frame(maxWidth: PorcelainTokens.readingWidth, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .porcelainScreen()
            .navigationTitle("Add photo")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { requestCancel() }
                        .accessibilityIdentifier("photo.add.cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    switch capture.phase {
                    case .done(let id):
                        Button("Done") {
                            deliverResult(id)
                            dismiss()
                        }
                        .disabled(refreshingMatches)
                        .accessibilityIdentifier("photo.add.done")
                    case .ready, .failed:
                        Button("Upload") { startPreparingUpload() }
                            .disabled(capture.chosen == nil || !capture.canUpload || preparingUpload)
                            .accessibilityIdentifier("photo.add.upload")
                    default:
                        EmptyView()
                    }
                }
            }
            .navigationDestination(for: AddPhotoRoute.self) { route in
                switch route {
                case .review:
                    if let reviewDraft {
                        PhotoMatchReviewContent(
                            draft: reviewDraft,
                            onCancel: { path.removeLast() },
                            onContinue: { reviewed in
                                guard let reviewed = reviewed.first else { return }
                                capture.acceptFinalReview(reviewed)
                                path.removeLast()
                                startUpload()
                            })
                    }
                }
            }
        }
        .nativeSheet(.photo)
        .photoPreviewPresentation(isPresented: $previewing) {
            if let image = capture.chosen {
                PhotoPreview(
                    photos: [
                        PhotoAttachment(id: "selection", filename: "Selected photo", source: .local(image))
                    ], selectedID: "selection")
            }
        }
        .draftDismissal(
            $draftDismissal, isDirty: capture.hasDraft,
            isSaving: isUploading || preparingUpload,
            onDiscard: { dismiss() },
            onCloseWhileSaving: {
                keepsPendingWriteAfterDismiss = true
                dismiss()
            }
        )
        .onDisappear {
            guard !keepsPendingWriteAfterDismiss else { return }
            operationTask?.cancel()
            operationTask = nil
            capture.cancelPendingWork()
        }
    }

    private var isUploading: Bool {
        if case .uploading = capture.phase { return true }
        return false
    }

    @ViewBuilder
    private var preview: some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            Eyebrow(
                capture.lifted?.foundSubject == true
                    ? (capture.useLifted ? "Lifted subject" : "Original") : "Photo")
            if let image = capture.chosen {
                Button {
                    previewing = true
                } label: {
                    // A just-picked local image has no bucket URL to size a transform for.
                    PhotoAttachmentImage(
                        photo: PhotoAttachment(
                            id: "selection", filename: "Selected photo", source: .local(image)),
                        renderedWidth: nil
                    )
                    .frame(maxWidth: .infinity, maxHeight: 320)
                    .background(checkerboard)
                    .clipShape(RoundedRectangle(cornerRadius: PorcelainTokens.radiusPanel))
                    .overlay(
                        RoundedRectangle(cornerRadius: PorcelainTokens.radiusPanel)
                            .strokeBorder(PorcelainTokens.hairline, lineWidth: PorcelainTokens.hairlineWidth)
                    )
                }.buttonStyle(.plain).accessibilityLabel("Preview selected photo")
                    .accessibilityIdentifier("photo.add.preview")
            }
            if capture.lifted?.foundSubject == false {
                Text("No subject found; the photo goes up as it is.")
                    .font(.porcelainLabel)
                    .foregroundStyle(PorcelainTokens.graphiteSecondary)
            }
        }
    }

    private var checkerboard: some View {
        // A visible ground for a transparent lift; white otherwise.
        PorcelainTokens.inset
    }

    @ViewBuilder
    private var options: some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            Eyebrow("Options")
            Panel(padding: 0, spacing: 0) {
                if capture.lifted == nil {
                    Button {
                        capture.prepareLift()
                    } label: {
                        Label("Lift the subject", systemImage: "person.crop.rectangle")
                            .font(.porcelainBody)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(PorcelainTokens.Space.md)
                    }
                    .buttonStyle(.plain)
                    .disabled(!capture.canLift)
                    .accessibilityIdentifier("photo.add.liftSubject")
                    PanelDivider()
                }
                if capture.lifted?.foundSubject == true {
                    Picker("Preview", selection: $capture.useLifted) {
                        Text("Cutout").tag(true)
                        Text("Original").tag(false)
                    }
                    .pickerStyle(.segmented)
                    .padding(PorcelainTokens.Space.md)
                    PanelDivider()
                    Text("Preview only. Cubby uploads the original and stores the cutout with it.")
                        .font(.porcelainLabel)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                        .padding(PorcelainTokens.Space.md)
                    PanelDivider()
                }
                if capture.canMakeCover {
                    Toggle("Make it the cover", isOn: $capture.makeCover)
                        .font(.porcelainBody)
                        .padding(PorcelainTokens.Space.md)
                    PanelDivider()
                }
                Button {
                    capture.retake()
                } label: {
                    Label("Choose another", systemImage: "arrow.uturn.backward")
                        .font(.porcelainBody)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(PorcelainTokens.Space.md)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("photo.add.chooseAnother")
            }
            .disabled(isUploading || preparingUpload)
        }
    }

    private func prepareAndUpload() async {
        guard !preparingUpload else { return }
        preparingUpload = true
        defer {
            if !Task.isCancelled { preparingUpload = false }
        }
        do {
            guard let item = try await capture.finalSelectionForReview() else {
                await uploadAndRefreshMatches()
                return
            }
            try await appModel.photoMatches.check([item], client: appModel.client)
            let candidateIDs = Set(
                (appModel.photoMatches.candidates[item.id] ?? []).map(\.id))
            if candidateIDs.subtracting(item.approvedCandidates).isEmpty {
                capture.acceptFinalReview(item)
                await uploadAndRefreshMatches()
            } else {
                if reviewDraft?.items.first?.id != item.id {
                    reviewDraft = PhotoReviewDraft(items: [item])
                }
                path.append(.review)
            }
        } catch is CancellationError {
        } catch {
            capture.failPreparation(error)
        }
    }

    private func startPreparingUpload() {
        operationTask?.cancel()
        operationTask = Task { await prepareAndUpload() }
    }

    private func startUpload() {
        operationTask?.cancel()
        operationTask = Task { await uploadAndRefreshMatches() }
    }

    private func requestCancel() {
        draftDismissal.request(
            isDirty: capture.hasDraft, isSaving: isUploading,
            dismiss: dismiss)
    }

    private func uploadAndRefreshMatches() async {
        await capture.upload()
        guard !Task.isCancelled, capture.uses(client: appModel.client) else { return }
        if case .done(let id) = capture.phase {
            refreshingMatches = true
            await appModel.photoMatches.refresh(client: appModel.client)
            if !Task.isCancelled {
                refreshingMatches = false
                if keepsPendingWriteAfterDismiss { deliverResult(id) }
            }
        }
    }

    private func deliverResult(_ id: ImageCode) {
        guard !deliveredResult else { return }
        deliveredResult = true
        onDone(id)
    }

    private static func label(for step: PhotoUploader.Step) -> String {
        switch step {
        case .encoding: "Encoding…"
        case .presigning: "Asking for an upload slot…"
        case .uploading: "Uploading…"
        case .marking: "Confirming the upload…"
        case .attaching: "Attaching…"
        case .ordering: "Making it the cover…"
        case .done: "Done"
        }
    }
}

private enum AddPhotoRoute: Hashable {
    case review
}

#Preview {
    let model = PreviewFixtures.signedInModel()
    AddPhotoSheet(
        capture: PhotoCaptureModel(
            client: model.client, entity: .product, entityID: "PRD-2345", entityTitle: "Sample Product",
            featurePrints: model.featurePrints),
        onDone: { _ in }
    )
}

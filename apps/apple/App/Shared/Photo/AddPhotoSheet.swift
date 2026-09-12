import CubbyKit
import SwiftUI

/// Picks, previews, and uploads one photo for an entity. Shows the lifted subject next to the
/// original when Vision found one, with the background and cover choices underneath.
struct AddPhotoSheet: View {
    @Bindable var capture: PhotoCaptureModel
    var onDone: (ImageCode) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: PorcelainTokens.Space.xl) {
                    switch capture.phase {
                    case .picking:
                        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
                            Eyebrow("Photo")
                            PhotoSourceButtons { image in Task { await capture.receive(image) } }
                        }
                    case .lifting:
                        Panel {
                            HStack(spacing: PorcelainTokens.Space.md) {
                                ProgressView().controlSize(.small)
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
                                    ProgressView().controlSize(.small)
                                    Text(Self.label(for: step))
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
                    Button("Cancel") { dismiss() }
                        .disabled(isUploading)
                }
                ToolbarItem(placement: .confirmationAction) {
                    switch capture.phase {
                    case .done(let id):
                        Button("Done") {
                            onDone(id)
                            dismiss()
                        }
                    case .ready, .failed:
                        Button("Upload") { Task { await capture.upload() } }
                            .disabled(capture.chosen == nil)
                    default:
                        EmptyView()
                    }
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 480, minHeight: 520)
        #endif
    }

    private var isUploading: Bool {
        if case .uploading = capture.phase { return true }
        return false
    }

    @ViewBuilder
    private var preview: some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            Eyebrow(capture.lifted?.foundSubject == true ? (capture.useLifted ? "Lifted subject" : "Original") : "Photo")
            if let image = capture.chosen {
                Image(decorative: image, scale: 1)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity, maxHeight: 320)
                    .background(checkerboard)
                    .clipShape(RoundedRectangle(cornerRadius: PorcelainTokens.radiusPanel))
                    .overlay(
                        RoundedRectangle(cornerRadius: PorcelainTokens.radiusPanel)
                            .strokeBorder(PorcelainTokens.hairline, lineWidth: PorcelainTokens.hairlineWidth)
                    )
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
                if capture.lifted?.foundSubject == true {
                    Picker("Version", selection: $capture.useLifted) {
                        Text("Lifted").tag(true)
                        Text("Original").tag(false)
                    }
                    .pickerStyle(.segmented)
                    .padding(PorcelainTokens.Space.md)
                    PanelDivider()
                    Picker("Background", selection: $capture.background) {
                        Text("White").tag(SubjectLift.Background.white)
                        Text("Transparent").tag(SubjectLift.Background.transparent)
                    }
                    .pickerStyle(.segmented)
                    .padding(PorcelainTokens.Space.md)
                    .disabled(!capture.useLifted)
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
            }
            .disabled(isUploading)
        }
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

#Preview {
    let model = PreviewFixtures.signedInModel()
    AddPhotoSheet(
        capture: PhotoCaptureModel(client: model.client, entity: .product, entityID: "PRD-2345", entityTitle: "Sample Product", featurePrints: model.featurePrints),
        onDone: { _ in }
    )
}

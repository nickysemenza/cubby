import CubbyKit
import SwiftUI

struct NearbyReceiptSearchView: View {
    let context: NearbyReceiptSearchContext
    let onConfirm: @MainActor @Sendable (PhotoFile, NearbyReceiptSearchContext) async throws -> Void
    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var model = NearbyReceiptSearchModel()

    init(
        context: NearbyReceiptSearchContext,
        onConfirm:
            @escaping @MainActor @Sendable (
                PhotoFile, NearbyReceiptSearchContext
            ) async throws -> Void
    ) {
        self.context = context
        self.onConfirm = onConfirm
    }

    init(context: NearbyReceiptSearchContext, submitter: any ConfirmedReceiptImportSubmitting) {
        self.init(context: context) { file, context in
            try await submitter.submitConfirmedReceipt(
                ConfirmedReceiptImport(context: context, file: file))
        }
    }

    var body: some View {
        List {
            summary
            searchContent
            manualPicker
            if let error = model.error {
                Section { Text(error).foregroundStyle(PorcelainTokens.destructive) }
            }
        }
        .navigationTitle("Receipt photo")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button(model.isConfirming ? "Adding…" : "Use photo") {
                    model.confirm(context: context, submit: onConfirm)
                }
                .disabled(model.selectedItem == nil || model.isConfirming)
                .accessibilityIdentifier("receiptPhoto.confirm")
            }
        }
        .onDisappear { model.cancel() }
        .onChange(of: model.didConfirm) { _, didConfirm in
            if didConfirm { dismiss() }
        }
    }

    private var summary: some View {
        Section {
            LabeledContent("Date") { Text(context.transactionDate, format: .dateTime.month().day()) }
            if let merchant = context.merchant { LabeledContent("Merchant", value: merchant) }
            if let cents = context.amountInCents {
                LabeledContent("Amount") {
                    Text(Double(cents) / 100, format: .currency(code: "USD"))
                }
            }
        } footer: {
            Text(
                "Search runs on this device within three days of the charge. Nothing uploads until you select a photo and choose Use photo."
            )
        }
    }

    @ViewBuilder private var searchContent: some View {
        Section("Nearby photos") {
            switch model.phase {
            case .idle:
                Button("Find nearby photos", systemImage: "photo.badge.magnifyingglass") {
                    Task {
                        await appModel.preparePhotoSubsystem()
                        model.startSearch(
                            context: context, analysisStore: appModel.photoAnalysisStore)
                    }
                }
                .accessibilityIdentifier("receiptPhoto.findNearby")
            case .searching(let completed, let total):
                ProgressView(
                    "Checking \(completed) of \(total)", value: Double(completed),
                    total: Double(max(1, total)))
            case .results:
                if model.candidates.isEmpty {
                    ContentUnavailableView(
                        "No likely receipts", systemImage: "doc.text.magnifyingglass",
                        description: Text("Choose a photo manually below."))
                } else {
                    ForEach(model.candidates) { candidate in candidateRow(candidate) }
                }
            case .pickerRequired:
                ContentUnavailableView(
                    "Use the photo picker", systemImage: "photo.on.rectangle",
                    description: Text(
                        "Whole-library access is unavailable. The system picker below can share one photo without granting broader access."
                    ))
            case .failed:
                ContentUnavailableView("Search unavailable", systemImage: "exclamationmark.triangle")
            }
        }
    }

    private var manualPicker: some View {
        Section("Choose manually") {
            PhotoSourceButtons(maxSelectionCount: 1, reviewsUploads: false) {
                model.receiveManualSelection($0)
            }
            if let item = model.selectedItem {
                HStack {
                    Image(decorative: item.preview, scale: 1)
                        .resizable().scaledToFill()
                        .frame(width: 52, height: 52).clipShape(RoundedRectangle(cornerRadius: 8))
                    Label("Ready for confirmation", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(PorcelainTokens.positive)
                }
            }
        }
    }

    private func candidateRow(_ candidate: NearbyReceiptSearchModel.Candidate) -> some View {
        Button {
            model.selectedID = candidate.id
        } label: {
            HStack {
                Image(decorative: candidate.item.preview, scale: 1)
                    .resizable().scaledToFill()
                    .frame(width: 52, height: 52).clipShape(RoundedRectangle(cornerRadius: 8))
                VStack(alignment: .leading) {
                    Text(candidate.capturedAt, format: .dateTime.month().day().hour().minute())
                    Text("Match \(candidate.score.total, format: .percent.precision(.fractionLength(0)))")
                        .font(.porcelainLabel)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                }
                Spacer()
                Image(systemName: model.selectedID == candidate.id ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(model.selectedID == candidate.id ? Color.accentColor : .secondary)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            "Photo from \(candidate.capturedAt.formatted(date: .abbreviated, time: .shortened))"
        )
        .accessibilityValue(model.selectedID == candidate.id ? "Selected" : "Not selected")
    }
}

#Preview(traits: .modifier(SignedInPreview())) {
    NavigationStack {
        NearbyReceiptSearchView(
            context: NearbyReceiptSearchContext(
                huntID: "HUNT-PREVIEW", transactionDate: .now, merchant: "Example Store",
                amountInCents: 2499)
        ) { _, _ in }
    }
}

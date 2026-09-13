import CubbyKit
import SwiftUI

/// A single-shot code lookup, presented from Search's toolbar and empty state: scan or type a
/// code, then act on what it resolves to. Unlike `CaptureView`'s sweep, there is no location and
/// no tally — this answers "what is this" and hands off, it never writes stock itself.
struct ScanLookupSheet: View {
    /// Called when the resolved value is plain text (not a code at all); the caller feeds it back
    /// into `SearchModel.query` so the field's search takes over. Defaults to a no-op so the sheet
    /// can be previewed standalone.
    var onTextResolved: (String) -> Void = { _ in }
    /// Preview-only seed for the outcome panel; never set by real callers.
    var previewOutcome: LookupOutcome?

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var manualEntry = ""
    @State private var resolving = false
    @State private var outcome: LookupOutcome?
    @State private var errorMessage: String?
    @State private var creatingProduct = false
    /// When each raw value was last accepted. Keyed per code because the scanner reports every
    /// code in frame, so two labels alternating (A, B, A…) must each keep their own window.
    @State private var recentReads: [String: Date] = [:]

    /// A repeat of a raw value inside this window is a re-read, not a new code — mirrors
    /// `ScanSession.debounceInterval` without touching `ScanDrain`, which this screen has no
    /// session to anchor.
    private static let repeatWindow: TimeInterval = 1.5

    var body: some View {
        NavigationStack {
            content
                .porcelainScreen()
                .navigationTitle("Scan a code")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                    }
                }
        }
        .task { outcome = previewOutcome }
    }

    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PorcelainTokens.Space.lg) {
                #if os(iOS)
                    scannerSlot
                #endif
                manualEntryField
                if resolving {
                    ProgressView().frame(maxWidth: .infinity)
                } else if let outcome {
                    outcomePanel(outcome)
                } else if let errorMessage {
                    Panel {
                        Text(errorMessage)
                            .font(.porcelainBody)
                            .foregroundStyle(PorcelainTokens.destructive)
                    }
                }
            }
            .padding(PorcelainTokens.Space.lg)
            .frame(maxWidth: PorcelainTokens.readingWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .porcelainScreen()
    }

    #if os(iOS)
        private var scannerSlot: some View {
            RoundedRectangle(cornerRadius: PorcelainTokens.radiusPanel)
                .fill(PorcelainTokens.inset)
                .aspectRatio(4.0 / 3.0, contentMode: .fit)
                .frame(maxWidth: .infinity, maxHeight: 260)
                .overlay { ScannerSlot { raw in handleRead(raw) } }
                .clipShape(RoundedRectangle(cornerRadius: PorcelainTokens.radiusPanel))
                .overlay(
                    RoundedRectangle(cornerRadius: PorcelainTokens.radiusPanel)
                        .strokeBorder(PorcelainTokens.hairline, lineWidth: PorcelainTokens.hairlineWidth)
                )
        }
    #endif

    private var manualEntryField: some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            Eyebrow("Barcode, ISBN, or label")
            HStack(spacing: PorcelainTokens.Space.sm) {
                TextField("Barcode, ISBN, or label", text: $manualEntry)
                    .keyboardDismissBar()
                    .font(.porcelainCode)
                    .textFieldStyle(.plain)
                    .autocorrectionDisabled()
                    #if os(iOS)
                        .keyboardType(.asciiCapable)
                        .textInputAutocapitalization(.characters)
                    #endif
                    .onSubmit { handleRead(manualEntry) }
                    .padding(.horizontal, PorcelainTokens.Space.md)
                    .frame(height: PorcelainTokens.touchTarget)
                    .background(
                        RoundedRectangle(cornerRadius: PorcelainTokens.radiusControl)
                            .fill(PorcelainTokens.surface)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: PorcelainTokens.radiusControl)
                            .strokeBorder(PorcelainTokens.hairline, lineWidth: PorcelainTokens.hairlineWidth)
                    )
                Button("Look up") { handleRead(manualEntry) }
                    .font(.porcelainTitle)
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.roundedRectangle(radius: PorcelainTokens.radiusControl))
                    .tint(PorcelainTokens.cobalt)
                    .frame(height: PorcelainTokens.touchTarget)
                    .disabled(manualEntry.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }

    @ViewBuilder
    private func outcomePanel(_ outcome: LookupOutcome) -> some View {
        switch outcome {
        case .products(let rows, let code):
            ProductMatchesPanel(rows: rows, code: code) { row in
                RecentEntities.record(row.id)
                dismiss()
                model.navigator.openInPlace(.entity(.product, id: row.id))
            }
        case .unknownCode(let code, let catalog):
            UnknownCodePanel(code: code, catalog: catalog, creating: creatingProduct) {
                Task { await createProduct(code: code) }
            } onStock: {
                model.navigator.pendingCaptureCode = code.value
                dismiss()
                model.navigator.open(.capture(location: nil))
            }
        case .link, .text:
            // Both are handled synchronously by `resolve(_:)` (navigate or hand off to search)
            // and never linger as the panel's state.
            EmptyView()
        }
    }

    private func handleRead(_ raw: String) {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        let now = Date.now
        if let last = recentReads[value], now.timeIntervalSince(last) < Self.repeatWindow { return }
        recentReads[value] = now
        // Single-shot: the first code to reach the server wins. A second read while one is in
        // flight would race it for `outcome`, and the panel's Create/Stock buttons would then act
        // on whichever answer landed last.
        guard !resolving else { return }
        Task { await resolve(value) }
    }

    private func resolve(_ raw: String) async {
        resolving = true
        errorMessage = nil
        defer { resolving = false }
        do {
            let result = try await CodeLookup(service: model.client).resolve(raw)
            switch result {
            case .link(let link):
                dismiss()
                model.navigator.openInPlace(link)
            case .products(let rows, _) where rows.count == 1:
                if let row = rows.first {
                    RecentEntities.record(row.id)
                    dismiss()
                    model.navigator.openInPlace(.entity(.product, id: row.id))
                }
            case .text(let value):
                dismiss()
                onTextResolved(value)
            default:
                outcome = result
            }
        } catch {
            errorMessage = (error as? CubbyAPIError)?.detail?.message ?? String(describing: error)
            Diagnostics.report(error, context: "scanLookup.resolve")
        }
    }

    private func createProduct(code: ScanCode) async {
        creatingProduct = true
        defer { creatingProduct = false }
        do {
            guard let found = try await model.client.findOrCreateProduct(code: code) else { return }
            RecentEntities.record(found.product.id.rawValue)
            dismiss()
            model.navigator.openInPlace(.entity(.product, id: found.product.id.rawValue))
        } catch {
            errorMessage = (error as? CubbyAPIError)?.detail?.message ?? String(describing: error)
            Diagnostics.report(error, context: "scanLookup.createProduct")
        }
    }
}

#Preview("Manual entry") {
    ScanLookupSheet().environment(PreviewFixtures.signedInModel())
}

#Preview("Unknown code, catalog hit") {
    ScanLookupSheet(
        previewOutcome: .unknownCode(
            .barcode("00012345678905"),
            catalog: UPCLookup(
                upc: "00012345678905", name: "LED bulbs, 4-pack", manufacturer: "Acme", category: nil,
                priceDollars: nil, imageURL: nil, source: "upcitemdb", cached: false)
        )
    )
    .environment(PreviewFixtures.signedInModel())
}

#Preview("Multiple products") {
    ScanLookupSheet(
        previewOutcome: .products(PreviewFixtures.sampleRows, code: .barcode("012345678905"))
    )
    .environment(PreviewFixtures.signedInModel())
}

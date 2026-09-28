import CubbyKit
import SwiftUI

#if os(iOS)
    import VisionKit
#endif

/// The working screen of a walk: one bin's expected rows, a scanner/manual-entry pair for finding
/// what turns up, and the staged decisions overflow (strays, adoptions, a stale snapshot) that
/// need a look before "Done" can commit. A `List` root — not the `Panel`-over-`ScrollView` stack
/// the rest of the app uses — because the expected rows need real swipe actions.
struct BinView: View {
    let session: RecountSession

    @State private var manualEntry = ""
    @State private var showingStrays = false

    var body: some View {
        List {
            if let bin = session.currentBin {
                BinPassHeader(progress: session.progress, breadcrumb: breadcrumbText(for: bin))
                    .listRowBackground(FieldGuideTokens.canvas)
                    .listRowSeparator(.hidden)
            }
            #if os(iOS)
                scannerRow
            #endif
            manualEntryRow
            chipsRows
            rowsSection
            straysRow
            stalePanelRow
            errorRow
            footerRows
        }
        .listStyle(.plain)
        .fieldGuideScreen()
        .refreshControl { await session.reload() }
        .sheet(isPresented: $showingStrays) {
            BinStraysSheet(session: session)
        }
        .scanFeedback(latestScanFeedbackKind, trigger: session.chips)
    }

    /// Derived from `session.chips.first` (newest first — see `RecountSession.chips`): the most
    /// recent chip's status, reduced to a feedback kind. `session.chips` itself is the trigger
    /// passed to `.scanFeedback`, since it changes both when a new chip is pushed and when an
    /// existing one's status settles.
    private var latestScanFeedbackKind: ScanFeedbackKind? {
        session.chips.first.flatMap { ScanFeedbackKind(chipStatus: $0.status) }
    }

    private func breadcrumbText(for bin: LocationTreeNode) -> String {
        session.tree?.breadcrumb(of: bin.id).map(\.name).joined(separator: " › ") ?? bin.name
    }

    #if os(iOS)
        /// The same `DataScannerView` usage as `CaptureView`, minus its own "no camera" explanation:
        /// on the simulator (unsupported) and on macOS (compiled out entirely) the manual entry field
        /// below is the only way in, with nothing else competing for the eye.
        @ViewBuilder
        private var scannerRow: some View {
            if DataScannerViewController.isSupported {
                RoundedRectangle(cornerRadius: FieldGuideTokens.radiusPanel)
                    .fill(FieldGuideTokens.inset)
                    .aspectRatio(4.0 / 3.0, contentMode: .fit)
                    .frame(maxWidth: .infinity, maxHeight: 300)
                    // Floating labels come from the expected rows — a local match, never a
                    // request per frame — so the walk shows what is verified before you scan it.
                    .overlay {
                        ScannerSlot(
                            onRead: { code in session.submit(code) },
                            annotate: { raw in session.annotation(forScanned: raw) }
                        )
                    }
                    .clipShape(RoundedRectangle(cornerRadius: FieldGuideTokens.radiusPanel))
                    .overlay(
                        RoundedRectangle(cornerRadius: FieldGuideTokens.radiusPanel)
                            .strokeBorder(
                                FieldGuideTokens.hairline, lineWidth: FieldGuideTokens.hairlineWidth)
                    )
                    .listRowBackground(FieldGuideTokens.canvas)
                    .listRowSeparator(.hidden)
            }
        }
    #endif

    private var manualEntryRow: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            Eyebrow("Scan or type a code")
            HStack(spacing: FieldGuideTokens.Space.sm) {
                TextField("Barcode, ISBN, or PRD-/LOC- label", text: $manualEntry)
                    .keyboardDismissBar()
                    .font(.fieldGuideCode)
                    .textFieldStyle(.plain)
                    .autocorrectionDisabled()
                    #if os(iOS)
                        .keyboardType(.asciiCapable)
                        .textInputAutocapitalization(.characters)
                    #endif
                    .onSubmit(submitManualEntry)
                    .padding(.horizontal, FieldGuideTokens.Space.md)
                    .frame(height: FieldGuideTokens.touchTarget)
                    .background(
                        RoundedRectangle(cornerRadius: FieldGuideTokens.radiusControl)
                            .fill(FieldGuideTokens.surface)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: FieldGuideTokens.radiusControl)
                            .strokeBorder(
                                FieldGuideTokens.hairline, lineWidth: FieldGuideTokens.hairlineWidth)
                    )
                Button("Submit", action: submitManualEntry)
                    .font(.fieldGuideTitle)
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.roundedRectangle(radius: FieldGuideTokens.radiusControl))
                    .tint(FieldGuideTokens.interaction)
                    .frame(height: FieldGuideTokens.touchTarget)
                    .disabled(manualEntry.isEmpty)
            }
        }
        .listRowBackground(FieldGuideTokens.canvas)
        .listRowSeparator(.hidden)
    }

    private func submitManualEntry() {
        let value = manualEntry
        manualEntry = ""
        session.submit(value)
    }

    @ViewBuilder
    private var chipsRows: some View {
        if !session.chips.isEmpty {
            Eyebrow("Recent")
                .listRowBackground(FieldGuideTokens.canvas)
                .listRowSeparator(.hidden)
            ForEach(session.chips) { chip in
                ScanChipRow(chip: chip)
                    .fieldGuideListRow()
            }
        }
    }

    @ViewBuilder
    private var rowsSection: some View {
        Eyebrow("Expected in this bin")
            .listRowBackground(FieldGuideTokens.canvas)
            .listRowSeparator(.hidden)
        if session.rows.isEmpty {
            Text("Nothing expected here.")
                .font(.fieldGuideBody)
                .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                .listRowBackground(FieldGuideTokens.canvas)
                .listRowSeparator(.hidden)
        } else {
            ForEach(session.rows) { state in
                BinRowView(
                    session: session, row: state.row, resolution: state.resolution,
                    isDuplicate: state.isDuplicate
                )
                .fieldGuideListRow()
            }
        }
    }

    @ViewBuilder
    private var straysRow: some View {
        if !session.strays.isEmpty || !session.adoptions.isEmpty {
            Button {
                showingStrays = true
            } label: {
                HStack {
                    Text("\(session.strays.count) found elsewhere · \(session.adoptions.count) bins to adopt")
                        .font(.fieldGuideBody)
                        .foregroundStyle(FieldGuideTokens.graphite)
                    Spacer(minLength: FieldGuideTokens.Space.sm)
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                }
                .frame(minHeight: FieldGuideTokens.touchTarget)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .fieldGuideListRow()
        }
    }

    @ViewBuilder
    private var stalePanelRow: some View {
        switch session.stale {
        case .refetched:
            Text(
                "This bin changed since you loaded it. Your decisions were kept — check the rows and press Done again."
            )
            .font(.fieldGuideBody)
            .foregroundStyle(FieldGuideTokens.warning)
            .listRowBackground(FieldGuideTokens.canvas)
            .listRowSeparator(.hidden)
        case .needsReload:
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
                Text("This bin changed twice in a row. Reload to try again.")
                    .font(.fieldGuideBody)
                    .foregroundStyle(FieldGuideTokens.destructive)
                Button("Reload") { Task { await session.reload() } }
                    .buttonStyle(.bordered)
            }
            .listRowBackground(FieldGuideTokens.canvas)
            .listRowSeparator(.hidden)
        case nil:
            EmptyView()
        }
    }

    @ViewBuilder
    private var errorRow: some View {
        if let lastError = session.lastError {
            Text(lastError)
                .font(.fieldGuideLabel)
                .foregroundStyle(FieldGuideTokens.destructive)
                .listRowBackground(FieldGuideTokens.canvas)
                .listRowSeparator(.hidden)
        }
    }

    @ViewBuilder
    private var footerRows: some View {
        Text(unresolvedText)
            .font(.fieldGuideLabel)
            .foregroundStyle(FieldGuideTokens.graphiteSecondary)
            .listRowBackground(FieldGuideTokens.canvas)
            .listRowSeparator(.hidden)

        Button {
            Task { await session.commitBin() }
        } label: {
            Text("Done with bin").frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .tint(FieldGuideTokens.interaction)
        .frame(height: FieldGuideTokens.touchTarget)
        .disabled(session.busy || session.stale == .needsReload)
        .listRowBackground(FieldGuideTokens.canvas)
        .listRowSeparator(.hidden)

        Button {
            Task { await session.skipBin() }
        } label: {
            Text("Skip").frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .frame(height: FieldGuideTokens.touchTarget)
        .disabled(session.busy)
        .listRowBackground(FieldGuideTokens.canvas)
        .listRowSeparator(.hidden)
    }

    private var unresolvedText: String {
        session.unresolvedCount == 0
            ? "Everything counted."
            : "\(session.unresolvedCount) not counted yet — Done marks them verified."
    }
}

/// "Bin 3 of 12", the bin's name, a 1px fill bar for how far into the walk this bin sits, and the
/// path down from the scope so a bin found several levels deep still says where it is.
private struct BinPassHeader: View {
    let progress: RecountSession.Progress
    let breadcrumb: String

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            Eyebrow("Bin \(progress.binIndex) of \(progress.binTotal)")
            Text(progress.binName)
                .font(.fieldGuideHeadline)
                .foregroundStyle(FieldGuideTokens.graphite)
                .lineLimit(1)
            if !breadcrumb.isEmpty {
                Text(breadcrumb)
                    .font(.fieldGuideLabel)
                    .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                    .lineLimit(1)
            }
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Rectangle().fill(FieldGuideTokens.hairline)
                    Rectangle()
                        .fill(FieldGuideTokens.interaction)
                        .frame(width: geometry.size.width * fraction)
                }
            }
            .frame(height: FieldGuideTokens.hairlineWidth * 3)
        }
    }

    private var fraction: Double {
        guard progress.binTotal > 0 else { return 0 }
        return min(max(Double(progress.binIndex) / Double(progress.binTotal), 0), 1)
    }
}

#Preview("Bin — empty session") {
    @Previewable @State var appModel = PreviewFixtures.signedInModel()
    NavigationStack {
        BinView(session: RecountSession(service: appModel.client))
    }
    .environment(appModel)
}

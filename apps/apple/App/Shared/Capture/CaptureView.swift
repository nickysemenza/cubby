import CubbyKit
import SwiftUI

/// The sweep screen. The camera slot is iOS-only; the manual-entry field is permanent on every
/// platform because it is the only scan path on the simulator and on macOS.
struct CaptureView: View {
    @Environment(AppModel.self) private var model
    @State private var capture: CaptureModel?
    @State private var pickingLocation = false
    @State private var showingStrays = false

    var body: some View {
        Group {
            if let capture {
                CaptureContent(capture: capture, pickingLocation: $pickingLocation, showingStrays: $showingStrays)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .porcelainScreen()
        .navigationTitle("Capture")
        .task(id: model.host) {
            let capture = CaptureModel(client: model.client)
            self.capture = capture
            await capture.loadLocations()
        }
        .sheet(isPresented: $pickingLocation) {
            if let capture { LocationPickerSheet(capture: capture) }
        }
        .sheet(isPresented: $showingStrays) {
            if let capture { StraysView(session: capture.session) }
        }
    }
}

private struct CaptureContent: View {
    @Bindable var capture: CaptureModel
    @Binding var pickingLocation: Bool
    @Binding var showingStrays: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PorcelainTokens.Space.lg) {
                #if os(iOS)
                scannerSlot
                #endif
                locationRow
                manualEntry
                tally
                chips
            }
            .padding(PorcelainTokens.Space.lg)
            .frame(maxWidth: PorcelainTokens.readingWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .porcelainScreen()
        .toolbar {
            ToolbarItem {
                Button {
                    showingStrays = true
                } label: {
                    Label("Strays", systemImage: "tray.full")
                }
                .badge(capture.session.strays.count)
                .disabled(capture.session.strays.isEmpty)
            }
        }
    }

    #if os(iOS)
    /// A 4:3 slot. On hardware this is the live scanner; on the simulator `ScannerSlot` renders its
    /// own explanation, and the inset tone keeps it reading as a disabled instrument, not an error.
    ///
    /// With no location chosen the slot stays a placeholder: the camera must not start before
    /// there is somewhere to put what it reads.
    private var scannerSlot: some View {
        RoundedRectangle(cornerRadius: PorcelainTokens.radiusPanel)
            .fill(PorcelainTokens.inset)
            .aspectRatio(4.0 / 3.0, contentMode: .fit)
            .frame(maxWidth: .infinity, maxHeight: 300)
            .overlay {
                if capture.session.location == nil {
                    VStack(spacing: PorcelainTokens.Space.sm) {
                        Image(systemName: "barcode.viewfinder")
                            .font(.system(size: 32, weight: .light))
                            .foregroundStyle(PorcelainTokens.graphiteSecondary)
                        Text("Pick a location to start the scanner")
                            .font(.porcelainBody)
                            .foregroundStyle(PorcelainTokens.graphiteSecondary)
                            .multilineTextAlignment(.center)
                    }
                    .padding(PorcelainTokens.Space.lg)
                } else {
                    ScannerSlot { code in capture.submit(code) }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: PorcelainTokens.radiusPanel))
            .overlay(
                RoundedRectangle(cornerRadius: PorcelainTokens.radiusPanel)
                    .strokeBorder(PorcelainTokens.hairline, lineWidth: PorcelainTokens.hairlineWidth)
            )
    }
    #endif

    private var locationRow: some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            Eyebrow("Sweeping")
            Panel(padding: 0, spacing: 0) {
                Button {
                    pickingLocation = true
                } label: {
                    HStack(spacing: PorcelainTokens.Space.md) {
                        DomainMark(.location, style: .symbol, size: 15)
                            .frame(width: 20)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(capture.location?.name ?? "Choose a location")
                                .font(.porcelainTitle)
                                .foregroundStyle(
                                    capture.location == nil
                                        ? PorcelainTokens.graphiteSecondary : PorcelainTokens.graphite
                                )
                                .lineLimit(1)
                            if let path = capture.location?.path, !path.isEmpty {
                                Text(path)
                                    .font(.porcelainLabel)
                                    .foregroundStyle(PorcelainTokens.graphiteSecondary)
                                    .lineLimit(1)
                            }
                        }
                        Spacer(minLength: PorcelainTokens.Space.sm)
                        if let code = capture.location?.id.rawValue {
                            Text(code)
                                .font(.porcelainCode)
                                .foregroundStyle(PorcelainTokens.graphiteSecondary)
                        }
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(PorcelainTokens.graphiteSecondary)
                    }
                    .padding(.horizontal, PorcelainTokens.Space.md)
                    .frame(minHeight: PorcelainTokens.touchTarget + 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if let error = capture.locationError {
                    PanelDivider()
                    Text(error)
                        .font(.porcelainLabel)
                        .foregroundStyle(PorcelainTokens.destructive)
                        .padding(.horizontal, PorcelainTokens.Space.md)
                        .padding(.vertical, PorcelainTokens.Space.sm)
                }
            }
        }
    }

    private var manualEntry: some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            Eyebrow("Enter a code")
            HStack(spacing: PorcelainTokens.Space.sm) {
                TextField("Barcode, ISBN, or PRD-/LOC- label", text: $capture.manualEntry)
                    .font(.porcelainCode)
                    .textFieldStyle(.plain)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .keyboardType(.asciiCapable)
                    .textInputAutocapitalization(.characters)
                    #endif
                    .onSubmit(capture.submitManualEntry)
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
                Button("Scan", action: capture.submitManualEntry)
                    .font(.porcelainTitle)
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.roundedRectangle(radius: PorcelainTokens.radiusControl))
                    .tint(PorcelainTokens.cobalt)
                    .frame(height: PorcelainTokens.touchTarget)
                    .disabled(capture.session.location == nil || capture.manualEntry.isEmpty)
            }
        }
    }

    private var tally: some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            Eyebrow("This sweep")
            HStack(spacing: PorcelainTokens.Space.sm) {
                Text("\(capture.session.tally.added) added")
                Text("·").foregroundStyle(PorcelainTokens.hairline)
                Text("\(capture.session.tally.confirmed) confirmed")
                Text("·").foregroundStyle(PorcelainTokens.hairline)
                Text("\(capture.session.pendingCount) pending")
            }
            .font(.porcelainData)
            .foregroundStyle(PorcelainTokens.graphite)
        }
    }

    /// Empty with no location chosen there is nothing to say here — the scanner slot above
    /// already asks for one, and saying it twice reads as two different problems.
    @ViewBuilder
    private var chips: some View {
        if capture.session.chips.isEmpty {
            if capture.session.location != nil {
                Panel {
                    Text("Scan or type a code. Each read lands here with what Cubby did about it.")
                        .font(.porcelainBody)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                #if os(macOS)
                // No scanner slot on the Mac, so this is the only place that can ask.
                Panel {
                    Text("Pick a location to start sweeping.")
                        .font(.porcelainBody)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                }
                #endif
            }
        } else {
            Panel(padding: 0, spacing: 0) {
                ForEach(Array(capture.session.chips.enumerated()), id: \.element.id) { index, chip in
                    if index > 0 { PanelDivider(inset: PorcelainTokens.Space.lg + 20) }
                    ScanChipRow(chip: chip)
                }
            }
        }
    }
}

/// One read and what Cubby did about it. The status is spelled out as well as tinted, because a
/// sweep is done at arm's length and color alone is not a readable outcome.
struct ScanChipRow: View {
    let chip: ScanSession.Chip

    var body: some View {
        HStack(alignment: .top, spacing: PorcelainTokens.Space.md) {
            Image(systemName: symbol)
                .font(.system(size: 15))
                .foregroundStyle(tint)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(chip.label)
                    .font(.porcelainBody)
                    .foregroundStyle(PorcelainTokens.graphite)
                    .lineLimit(2)
                if case .failed(let message) = chip.status {
                    Text(message)
                        .font(.porcelainLabel)
                        .foregroundStyle(PorcelainTokens.destructive)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: PorcelainTokens.Space.sm)
            StatusChip(text: statusLabel, tone: chipTone)
        }
        .padding(.horizontal, PorcelainTokens.Space.md)
        .padding(.vertical, PorcelainTokens.Space.md)
    }

    private var statusLabel: String {
        switch chip.status {
        case .pending: "Looking up"
        case .added: "Added"
        case .confirmed: "Confirmed"
        case .queued: "Elsewhere"
        case .failed: "Failed"
        }
    }

    private var symbol: String {
        switch chip.status {
        case .pending: "circle.dotted"
        case .added: "plus.circle.fill"
        case .confirmed: "checkmark.circle"
        case .queued: "arrow.triangle.branch"
        case .failed: "exclamationmark.triangle.fill"
        }
    }

    private var chipTone: StatusChip.Tone {
        switch chip.status {
        case .pending: .neutral
        case .added: .positive
        case .confirmed: .neutral
        case .queued: .warning
        case .failed: .destructive
        }
    }

    private var tint: Color {
        switch chip.status {
        case .pending: PorcelainTokens.graphiteSecondary
        case .added: PorcelainTokens.positive
        case .confirmed: PorcelainTokens.graphiteSecondary
        case .queued: PorcelainTokens.warning
        case .failed: PorcelainTokens.destructive
        }
    }
}

#Preview {
    NavigationStack { CaptureView() }.environment(PreviewFixtures.signedInModel())
}

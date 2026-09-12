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
                ProgressView()
            }
        }
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
        VStack(spacing: 0) {
            #if os(iOS)
            if capture.session.location != nil {
                ScannerSlot { code in capture.submit(code) }
                    .frame(maxWidth: .infinity)
                    .frame(height: 260)
                    .clipShape(RoundedRectangle(cornerRadius: PorcelainTokens.radiusMedium))
                    .padding(.horizontal)
            }
            #endif
            List {
                Section {
                    Button {
                        pickingLocation = true
                    } label: {
                        LabeledContent("Location") {
                            Text(capture.location?.name ?? "Choose…")
                                .foregroundStyle(capture.location == nil ? PorcelainTokens.graphiteSecondary : PorcelainTokens.graphite)
                        }
                    }
                    .buttonStyle(.plain)
                    if let error = capture.locationError {
                        Text(error).foregroundStyle(PorcelainTokens.destructive).font(.footnote)
                    }
                }
                Section("Enter a code") {
                    HStack {
                        TextField("Barcode, ISBN, or PRD-/LOC- label", text: $capture.manualEntry)
                            .autocorrectionDisabled()
                            #if os(iOS)
                            .keyboardType(.asciiCapable)
                            .textInputAutocapitalization(.characters)
                            #endif
                            .onSubmit(capture.submitManualEntry)
                        Button("Scan", action: capture.submitManualEntry)
                            .buttonStyle(.borderedProminent)
                            .disabled(capture.session.location == nil || capture.manualEntry.isEmpty)
                    }
                }
                Section {
                    ForEach(capture.session.chips) { chip in
                        ScanChipRow(chip: chip)
                    }
                    if capture.session.chips.isEmpty {
                        Text(capture.session.location == nil ? "Pick a location to start sweeping." : "Scan or type a code.")
                            .foregroundStyle(PorcelainTokens.graphiteSecondary)
                    }
                } header: {
                    HStack {
                        Text("Recent")
                        Spacer()
                        Text("\(capture.session.tally.added) added · \(capture.session.tally.confirmed) confirmed")
                            .font(.footnote.monospacedDigit())
                    }
                }
            }
        }
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
}

struct ScanChipRow: View {
    let chip: ScanSession.Chip

    var body: some View {
        HStack {
            Image(systemName: symbol)
                .foregroundStyle(tint)
            VStack(alignment: .leading) {
                Text(chip.label).lineLimit(1)
                if case .failed(let message) = chip.status {
                    Text(message).font(.footnote).foregroundStyle(PorcelainTokens.destructive)
                }
            }
            Spacer()
            Text(statusLabel).font(.footnote).foregroundStyle(tint)
        }
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

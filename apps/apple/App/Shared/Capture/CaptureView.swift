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
                CaptureContent(
                    capture: capture, pickingLocation: $pickingLocation, showingStrays: $showingStrays)
            } else {
                LoadingIndicator.screen(label: "Loading Capture")
            }
        }
        .porcelainScreen()
        .navigationTitle("Capture")
        .task(id: model.host) {
            let capture = CaptureModel(client: model.client)
            self.capture = capture
            await capture.loadLocations()
            applyPendingLocation()
            applyPendingCode()
        }
        .onChange(of: model.navigator.pendingCaptureLocation) {
            applyPendingLocation()
            applyPendingCode()
        }
        .onChange(of: model.navigator.pendingCaptureCode) { applyPendingCode() }
        // "Stock it at a location" lands here before a location exists; the code waits for the
        // pick, then seeds the field.
        .onChange(of: capture?.location?.id) { applyPendingCode() }
        .sheet(isPresented: $pickingLocation) {
            if let capture { LocationPickerSheet(capture: capture) }
        }
        .sheet(isPresented: $showingStrays) {
            if let capture { StraysView(session: capture.session) }
        }
    }
}

extension CaptureView {
    /// A `cubby://capture?location=` link lands here; it only applies once the options are
    /// loaded, so a link that arrives first waits for the load above.
    fileprivate func applyPendingLocation() {
        guard let capture, !capture.locations.isEmpty else { return }
        if let id = model.navigator.takeCaptureLocation() { capture.select(id: id) }
    }

    /// A code found elsewhere (Search's scan sheet) only ever seeds the manual-entry field, and
    /// only once a location is selected — whether one was just chosen above or was already set.
    /// It is never submitted for the caller: inventory must never change without an explicit tap.
    fileprivate func applyPendingCode() {
        guard let capture, capture.location != nil else { return }
        if let code = model.navigator.takeCaptureCode() { capture.manualEntry = code }
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
                missingReview
            }
            .padding(PorcelainTokens.Space.lg)
            .frame(maxWidth: PorcelainTokens.readingWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .porcelainScreen()
        // Newest chip first; its status settling is what changes `chips`, so that is the trigger.
        .scanFeedback(
            capture.session.chips.first.flatMap { ScanFeedbackKind(chipStatus: $0.status) },
            trigger: capture.session.chips
        )
        .toolbar {
            ToolbarItem {
                NavigationLink(value: Route.identify) {
                    Label("Identify a photo", systemImage: "camera.metering.center.weighted")
                }
            }
            ToolbarItem {
                NavigationLink(value: Route.locationPhotoPass(scope: capture.location?.id)) {
                    Label("Location photo pass", systemImage: "camera.on.rectangle")
                }
            }
            ToolbarItem {
                NavigationLink(value: Route.audit(locationID: capture.location?.id)) {
                    Label("Walk the shelf", systemImage: "checklist")
                }
            }
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
                        // Labels only for codes this sweep already resolved: no request per frame.
                        ScannerSlot(
                            onRead: { code in capture.submit(code) },
                            annotate: { raw in capture.session.annotation(forScanned: raw) }
                        )
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
                    .keyboardDismissBar()
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

    @ViewBuilder
    private var missingReview: some View {
        if capture.location != nil {
            VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
                Button("I got everything") { Task { await capture.checkMissing() } }
                    .disabled(capture.checkingMissing)
                if let error = capture.missingError {
                    Text(error).foregroundStyle(PorcelainTokens.destructive)
                }
                if let missing = capture.missingBins {
                    Panel {
                        Eyebrow("Bins not seen")
                        Text(
                            missing.isEmpty
                                ? "Every movable bin was accounted for. Items are checked in a recount."
                                : "These bins are still recorded here. Review each one; unscanned items are not marked missing."
                        )
                        .font(.porcelainBody)
                        ForEach(missing, id: \.id) { bin in
                            VStack(alignment: .leading) {
                                Text(bin.name).font(.porcelainTitle)
                                HStack {
                                    Button("Move to Unknown") {
                                        Task { await capture.sendMissingToUnknown(bin.id) }
                                    }
                                    Menu("Move to…") {
                                        ForEach(
                                            capture.locations.filter {
                                                $0.id != capture.location?.id && $0.id != bin.id
                                            }
                                        ) { target in
                                            Button(target.name) {
                                                Task { await capture.moveMissing(bin.id, to: target.id) }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        NavigationLink(value: Route.audit(locationID: capture.location?.id)) {
                            Label("Recount the items too", systemImage: "checklist")
                        }
                    }
                }
            }
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(alignment: .top, spacing: PorcelainTokens.Space.md) {
            Image(systemName: symbol)
                .font(.system(size: 15))
                .foregroundStyle(tint)
                .frame(width: 20)
                // Motion is a secondary cue only: the label and chip already spell the outcome out.
                .symbolEffect(.pulse, isActive: !reduceMotion && isPending)
                .symbolEffect(.bounce, options: .nonRepeating, isActive: !reduceMotion && isSettled)
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

    private var isPending: Bool {
        if case .pending = chip.status { return true }
        return false
    }

    /// `.added`/`.confirmed` only — the outcomes worth a bounce; warnings and failures hold still.
    private var isSettled: Bool {
        switch chip.status {
        case .added, .confirmed: true
        default: false
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

#Preview(traits: .modifier(SignedInPreview())) {
    NavigationStack { CaptureView() }
}

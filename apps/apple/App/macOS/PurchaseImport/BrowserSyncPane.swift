import CubbyKit
import SwiftUI

/// Operational browser work lives in the main window; Settings owns browser and permissions.
struct BrowserSyncPane: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openSettings) private var openSettings
    @AppStorage("purchaseImport.browser") private var browser = BrowserChoice.chrome
    @State private var query = ""
    @State private var loading = true
    @State private var selection: String?
    @State private var sortOrder = [KeyPathComparator(\BrowserSyncRow.vendor)]

    private var rows: [BrowserSyncRow] {
        let states = Dictionary(
            model.browserBridge.accountStates.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return model.browserBridge.syncPlans.map { plan in
            BrowserSyncRow(plan: plan, state: states[plan.shortcode])
        }.filter { row in
            query.isEmpty
                || "\(row.vendor) \(row.account) \(row.status) \(row.plan.line)"
                    .localizedStandardContains(query)
        }.sorted(using: sortOrder)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Label(
                    "\(model.browserBridge.syncPlans.filter { $0.connected == true }.count) of \(model.browserBridge.syncPlans.count) accounts connected",
                    systemImage: "network")
                Spacer()
                Text("\(model.browserBridge.syncPlans.count) accounts")
                    .foregroundStyle(.secondary)
                if model.browserBridge.status != .connected {
                    Button("Reconnect") { model.browserBridge.reconnect(browser: browser) }
                        .disabled(!model.browserBridge.isConfigured || model.browserBridge.isSyncing)
                }
                Button("Browser & permissions…") { openSettings() }
            }
            .padding(FieldGuideTokens.Space.md)
            if let error = model.browserBridge.error {
                Text(error).foregroundStyle(FieldGuideTokens.destructive)
                    .textSelection(.enabled).padding(.horizontal)
            }
            if let error = model.browserBridge.syncPlanError {
                InlineLoadFailure(message: error) { await model.browserBridge.refreshSyncPlan() }
                    .padding(.horizontal)
            }
            Table(rows, selection: $selection, sortOrder: $sortOrder) {
                TableColumn("Vendor", value: \.vendor) { row in
                    VStack(alignment: .leading) {
                        Text(row.vendor)
                        if !row.account.isEmpty {
                            Text(row.account).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .help(row.plan.shortcode)
                }
                .width(min: 130, ideal: 200)
                TableColumn("Connection", value: \.status) { row in
                    VStack(alignment: .leading) {
                        Text(row.status)
                        if let state = row.state {
                            if state.needsAuthentication && row.plan.accountStatus != .paused_auth {
                                Button("Open sign-in") {
                                    model.browserBridge.raiseAuthenticationWindow(accountID: row.id)
                                }
                            }
                            if let command = state.lastCommand {
                                Text("Last browser command").font(.caption).foregroundStyle(.secondary)
                                if let runID = state.lastCommandRunID {
                                    Button("View command run") {
                                        model.navigator.openActivity(.serverRun(runID))
                                    }
                                }
                                Text(command).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                    .help(command)
                            }
                            if let error = state.error {
                                Text(error).font(.caption).foregroundStyle(FieldGuideTokens.destructive)
                                    .lineLimit(2).help(error)
                            }
                        }
                    }
                }
                .width(min: 120, ideal: 160)
                TableColumn("Account status") { row in
                    VStack(alignment: .leading) {
                        Text(row.accountStatus)
                        if row.plan.accountStatus == .paused_auth {
                            Button("Open sign-in") {
                                model.browserBridge.raiseAuthenticationWindow(accountID: row.id)
                            }
                        }
                        if let timestamp = row.plan.lastSuccessAt,
                            let value = EntityFieldValue.date(.string(timestamp))
                        {
                            Text("Last completed account run: \(value)")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                .width(min: 130, ideal: 180)
                TableColumn("Import plan") { row in
                    Text(row.plan.line).lineLimit(2).help(row.plan.line)
                }
                .width(min: 160, ideal: 300)
                TableColumn("Actions") { row in
                    HStack {
                        Button(row.syncTitle) { sync(accountID: row.id) }
                            .disabled(row.plan.disabledReason != nil || cannotSync)
                            .accessibilityLabel("\(row.syncTitle) \(row.vendor) \(row.account)")
                            .accessibilityIdentifier("browserSync.sync.\(row.id)")
                        if let runID = row.runID {
                            Button("View run") { openRun(runID) }
                        } else if row.plan.disabledReason == nil {
                            BrowserSyncHistoryButton(accountID: row.id, disabled: cannotSync) { range in
                                sync(accountID: row.id, backfill: range)
                            }
                        }
                    }
                }
                .width(min: 150, ideal: 190)
            }
            .accessibilityIdentifier("browserSync.accounts")
            .overlay {
                if rows.isEmpty {
                    if loading && model.browserBridge.syncPlans.isEmpty {
                        LoadingIndicator(label: "Loading sync accounts")
                    } else if model.browserBridge.syncPlans.isEmpty {
                        ContentUnavailableView(
                            "No browser-sync accounts", systemImage: "network",
                            description: Text("Enable browser sync on a vendor account to see it here."))
                    } else {
                        ContentUnavailableView.search(text: query)
                    }
                }
            }
        }
        .navigationTitle("Browser Sync")
        .searchable(text: $query, prompt: "Search vendors, accounts, or status")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button(
                    "Sync all (\(model.browserBridge.syncableAccountCount))", systemImage: "arrow.clockwise"
                ) {
                    sync()
                }
                .disabled(cannotSync || model.browserBridge.syncableAccountCount == 0)
                .accessibilityIdentifier("browserSync.syncAll")
            }
        }
        .refreshControl(identifier: "browserSync.refresh") { await model.browserBridge.refreshSyncPlan() }
        .task {
            await model.browserBridge.refreshSyncPlan()
            loading = false
        }
    }

    private var cannotSync: Bool { !model.browserBridge.isConfigured || model.browserBridge.isSyncing }

    private func openRun(_ id: String) {
        model.navigator.openRecord(.init(key: .run, id: id))
    }

    private func sync(accountID: String? = nil, backfill: BrowserBridgeBackfillRange? = nil) {
        model.browserBridge.syncNow(browser: browser, accountID: accountID, backfill: backfill) { runs in
            if runs.count == 1, let run = runs.first {
                openRun(run.runId)
            } else if !runs.isEmpty {
                model.navigator.openActivity(nil)
            }
        }
    }
}

nonisolated private struct BrowserSyncRow: Identifiable {
    let plan: SyncPlanAccount
    let state: BrowserBridgeAccountState?
    var id: String { plan.shortcode }
    var vendor: String { plan.vendorName }
    var account: String {
        plan.label.compare(plan.vendorName, options: [.caseInsensitive, .diacriticInsensitive])
            == .orderedSame
            ? "" : plan.label
    }
    let status: String

    @MainActor init(plan: SyncPlanAccount, state: BrowserBridgeAccountState?) {
        self.plan = plan
        self.state = state
        status = plan.connected.map { $0 ? "Connected" : "Disconnected" } ?? "Connection unavailable"
    }
    var accountStatus: String {
        let field = EntityManifest[.vendorAccount].fields.first { $0.key == "status" }
        return field.map { EntityFieldValue.enumLabel(plan.accountStatus.rawValue, field: $0) }
            ?? plan.accountStatus.rawValue
    }
    var syncTitle: String {
        if case .resume = plan.action { return "Resume" }
        return "Sync"
    }
    var runID: String? {
        switch plan.action {
        case .resume(let action): action.runId
        case .blocked(let action): action.runId
        default: nil
        }
    }
}

private struct BrowserSyncHistoryButton: View {
    let accountID: String
    let disabled: Bool
    let start: (BrowserBridgeBackfillRange) -> Void
    @State private var presented = false
    @State private var from = BrowserBridgeBackfillRange.defaultDates().from
    @State private var to = BrowserBridgeBackfillRange.defaultDates().to

    var body: some View {
        Button("History…") { presented = true }
            .disabled(disabled)
            .accessibilityIdentifier("browserSync.history.\(accountID)")
            .popover(isPresented: $presented) {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Import order history").font(.headline)
                    DatePicker("From", selection: $from, in: ...to, displayedComponents: .date)
                    DatePicker("To", selection: $to, in: from...Date.now, displayedComponents: .date)
                    HStack {
                        Button("Cancel") { presented = false }
                            .keyboardShortcut(.cancelAction)
                        Spacer()
                        Button("Import this range") {
                            guard let range = BrowserBridgeBackfillRange(from: from, to: to) else { return }
                            presented = false
                            start(range)
                        }
                        .disabled(disabled || BrowserBridgeBackfillRange(from: from, to: to) == nil)
                        .keyboardShortcut(.defaultAction)
                    }
                }
                .padding(FieldGuideTokens.Space.md).frame(width: 320)
            }
    }
}

#if DEBUG
    /// Synthetic fleet exercises scrolling and two distinct accounts at the same vendor.
    private final class BrowserSyncPreviewController: BrowserBridgeControlling {
        let plans: [SyncPlanAccount] = (1...100).map { index in
            .init(
                shortcode: "VACCT-EXAMPLE-\(index)",
                label: index == 2 ? "Second account" : "Example shop \(index == 1 ? 1 : index)",
                vendorName: "Example shop \(index == 2 ? 1 : index)",
                accountStatus: index == 1 ? .paused_auth : (index == 2 ? .paused_offline : .active),
                connected: index == 2 ? false : true, lastSuccessAt: nil,
                action: .firstSync(.init(kind: .firstSync)),
                line: "First sync: read available order history.", disabledReason: nil)
        }
        func connect(browser: BrowserChoice) async throws {}
        func syncPlan() async throws -> SyncPlanOutput { .init(accounts: plans) }
        func syncNow(browser: BrowserChoice, accountID: String?, backfill: BrowserBridgeBackfillRange?)
            async throws -> [StartSyncOutput]
        { [] }
        func disconnect() async {}
        func raiseAuthenticationWindow(for accountID: String) {}
        func appDidBecomeActive() {}
    }

    private struct BrowserSyncPreview: View {
        @Environment(AppModel.self) private var model
        @State private var controller = BrowserSyncPreviewController()
        var body: some View {
            NavigationStack { BrowserSyncPane() }
                .task {
                    model.browserBridge.install(controller: controller)
                    model.browserBridge.setAccounts(
                        controller.plans.map {
                            .init(
                                id: $0.shortcode, label: $0.label, ledgerPartyId: "PARTY-EXAMPLE",
                                browser: .chrome)
                        })
                    for plan in controller.plans {
                        model.browserBridge.setAccountStatus(.connected, accountID: plan.shortcode)
                    }
                    model.browserBridge.setStatus(.connected)
                    model.browserBridge.setAccountCounts(connected: 100, total: 100)
                    await model.browserBridge.refreshSyncPlan()
                }
        }
    }

    #Preview("100 accounts", traits: .modifier(SignedInPreview())) {
        BrowserSyncPreview().frame(width: 1000, height: 650)
    }

    #Preview("Narrow", traits: .modifier(SignedInPreview())) {
        BrowserSyncPreview().frame(width: 540, height: 480)
    }
#endif

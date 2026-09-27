import CubbyKit
import SwiftUI

/// Mail evidence stays readable on the Vendor, Vendor account, and Purchase pages.
struct OrderMailDetailSlot: View {
    enum Scope {
        case vendor(String, String?)
        case purchase(String)
    }

    let scope: Scope
    @Environment(AppModel.self) private var appModel
    @State private var worklist: PurchaseOrderMailOut?
    @State private var error: String?
    @State private var busyEventID: String?

    var body: some View {
        Group {
            if let worklist {
                if worklist.items.isEmpty {
                    Text("No order email linked yet.").foregroundStyle(.secondary)
                } else {
                    ForEach(worklist.items, id: \.messageId) { mail in
                        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
                            Text(mail.subject).font(.subheadline.weight(.semibold))
                            Text(mail.sender).font(.caption).foregroundStyle(.secondary)
                            ForEach(mail.events, id: \.id) { event in
                                VStack(alignment: .leading, spacing: PorcelainTokens.Space.xs) {
                                    Text("\(event.event.capitalized) · \(event.orderId ?? "Order unknown")")
                                        .font(.subheadline)
                                    if let amount = event.amount {
                                        Text(amount, format: .currency(code: event.currency ?? "USD"))
                                            .font(.caption.monospacedDigit())
                                    }
                                    ForEach(event.candidates, id: \.purchaseId) { candidate in
                                        HStack {
                                            NavigationLink {
                                                EntityDetailView(key: .purchase, id: candidate.purchaseId)
                                            } label: {
                                                Text(candidate.orderId ?? candidate.purchaseId)
                                            }
                                            Spacer()
                                            if let decision = candidate.decision {
                                                Text(decision.rawValue.capitalized)
                                                    .font(.caption).foregroundStyle(.secondary)
                                            }
                                            if candidate.decision != .linked {
                                                Button("Link") {
                                                    decide(
                                                        eventID: event.id, purchaseID: candidate.purchaseId,
                                                        checksum: event.evidenceChecksum, link: true)
                                                }
                                                .disabled(busyEventID != nil)
                                            }
                                            if candidate.decision != .dismissed {
                                                Button("Dismiss") {
                                                    decide(
                                                        eventID: event.id, purchaseID: candidate.purchaseId,
                                                        checksum: event.evidenceChecksum, link: false)
                                                }
                                                .disabled(busyEventID != nil)
                                            }
                                        }
                                        .font(.caption)
                                    }
                                }
                                .padding(.top, PorcelainTokens.Space.xs)
                            }
                            if let threadID = mail.threadId,
                                let url = URL(string: "https://mail.google.com/mail/u/0/#all/\(threadID)")
                            {
                                Link("Open Gmail conversation", destination: url)
                                    .font(.caption)
                            }
                            DisclosureGroup("Technical details") {
                                Text("Message ID: \(mail.messageId)")
                                    .font(.caption.monospaced()).textSelection(.enabled)
                                if let threadID = mail.threadId {
                                    Text("Thread ID: \(threadID)")
                                        .font(.caption.monospaced()).textSelection(.enabled)
                                }
                            }
                        }
                        .padding(.vertical, PorcelainTokens.Space.xs)
                    }
                }
            } else if error == nil {
                LoadingIndicator(label: "Loading order email")
            }
            if let error {
                Text(error).font(.callout).foregroundStyle(PorcelainTokens.destructive)
                Button("Retry") { Task { await load() } }
            }
        }
        .task { await load() }
    }

    private func load() async {
        do {
            switch scope {
            case .vendor(let vendorID, let ledgerPartyID):
                worklist = try await appModel.client.vendorOrderMail(
                    vendorID: vendorID, ledgerPartyID: ledgerPartyID)
            case .purchase(let purchaseID):
                worklist = try await appModel.client.purchaseOrderMail(purchaseID)
            }
            error = nil
        } catch {
            Diagnostics.report(error, context: "Load order email")
            self.error = error.localizedDescription
        }
    }

    private func decide(eventID: String, purchaseID: String, checksum: String, link: Bool) {
        busyEventID = eventID
        Task {
            defer { busyEventID = nil }
            do {
                try await appModel.client.decideOrderMail(
                    eventID: eventID, purchaseID: purchaseID, link: link,
                    evidenceChecksum: checksum)
                await load()
            } catch {
                Diagnostics.report(error, context: "Review order email match")
                self.error = error.localizedDescription
            }
        }
    }
}

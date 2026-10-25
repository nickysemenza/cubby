import Foundation
import Testing

@testable import CubbyKit

@Suite("Household queue overview")
struct HouseholdQueueOverviewTests {
    private func row(_ id: String, executor: String?, dispatchedAt: String?) throws -> EntityRow {
        var object: [String: Any] = ["id": id, "displayName": "Synthetic job \(id)"]
        if let executor { object["lastExecutor"] = executor }
        if let dispatchedAt { object["dispatchedAt"] = dispatchedAt }
        let raw = try JSONDecoder().decode(
            JSONValue.self, from: JSONSerialization.data(withJSONObject: object))
        return EntityRow(id: id, title: "Synthetic job \(id)", subtitle: nil, imageURL: nil, raw: raw)
    }

    @Test func splitsLeasesByDeviceOldestFirst() throws {
        let overview = HouseholdQueueOverview.make(
            leasedRows: [
                try row("IPR-B", executor: "Kitchen Mac", dispatchedAt: "2099-01-01T00:02:00.000Z"),
                try row("IPR-A", executor: "Hall phone", dispatchedAt: "2099-01-01T00:01:00.000Z"),
                try row("IPR-C", executor: "Kitchen Mac", dispatchedAt: "2099-01-01T00:00:00.000Z"),
                try row("IPR-D", executor: nil, dispatchedAt: nil),
            ],
            leasedCount: 7, waitingForAppleDevice: 3, frontierQueued: 2, runsNeedingAttention: 1,
            thisDeviceName: "Kitchen Mac")
        #expect(overview.myLeases.map(\.id) == ["IPR-C", "IPR-B"])
        #expect(overview.otherLeases.map(\.id) == ["IPR-A", "IPR-D"])
        #expect(overview.otherLeases.first?.executor == "Hall phone")
        #expect(overview.myLeases.first?.leasedAt == Date(timeIntervalSince1970: 4_070_908_800))
        #expect(overview.leasedCount == 7)
        #expect(overview.waitingForAppleDevice == 3)
        #expect(overview.frontierQueued == 2)
    }

    @Test func stateFiltersUseTheDeclaredWireName() {
        let filter = HouseholdQueueOverview.imageJobFilter(.waitingForDevice)
        #expect(filter.values.values.first == ["waiting_for_device"])
    }
}

import ArgumentParser
import CubbyKit
import Foundation

/// The same reviewed booking/correction sessions used by the native detail screen.
struct HeadlessFinancialBooking: AsyncParsableCommand {
    static let configuration = CommandConfiguration(commandName: "headless-financial-booking")
    @Option(name: .customLong("base-url")) var baseURLString: String
    @Option(name: .customLong("input-file")) var inputFile: String?
    @Option(name: .customLong("review-file")) var reviewFile: String?
    @Flag var correction = false

    @MainActor
    func run() async throws {
        try await CLI.run {
            guard (inputFile == nil) != (reviewFile == nil) else {
                throw CLIError.message("Choose an input to preview or an exact reviewed preview to commit")
            }
            let context = try await CLI.fixtureContext(baseURLString: baseURLString)
            let data = try Data(contentsOf: URL(fileURLWithPath: inputFile ?? reviewFile!))
            let decoder = JSONDecoder.cubby()
            let output: Data
            if correction {
                let reviewed = try reviewFile.map { _ in
                    try decoder.decode(FinancialBookingCorrectionPreview.self, from: data)
                }
                let session = FinancialBookingCorrectionReviewSession(reviewed: reviewed)
                if reviewed != nil {
                    output = try JSONEncoder.cubby().encode(await session.commit(client: context.client))
                } else {
                    try await session.prepare(
                        decoder.decode(FinancialBookingCorrectionInput.self, from: data),
                        client: context.client)
                    output = try JSONEncoder.cubby().encode(session.preview)
                }
            } else {
                let reviewed = try reviewFile.map { _ in
                    try decoder.decode(FinancialBookingPreview.self, from: data)
                }
                let session = FinancialBookingReviewSession(reviewed: reviewed)
                if reviewed != nil {
                    output = try JSONEncoder.cubby().encode(await session.commit(client: context.client))
                } else {
                    try await session.prepare(
                        decoder.decode(FinancialBookingInput.self, from: data), client: context.client)
                    output = try JSONEncoder.cubby().encode(session.preview)
                }
            }
            print(String(decoding: output, as: UTF8.self))
        }
    }
}

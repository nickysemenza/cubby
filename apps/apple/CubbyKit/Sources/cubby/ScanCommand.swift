import ArgumentParser
import CubbyKit

/// Classifies and scans one code at a location — the CLI's stand-in for `DataScannerView` on a
/// device that has no camera.
struct Scan: AsyncParsableCommand {
    static let configuration = CommandConfiguration(abstract: "Scan or type a code at a location.")

    @OptionGroup var global: GlobalOptions
    @Argument(help: "Location shortcode, e.g. LOC-2345.")
    var locationID: String
    @Argument(help: "A barcode, ISBN, or Cubby product shortcode/label URL.")
    var code: String

    func run() async throws {
        try await CLI.run {
            let scanCode: ScanCode
            switch ScanCode.classify(code) {
            case .success(let value):
                scanCode = value
            case .failure(let error):
                throw CLIError.message(error.message)
            }

            let context = try CLIContext.make(from: global)
            let result = try await context.client.scan(scanCode, at: LocationCode(locationID))

            print("\(result.outcome.rawValue): \(result.product.name)")
            for stray in result.strays {
                let suffix = stray.ambiguousQuantity ? " (ambiguous quantity)" : ""
                print("  stray: \(stray.entryId.rawValue) at \(stray.locationName)\(suffix)")
            }
        }
    }
}

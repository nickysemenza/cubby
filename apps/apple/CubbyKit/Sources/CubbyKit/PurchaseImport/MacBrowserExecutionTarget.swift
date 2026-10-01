#if os(macOS)
    import AppKit
    import Foundation
    import Security

    /// Browser identity is supplied by the entry point, never discovered from process arguments in the executor.
    public struct MacBrowserExecutionTarget: Sendable {
        public let browser: BrowserChoice
        public let bundleIdentifier: String
        private let ownershipCheck: (@MainActor @Sendable () throws -> Void)?

        private init(
            browser: BrowserChoice, bundleIdentifier: String,
            ownershipCheck: (@MainActor @Sendable () throws -> Void)? = nil
        ) {
            self.browser = browser
            self.bundleIdentifier = bundleIdentifier
            self.ownershipCheck = ownershipCheck
        }

        public static func installed(_ browser: BrowserChoice) -> Self {
            Self(
                browser: browser,
                bundleIdentifier: browser == .safari ? "com.apple.Safari" : "com.google.Chrome")
        }

        public static func signingTeam(of applicationURL: URL) throws -> String {
            var code: SecStaticCode?
            guard SecStaticCodeCreateWithPath(applicationURL as CFURL, [], &code) == errSecSuccess,
                let code
            else { throw Failure.invalidSignature }
            var information: CFDictionary?
            guard
                SecCodeCopySigningInformation(
                    code, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
                let values = information as? [String: Any],
                let team = values[kSecCodeInfoTeamIdentifier as String] as? String, !team.isEmpty
            else { throw Failure.invalidSignature }
            return team
        }

        @MainActor
        public static func fixtureChrome(
            baseURL: URL, bundleIdentifier: String, applicationURL: URL,
            processID: Int32, teamID: String
        ) throws -> Self {
            #if DEBUG
                guard ["http", "https"].contains(baseURL.scheme?.lowercased() ?? ""),
                    ["127.0.0.1", "localhost", "::1"].contains(baseURL.host?.lowercased() ?? ""),
                    bundleIdentifier == "com.cubby.fixture.browser"
                        || bundleIdentifier.range(
                            of: "^com\\.cubby\\.fixture\\.browser\\.[a-f0-9]{16}$",
                            options: .regularExpression) != nil,
                    applicationURL.isFileURL, processID > 0,
                    teamID.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil
                else { throw Failure.invalidFixtureConfiguration }
                let applicationURL = applicationURL.resolvingSymlinksInPath().standardizedFileURL
                let target = Self(browser: .chrome, bundleIdentifier: bundleIdentifier) {
                    let running = NSRunningApplication.runningApplications(
                        withBundleIdentifier: bundleIdentifier)
                    guard running.count == 1, let application = running.first,
                        application.processIdentifier == processID, !application.isTerminated,
                        application.bundleURL?.resolvingSymlinksInPath().standardizedFileURL == applicationURL
                    else { throw Failure.ownershipChanged }
                }
                try target.verifyOwnership()
                // The signed fixture app grants read access only to this isolated browser bundle.
                var code: SecStaticCode?
                let guestStatus = SecStaticCodeCreateWithPath(applicationURL as CFURL, [], &code)
                guard guestStatus == errSecSuccess, let code else {
                    throw Failure.signatureCheck("SecStaticCodeCreateWithPath", guestStatus)
                }
                var requirement: SecRequirement?
                let expression =
                    "anchor apple generic and identifier \"\(bundleIdentifier)\" and certificate leaf[subject.OU] = \"\(teamID)\""
                let requirementStatus = SecRequirementCreateWithString(
                    expression as CFString, [], &requirement)
                guard requirementStatus == errSecSuccess else {
                    throw Failure.signatureCheck("SecRequirementCreateWithString", requirementStatus)
                }
                let validationStatus = SecStaticCodeCheckValidity(code, [], requirement)
                guard validationStatus == errSecSuccess else {
                    throw Failure.signatureCheck("SecStaticCodeCheckValidity", validationStatus)
                }
                return target
            #else
                throw Failure.invalidFixtureConfiguration
            #endif
        }

        @MainActor
        func verifyOwnership() throws { try ownershipCheck?() }

        public enum Failure: Error, LocalizedError, Equatable, Sendable {
            case invalidFixtureConfiguration
            case invalidSignature
            case signatureCheck(String, OSStatus)
            case ownershipChanged

            public var errorDescription: String? {
                switch self {
                case .invalidFixtureConfiguration:
                    "The isolated browser requires a DEBUG build, loopback server and explicit fixture identity."
                case .invalidSignature:
                    "The isolated browser does not have the expected Apple-issued code signature."
                case .signatureCheck(let operation, let status):
                    "\(operation) refused the isolated browser signature (OSStatus \(status))."
                case .ownershipChanged:
                    "The isolated browser's exact process and application path no longer match."
                }
            }
        }
    }
#endif

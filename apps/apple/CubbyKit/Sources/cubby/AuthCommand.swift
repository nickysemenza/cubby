import ArgumentParser
import CubbyKit

#if os(macOS)
    import AppKit
    import Foundation
#endif

struct Auth: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        abstract: "Manage the stored Cubby credential.",
        subcommands: [Login.self, Status.self, Logout.self]
    )
}

extension Auth {
    struct Login: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            abstract:
                "Sign in. On macOS this approves sign-in in the Cubby app; pass --email for password sign-in."
        )

        @OptionGroup var global: GlobalOptions
        @Option(help: "Email address for password sign-in. Prompted on stdin if omitted.")
        var email: String?

        func run() async throws {
            try await CLI.run {
                #if os(macOS)
                    if email == nil {
                        try await Self.loginViaApp(global: global)
                        return
                    }
                #endif
                let context = try CLIContext.make(from: global)
                let resolvedEmail = try email ?? CLI.readLine(prompt: "Email: ")
                let password = try CLI.readPassword(prompt: "Password: ")

                let flow = AuthFlow(
                    baseURL: context.baseURL, credentials: context.credentials, identity: context.identity)
                _ = try await flow.signIn(email: resolvedEmail, password: password)

                print("Signed in as \(resolvedEmail) (token stored for \(context.host)).")
            }
        }

        #if os(macOS)
            /// The default `cubby auth login`: listens on loopback, opens the Mac app's
            /// `cubby://cli-auth` confirmation, and stores the approved bearer token — checked
            /// for this CLI's server — in the file store. The token is a copy of the app's
            /// session: logging out here revokes the shared server session, so the app signs
            /// out there too.
            fileprivate static func loginViaApp(global: GlobalOptions) async throws {
                guard global.apiKey == nil else {
                    throw CLIError.message("App-approved sign-in cannot be combined with --api-key.")
                }
                guard
                    NSWorkspace.shared.urlForApplication(
                        withBundleIdentifier: "com.nickysemenza.cubby") != nil
                else {
                    throw CLIError.message(
                        "The Cubby Mac app isn't installed. Install it first, or sign in with `cubby auth login --email <address>`."
                    )
                }
                let context = try CLIContext.make(from: global)
                let handoff = CliAuthLoopbackHandoff()
                defer { handoff.close() }
                do {
                    let port = try await handoff.start()
                    let link = CubbyLink.cliAuth(port: port, nonce: handoff.nonce)
                    guard NSWorkspace.shared.open(link.url) else {
                        throw CLIError.message("Could not open the Cubby app to approve sign-in.")
                    }
                    print("Opened Cubby — approve the sign-in there to finish logging in this CLI.")
                    let token = try await handoff.receive(for: context.baseURL)
                    try await context.credentials.set(.bearer(token))
                } catch {
                    throw CLIError.message(
                        (error as? LocalizedError)?.errorDescription ?? String(describing: error))
                }
                print(
                    "Signed in via the Cubby app (token stored for \(context.host)). This shares the app's session: `cubby auth logout` signs the app out too."
                )
            }
        #endif
    }

    struct Status: AsyncParsableCommand {
        static let configuration = CommandConfiguration(abstract: "Show the stored credential.")

        @OptionGroup var global: GlobalOptions

        func run() async throws {
            try await CLI.run {
                let context = try CLIContext.make(from: global)
                guard let credential = await context.credentials.current() else {
                    print("\(context.host): no credential")
                    return
                }
                switch credential {
                case .bearer(let token):
                    print("\(context.host): bearer \(Self.prefix(of: token))")
                case .apiKey(let key):
                    print("\(context.host): apiKey \(Self.prefix(of: key))")
                }
            }
        }

        private static func prefix(of token: String) -> String {
            String(token.prefix(6))
        }
    }

    struct Logout: AsyncParsableCommand {
        static let configuration = CommandConfiguration(abstract: "Sign out and clear the stored credential.")

        @OptionGroup var global: GlobalOptions

        func run() async throws {
            try await CLI.run {
                let context = try CLIContext.make(from: global)
                let flow = AuthFlow(
                    baseURL: context.baseURL, credentials: context.credentials, identity: context.identity)
                try await flow.signOut()
                print("Signed out (credential cleared for \(context.host)).")
            }
        }
    }
}

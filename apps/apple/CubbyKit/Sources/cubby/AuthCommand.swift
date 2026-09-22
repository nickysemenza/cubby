import ArgumentParser
import CubbyKit

struct Auth: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        abstract: "Manage the stored Cubby credential.",
        subcommands: [Login.self, Status.self, Logout.self]
    )
}

extension Auth {
    struct Login: AsyncParsableCommand {
        static let configuration = CommandConfiguration(abstract: "Sign in with email + password.")

        @OptionGroup var global: GlobalOptions
        @Option(help: "Email address. Prompted on stdin if omitted.")
        var email: String?

        func run() async throws {
            try await CLI.run {
                let context = try CLIContext.make(from: global)
                let resolvedEmail = try email ?? CLI.readLine(prompt: "Email: ")
                let password = try CLI.readPassword(prompt: "Password: ")

                let flow = AuthFlow(
                    baseURL: context.baseURL, credentials: context.credentials, identity: context.identity)
                _ = try await flow.signIn(email: resolvedEmail, password: password)

                print("Signed in as \(resolvedEmail) (token stored for \(context.host)).")
            }
        }
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

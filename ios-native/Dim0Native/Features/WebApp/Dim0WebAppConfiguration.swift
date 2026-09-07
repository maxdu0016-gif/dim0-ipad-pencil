import Foundation

enum Dim0WebAppConfiguration {
    private static let fallbackURL = URL(string: "https://app.dim0.net")!
    private static let nativeGoogleStatePrefix = "dim0-ios:"
    static let googleCallbackScheme = "com.dim0.canvas.oauth"

    /// Resolves the full Dim0 web application hosted inside the native iPad shell.
    static var appURL: URL {
        if let override = ProcessInfo.processInfo.environment["DIM0_APP_URL"],
           let url = normalizedURL(override) {
            return url
        }

        if let configured = Bundle.main.object(forInfoDictionaryKey: "Dim0AppURL") as? String,
           let url = normalizedURL(configured) {
            return url
        }

        return fallbackURL
    }

    /// Returns whether a script-message origin is the configured Dim0 application.
    static func isTrustedAppOrigin(scheme: String, host: String, port: Int) -> Bool {
        guard let appScheme = appURL.scheme?.lowercased(),
              let appHost = appURL.host?.lowercased() else {
            return false
        }
        let expectedPort = appURL.port ?? (appScheme == "https" ? 443 : 80)
        let originScheme = scheme.lowercased()
        let originPort = port == 0 ? (originScheme == "https" ? 443 : 80) : port
        return originScheme == appScheme
            && host.lowercased() == appHost
            && originPort == expectedPort
    }

    /// Allows secure navigation and explicit local-development HTTP URLs only.
    static func isAllowedWebURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        if scheme == "https" || scheme == "about" || scheme == "blob" {
            return true
        }
        guard scheme == "http", let host = url.host?.lowercased() else {
            return false
        }
        return isLocalDevelopmentHost(host)
    }

    /// Returns whether the URL belongs to the configured Dim0 application origin.
    static func isTrustedAppURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme,
              let host = url.host else {
            return false
        }
        let port = url.port ?? (scheme.lowercased() == "https" ? 443 : 80)
        return isTrustedAppOrigin(scheme: scheme, host: host, port: port)
    }

    /// Accepts only Google's OAuth endpoint when the trusted web app requests native authentication.
    static func isGoogleAuthorizationURL(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "https"
            && url.host?.lowercased() == "accounts.google.com"
            && url.path == "/o/oauth2/v2/auth"
    }

    /// Converts a private native OAuth callback back to the configured web callback route.
    static func googleWebCallbackURL(from callback: URL) -> URL? {
        guard callback.scheme?.lowercased() == googleCallbackScheme,
              callback.host?.lowercased() == "google",
              callback.path == "/callback",
              let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems,
              let state = items.first(where: { $0.name == "state" })?.value,
              state.hasPrefix(nativeGoogleStatePrefix),
              items.contains(where: { $0.name == "code" || $0.name == "error" }) else {
            return nil
        }

        var destination = URLComponents(url: appURL, resolvingAgainstBaseURL: false)
        destination?.path = "/signin/google/callback"
        destination?.queryItems = items.filter { ["code", "state", "error"].contains($0.name) }
        destination?.fragment = nil
        return destination?.url
    }

    /// Accepts HTTPS production URLs and HTTP LAN URLs used by self-hosted development builds.
    private static func normalizedURL(_ rawValue: String) -> URL? {
        let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }
        let candidate = value.contains("://") ? value : "https://\(value)"
        guard let url = URL(string: candidate),
              let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http",
              url.host != nil,
              isAllowedWebURL(url) else {
            return nil
        }
        return url
    }

    /// Recognizes loopback, Bonjour, and RFC1918 hosts used by development builds.
    private static func isLocalDevelopmentHost(_ host: String) -> Bool {
        if host == "localhost" || host == "::1" || host.hasSuffix(".local") {
            return true
        }
        if host.hasPrefix("127.") || host.hasPrefix("10.") || host.hasPrefix("192.168.") {
            return true
        }
        let octets = host.split(separator: ".").compactMap { Int($0) }
        return octets.count == 4
            && octets[0] == 172
            && (16...31).contains(octets[1])
    }
}

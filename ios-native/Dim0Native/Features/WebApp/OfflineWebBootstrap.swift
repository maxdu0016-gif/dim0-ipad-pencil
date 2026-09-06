import Foundation
import WebKit

@MainActor
enum OfflineWebBootstrap {
    /// Keep the existing HTTPS origin so previously saved IndexedDB boards remain available.
    static func load(into webView: WKWebView) -> Bool {
        guard let resource = Bundle.main.url(forResource: "offline-app", withExtension: "html"),
              let html = try? String(contentsOf: resource, encoding: .utf8) else { return false }
        webView.loadSimulatedRequest(URLRequest(url: Dim0WebAppConfiguration.appURL), responseHTML: html)
        return true
    }
}

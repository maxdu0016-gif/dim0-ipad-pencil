import XCTest
import WebKit
@testable import Dim0Native

@MainActor
final class LocalPairingTests: XCTestCase {
    func testOnlyPrivateHTTPSAddressesAreAccepted() {
        for value in ["https://192.168.1.2:54321", "https://10.0.0.2:54321", "https://172.16.0.2:54321"] {
            XCTAssertNotNil(LocalPairingBridge.endpoint(value), value)
        }
        for value in ["http://192.168.1.2:54321", "https://127.0.0.1:54321", "https://8.8.8.8:54321", "https://example.com:54321",
                      "https://192.168.1.2:54321/path", "https://user@192.168.1.2:54321", "https://192.168.1.2:54321?url=x",
                      "https://192.168.1.2", "https://192.168.1.2:443", "https://172.32.0.2:54321", "file:///etc/passwd"] {
            XCTAssertNil(LocalPairingBridge.endpoint(value), value)
        }
    }

    /// Simulated responses must retain the HTTPS origin, and its saved browser data, after a reload.
    func testOfflineHTMLKeepsExistingOriginAndStorage() async throws {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: configuration)
        let request = URLRequest(url: Dim0WebAppConfiguration.appURL)
        let first = NavigationWaiter()
        view.navigationDelegate = first
        view.loadSimulatedRequest(request, responseHTML: "<html><body>First</body></html>")
        await fulfillment(of: [first.loaded], timeout: 15)
        _ = try await runScript(view, "localStorage.setItem('offline-origin-test', 'saved'); return location.origin")
        _ = try await runScript(view, """
            const db = await new Promise((resolve, reject) => {
              const r = indexedDB.open('offline-origin-test', 1);
              r.onupgradeneeded = () => r.result.createObjectStore('boards');
              r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
            });
            const tx = db.transaction('boards', 'readwrite');
            tx.objectStore('boards').put({title: 'Existing drawing'}, 'old-board');
            await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
            db.close(); return true;
            """)
        let next = NavigationWaiter()
        view.navigationDelegate = next
        view.loadSimulatedRequest(request, responseHTML: "<html><body>Offline</body></html>")
        await fulfillment(of: [next.loaded], timeout: 15)
        let value = try await runScript(view, "return localStorage.getItem('offline-origin-test')") as? String
        XCTAssertEqual(value, "saved")
        let title = try await runScript(view, """
            const db = await new Promise((resolve, reject) => {
              const r = indexedDB.open('offline-origin-test', 1);
              r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
            });
            const value = await new Promise((resolve, reject) => {
              const r = db.transaction('boards').objectStore('boards').get('old-board');
              r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
            });
            db.close(); return value.title;
            """) as? String
        XCTAssertEqual(title, "Existing drawing")
        let origin = try await runScript(view, "return location.origin") as? String
        XCTAssertEqual(origin, "https://\(try XCTUnwrap(Dim0WebAppConfiguration.appURL.host))")
    }

    /// Use the Objective-C message bridge: the simulator lacks the Swift WebKit async overlay dylib.
    private func runScript(_ view: WKWebView, _ script: String) async throws -> Any? {
        let receiver = ScriptResultReceiver()
        view.configuration.userContentController.add(receiver, name: "testResult")
        defer { view.configuration.userContentController.removeScriptMessageHandler(forName: "testResult") }
        view.evaluateJavaScript("void (async () => { \(script) })().then(value => window.webkit.messageHandlers.testResult.postMessage({value}), error => window.webkit.messageHandlers.testResult.postMessage({error: String(error)}))") { _, error in
            if let error { receiver.complete(["error": error.localizedDescription]) }
        }
        await fulfillment(of: [receiver.received], timeout: 15)
        if let error = receiver.result?["error"] as? String { throw NSError(domain: "OfflineTest", code: 1, userInfo: [NSLocalizedDescriptionKey: error]) }
        return try XCTUnwrap(receiver.result)["value"]
    }
}

@MainActor
private final class ScriptResultReceiver: NSObject, WKScriptMessageHandler {
    let received = XCTestExpectation(description: "Web script result")
    var result: [String: Any]?
    func complete(_ value: [String: Any]) {
        guard result == nil else { return }
        result = value
        received.fulfill()
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        complete(message.body as? [String: Any] ?? ["error": "Invalid test reply"])
    }
}

@MainActor
private final class NavigationWaiter: NSObject, WKNavigationDelegate {
    let loaded = XCTestExpectation(description: "Simulated HTML loaded")
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded.fulfill() }
}

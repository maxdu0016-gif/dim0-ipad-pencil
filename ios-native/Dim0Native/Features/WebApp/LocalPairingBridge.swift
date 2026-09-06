import AVFoundation
import CryptoKit
import Security
import UIKit
import WebKit

/// The QR pins a single local HTTPS server. This delegate never changes global TLS policy.
private final class LocalPinnedSession: NSObject, URLSessionDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    let endpoint: URL
    let fingerprint: String

    init(endpoint: URL, fingerprint: String) {
        self.endpoint = endpoint
        self.fingerprint = fingerprint
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              challenge.protectionSpace.host == endpoint.host,
              challenge.protectionSpace.port == endpoint.port,
              let trust = challenge.protectionSpace.serverTrust,
              let cert = SecTrustGetCertificateAtIndex(trust, 0) else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        let digest = SHA256.hash(data: SecCertificateCopyData(cert) as Data).map { String(format: "%02x", $0) }.joined()
        completionHandler(digest == fingerprint ? .useCredential : .cancelAuthenticationChallenge,
                          digest == fingerprint ? URLCredential(trust: trust) : nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Credentials stay in the Keychain; the web app receives an opaque connection id only.
struct LocalPairingCredential: Codable {
    let endpoint: String
    let fingerprint: String
    let token: String
    let room: String
    let clientId: String
}

@MainActor
final class LocalPairingBridge: NSObject, WKScriptMessageHandlerWithReply {
    weak var webView: WKWebView?
    private let service = "com.dim0.canvas.lan"
    private var scanner: LocalQRScanner?

    /// Only the main, trusted app frame can scan or reach a paired local server.
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame,
              Dim0WebAppConfiguration.isTrustedAppOrigin(scheme: message.frameInfo.securityOrigin.protocol,
                  host: message.frameInfo.securityOrigin.host, port: message.frameInfo.securityOrigin.port),
              let body = message.body as? [String: Any], let action = body["action"] as? String else {
            replyHandler(nil, "Untrusted local connection request")
            return
        }
        if action == "scan" {
            scan(replyHandler)
            return
        }
        Task { @MainActor in
            do { replyHandler(try await command(action, body["body"] as? [String: Any] ?? [:]), nil) }
            catch { replyHandler(nil, error.localizedDescription) }
        }
    }

    /// Parse only explicit private IPv4 HTTPS endpoints; no DNS or arbitrary URL proxying.
    static func endpoint(_ raw: String) -> URL? {
        guard let url = URL(string: raw), url.scheme == "https", url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/",
              let port = url.port, (1024...65535).contains(port), let host = url.host else { return nil }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        let octets = parts.compactMap { Int($0) }
        guard parts.count == 4, octets.count == 4, octets.allSatisfy({ (0...255).contains($0) }),
              zip(parts, octets).allSatisfy({ String($0.0) == String($0.1) }),
              octets[0] == 10 || (octets[0] == 172 && (16...31).contains(octets[1])) || (octets[0] == 192 && octets[1] == 168) else { return nil }
        return url
    }

    private func failure(_ text: String) -> NSError { NSError(domain: "Dim0LAN", code: 1, userInfo: [NSLocalizedDescriptionKey: text]) }

    private func keyQuery(_ id: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: id]
    }

    private func save(_ credential: LocalPairingCredential, id: String) throws {
        let data = try JSONEncoder().encode(credential)
        var query = keyQuery(id)
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        if status == errSecDuplicateItem {
            guard SecItemUpdate(keyQuery(id) as CFDictionary, [kSecValueData as String: data] as CFDictionary) == errSecSuccess else {
                throw failure("Unable to update pairing securely")
            }
        } else if status != errSecSuccess { throw failure("Unable to save pairing securely") }
    }

    private func load(_ id: String) throws -> LocalPairingCredential {
        var query = keyQuery(id)
        query[kSecReturnData as String] = true
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else {
            throw failure("Pair this device again")
        }
        return try JSONDecoder().decode(LocalPairingCredential.self, from: data)
    }

    private func request(_ credential: LocalPairingCredential, path: String, body: [String: Any]) async throws -> [String: Any] {
        guard let endpoint = Self.endpoint(credential.endpoint) else { throw failure("Invalid local address") }
        let delegate = LocalPinnedSession(endpoint: endpoint, fingerprint: credential.fingerprint)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.httpShouldSetCookies = false
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: endpoint.appendingPathComponent("v1/\(path)"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        guard (request.httpBody?.count ?? 0) <= 32 * 1024 * 1024 else { throw failure("Transfer exceeds 32 MB") }
        let (data, response) = try await session.data(for: request)
        guard data.count <= 32 * 1024 * 1024, let response = response as? HTTPURLResponse else { throw failure("Invalid local response") }
        guard response.statusCode == 200 else {
            throw failure(response.statusCode == 403 ? "请在电脑上确认配对；已撤销的连接需要重新配对。" : "Local service rejected the request (\(response.statusCode))")
        }
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw failure("Invalid local response") }
        return json
    }

    private func command(_ action: String, _ body: [String: Any]) async throws -> Any {
        if action == "join" {
            guard let raw = body["invitation"] as? String, raw.utf8.count < 4096,
                  let data = raw.data(using: .utf8), let invite = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  invite["version"] as? Int == 1, let address = invite["endpoint"] as? String, Self.endpoint(address) != nil,
                  let fingerprint = invite["fingerprint"] as? String, fingerprint.count == 64,
                  fingerprint.allSatisfy({ $0.isHexDigit }), let token = invite["invite"] as? String, token.count == 64, token.allSatisfy({ $0.isHexDigit }),
                  let expires = invite["expires"] as? Double, expires > Date().timeIntervalSince1970 else {
                throw failure("配对码无效或已过期，请在电脑上重新生成。")
            }
            var bytes = [UInt8](repeating: 0, count: 32)
            guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw failure("Random generator unavailable") }
            let deviceToken = bytes.map { String(format: "%02x", $0) }.joined()
            // Persist before sending: a lost claim response must retry with the same device credential.
            let id = SHA256.hash(data: Data("\(address)|\(fingerprint.lowercased())|\(token)".utf8)).map { String(format: "%02x", $0) }.joined()
            let provisional: LocalPairingCredential
            if let existing = try? load(id) { provisional = existing }
            else {
                provisional = LocalPairingCredential(endpoint: address, fingerprint: fingerprint.lowercased(), token: deviceToken, room: "", clientId: "")
                try save(provisional, id: id)
            }
            let result = try await request(provisional, path: "claim", body: ["invite": token, "credential": provisional.token, "name": "Dim0 iPad"])
            guard let room = result["room"] as? String, let clientId = result["clientId"] as? String else { throw failure("Invalid pairing reply") }
            try save(LocalPairingCredential(endpoint: address, fingerprint: fingerprint.lowercased(), token: provisional.token, room: room, clientId: clientId), id: id)
            return ["connectionId": id, "room": room, "clientId": clientId, "endpoint": address]
        }
        guard let id = body["connectionId"] as? String else { throw failure("Missing pairing") }
        if action == "forget" {
            if let credential = try? load(id) {
                _ = try await request(credential, path: "leave", body: [:])
            }
            SecItemDelete(keyQuery(id) as CFDictionary)
            return ["ok": true]
        }
        let credential = try load(id)
        switch action {
        case "bootstrap": return try await request(credential, path: "bootstrap", body: [:])
        case "exchange": return try await request(credential, path: "exchange", body: ["since": body["since"] ?? 0, "messages": body["messages"] ?? []])
        default: throw failure("Unsupported local action")
        }
    }

    private func scan(_ reply: @escaping (Any?, String?) -> Void) {
        guard scanner == nil, var presenter = webView?.window?.rootViewController else {
            reply(nil, "Scanner unavailable; paste the pairing code instead")
            return
        }
        while let next = presenter.presentedViewController { presenter = next }
        let controller = LocalQRScanner { [weak self] value in
            self?.scanner = nil
            if let value { reply(value, nil) } else { reply(nil, "Scan cancelled") }
        }
        scanner = controller
        presenter.present(controller, animated: true)
    }
}

/// QR-only camera reader. Text entry in the web UI remains available without camera permission.
private final class LocalQRScanner: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let capture = AVCaptureSession()
    private let captureQueue = DispatchQueue(label: "com.dim0.lan.camera")
    private let completion: (String?) -> Void
    private var finished = false
    private var preview: AVCaptureVideoPreviewLayer?

    init(completion: @escaping (String?) -> Void) { self.completion = completion; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        isModalInPresentation = true
        let close = UIButton(type: .system)
        close.setTitle("取消扫码", for: .normal)
        close.backgroundColor = .systemBackground
        close.frame = CGRect(x: 24, y: 40, width: 120, height: 48)
        close.addTarget(self, action: #selector(cancel), for: .touchUpInside)
        view.addSubview(close)
        AVCaptureDevice.requestAccess(for: .video) { [weak self] allowed in
            DispatchQueue.main.async { allowed ? self?.start() : self?.finish(nil) }
        }
    }
    private func start() {
        guard !finished, let device = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: device), capture.canAddInput(input) else { finish(nil); return }
        capture.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard capture.canAddOutput(output) else { finish(nil); return }
        capture.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let layer = AVCaptureVideoPreviewLayer(session: capture)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.insertSublayer(layer, at: 0)
        preview = layer
        captureQueue.async { [capture] in capture.startRunning() }
    }
    override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); preview?.frame = view.bounds }
    @objc private func cancel() { finish(nil) }
    private func finish(_ value: String?) {
        guard !finished else { return }
        finished = true
        captureQueue.async { [capture] in capture.stopRunning() }
        dismiss(animated: true) { self.completion(value) }
    }
    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        if let code = metadataObjects.first as? AVMetadataMachineReadableCodeObject, let value = code.stringValue { finish(value) }
    }
}

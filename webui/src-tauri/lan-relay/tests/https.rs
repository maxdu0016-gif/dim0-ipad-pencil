use dim0_lan_relay::{now, secret, server};
use reqwest::{blocking::Client, Certificate, StatusCode};
use serde_json::{json, Value};
use std::time::Duration;

/// Run explicitly on a machine with a private network interface; no Internet service is contacted.
#[test]
#[ignore = "requires a private LAN interface"]
fn tls_authorization_and_revocation_over_real_network() {
    let address = server::addresses()
        .unwrap()
        .into_iter()
        .next()
        .expect("No private interface");
    let dir = std::env::temp_dir().join(format!("dim0-lan-https-{}", secret().unwrap()));
    let running = server::start(&dir, &address).unwrap();
    let identity: Value =
        serde_json::from_slice(&std::fs::read(dir.join("tls-identity.json")).unwrap()).unwrap();
    let certificate = Certificate::from_pem(identity["cert"].as_str().unwrap().as_bytes()).unwrap();
    let client = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .add_root_certificate(certificate)
        .build()
        .unwrap();
    let url = |path: &str| format!("{}/v1/{path}", running.endpoint);
    // Default trust must reject our local identity; this test never disables certificate verification.
    let untrusted = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    assert!(untrusted.post(url("bootstrap")).send().is_err());
    let room = running
        .relay
        .create_room("board", &json!({"content":{"nodes":[],"edges":[]}}))
        .unwrap();
    let invitation = running.relay.invite(&room, now()).unwrap();
    let token = secret().unwrap();
    let claimed: Value = client
        .post(url("claim"))
        .json(&json!({"invite":invitation,"credential":token,"name":"Test iPad"}))
        .send()
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(
        client
            .post(url("bootstrap"))
            .bearer_auth(&token)
            .send()
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    running
        .relay
        .approve(&room, claimed["clientId"].as_str().unwrap(), true)
        .unwrap();
    let seed: Value = client
        .post(url("bootstrap"))
        .bearer_auth(&token)
        .send()
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .unwrap();
    assert!(seed["seed"]["content"]["nodes"].is_array());
    assert_eq!(
        client
            .post(format!("{}/v1/approve", running.endpoint))
            .bearer_auth(&token)
            .json(&json!({}))
            .send()
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    client
        .post(url("leave"))
        .bearer_auth(&token)
        .send()
        .unwrap()
        .error_for_status()
        .unwrap();
    assert_eq!(
        client
            .post(url("bootstrap"))
            .bearer_auth(&token)
            .send()
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    drop(running);
    // The service thread owns the SQLite handle until shutdown completes; retain this isolated test directory.
}

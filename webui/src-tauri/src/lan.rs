//! Native-only administration. Remote peers never receive these commands.
use dim0_lan_relay::{now, server};
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::Manager;

#[derive(Default)]
pub struct Lan(pub Mutex<Option<server::Running>>);

/// One native entry point with a closed action list, scoped to the active local relay.
#[tauri::command]
pub fn lan_command(
    app: tauri::AppHandle,
    state: tauri::State<Lan>,
    action: String,
    body: Value,
) -> Result<Value, String> {
    if action == "addresses" {
        return server::addresses().map(|a| json!(a));
    }
    let mut guard = state.0.lock().map_err(|_| "Local service unavailable")?;
    if action == "stop" {
        *guard = None;
        return Ok(json!({}));
    }
    if action == "start" {
        if guard.is_none() {
            let dir = app
                .path()
                .app_data_dir()
                .map_err(|e| e.to_string())?
                .join("lan");
            let address = body["address"]
                .as_str()
                .ok_or("Choose your Wi-Fi address")?;
            *guard = Some(server::start(&dir, address)?);
        }
        let server = guard.as_ref().ok_or("Local service unavailable")?;
        return Ok(json!({"endpoint":server.endpoint,"fingerprint":server.fingerprint}));
    }
    let server = guard.as_ref().ok_or("Start the local service first")?;
    let room = body["room"].as_str().unwrap_or("");
    match action.as_str() {
        "create" => server
            .relay
            .create_room(body["boardId"].as_str().unwrap_or(""), &body["seed"])
            .map(|r| json!({"room":r})),
        "invite" => {
            let token = server.relay.invite(room, now())?;
            let invitation = json!({"version":1,"endpoint":server.endpoint,"fingerprint":server.fingerprint,"invite":token,"expires":now()+600}).to_string();
            let svg = dim0_lan_relay::qr_svg(&invitation)?;
            Ok(json!({"invitation":invitation,"svg":svg}))
        }
        "peers" => server.relay.peers(room),
        "approve" => server
            .relay
            .approve(
                room,
                body["peer"].as_str().ok_or("Missing peer")?,
                body["allowed"].as_bool().ok_or("Missing decision")?,
            )
            .map(|_| json!({})),
        "bootstrap" => server.relay.bootstrap(room),
        "exchange" => server.relay.exchange(
            room,
            body["clientId"].as_str().ok_or("Missing client identity")?,
            &body,
        ),
        _ => Err("Unknown LAN command".into()),
    }
}

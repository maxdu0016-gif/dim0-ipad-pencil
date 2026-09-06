//! A board-scoped, durable LAN sequencer. All merge decisions remain in the client.
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

pub mod server;

pub const MAX_BODY: usize = 32 * 1024 * 1024;
pub type Result<T> = std::result::Result<T, String>;

pub struct Relay(Mutex<Connection>);

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// OS randomness for invitations and room ids, never predictable timestamps.
pub fn secret() -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(hex(&bytes))
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn qr_svg(value: &str) -> Result<String> {
    qrcode::QrCode::new(value.as_bytes())
        .map(|code| {
            code.render::<qrcode::render::svg::Color>()
                .min_dimensions(320, 320)
                .build()
        })
        .map_err(|e| e.to_string())
}

fn hash(value: &str) -> String {
    hex(&Sha256::digest(value.as_bytes()))
}
fn err(e: rusqlite::Error) -> String {
    e.to_string()
}
fn string<'a>(v: &'a Value, name: &str) -> Result<&'a str> {
    v[name]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 256)
        .ok_or_else(|| format!("Invalid {name}"))
}

impl Relay {
    pub fn open(path: &Path) -> Result<Self> {
        Self::from_connection(Connection::open(path).map_err(err)?)
    }

    fn from_connection(conn: Connection) -> Result<Self> {
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, board TEXT UNIQUE NOT NULL, seed TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS batches(room TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, client TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(room,seq), UNIQUE(room,id));
            CREATE TABLE IF NOT EXISTS invites(hash TEXT PRIMARY KEY, room TEXT NOT NULL, expires INTEGER NOT NULL, claimant TEXT);
            CREATE TABLE IF NOT EXISTS peers(hash TEXT PRIMARY KEY, room TEXT NOT NULL, client TEXT NOT NULL, name TEXT NOT NULL, approved INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0);")
            .map_err(err)?;
        Ok(Self(Mutex::new(conn)))
    }

    /// Capture one immutable base per board. Re-inviting never resets its journal.
    pub fn create_room(&self, board: &str, seed: &Value) -> Result<String> {
        if board.is_empty() || board.len() > 256 {
            return Err("Invalid board".into());
        }
        let raw = serde_json::to_string(seed).map_err(|e| e.to_string())?;
        if raw.len() > MAX_BODY
            || !seed["content"]["nodes"].is_array()
            || !seed["content"]["edges"].is_array()
        {
            return Err("Invalid or oversized board package".into());
        }
        let conn = self.0.lock().map_err(|_| "Relay unavailable")?;
        let existing: Option<String> = conn
            .query_row("SELECT id FROM rooms WHERE board=?", [board], |r| r.get(0))
            .optional()
            .map_err(err)?;
        if let Some(id) = existing {
            return Ok(id);
        }
        let id = secret()?;
        conn.execute("INSERT INTO rooms VALUES(?,?,?)", params![id, board, raw])
            .map_err(err)?;
        Ok(id)
    }

    /// Only a local desktop command creates invitations; they expire after ten minutes.
    pub fn invite(&self, room: &str, clock: u64) -> Result<String> {
        let conn = self.0.lock().map_err(|_| "Relay unavailable")?;
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM rooms WHERE id=?)",
                [room],
                |r| r.get(0),
            )
            .map_err(err)?;
        if !exists {
            return Err("Unknown room".into());
        }
        conn.execute("DELETE FROM invites WHERE room=?", [room])
            .map_err(err)?;
        let token = secret()?;
        conn.execute(
            "INSERT INTO invites(hash,room,expires) VALUES(?,?,?)",
            params![hash(&token), room, clock + 600],
        )
        .map_err(err)?;
        Ok(token)
    }

    /// Claim is retry-safe for the same device secret, but an invitation cannot pair another device.
    pub fn claim(&self, invite: &str, credential: &str, name: &str, clock: u64) -> Result<Value> {
        if credential.len() != 64
            || !credential.bytes().all(|b| b.is_ascii_hexdigit())
            || name.is_empty()
            || name.len() > 80
        {
            return Err("Invalid device identity".into());
        }
        let mut conn = self.0.lock().map_err(|_| "Relay unavailable")?;
        let tx = conn.transaction().map_err(err)?;
        let (room, expires, claimant): (String, u64, Option<String>) = tx
            .query_row(
                "SELECT room,expires,claimant FROM invites WHERE hash=?",
                [hash(invite)],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|_| "Invitation unavailable")?;
        let device = hash(credential);
        if clock >= expires || claimant.as_ref().is_some_and(|c| c != &device) {
            return Err("Invitation expired or already used".into());
        }
        tx.execute(
            "INSERT OR IGNORE INTO peers(hash,room,client,name) VALUES(?,?,?,?)",
            params![device, room, device, name],
        )
        .map_err(err)?;
        tx.execute(
            "UPDATE invites SET claimant=? WHERE hash=?",
            params![device, hash(invite)],
        )
        .map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(json!({"room":room,"clientId":device}))
    }

    pub fn peers(&self, room: &str) -> Result<Value> {
        let conn = self.0.lock().map_err(|_| "Relay unavailable")?;
        let mut statement = conn
            .prepare("SELECT hash,name,approved,revoked FROM peers WHERE room=?")
            .map_err(err)?;
        let rows = statement.query_map([room], |r| Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"approved":r.get::<_,bool>(2)?,"revoked":r.get::<_,bool>(3)?}))).map_err(err)?;
        Ok(Value::Array(
            rows.collect::<std::result::Result<Vec<_>, _>>()
                .map_err(err)?,
        ))
    }

    /// This is deliberately absent from the network router: only desktop UI can approve/revoke.
    pub fn approve(&self, room: &str, peer: &str, allowed: bool) -> Result<()> {
        let conn = self.0.lock().map_err(|_| "Relay unavailable")?;
        conn.execute(
            "UPDATE peers SET approved=?,revoked=? WHERE room=? AND hash=?",
            params![allowed, !allowed, room, peer],
        )
        .map_err(err)?;
        Ok(())
    }

    pub fn authorize(&self, credential: &str) -> Result<(String, String)> {
        let conn = self.0.lock().map_err(|_| "Relay unavailable")?;
        conn.query_row(
            "SELECT room,client FROM peers WHERE hash=? AND approved=1 AND revoked=0",
            [hash(credential)],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| "Pairing not approved or revoked".into())
    }

    /// A device can revoke only its own credential; this is idempotent even after revocation.
    pub fn leave(&self, credential: &str) -> Result<()> {
        let conn = self.0.lock().map_err(|_| "Relay unavailable")?;
        conn.execute(
            "UPDATE peers SET approved=0,revoked=1 WHERE hash=?",
            [hash(credential)],
        )
        .map_err(err)?;
        Ok(())
    }

    /// Retire a room without destroying its journal. Future pairing starts a new immutable base.
    pub fn retire(&self, room: &str) -> Result<()> {
        let mut conn = self.0.lock().map_err(|_| "Relay unavailable")?;
        let tx = conn.transaction().map_err(err)?;
        tx.execute("UPDATE peers SET approved=0,revoked=1 WHERE room=?", [room])
            .map_err(err)?;
        tx.execute("DELETE FROM invites WHERE room=?", [room])
            .map_err(err)?;
        tx.execute(
            "UPDATE rooms SET board=? WHERE id=?",
            params![format!("retired:{room}"), room],
        )
        .map_err(err)?;
        tx.commit().map_err(err)
    }

    /// Initial transfer contains the immutable base and every subsequent batch, never a destructive reset.
    pub fn bootstrap(&self, room: &str) -> Result<Value> {
        let conn = self.0.lock().map_err(|_| "Relay unavailable")?;
        let raw: String = conn
            .query_row("SELECT seed FROM rooms WHERE id=?", [room], |r| r.get(0))
            .map_err(err)?;
        let seed: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        Ok(json!({"seed": seed}))
    }

    /// Sequence and deduplicate in one durable transaction; ack only after commit.
    pub fn exchange(&self, room: &str, client: &str, request: &Value) -> Result<Value> {
        let since = request["since"]
            .as_u64()
            .filter(|n| *n <= i64::MAX as u64)
            .ok_or("Invalid cursor")?;
        let outgoing = request["messages"]
            .as_array()
            .filter(|m| m.len() <= 100)
            .ok_or("Invalid message batch")?;
        if client.is_empty() || client.len() > 256 {
            return Err("Invalid client".into());
        }
        let mut conn = self.0.lock().map_err(|_| "Relay unavailable")?;
        let tx = conn.transaction().map_err(err)?;
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM rooms WHERE id=?)",
                [room],
                |r| r.get(0),
            )
            .map_err(err)?;
        if !exists {
            return Err("Unknown room".into());
        }
        let mut seq: u64 = tx
            .query_row(
                "SELECT COALESCE(MAX(seq),0) FROM batches WHERE room=?",
                [room],
                |r| r.get(0),
            )
            .map_err(err)?;
        if since > seq {
            return Err("Relay cursor is ahead of journal".into());
        }
        let mut acknowledgments = Vec::new();
        for msg in outgoing {
            if msg["kind"] == "hello"
                || msg["kind"] == "presence"
                || msg["kind"] == "presence-leave"
            {
                continue;
            }
            if msg["kind"] != "op" {
                return Err("Unknown message".into());
            }
            let client_seq = msg["client_seq"]
                .as_u64()
                .ok_or("Invalid client sequence")?;
            let batch = &msg["batch"];
            let id = string(batch, "id")?;
            if string(batch, "clientId")? != client {
                return Err("Client identity mismatch".into());
            }
            let ops = batch["ops"]
                .as_array()
                .filter(|a| !a.is_empty() && a.len() <= 10000)
                .ok_or("Invalid operations")?;
            for op in ops {
                validate_op(op)?;
            }
            let raw = serde_json::to_string(batch).map_err(|e| e.to_string())?;
            if raw.len() > MAX_BODY / 2 {
                return Err("Batch too large".into());
            }
            let duplicate: Option<(u64, String)> = tx
                .query_row(
                    "SELECT seq,body FROM batches WHERE room=? AND id=?",
                    params![room, id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(err)?;
            let applied = if let Some((old_seq, old_body)) = duplicate {
                if old_body != raw {
                    return Err("Batch id reused with different content".into());
                }
                old_seq
            } else {
                seq += 1;
                tx.execute(
                    "INSERT INTO batches VALUES(?,?,?,?,?)",
                    params![room, seq, id, client, raw],
                )
                .map_err(err)?;
                seq
            };
            acknowledgments
                .push(json!({"kind":"op-applied","seq":applied,"client_seq":client_seq}));
        }
        let mut messages = Vec::new();
        let mut cursor = since;
        {
            let mut query = tx.prepare("SELECT seq,client,body FROM batches WHERE room=? AND seq>? ORDER BY seq LIMIT 100").map_err(err)?;
            let rows = query
                .query_map(params![room, since], |r| {
                    Ok((
                        r.get::<_, u64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })
                .map_err(err)?;
            let mut size = 0;
            for row in rows {
                let (n, sender, raw) = row.map_err(err)?;
                size += raw.len();
                if size > MAX_BODY - 4096 {
                    break;
                }
                cursor = n;
                if sender != client {
                    messages.push(json!({"kind":"peer-op","seq":n,"batch":serde_json::from_str::<Value>(&raw).map_err(|e| e.to_string())?}));
                }
            }
        }
        // Preserve total order, including self acks. A later peer edit must win over an earlier local edit.
        // With paginated catch-up, defer later acks until their journal position has been delivered.
        messages.extend(
            acknowledgments
                .into_iter()
                .filter(|m| m["seq"].as_u64().unwrap_or(u64::MAX) <= cursor),
        );
        messages.sort_by_key(|m| m["seq"].as_u64().unwrap_or(0));
        tx.commit().map_err(err)?;
        Ok(json!({"cursor":cursor,"latest":seq,"messages":messages}))
    }
}

/// Validate the operation envelope before another device can feed it to the canvas engine.
fn validate_op(op: &Value) -> Result<()> {
    match string(op, "type")? {
        "node.add" | "node.remove" => {
            let node = &op["node"];
            string(node, "id")?;
            string(node, "type")?;
            for key in ["x", "y", "w", "h", "angle", "z"] {
                if node[key].as_f64().is_none() {
                    return Err(format!("Invalid node {key}"));
                }
            }
            if !node["groups"].is_array() {
                return Err("Invalid node groups".into());
            }
        }
        "edge.add" | "edge.remove" => {
            let edge = &op["edge"];
            string(edge, "id")?;
            if !edge["source"].is_object()
                || !edge["target"].is_object()
                || !edge["groups"].is_array()
            {
                return Err("Invalid edge".into());
            }
        }
        "node.update" | "edge.update" => {
            string(op, "id")?;
            if !op["patch"].is_object() || !op["prev"].is_object() {
                return Err("Invalid update".into());
            }
            if op["patch"].get("id").is_some_and(|id| id != &op["id"]) {
                return Err("Cannot change entity identity".into());
            }
            for key in ["x", "y", "w", "h", "angle", "z"] {
                if op["patch"].get(key).is_some_and(|v| v.as_f64().is_none()) {
                    return Err("Invalid geometry".into());
                }
            }
        }
        "group.upsert" | "group.remove" => {
            string(&op["group"], "id")?;
        }
        "frame.reorder" => {
            for key in ["ids", "prev"] {
                if !op[key]
                    .as_array()
                    .is_some_and(|a| a.iter().all(Value::is_string))
                {
                    return Err("Invalid frame order".into());
                }
            }
        }
        _ => return Err("Unsupported operation".into()),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn relay() -> Relay {
        Relay::from_connection(Connection::open_in_memory().unwrap()).unwrap()
    }
    fn seed() -> Value {
        json!({"content":{"nodes":[],"edges":[]}})
    }
    fn op(id: &str, client: &str) -> Value {
        json!({"kind":"op","client_seq":1,"batch":{"id":id,"clientId":client,"ops":[{"type":"node.update","id":"n","patch":{"x":10},"prev":{"x":0}}]}})
    }

    #[test]
    fn invitation_requires_approval_expires_and_cannot_be_reused() {
        let relay = relay();
        let room = relay.create_room("board", &seed()).unwrap();
        let invite = relay.invite(&room, 100).unwrap();
        let credential = secret().unwrap();
        let joined = relay.claim(&invite, &credential, "iPad", 101).unwrap();
        assert!(relay.authorize(&credential).is_err());
        assert!(relay
            .claim(&invite, &secret().unwrap(), "Other", 102)
            .is_err());
        assert!(relay.claim(&invite, &credential, "iPad", 102).is_ok());
        relay
            .approve(&room, joined["clientId"].as_str().unwrap(), true)
            .unwrap();
        assert_eq!(relay.authorize(&credential).unwrap().0, room);
        relay
            .approve(&room, joined["clientId"].as_str().unwrap(), false)
            .unwrap();
        assert!(relay.authorize(&credential).is_err());
        let expired = relay.invite(&room, 0).unwrap();
        assert!(relay
            .claim(&expired, &secret().unwrap(), "iPad", 600)
            .is_err());
    }

    #[test]
    fn sequences_deduplicates_and_rolls_back_invalid_transactions() {
        let relay = relay();
        let room = relay.create_room("board", &seed()).unwrap();
        let request = json!({"since":0,"messages":[op("a","desktop")]});
        assert_eq!(
            relay.exchange(&room, "desktop", &request).unwrap()["latest"],
            1
        );
        assert_eq!(
            relay.exchange(&room, "desktop", &request).unwrap()["latest"],
            1
        );
        assert!(relay.exchange(&room, "intruder", &request).is_err());
        let invalid = json!({"since":0,"messages":[op("b","desktop"),{"kind":"invalid"}]});
        assert!(relay.exchange(&room, "desktop", &invalid).is_err());
        let result = relay
            .exchange(&room, "ipad", &json!({"since":0,"messages":[]}))
            .unwrap();
        assert_eq!(result["latest"], 1);
        assert_eq!(result["messages"].as_array().unwrap().len(), 1);
        assert_eq!(relay.create_room("board", &seed()).unwrap(), room);
    }

    #[test]
    fn journal_survives_restart_and_ack_precedes_later_peer_edit() {
        let path = std::env::temp_dir().join(format!("dim0-lan-{}.db", secret().unwrap()));
        let room;
        {
            let relay = Relay::open(&path).unwrap();
            room = relay.create_room("b", &seed()).unwrap();
            relay
                .exchange(
                    &room,
                    "desktop",
                    &json!({"since":0,"messages":[op("first","desktop")]}),
                )
                .unwrap();
            relay
                .exchange(
                    &room,
                    "ipad",
                    &json!({"since":0,"messages":[op("second","ipad")]}),
                )
                .unwrap();
        }
        {
            let relay = Relay::open(&path).unwrap();
            let response = relay
                .exchange(
                    &room,
                    "desktop",
                    &json!({"since":0,"messages":[op("first","desktop")]}),
                )
                .unwrap();
            assert_eq!(response["latest"], 2);
            assert_eq!(response["messages"][0]["kind"], "op-applied");
            assert_eq!(response["messages"][1]["kind"], "peer-op");
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn pagination_defers_acks_until_prior_history_is_delivered() {
        let relay = relay();
        let room = relay.create_room("board", &seed()).unwrap();
        let messages: Vec<Value> = (0..100).map(|i| op(&format!("peer-{i}"), "peer")).collect();
        relay
            .exchange(&room, "peer", &json!({"since":0,"messages":messages}))
            .unwrap();
        let request = json!({"since":0,"messages":[op("local", "desktop")]});
        let first = relay.exchange(&room, "desktop", &request).unwrap();
        assert_eq!(first["cursor"], 100);
        assert_eq!(first["latest"], 101);
        assert!(first["messages"]
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m["kind"] == "peer-op"));
        let second = relay
            .exchange(
                &room,
                "desktop",
                &json!({"since":100,"messages":[op("local", "desktop")]}),
            )
            .unwrap();
        assert_eq!(second["messages"][0]["kind"], "op-applied");
        assert_eq!(second["latest"], 101);
        let mut changed = op("local", "desktop");
        changed["batch"]["ops"][0]["patch"]["x"] = json!(99);
        assert!(relay
            .exchange(&room, "desktop", &json!({"since":101,"messages":[changed]}))
            .is_err());
    }

    #[test]
    fn unpair_revokes_credentials_and_new_room_preserves_old_journal() {
        let relay = relay();
        let room = relay.create_room("board", &seed()).unwrap();
        let invite = relay.invite(&room, 100).unwrap();
        let credential = secret().unwrap();
        let peer = relay.claim(&invite, &credential, "iPad", 101).unwrap();
        relay
            .approve(&room, peer["clientId"].as_str().unwrap(), true)
            .unwrap();
        relay
            .exchange(
                &room,
                "desktop",
                &json!({"since":0,"messages":[op("a", "desktop")]}),
            )
            .unwrap();
        relay.leave(&credential).unwrap();
        relay.leave(&credential).unwrap();
        assert!(relay.authorize(&credential).is_err());
        relay.retire(&room).unwrap();
        assert!(relay.claim(&invite, &credential, "iPad", 102).is_err());
        assert_ne!(relay.create_room("board", &seed()).unwrap(), room);
        assert_eq!(
            relay
                .exchange(&room, "desktop", &json!({"since":0,"messages":[]}))
                .unwrap()["latest"],
            1
        );
    }
}

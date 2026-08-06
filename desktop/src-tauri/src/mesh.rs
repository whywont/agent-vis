use crate::secrets::{SecretStore, SystemSecretStore, MESH_IDENTITY_KEY_ACCOUNT};
use crate::settings::{desktop_settings_path, read_validated_desktop_settings};
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
use serde::Serialize;
use snow::{params::NoiseParams, Builder, TransportState};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

const MESH_PORT: u16 = 4242;
const MAX_FRAME_BYTES: usize = 64 * 1024;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_PENDING_HANDSHAKES: usize = 16;
const PROTOCOL_VERSION: u8 = 1;
const NOISE_PATTERN: &str = "Noise_XX_25519_ChaChaPoly_SHA256";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MeshPeerStatus {
    id: String,
    connected: bool,
    detail: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MeshStatus {
    public_key: String,
    listening: bool,
    peers: Vec<MeshPeerStatus>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectMeshPeerResponse {
    connected: bool,
    detail: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectMeshPeerRequest {
    device_id: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct MeshMessage {
    protocol: u8,
    kind: String,
}

pub(crate) struct MeshState {
    app: tauri::AppHandle,
    private_key: Vec<u8>,
    public_key: String,
    statuses: Arc<Mutex<Vec<MeshPeerStatus>>>,
    listener: Mutex<Option<MeshListener>>,
}

struct MeshListener {
    shutdown: Arc<AtomicBool>,
    thread: JoinHandle<()>,
}

impl MeshState {
    pub(crate) fn new(app: tauri::AppHandle) -> Result<Self, String> {
        let private_key = load_or_create_identity()?;
        let public_key = public_key_for(&private_key)?;
        let state = Self {
            app,
            private_key,
            public_key,
            statuses: Arc::new(Mutex::new(Vec::new())),
            listener: Mutex::new(None),
        };
        let enabled = read_validated_desktop_settings(&desktop_settings_path(&state.app)?)
            .map(|settings| crate::settings::has_authenticated_device(&settings))
            .unwrap_or(false);
        state.set_enabled(enabled);
        Ok(state)
    }

    pub(crate) fn set_enabled(&self, enabled: bool) {
        let Ok(mut active) = self.listener.lock() else {
            return;
        };
        if enabled == active.is_some() {
            return;
        }
        if !enabled {
            if let Some(listener) = active.take() {
                listener.shutdown.store(true, Ordering::Release);
                let _ = listener.thread.join();
            }
            return;
        }

        let Ok(listener) = TcpListener::bind(("0.0.0.0", MESH_PORT)) else {
            return;
        };
        if listener.set_nonblocking(true).is_err() {
            return;
        }
        let shutdown = Arc::new(AtomicBool::new(false));
        let state = ListenerState {
            app: self.app.clone(),
            private_key: self.private_key.clone(),
            statuses: Arc::clone(&self.statuses),
            pending_handshakes: Arc::new(Mutex::new(0)),
        };
        let shutdown_for_thread = Arc::clone(&shutdown);
        let thread =
            std::thread::spawn(move || accept_connections(listener, state, shutdown_for_thread));
        *active = Some(MeshListener { shutdown, thread });
    }

    fn status(&self) -> MeshStatus {
        MeshStatus {
            public_key: self.public_key.clone(),
            listening: self
                .listener
                .lock()
                .map(|listener| listener.is_some())
                .unwrap_or(false),
            peers: self
                .statuses
                .lock()
                .map(|statuses| statuses.clone())
                .unwrap_or_default(),
        }
    }
}

struct ListenerState {
    app: tauri::AppHandle,
    private_key: Vec<u8>,
    statuses: Arc<Mutex<Vec<MeshPeerStatus>>>,
    pending_handshakes: Arc<Mutex<usize>>,
}

fn noise_builder<'a>(private_key: &'a [u8]) -> Result<Builder<'a>, String> {
    let params = NoiseParams::from_str(NOISE_PATTERN).map_err(|error| error.to_string())?;
    Builder::new(params)
        .local_private_key(private_key)
        .map_err(|error| error.to_string())
}

fn load_or_create_identity() -> Result<Vec<u8>, String> {
    if let Some(value) = SystemSecretStore.get(MESH_IDENTITY_KEY_ACCOUNT)? {
        let key = STANDARD_NO_PAD
            .decode(value)
            .map_err(|_| "Mesh identity in Keychain is invalid.".to_owned())?;
        if key.len() != 32 {
            return Err("Mesh identity in Keychain is invalid.".to_owned());
        }
        return Ok(key);
    }
    let keypair =
        Builder::new(NoiseParams::from_str(NOISE_PATTERN).map_err(|error| error.to_string())?)
            .generate_keypair()
            .map_err(|error| error.to_string())?;
    SystemSecretStore.set(
        MESH_IDENTITY_KEY_ACCOUNT,
        &STANDARD_NO_PAD.encode(&keypair.private),
    )?;
    Ok(keypair.private)
}

fn public_key_for(private_key: &[u8]) -> Result<String, String> {
    if private_key.len() != 32 {
        return Err("Mesh identity has an invalid length.".to_owned());
    }
    let scalar: [u8; 32] = private_key
        .try_into()
        .map_err(|_| "Mesh identity has an invalid length.".to_owned())?;
    let public = x25519_basepoint(scalar);
    Ok(STANDARD_NO_PAD.encode(public))
}

fn x25519_basepoint(scalar: [u8; 32]) -> [u8; 32] {
    use curve25519_dalek::constants::X25519_BASEPOINT;
    *X25519_BASEPOINT.mul_clamped(scalar).as_bytes()
}

pub(crate) fn valid_public_key(value: &str) -> bool {
    STANDARD_NO_PAD
        .decode(value)
        .is_ok_and(|bytes| valid_public_key_bytes(&bytes))
}

fn valid_public_key_bytes(bytes: &[u8]) -> bool {
    if bytes.len() != 32 {
        return false;
    }
    let point: [u8; 32] = match bytes.try_into() {
        Ok(point) => point,
        Err(_) => return false,
    };
    use curve25519_dalek::montgomery::MontgomeryPoint;
    // Reject non-contributory points: Snow's X25519 resolver accepts them and
    // would otherwise feed an all-zero shared secret into the Noise schedule.
    MontgomeryPoint(point).mul_clamped([42_u8; 32]).as_bytes() != &[0_u8; 32]
}

fn decode_public_key(value: &str) -> Result<Vec<u8>, String> {
    let key = STANDARD_NO_PAD
        .decode(value)
        .map_err(|_| "The peer identity key is invalid.".to_owned())?;
    if key.len() != 32 {
        return Err("The peer identity key is invalid.".to_owned());
    }
    if !valid_public_key_bytes(&key) {
        return Err("The peer identity key is non-contributory.".to_owned());
    }
    Ok(key)
}

fn write_frame(stream: &mut TcpStream, data: &[u8]) -> Result<(), String> {
    if data.len() > MAX_FRAME_BYTES {
        return Err("Mesh frame exceeds the size limit.".to_owned());
    }
    stream
        .write_all(&(data.len() as u32).to_be_bytes())
        .map_err(|error| error.to_string())?;
    stream.write_all(data).map_err(|error| error.to_string())
}

fn read_frame(stream: &mut TcpStream) -> Result<Vec<u8>, String> {
    let mut length = [0; 4];
    stream
        .read_exact(&mut length)
        .map_err(|error| error.to_string())?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err("Mesh frame has an invalid size.".to_owned());
    }
    let mut frame = vec![0; length];
    stream
        .read_exact(&mut frame)
        .map_err(|error| error.to_string())?;
    Ok(frame)
}

fn validate_ephemeral_key(frame: &[u8]) -> Result<(), String> {
    // Every XX first/second handshake message starts with a 32-byte ephemeral
    // X25519 key. Reject low-order input before Snow performs any DH with it.
    if frame.len() < 32 || !valid_public_key_bytes(&frame[..32]) {
        return Err("Peer provided a non-contributory ephemeral key.".to_owned());
    }
    Ok(())
}

fn handshake_initiator(
    stream: &mut TcpStream,
    private_key: &[u8],
    expected_public: &[u8],
) -> Result<TransportState, String> {
    let mut handshake = noise_builder(private_key)?
        .build_initiator()
        .map_err(|error| error.to_string())?;
    let mut output = vec![0; MAX_FRAME_BYTES];
    let size = handshake
        .write_message(&[], &mut output)
        .map_err(|error| error.to_string())?;
    write_frame(stream, &output[..size])?;
    let input = read_frame(stream)?;
    validate_ephemeral_key(&input)?;
    handshake
        .read_message(&input, &mut output)
        .map_err(|error| error.to_string())?;
    let size = handshake
        .write_message(&[], &mut output)
        .map_err(|error| error.to_string())?;
    write_frame(stream, &output[..size])?;
    let remote = handshake
        .get_remote_static()
        .ok_or("Peer did not provide an identity key.")?;
    if !valid_public_key_bytes(remote) {
        return Err("Peer provided a non-contributory identity key.".to_owned());
    }
    if remote != expected_public {
        return Err("Peer identity does not match the configured key.".to_owned());
    }
    handshake
        .into_transport_mode()
        .map_err(|error| error.to_string())
}

fn handshake_responder(
    stream: &mut TcpStream,
    private_key: &[u8],
) -> Result<(TransportState, Vec<u8>), String> {
    let mut handshake = noise_builder(private_key)?
        .build_responder()
        .map_err(|error| error.to_string())?;
    let mut output = vec![0; MAX_FRAME_BYTES];
    let input = read_frame(stream)?;
    validate_ephemeral_key(&input)?;
    handshake
        .read_message(&input, &mut output)
        .map_err(|error| error.to_string())?;
    let size = handshake
        .write_message(&[], &mut output)
        .map_err(|error| error.to_string())?;
    write_frame(stream, &output[..size])?;
    let input = read_frame(stream)?;
    handshake
        .read_message(&input, &mut output)
        .map_err(|error| error.to_string())?;
    let remote = handshake
        .get_remote_static()
        .ok_or("Peer did not provide an identity key.")?
        .to_vec();
    if !valid_public_key_bytes(&remote) {
        return Err("Peer provided a non-contributory identity key.".to_owned());
    }
    Ok((
        handshake
            .into_transport_mode()
            .map_err(|error| error.to_string())?,
        remote,
    ))
}

fn send_message(
    stream: &mut TcpStream,
    state: &mut TransportState,
    message: &MeshMessage,
) -> Result<(), String> {
    let plaintext = serde_json::to_vec(message).map_err(|error| error.to_string())?;
    let mut ciphertext = vec![0; plaintext.len() + 32];
    let size = state
        .write_message(&plaintext, &mut ciphertext)
        .map_err(|error| error.to_string())?;
    write_frame(stream, &ciphertext[..size])
}

fn receive_message(
    stream: &mut TcpStream,
    state: &mut TransportState,
) -> Result<MeshMessage, String> {
    let ciphertext = read_frame(stream)?;
    let mut plaintext = vec![0; MAX_FRAME_BYTES];
    let size = state
        .read_message(&ciphertext, &mut plaintext)
        .map_err(|error| error.to_string())?;
    let message: MeshMessage = serde_json::from_slice(&plaintext[..size])
        .map_err(|_| "Mesh message schema is invalid.".to_owned())?;
    if message.protocol != PROTOCOL_VERSION || !matches!(message.kind.as_str(), "hello" | "ack") {
        return Err("Mesh protocol version or message type is unsupported.".to_owned());
    }
    Ok(message)
}

fn accept_connections(listener: TcpListener, state: ListenerState, shutdown: Arc<AtomicBool>) {
    while !shutdown.load(Ordering::Acquire) {
        let mut stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(50));
                continue;
            }
            Err(_) => continue,
        };
        let accepted = state
            .pending_handshakes
            .lock()
            .map(|mut count| {
                if *count >= MAX_PENDING_HANDSHAKES {
                    false
                } else {
                    *count += 1;
                    true
                }
            })
            .unwrap_or(false);
        if !accepted {
            // Drop excess unauthenticated connections before they consume a thread.
            continue;
        }
        let state = ListenerState {
            app: state.app.clone(),
            private_key: state.private_key.clone(),
            statuses: Arc::clone(&state.statuses),
            pending_handshakes: Arc::clone(&state.pending_handshakes),
        };
        std::thread::spawn(move || {
            let _ = stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT));
            let _ = stream.set_write_timeout(Some(HANDSHAKE_TIMEOUT));
            let outcome = receive_connection(&mut stream, &state);
            if let Err(detail) = outcome {
                set_status(&state.statuses, "unknown", false, detail);
            }
            if let Ok(mut count) = state.pending_handshakes.lock() {
                *count = count.saturating_sub(1);
            }
        });
    }
}

fn receive_connection(stream: &mut TcpStream, state: &ListenerState) -> Result<(), String> {
    let (mut transport, remote_key) = handshake_responder(stream, &state.private_key)?;
    let settings = read_validated_desktop_settings(&desktop_settings_path(&state.app)?)?;
    let device = settings
        .paired_devices
        .iter()
        .find(|device| {
            decode_public_key(&device.public_key).ok().as_deref() == Some(remote_key.as_slice())
        })
        .ok_or("Unrecognized mesh peer.")?;
    let hello = receive_message(stream, &mut transport)?;
    if hello.kind != "hello" {
        return Err("Mesh peer did not send a hello message.".to_owned());
    }
    send_message(
        stream,
        &mut transport,
        &MeshMessage {
            protocol: PROTOCOL_VERSION,
            kind: "ack".to_owned(),
        },
    )?;
    set_status(
        &state.statuses,
        &device.id,
        true,
        "Authenticated encrypted connection verified.".to_owned(),
    );
    Ok(())
}

fn set_status(
    statuses: &Arc<Mutex<Vec<MeshPeerStatus>>>,
    id: &str,
    connected: bool,
    detail: String,
) {
    let Ok(mut statuses) = statuses.lock() else {
        return;
    };
    if let Some(status) = statuses.iter_mut().find(|status| status.id == id) {
        *status = MeshPeerStatus {
            id: id.to_owned(),
            connected,
            detail,
        };
    } else {
        statuses.push(MeshPeerStatus {
            id: id.to_owned(),
            connected,
            detail,
        });
    }
}

#[tauri::command]
pub(crate) fn get_mesh_status(state: tauri::State<'_, MeshState>) -> MeshStatus {
    state.status()
}

#[tauri::command]
pub(crate) fn connect_mesh_peer(
    app: tauri::AppHandle,
    state: tauri::State<'_, MeshState>,
    request: ConnectMeshPeerRequest,
) -> Result<ConnectMeshPeerResponse, String> {
    let settings = read_validated_desktop_settings(&desktop_settings_path(&app)?)?;
    let device = settings
        .paired_devices
        .iter()
        .find(|device| device.id == request.device_id)
        .ok_or("The configured device was not found.")?;
    let peer_key = decode_public_key(&device.public_key)?;
    let address = device
        .endpoint
        .to_socket_addrs()
        .map_err(|_| "Could not resolve the mesh peer address.")?
        .next()
        .ok_or("Could not resolve the mesh peer address.")?;
    let mut stream = TcpStream::connect_timeout(&address, HANDSHAKE_TIMEOUT)
        .map_err(|error| format!("Could not connect to {}: {error}", device.name))?;
    stream
        .set_read_timeout(Some(HANDSHAKE_TIMEOUT))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(HANDSHAKE_TIMEOUT))
        .map_err(|error| error.to_string())?;
    let result = (|| {
        let mut transport = handshake_initiator(&mut stream, &state.private_key, &peer_key)?;
        send_message(
            &mut stream,
            &mut transport,
            &MeshMessage {
                protocol: PROTOCOL_VERSION,
                kind: "hello".to_owned(),
            },
        )?;
        let reply = receive_message(&mut stream, &mut transport)?;
        if reply.kind != "ack" {
            return Err("Mesh peer did not acknowledge the connection.".to_owned());
        }
        Ok(())
    })();
    match result {
        Ok(()) => {
            set_status(
                &state.statuses,
                &device.id,
                true,
                "Authenticated encrypted connection verified.".to_owned(),
            );
            Ok(ConnectMeshPeerResponse {
                connected: true,
                detail: "Authenticated encrypted connection verified.".to_owned(),
            })
        }
        Err(detail) => {
            set_status(&state.statuses, &device.id, false, detail.clone());
            Ok(ConnectMeshPeerResponse {
                connected: false,
                detail,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_a_base64_x25519_public_key() {
        assert!(valid_public_key(&STANDARD_NO_PAD.encode([7_u8; 32])));
        assert!(!valid_public_key(&STANDARD_NO_PAD.encode([0_u8; 32])));
        assert!(!valid_public_key("not-a-key"));
    }

    #[test]
    fn rejects_non_contributory_ephemeral_keys() {
        assert!(validate_ephemeral_key(&[0_u8; 32]).is_err());
    }

    #[test]
    fn public_key_matches_the_noise_static_identity() {
        let pair = Builder::new(NoiseParams::from_str(NOISE_PATTERN).unwrap())
            .generate_keypair()
            .unwrap();
        assert_eq!(
            public_key_for(&pair.private).unwrap(),
            STANDARD_NO_PAD.encode(pair.public),
        );
    }

    #[test]
    fn encrypted_messages_reject_an_unsupported_protocol() {
        let message = MeshMessage {
            protocol: 99,
            kind: "hello".to_owned(),
        };
        assert_ne!(message.protocol, PROTOCOL_VERSION);
    }
}

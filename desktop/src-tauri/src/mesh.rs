use crate::secrets::{SecretStore, SystemSecretStore, MESH_IDENTITY_KEY_ACCOUNT};
use crate::sessions::{
    discover_sessions, persist_synced_session, prune_synced_sessions, resolve_session_ref,
    synced_sessions_root, SessionMeta,
};
use crate::settings::{
    desktop_settings_path, read_validated_desktop_settings, DesktopSettingsFile, SessionSharingMode,
};
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use snow::{params::NoiseParams, Builder, TransportState};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::path::Path;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

const MESH_PORT: u16 = 4242;
const MAX_FRAME_BYTES: usize = 64 * 1024;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(8);
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_PENDING_HANDSHAKES: usize = 16;
const PROTOCOL_VERSION: u8 = 1;
const NOISE_PATTERN: &str = "Noise_XX_25519_ChaChaPoly_SHA256";
const TRANSCRIPT_CHUNK_BYTES: usize = 32 * 1024;
const MAX_SYNCED_SESSIONS: usize = 256;
const MAX_SYNCED_FILES: usize = 32;
const MAX_SYNCED_SESSION_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SYNCED_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
const TRANSCRIPT_SYNC_CAPABILITY: &str = "transcript-snapshots-v1";

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncAllMeshPeersResponse {
    peers: Vec<MeshPeerStatus>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectMeshPeerRequest {
    device_id: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MeshSessionMeta {
    id: String,
    cwd: String,
    model: String,
    timestamp: String,
    modified: String,
    cli_version: String,
    source: String,
    project: Option<String>,
    file_count: usize,
}

impl MeshSessionMeta {
    fn from_session(session: &SessionMeta) -> Self {
        Self {
            id: session.id.clone(),
            cwd: session.cwd.clone(),
            model: session.model.clone(),
            timestamp: session.timestamp.clone(),
            modified: session.modified.clone(),
            cli_version: session.cli_version.clone(),
            source: session.source.to_owned(),
            project: session.project.clone(),
            file_count: session.files.len(),
        }
    }

    fn into_session(self) -> Result<SessionMeta, String> {
        let source = match self.source.as_str() {
            "codex" => "codex",
            "claude-code" => "claude-code",
            _ => return Err("Mesh session source is invalid.".to_owned()),
        };
        if self.id.is_empty() || self.file_count == 0 || self.file_count > MAX_SYNCED_FILES {
            return Err("Mesh session metadata is invalid.".to_owned());
        }
        let files = (0..self.file_count)
            .map(|index| format!("{index}.jsonl"))
            .collect::<Vec<_>>();
        Ok(SessionMeta {
            file: files[0].clone(),
            files,
            id: self.id,
            cwd: self.cwd,
            model: self.model,
            timestamp: self.timestamp,
            modified: self.modified,
            cli_version: self.cli_version,
            source,
            project: self.project,
            synced: false,
        })
    }
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum MeshMessage {
    Hello {
        protocol: u8,
        #[serde(default)]
        capabilities: Vec<String>,
    },
    Ack {
        protocol: u8,
        #[serde(default)]
        capabilities: Vec<String>,
    },
    Reject {
        protocol: u8,
        reason: MeshRejectReason,
    },
    SyncError {
        protocol: u8,
        detail: String,
    },
    SessionStart {
        protocol: u8,
        session_key: String,
        metadata: Box<MeshSessionMeta>,
        file_sizes: Vec<u64>,
    },
    SessionChunk {
        protocol: u8,
        file_index: usize,
        offset: u64,
        data: String,
    },
    SessionEnd {
        protocol: u8,
    },
    Complete {
        protocol: u8,
        sessions: usize,
    },
}

impl MeshMessage {
    fn protocol(&self) -> u8 {
        match self {
            Self::Hello { protocol, .. }
            | Self::Ack { protocol, .. }
            | Self::Reject { protocol, .. }
            | Self::SyncError { protocol, .. }
            | Self::SessionStart { protocol, .. }
            | Self::SessionChunk { protocol, .. }
            | Self::SessionEnd { protocol }
            | Self::Complete { protocol, .. } => *protocol,
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum MeshRejectReason {
    DeviceNotAuthorized,
}

pub(crate) struct MeshState {
    app: tauri::AppHandle,
    identity: Mutex<MeshIdentity>,
    statuses: Arc<Mutex<Vec<MeshPeerStatus>>>,
    listener: Mutex<Option<MeshListener>>,
}

struct MeshIdentity {
    private_key: Vec<u8>,
    public_key: String,
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
            identity: Mutex::new(MeshIdentity {
                private_key,
                public_key,
            }),
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
        let private_key = match self.identity.lock() {
            Ok(identity) => identity.private_key.clone(),
            Err(_) => return,
        };
        let state = ListenerState {
            app: self.app.clone(),
            private_key,
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
            public_key: self
                .identity
                .lock()
                .map(|identity| identity.public_key.clone())
                .unwrap_or_default(),
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

    fn regenerate_identity(&self) -> Result<MeshStatus, String> {
        let private_key = generate_identity()?;
        SystemSecretStore.set(
            MESH_IDENTITY_KEY_ACCOUNT,
            &STANDARD_NO_PAD.encode(&private_key),
        )?;
        let public_key = public_key_for(&private_key)?;
        self.set_enabled(false);
        {
            let mut identity = self
                .identity
                .lock()
                .map_err(|_| "Mesh identity state is unavailable.".to_owned())?;
            *identity = MeshIdentity {
                private_key,
                public_key,
            };
        }
        if let Ok(mut statuses) = self.statuses.lock() {
            statuses.clear();
        }
        let enabled = read_validated_desktop_settings(&desktop_settings_path(&self.app)?)
            .map(|settings| crate::settings::has_authenticated_device(&settings))
            .unwrap_or(false);
        self.set_enabled(enabled);
        Ok(self.status())
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
    let private_key = generate_identity()?;
    SystemSecretStore.set(
        MESH_IDENTITY_KEY_ACCOUNT,
        &STANDARD_NO_PAD.encode(&private_key),
    )?;
    Ok(private_key)
}

fn generate_identity() -> Result<Vec<u8>, String> {
    Builder::new(NoiseParams::from_str(NOISE_PATTERN).map_err(|error| error.to_string())?)
        .generate_keypair()
        .map(|keypair| keypair.private)
        .map_err(|error| error.to_string())
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
        .map_err(mesh_io_error)?;
    stream.write_all(data).map_err(mesh_io_error)
}

fn read_frame(stream: &mut TcpStream) -> Result<Vec<u8>, String> {
    let mut length = [0; 4];
    stream.read_exact(&mut length).map_err(mesh_io_error)?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err("Mesh frame has an invalid size.".to_owned());
    }
    let mut frame = vec![0; length];
    stream.read_exact(&mut frame).map_err(mesh_io_error)?;
    Ok(frame)
}

fn mesh_io_error(error: std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::UnexpectedEof
        | std::io::ErrorKind::ConnectionAborted
        | std::io::ErrorKind::ConnectionReset
        | std::io::ErrorKind::BrokenPipe => "Peer closed the connection. Confirm Agent Vis is open on the other Mac, both Macs run the same build, and this device's identity key is saved there.".to_owned(),
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => {
            "Timed out waiting for the peer device. Confirm Agent Vis is open there and Tailscale can reach port 4242.".to_owned()
        }
        _ => error.to_string(),
    }
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
    let input = read_frame(stream)
        .map_err(|error| format!("Responder could not receive Noise message 1: {error}"))?;
    validate_ephemeral_key(&input)?;
    handshake
        .read_message(&input, &mut output)
        .map_err(|error| error.to_string())?;
    let size = handshake
        .write_message(&[], &mut output)
        .map_err(|error| error.to_string())?;
    write_frame(stream, &output[..size])
        .map_err(|error| format!("Responder could not send Noise message 2: {error}"))?;
    let input = read_frame(stream)
        .map_err(|error| format!("Responder could not receive Noise message 3: {error}"))?;
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
    if message.protocol() != PROTOCOL_VERSION {
        return Err("Mesh protocol version is unsupported.".to_owned());
    }
    Ok(message)
}

fn grouped_local_sessions(home: &Path) -> Vec<SessionMeta> {
    let mut grouped = Vec::<SessionMeta>::new();
    let mut indexes = HashMap::<String, usize>::new();
    for session in discover_sessions(home) {
        let key = format!("{}:{}", session.source, session.id);
        if let Some(index) = indexes.get(&key).copied() {
            grouped[index].files.push(session.file);
        } else {
            indexes.insert(key, grouped.len());
            grouped.push(session);
        }
    }
    grouped
}

fn authorized_sessions(home: &Path, settings: &DesktopSettingsFile) -> Vec<SessionMeta> {
    grouped_local_sessions(home)
        .into_iter()
        .filter(|session| {
            let key = format!("{}:{}", session.source, session.id);
            valid_session_key(&key)
                && match settings.session_sharing_mode {
                    SessionSharingMode::Off => false,
                    SessionSharingMode::Selected => settings.shared_session_keys.contains(&key),
                    SessionSharingMode::All => true,
                }
        })
        .collect()
}

fn valid_session_key(value: &str) -> bool {
    value.len() <= 512
        && value.split_once(':').is_some_and(|(source, id)| {
            matches!(source, "codex" | "claude-code")
                && !id.is_empty()
                && id
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || character == '-')
        })
}

fn send_snapshots(
    stream: &mut TcpStream,
    transport: &mut TransportState,
    settings: &DesktopSettingsFile,
) -> Result<usize, String> {
    let home = dirs::home_dir().ok_or("Could not resolve the home directory")?;
    let sessions = authorized_sessions(&home, settings);
    if sessions.len() > MAX_SYNCED_SESSIONS {
        return Err("Too many sessions are authorized for one mesh sync.".to_owned());
    }
    let mut total_bytes = 0_u64;
    for session in &sessions {
        if session.files.is_empty() || session.files.len() > MAX_SYNCED_FILES {
            return Err("A shared session contains too many transcript files.".to_owned());
        }
        let resolved = session
            .files
            .iter()
            .map(|file_ref| resolve_session_ref(&home, file_ref))
            .collect::<Result<Vec<_>, _>>()?;
        let file_sizes = resolved
            .iter()
            .map(|(path, _)| path.metadata().map(|metadata| metadata.len()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        let session_bytes = file_sizes.iter().try_fold(0_u64, |total, size| {
            total
                .checked_add(*size)
                .ok_or_else(|| "Shared session size overflowed.".to_owned())
        })?;
        if session_bytes == 0 || session_bytes > MAX_SYNCED_SESSION_BYTES {
            return Err("A shared session exceeds the mesh transcript size limit.".to_owned());
        }
        total_bytes = total_bytes
            .checked_add(session_bytes)
            .ok_or_else(|| "Shared transcript size overflowed.".to_owned())?;
        if total_bytes > MAX_SYNCED_TOTAL_BYTES {
            return Err("Shared transcripts exceed the mesh sync size limit.".to_owned());
        }
        let session_key = format!("{}:{}", session.source, session.id);
        send_message(
            stream,
            transport,
            &MeshMessage::SessionStart {
                protocol: PROTOCOL_VERSION,
                session_key,
                metadata: Box::new(MeshSessionMeta::from_session(session)),
                file_sizes,
            },
        )?;
        let mut buffer = vec![0_u8; TRANSCRIPT_CHUNK_BYTES];
        for (file_index, (path, _)) in resolved.iter().enumerate() {
            let mut file = File::open(path).map_err(|error| error.to_string())?;
            let mut offset = 0_u64;
            loop {
                let size = file.read(&mut buffer).map_err(|error| error.to_string())?;
                if size == 0 {
                    break;
                }
                send_message(
                    stream,
                    transport,
                    &MeshMessage::SessionChunk {
                        protocol: PROTOCOL_VERSION,
                        file_index,
                        offset,
                        data: STANDARD_NO_PAD.encode(&buffer[..size]),
                    },
                )?;
                offset += size as u64;
            }
        }
        send_message(
            stream,
            transport,
            &MeshMessage::SessionEnd {
                protocol: PROTOCOL_VERSION,
            },
        )?;
    }
    send_message(
        stream,
        transport,
        &MeshMessage::Complete {
            protocol: PROTOCOL_VERSION,
            sessions: sessions.len(),
        },
    )?;
    Ok(sessions.len())
}

struct IncomingSession {
    key: String,
    metadata: SessionMeta,
    expected_sizes: Vec<u64>,
    files: Vec<Vec<u8>>,
}

fn receive_snapshots(
    stream: &mut TcpStream,
    transport: &mut TransportState,
    synced_root: &Path,
    device_id: &str,
) -> Result<usize, String> {
    let mut current: Option<IncomingSession> = None;
    let mut received_sessions = 0_usize;
    let mut declared_total = 0_u64;
    let mut received_keys = HashSet::new();
    loop {
        match receive_message(stream, transport)? {
            MeshMessage::SessionStart {
                session_key,
                metadata,
                file_sizes,
                ..
            } => {
                if current.is_some()
                    || received_sessions >= MAX_SYNCED_SESSIONS
                    || !valid_session_key(&session_key)
                    || file_sizes.is_empty()
                    || file_sizes.len() > MAX_SYNCED_FILES
                    || file_sizes.contains(&0)
                    || metadata.file_count != file_sizes.len()
                {
                    return Err("Mesh session declaration is invalid.".to_owned());
                }
                let session_bytes = file_sizes.iter().try_fold(0_u64, |total, size| {
                    total
                        .checked_add(*size)
                        .ok_or_else(|| "Mesh session size overflowed.".to_owned())
                })?;
                if session_bytes > MAX_SYNCED_SESSION_BYTES {
                    return Err("Mesh session exceeds the transcript size limit.".to_owned());
                }
                declared_total = declared_total
                    .checked_add(session_bytes)
                    .ok_or_else(|| "Mesh sync size overflowed.".to_owned())?;
                if declared_total > MAX_SYNCED_TOTAL_BYTES {
                    return Err("Mesh sync exceeds the total transcript size limit.".to_owned());
                }
                let session = metadata.into_session()?;
                if session_key != format!("{}:{}", session.source, session.id) {
                    return Err("Mesh session identity does not match its metadata.".to_owned());
                }
                let files = file_sizes
                    .iter()
                    .map(|size| Vec::with_capacity(*size as usize))
                    .collect();
                current = Some(IncomingSession {
                    key: session_key,
                    metadata: session,
                    expected_sizes: file_sizes,
                    files,
                });
            }
            MeshMessage::SessionChunk {
                file_index,
                offset,
                data,
                ..
            } => {
                let incoming = current
                    .as_mut()
                    .ok_or("Mesh sent transcript data before session metadata.")?;
                let expected = *incoming
                    .expected_sizes
                    .get(file_index)
                    .ok_or("Mesh transcript file index is invalid.")?;
                let target = incoming
                    .files
                    .get_mut(file_index)
                    .ok_or("Mesh transcript file index is invalid.")?;
                if offset != target.len() as u64 {
                    return Err("Mesh transcript chunks are out of order.".to_owned());
                }
                let chunk = STANDARD_NO_PAD
                    .decode(data)
                    .map_err(|_| "Mesh transcript chunk is invalid.".to_owned())?;
                if chunk.is_empty()
                    || chunk.len() > TRANSCRIPT_CHUNK_BYTES
                    || target.len() as u64 + chunk.len() as u64 > expected
                {
                    return Err("Mesh transcript chunk exceeds its declared size.".to_owned());
                }
                target.extend_from_slice(&chunk);
            }
            MeshMessage::SessionEnd { .. } => {
                let incoming = current
                    .take()
                    .ok_or("Mesh ended a transcript that was not started.")?;
                if incoming
                    .files
                    .iter()
                    .zip(incoming.expected_sizes.iter())
                    .any(|(file, expected)| file.len() as u64 != *expected)
                {
                    return Err("Mesh transcript did not match its declared size.".to_owned());
                }
                persist_synced_session(
                    synced_root,
                    device_id,
                    &incoming.key,
                    &incoming.metadata,
                    &incoming.files,
                )?;
                received_keys.insert(incoming.key);
                received_sessions += 1;
            }
            MeshMessage::Complete { sessions, .. } => {
                if current.is_some() || sessions != received_sessions {
                    return Err("Mesh sync completion count is invalid.".to_owned());
                }
                prune_synced_sessions(synced_root, device_id, &received_keys)?;
                return Ok(received_sessions);
            }
            MeshMessage::SyncError { detail, .. } => {
                return Err(format!("Peer could not complete sync: {detail}"));
            }
            MeshMessage::Hello { .. } | MeshMessage::Ack { .. } | MeshMessage::Reject { .. } => {
                return Err("Mesh message is not valid during transcript transfer.".to_owned());
            }
        }
    }
}

fn report_sync_error(stream: &mut TcpStream, transport: &mut TransportState, detail: &str) {
    let detail = detail.chars().take(512).collect::<String>();
    let _ = send_message(
        stream,
        transport,
        &MeshMessage::SyncError {
            protocol: PROTOCOL_VERSION,
            detail,
        },
    );
}

fn prepare_accepted_stream(stream: &TcpStream) -> Result<(), String> {
    // A nonblocking listener can yield a nonblocking accepted socket on
    // macOS. Restore blocking I/O so the handshake timeouts wait for the
    // peer's next framed Noise message instead of failing with WouldBlock.
    stream
        .set_nonblocking(false)
        .map_err(|error| error.to_string())
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
        if prepare_accepted_stream(&stream).is_err() {
            continue;
        }
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
                eprintln!("Agent Vis mesh responder rejected a connection: {detail}");
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
    let hello = receive_message(stream, &mut transport)
        .map_err(|error| format!("Responder could not receive mesh hello: {error}"))?;
    let MeshMessage::Hello { capabilities, .. } = hello else {
        return Err("Mesh peer did not send a hello message.".to_owned());
    };
    let settings = read_validated_desktop_settings(&desktop_settings_path(&state.app)?)?;
    let Some(device) = settings.paired_devices.iter().find(|device| {
        decode_public_key(&device.public_key).ok().as_deref() == Some(remote_key.as_slice())
    }) else {
        send_message(
            stream,
            &mut transport,
            &MeshMessage::Reject {
                protocol: PROTOCOL_VERSION,
                reason: MeshRejectReason::DeviceNotAuthorized,
            },
        )?;
        return Err("Unrecognized mesh peer.".to_owned());
    };
    send_message(
        stream,
        &mut transport,
        &MeshMessage::Ack {
            protocol: PROTOCOL_VERSION,
            capabilities: vec![TRANSCRIPT_SYNC_CAPABILITY.to_owned()],
        },
    )?;
    if !capabilities
        .iter()
        .any(|capability| capability == TRANSCRIPT_SYNC_CAPABILITY)
    {
        return Err("Peer is running an older Agent Vis build without transcript sync.".to_owned());
    }
    stream
        .set_read_timeout(Some(TRANSFER_TIMEOUT))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(TRANSFER_TIMEOUT))
        .map_err(|error| error.to_string())?;
    let received = match receive_snapshots(
        stream,
        &mut transport,
        &synced_sessions_root(&state.app)?,
        &device.id,
    ) {
        Ok(received) => received,
        Err(detail) => {
            report_sync_error(stream, &mut transport, &detail);
            return Err(detail);
        }
    };
    let sent = match send_snapshots(stream, &mut transport, &settings) {
        Ok(sent) => sent,
        Err(detail) => {
            report_sync_error(stream, &mut transport, &detail);
            return Err(detail);
        }
    };
    set_status(
        &state.statuses,
        &device.id,
        true,
        format!("Synced {received} received and {sent} shared transcripts."),
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
pub(crate) fn regenerate_mesh_identity(
    state: tauri::State<'_, MeshState>,
) -> Result<MeshStatus, String> {
    state.regenerate_identity()
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
    Ok(sync_mesh_peer(&app, &state, &settings, device))
}

#[tauri::command]
pub(crate) fn sync_all_mesh_peers(
    app: tauri::AppHandle,
    state: tauri::State<'_, MeshState>,
) -> Result<SyncAllMeshPeersResponse, String> {
    let settings = read_validated_desktop_settings(&desktop_settings_path(&app)?)?;
    let peers = settings
        .paired_devices
        .iter()
        .filter(|device| valid_public_key(&device.public_key))
        .map(|device| {
            let response = sync_mesh_peer(&app, &state, &settings, device);
            MeshPeerStatus {
                id: device.id.clone(),
                connected: response.connected,
                detail: response.detail,
            }
        })
        .collect();
    Ok(SyncAllMeshPeersResponse { peers })
}

fn sync_mesh_peer(
    app: &tauri::AppHandle,
    state: &MeshState,
    settings: &DesktopSettingsFile,
    device: &crate::settings::PairedDevice,
) -> ConnectMeshPeerResponse {
    let result = (|| {
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
        let private_key = state
            .identity
            .lock()
            .map_err(|_| "Mesh identity state is unavailable.".to_owned())?
            .private_key
            .clone();
        let mut transport = handshake_initiator(&mut stream, &private_key, &peer_key)?;
        send_message(
            &mut stream,
            &mut transport,
            &MeshMessage::Hello {
                protocol: PROTOCOL_VERSION,
                capabilities: vec![TRANSCRIPT_SYNC_CAPABILITY.to_owned()],
            },
        )?;
        let reply = receive_message(&mut stream, &mut transport)?;
        match reply {
            MeshMessage::Ack { capabilities, .. }
                if capabilities
                    .iter()
                    .any(|capability| capability == TRANSCRIPT_SYNC_CAPABILITY) => {}
            MeshMessage::Ack { .. } => {
                return Err("The other Mac is running an older Agent Vis build without transcript sync. Update and reopen Agent Vis there, then try again.".to_owned());
            }
            MeshMessage::Reject {
                reason: MeshRejectReason::DeviceNotAuthorized,
                ..
            } => {
                return Err("Peer has not authorized this Mac. Save this Mac's identity key in Agent Vis on the other device, then try again.".to_owned());
            }
            MeshMessage::SyncError { detail, .. } => {
                return Err(format!("Peer could not start sync: {detail}"));
            }
            _ => return Err("Mesh peer did not acknowledge the connection.".to_owned()),
        }
        stream
            .set_read_timeout(Some(TRANSFER_TIMEOUT))
            .map_err(|error| error.to_string())?;
        stream
            .set_write_timeout(Some(TRANSFER_TIMEOUT))
            .map_err(|error| error.to_string())?;
        let sent = match send_snapshots(&mut stream, &mut transport, settings) {
            Ok(sent) => sent,
            Err(detail) => {
                report_sync_error(&mut stream, &mut transport, &detail);
                return Err(detail);
            }
        };
        let received = match receive_snapshots(
            &mut stream,
            &mut transport,
            &synced_sessions_root(app)?,
            &device.id,
        ) {
            Ok(received) => received,
            Err(detail) => {
                report_sync_error(&mut stream, &mut transport, &detail);
                return Err(detail);
            }
        };
        Ok((sent, received))
    })();
    match result {
        Ok((sent, received)) => {
            let detail = format!("Synced {received} received and {sent} shared transcripts.");
            set_status(&state.statuses, &device.id, true, detail.clone());
            ConnectMeshPeerResponse {
                connected: true,
                detail,
            }
        }
        Err(detail) => {
            set_status(&state.statuses, &device.id, false, detail.clone());
            ConnectMeshPeerResponse {
                connected: false,
                detail,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn settings_with_mode(mode: SessionSharingMode) -> DesktopSettingsFile {
        DesktopSettingsFile {
            session_sharing_mode: mode,
            ..DesktopSettingsFile::default()
        }
    }

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
        let message = MeshMessage::Hello {
            protocol: 99,
            capabilities: Vec::new(),
        };
        assert_ne!(message.protocol(), PROTOCOL_VERSION);
    }

    #[test]
    fn older_hello_messages_have_no_transcript_sync_capability() {
        let message: MeshMessage =
            serde_json::from_str(r#"{"kind":"hello","protocol":1}"#).unwrap();
        let MeshMessage::Hello { capabilities, .. } = message else {
            unreachable!();
        };
        assert!(capabilities.is_empty());
    }

    #[test]
    fn two_mesh_identities_complete_the_sync_protocol() {
        let initiator_private = generate_identity().unwrap();
        let responder_private = generate_identity().unwrap();
        let responder_public = STANDARD_NO_PAD
            .decode(public_key_for(&responder_private).unwrap())
            .unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();

        let responder = std::thread::spawn(move || {
            let (mut stream, _) = loop {
                match listener.accept() {
                    Ok(connection) => break connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(1));
                    }
                    Err(error) => panic!("could not accept test connection: {error}"),
                }
            };
            prepare_accepted_stream(&stream).unwrap();
            let (mut transport, _) = handshake_responder(&mut stream, &responder_private).unwrap();
            let hello = receive_message(&mut stream, &mut transport).unwrap();
            assert!(matches!(
                hello,
                MeshMessage::Hello { capabilities, .. }
                    if capabilities.contains(&TRANSCRIPT_SYNC_CAPABILITY.to_owned())
            ));
            send_message(
                &mut stream,
                &mut transport,
                &MeshMessage::Ack {
                    protocol: PROTOCOL_VERSION,
                    capabilities: vec![TRANSCRIPT_SYNC_CAPABILITY.to_owned()],
                },
            )
            .unwrap();
            assert!(matches!(
                receive_message(&mut stream, &mut transport).unwrap(),
                MeshMessage::Complete { sessions: 0, .. }
            ));
            send_message(
                &mut stream,
                &mut transport,
                &MeshMessage::Complete {
                    protocol: PROTOCOL_VERSION,
                    sessions: 0,
                },
            )
            .unwrap();
        });

        let mut stream = TcpStream::connect(address).unwrap();
        let mut transport =
            handshake_initiator(&mut stream, &initiator_private, &responder_public).unwrap();
        send_message(
            &mut stream,
            &mut transport,
            &MeshMessage::Hello {
                protocol: PROTOCOL_VERSION,
                capabilities: vec![TRANSCRIPT_SYNC_CAPABILITY.to_owned()],
            },
        )
        .unwrap();
        assert!(matches!(
            receive_message(&mut stream, &mut transport).unwrap(),
            MeshMessage::Ack { capabilities, .. }
                if capabilities.contains(&TRANSCRIPT_SYNC_CAPABILITY.to_owned())
        ));
        send_message(
            &mut stream,
            &mut transport,
            &MeshMessage::Complete {
                protocol: PROTOCOL_VERSION,
                sessions: 0,
            },
        )
        .unwrap();
        assert!(matches!(
            receive_message(&mut stream, &mut transport).unwrap(),
            MeshMessage::Complete { sessions: 0, .. }
        ));
        responder.join().unwrap();
    }

    #[test]
    fn sharing_policy_filters_local_sessions() {
        let home = std::env::temp_dir().join(format!(
            "agent-vis-mesh-policy-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let session_dir = home.join(".codex/sessions/2026/08/05");
        std::fs::create_dir_all(&session_dir).unwrap();
        std::fs::write(
            session_dir.join("session.jsonl"),
            concat!(
                "{\"type\":\"session_meta\",",
                "\"payload\":{\"id\":\"session-1\",\"cwd\":\"/repo\"}}\n"
            ),
        )
        .unwrap();

        assert!(
            authorized_sessions(&home, &settings_with_mode(SessionSharingMode::Off)).is_empty()
        );
        let mut selected = settings_with_mode(SessionSharingMode::Selected);
        assert!(authorized_sessions(&home, &selected).is_empty());
        selected
            .shared_session_keys
            .push("codex:session-1".to_owned());
        assert_eq!(authorized_sessions(&home, &selected).len(), 1);
        assert_eq!(
            authorized_sessions(&home, &settings_with_mode(SessionSharingMode::All)).len(),
            1
        );
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn rejects_invalid_transfer_declarations_and_chunks() {
        assert!(!valid_session_key("synced:peer/session"));
        assert!(!valid_session_key("codex:../../secret"));

        let message = MeshMessage::SessionChunk {
            protocol: PROTOCOL_VERSION,
            file_index: 0,
            offset: 0,
            data: STANDARD_NO_PAD.encode(vec![0_u8; TRANSCRIPT_CHUNK_BYTES + 1]),
        };
        let MeshMessage::SessionChunk { data, .. } = message else {
            unreachable!();
        };
        assert!(STANDARD_NO_PAD.decode(data).unwrap().len() > TRANSCRIPT_CHUNK_BYTES);
    }
}

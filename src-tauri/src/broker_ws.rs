use futures_util::future::BoxFuture;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::net::{Ipv4Addr, SocketAddrV4};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

const PROTOCOL_VERSION: u8 = 1;

/// Capacity for the bounded per-client and per-upstream queues (R2).
/// Generous versus any legitimate burst (chat deltas arrive at tens of
/// frames per second) while capping memory when a consumer stalls; on
/// overflow the message is dropped with a warning instead of blocking the
/// runtime or growing without bound.
const CHANNEL_CAPACITY: usize = 4096;

/// Initial delay before the first reconnect attempt after an upstream
/// failure. 750ms matches the previous fixed retry interval.
const UPSTREAM_RECONNECT_INITIAL_DELAY_MS: u64 = 750;
/// Ceiling for the exponential reconnect delay.
const UPSTREAM_RECONNECT_MAX_DELAY_MS: u64 = 10_000;
/// Hard cap on consecutive failed reconnect attempts (R1). Belt-and-braces
/// next to `UPSTREAM_RECONNECT_GIVE_UP_AFTER`: with the doubling schedule
/// above, the ~5-minute wall-clock deadline is normally reached first
/// (after ~33 attempts); the attempt cap only matters if sleeps run short.
const UPSTREAM_RECONNECT_MAX_ATTEMPTS: u32 = 60;
/// Give up retrying a dead upstream after this much continuous failure
/// (~5 minutes, R1). The give-up path evicts the upstream and its session
/// routes exactly like a managed stop and notifies the UI that the
/// instance is dead.
const UPSTREAM_RECONNECT_GIVE_UP_AFTER: std::time::Duration =
    std::time::Duration::from_secs(5 * 60);

type Tx = mpsc::Sender<String>;

/// Emits an intermediate progress frame for an in-flight `broker_control`
/// request (e.g. updater download chunks). The broker wires this to the
/// requesting client's socket, tagged with the original `requestId`.
pub type ProgressSink = Arc<dyn Fn(Value) + Send + Sync>;

/// Async handler for `broker_control` requests. Given a command name + args
/// (+ a progress sink for streaming ops) it resolves to `Ok(result_json)` or
/// `Err(message)`. Injected from main.rs so the broker can run process/window
/// lifecycle and native ops on behalf of any client (desktop WebView, remote,
/// mobile) without main.rs and broker_ws forming a circular dependency.
pub type ControlHandler = Arc<
    dyn Fn(String, Value, ProgressSink) -> BoxFuture<'static, Result<Value, String>> + Send + Sync,
>;

/// What `run_upstream` should do after a failed reconnect attempt (R1).
#[derive(Debug, PartialEq, Eq)]
enum ReconnectDecision {
    /// Wait this long, then try again.
    Retry(std::time::Duration),
    /// The upstream is considered permanently dead: evict it and notify.
    GiveUp,
}

/// Pure backoff policy for upstream reconnects (R1): exponential delay
/// starting at [`UPSTREAM_RECONNECT_INITIAL_DELAY_MS`] (750ms), doubling up
/// to [`UPSTREAM_RECONNECT_MAX_DELAY_MS`] (10s); give up after
/// [`UPSTREAM_RECONNECT_MAX_ATTEMPTS`] consecutive failures or
/// [`UPSTREAM_RECONNECT_GIVE_UP_AFTER`] (~5 minutes) of continuous failure,
/// whichever comes first.
///
/// `consecutive_failures` counts failures in the current streak (1 on the
/// first failure; reset to 0 whenever a connection succeeds). `failed_for`
/// is how long that streak has lasted so far (sleeps + connect attempts).
fn reconnect_decision(
    consecutive_failures: u32,
    failed_for: std::time::Duration,
) -> ReconnectDecision {
    if consecutive_failures >= UPSTREAM_RECONNECT_MAX_ATTEMPTS
        || failed_for >= UPSTREAM_RECONNECT_GIVE_UP_AFTER
    {
        return ReconnectDecision::GiveUp;
    }
    // 2^20 * 750ms is far beyond the cap; clamping the shift keeps the
    // multiplication from overflowing for pathological counters.
    let shift = consecutive_failures.saturating_sub(1).min(20);
    let delay_ms = UPSTREAM_RECONNECT_INITIAL_DELAY_MS.saturating_mul(1u64 << shift);
    ReconnectDecision::Retry(std::time::Duration::from_millis(
        delay_ms.min(UPSTREAM_RECONNECT_MAX_DELAY_MS),
    ))
}

#[derive(Default)]
struct BrokerInner {
    ui_clients: Mutex<HashMap<u64, Tx>>,
    upstreams: Mutex<HashMap<u16, Tx>>,
    routes: Mutex<HashMap<String, u16>>,
    disabled_ports: Mutex<HashSet<u16>>,
    active_port: Mutex<Option<u16>>,
    next_client_id: AtomicU64,
    control_handler: Mutex<Option<ControlHandler>>,
}

#[derive(Clone)]
pub struct BrokerWs {
    port: u16,
    inner: Arc<BrokerInner>,
}

impl BrokerWs {
    pub fn start() -> Result<Self, String> {
        let std_listener = std::net::TcpListener::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0))
            .map_err(|e| format!("Failed to bind broker websocket: {}", e))?;
        std_listener
            .set_nonblocking(true)
            .map_err(|e| format!("Failed to configure broker websocket: {}", e))?;
        let port = std_listener
            .local_addr()
            .map_err(|e| format!("Failed to read broker websocket address: {}", e))?
            .port();
        let broker = Self {
            port,
            inner: Arc::new(BrokerInner::default()),
        };
        let server = broker.clone();
        tauri::async_runtime::spawn(async move {
            let listener = match TcpListener::from_std(std_listener) {
                Ok(listener) => listener,
                Err(err) => {
                    log::error!("[broker-ws] failed to create Tokio listener: {}", err);
                    return;
                }
            };
            server.run(listener).await;
        });
        Ok(broker)
    }

    pub fn url(&self) -> String {
        format!("ws://127.0.0.1:{}/ui-ws", self.port)
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn set_active_port(&self, port: u16) {
        *self.inner.active_port.lock().unwrap() = Some(port);
    }

    pub fn active_port(&self) -> Option<u16> {
        *self.inner.active_port.lock().unwrap()
    }

    /// Number of omp upstream connections the broker is currently maintaining.
    /// Used to detect when a global `active_port` fallback would be ambiguous:
    /// with more than one live omp process (multi-window / multi-workspace) the
    /// active_port belongs to whichever window registered most recently, so it
    /// cannot be safely used to guess the target of an unaddressed command.
    pub fn live_upstream_count(&self) -> usize {
        self.inner.upstreams.lock().unwrap().len()
    }

    /// Install the handler used to execute `broker_control` requests. Called
    /// once from main.rs after OmpManager + BrokerWs exist.
    pub fn set_control_handler(&self, handler: ControlHandler) {
        *self.inner.control_handler.lock().unwrap() = Some(handler);
    }

    pub fn register_session(&self, port: u16, session_id: &str) {
        log::info!(
            "[broker-ws] register_session port={} session_id={}",
            port,
            session_id
        );
        self.inner.disabled_ports.lock().unwrap().remove(&port);
        self.set_active_port(port);
        self.set_route(port, session_id);
        self.ensure_upstream(port);
    }

    /// Like `register_session` but does NOT promote this port to active_port.
    /// Use for background/dedicated session processes that should not become
    /// the default command target.
    pub fn track_background_session(&self, port: u16, session_id: &str) {
        self.inner.disabled_ports.lock().unwrap().remove(&port);
        self.set_route(port, session_id);
        self.ensure_upstream(port);
    }

    /// Point `session_id` at `port`, first evicting any other session id that
    /// previously resolved to this port.
    ///
    /// A `omp --mode rpc` process drives exactly ONE active session at a time, so
    /// a port maps to at most one session id. An in-place `new_session` /
    /// `switch_session` reuses the same port for a *different* session; without
    /// this eviction the PREVIOUS session id would keep pointing here. Because
    /// `resolve_command_port` consults the session-id route BEFORE `sourcePort`,
    /// a command still tagged with that now-defunct session would be silently
    /// misrouted into whatever session currently occupies the port — and would
    /// even override a correct `sourcePort` hint. Evicting stale entries keeps
    /// the routing table 1:1 with live sessions (fixes F1 + F2).
    fn set_route(&self, port: u16, session_id: &str) {
        let session_id = session_id.trim();
        let mut routes = self.inner.routes.lock().unwrap();
        // Drop every other session id resolving to this port; keep only the
        // entry for `session_id` itself (so a repeated learn stays idempotent).
        routes.retain(|existing, routed| *routed != port || existing == session_id);
        if !session_id.is_empty() {
            routes.insert(session_id.to_string(), port);
        }
    }

    pub fn unregister_port(&self, port: u16) {
        log::info!("[broker-ws] unregister_port port={}", port);
        self.inner.disabled_ports.lock().unwrap().insert(port);
        self.inner.upstreams.lock().unwrap().remove(&port);
        self.inner
            .routes
            .lock()
            .unwrap()
            .retain(|_, routed| *routed != port);
        let mut active = self.inner.active_port.lock().unwrap();
        if *active == Some(port) {
            *active = None;
        }
    }

    async fn run(self, listener: TcpListener) {
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let broker = self.clone();
                    tauri::async_runtime::spawn(async move {
                        broker.handle_ui_client(stream).await;
                    });
                }
                Err(err) => {
                    log::warn!("[broker-ws] accept failed: {}", err);
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                }
            }
        }
    }

    async fn handle_ui_client(self, stream: TcpStream) {
        let ws = match tokio_tungstenite::accept_async(stream).await {
            Ok(ws) => ws,
            Err(err) => {
                log::warn!("[broker-ws] UI websocket handshake failed: {}", err);
                return;
            }
        };
        let client_id = self.inner.next_client_id.fetch_add(1, Ordering::Relaxed);
        let (mut writer, mut reader) = ws.split();
        let (tx, mut rx) = mpsc::channel::<String>(CHANNEL_CAPACITY);
        self.inner
            .ui_clients
            .lock()
            .unwrap()
            .insert(client_id, tx.clone());

        // Capability handshake: tell the client whether native (OS/window) ops
        // are available. Inside the desktop app a control handler is installed
        // (native:true); a bare broker without a handler can only forward chat.
        let native = self.inner.control_handler.lock().unwrap().is_some();
        if tx
            .try_send(
                json!({
                    "type": "capabilities",
                    "protocolVersion": PROTOCOL_VERSION,
                    "native": native,
                })
                .to_string(),
            )
            .is_err()
        {
            log::warn!(
                "[broker-ws] failed to deliver capabilities handshake to client {} (gone or saturated)",
                client_id
            );
        }

        let writer_task = tauri::async_runtime::spawn(async move {
            while let Some(message) = rx.recv().await {
                if writer.send(Message::Text(message)).await.is_err() {
                    break;
                }
            }
        });

        while let Some(item) = reader.next().await {
            match item {
                Ok(Message::Text(text)) => self.route_ui_message(&text, &tx),
                Ok(Message::Close(_)) => break,
                Ok(_) => {}
                Err(err) => {
                    log::warn!("[broker-ws] UI websocket read failed: {}", err);
                    break;
                }
            }
        }

        self.inner.ui_clients.lock().unwrap().remove(&client_id);
        writer_task.abort();
    }

    fn route_ui_message(&self, text: &str, client_tx: &Tx) {
        let Ok(value) = serde_json::from_str::<Value>(text) else {
            log::warn!("[broker-ws] invalid UI message");
            return;
        };

        // `broker_control` requests are NOT forwarded to a omp upstream — they are
        // process/window lifecycle or native ops handled by the host (Rust).
        // Dispatch to the injected control handler and reply to this client only.
        if value.get("type").and_then(Value::as_str) == Some("broker_control") {
            self.dispatch_control(&value, client_tx);
            return;
        }

        let Some(port) = self.resolve_command_port(&value) else {
            log::warn!("[broker-ws] no route for UI command: {}", value);
            self.notify_undeliverable(client_tx, &value, "no_route");
            return;
        };
        log::info!(
            "[broker-ws] route command={} request_id={:?} session_id={:?} source_port={:?} -> port={}",
            value.pointer("/payload/type").and_then(Value::as_str).unwrap_or_else(|| {
                value.get("type").and_then(Value::as_str).unwrap_or("unknown")
            }),
            value.get("requestId").and_then(Value::as_str),
            value.get("sessionId").and_then(Value::as_str),
            value.get("sourcePort").and_then(Value::as_u64),
            port
        );
        self.ensure_upstream(port);
        let upstream_tx = self.inner.upstreams.lock().unwrap().get(&port).cloned();
        // A `broker_command` is fire-and-forget on the wire, so a routing/delivery
        // failure here would otherwise vanish silently — the user sees their
        // prompt echoed but the agent never receives it. Reply to the sender with
        // a `command_undeliverable` frame (tagged with the original requestId) so
        // the UI can surface the loss instead of hanging (F3). `ensure_upstream`
        // queues into the channel even while reconnecting, so a `None` tx (or a
        // closed channel) means the port is genuinely gone (killed/disabled); a
        // FULL channel means the upstream is alive but its (bounded) queue is
        // saturated (R2) — dropped either way, but surfaced with distinct reasons.
        let mut undeliverable_reason = "upstream_unavailable";
        let delivered = match upstream_tx {
            Some(tx) => match tx.try_send(text.to_string()) {
                Ok(()) => true,
                Err(mpsc::error::TrySendError::Full(_)) => {
                    log::warn!(
                        "[broker-ws] upstream {} queue full (capacity {}); dropping command",
                        port,
                        CHANNEL_CAPACITY
                    );
                    undeliverable_reason = "upstream_backpressure";
                    false
                }
                Err(mpsc::error::TrySendError::Closed(_)) => false,
            },
            None => false,
        };
        if !delivered {
            log::warn!("[broker-ws] upstream {} unavailable; command dropped", port);
            self.notify_undeliverable(client_tx, &value, undeliverable_reason);
        }
    }

    /// Reply to the originating UI client that a `broker_command` could not be
    /// delivered. Tagged with the original `requestId` so the frontend can
    /// correlate it to the in-flight prompt and surface a visible error.
    fn notify_undeliverable(&self, client_tx: &Tx, value: &Value, reason: &str) {
        let request_id = value.get("requestId").and_then(Value::as_str).unwrap_or("");
        let command = value
            .pointer("/payload/type")
            .and_then(Value::as_str)
            .or_else(|| value.get("type").and_then(Value::as_str))
            .unwrap_or("");
        if client_tx
            .try_send(
                json!({
                    "type": "command_undeliverable",
                    "protocolVersion": PROTOCOL_VERSION,
                    "requestId": request_id,
                    "command": command,
                    "reason": reason,
                    "sessionId": value.get("sessionId").cloned().unwrap_or(Value::Null),
                })
                .to_string(),
            )
            .is_err()
        {
            log::warn!(
                "[broker-ws] failed to deliver command_undeliverable notice (client gone or saturated)"
            );
        }
    }

    fn dispatch_control(&self, value: &Value, client_tx: &Tx) {
        let request_id = value
            .get("requestId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let command = value
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let args = value.get("args").cloned().unwrap_or(Value::Null);

        let handler = self.inner.control_handler.lock().unwrap().clone();
        let tx = client_tx.clone();

        let Some(handler) = handler else {
            if tx
                .try_send(
                    json!({
                        "type": "control_response",
                        "requestId": request_id,
                        "ok": false,
                        "error": "Control commands are not available on this server",
                    })
                    .to_string(),
                )
                .is_err()
            {
                log::warn!(
                    "[broker-ws] failed to deliver control_response (client gone or saturated)"
                );
            }
            return;
        };

        // Progress sink: streams intermediate frames (e.g. updater download
        // chunks) back to the requesting client, tagged with the requestId.
        let progress_tx = tx.clone();
        let progress_request_id = request_id.clone();
        let sink: ProgressSink = Arc::new(move |data: Value| {
            if progress_tx
                .try_send(
                    json!({
                        "type": "control_progress",
                        "requestId": progress_request_id,
                        "data": data,
                    })
                    .to_string(),
                )
                .is_err()
            {
                log::warn!(
                    "[broker-ws] failed to deliver control_progress frame (client gone or saturated)"
                );
            }
        });

        log::info!(
            "[broker-ws] control command={} request_id={}",
            command,
            request_id
        );
        let started = std::time::Instant::now();
        tauri::async_runtime::spawn(async move {
            let response = match handler(command.clone(), args, sink).await {
                Ok(result) => {
                    log::info!(
                        "[broker-ws] control command={} ok in {}ms (request_id={})",
                        command,
                        started.elapsed().as_millis(),
                        request_id
                    );
                    json!({
                        "type": "control_response",
                        "requestId": request_id,
                        "ok": true,
                        "result": result,
                    })
                }
                Err(error) => {
                    log::warn!("[broker-ws] control command {} failed: {}", command, error);
                    json!({
                        "type": "control_response",
                        "requestId": request_id,
                        "ok": false,
                        "error": error,
                    })
                }
            };
            if tx.try_send(response.to_string()).is_err() {
                log::warn!(
                    "[broker-ws] failed to deliver control_response (client gone or saturated)"
                );
            }
        });
    }

    fn resolve_command_port(&self, value: &Value) -> Option<u16> {
        let session_id = value
            .get("sessionId")
            .and_then(Value::as_str)
            .or_else(|| value.pointer("/payload/sessionId").and_then(Value::as_str))
            .or_else(|| {
                value
                    .pointer("/payload/sessionFile")
                    .and_then(Value::as_str)
            })
            .or_else(|| {
                value
                    .pointer("/payload/sessionPath")
                    .and_then(Value::as_str)
            });
        let source_port = value
            .get("sourcePort")
            .and_then(Value::as_u64)
            .and_then(|port| u16::try_from(port).ok());
        if let Some(session_id) = session_id {
            if let Some(port) = self.inner.routes.lock().unwrap().get(session_id).copied() {
                // The session route is authoritative — it is learned from real
                // upstream traffic and kept 1:1 with live sessions by set_route.
                // A disagreeing sourcePort means the client's foreground-port
                // hint has drifted; trust the route but make it observable so a
                // genuine misroute can never hide (F2).
                if let Some(source_port) = source_port {
                    if source_port != port {
                        log::warn!(
                            "[broker-ws] route/source_port disagree: session_id={} -> port={} but source_port={}; trusting session route",
                            session_id,
                            port,
                            source_port
                        );
                    }
                }
                return Some(port);
            }
        }
        if let Some(source_port) = source_port {
            return Some(source_port);
        }
        // Last resort: the global active_port. Safe only when unambiguous — with
        // multiple live omp processes it belongs to whichever window registered
        // most recently, so guessing it would misroute an unaddressed command
        // into another window's session. When ambiguous, return None so the
        // command surfaces as undeliverable (F3) instead of misrouting (F4).
        let active = *self.inner.active_port.lock().unwrap();
        if self.inner.upstreams.lock().unwrap().len() > 1 {
            log::warn!(
                "[broker-ws] refusing ambiguous active_port fallback ({:?}) among {} live upstreams",
                active,
                self.inner.upstreams.lock().unwrap().len()
            );
            return None;
        }
        active
    }

    fn ensure_upstream(&self, port: u16) {
        if self.inner.disabled_ports.lock().unwrap().contains(&port) {
            return;
        }
        // Insert the sender inside the lock before spawning so that a second
        // concurrent call sees the key and returns early — eliminates the
        // TOCTOU window between the contains_key check and the spawn.
        let rx = {
            let mut upstreams = self.inner.upstreams.lock().unwrap();
            if upstreams.contains_key(&port) {
                return;
            }
            let (tx, rx) = mpsc::channel::<String>(CHANNEL_CAPACITY);
            upstreams.insert(port, tx);
            rx
        };
        let broker = self.clone();
        tauri::async_runtime::spawn(async move {
            broker.run_upstream(port, rx).await;
        });
    }

    async fn run_upstream(self, port: u16, mut rx: mpsc::Receiver<String>) {
        let url = format!("ws://127.0.0.1:{}/ws", port);
        // Backoff state for the current failure streak; both reset whenever
        // a connection succeeds, so a healthy-but-restarted upstream starts
        // from the initial delay again (R1).
        let mut consecutive_failures: u32 = 0;
        let mut failing_since: Option<std::time::Instant> = None;

        loop {
            if self.inner.disabled_ports.lock().unwrap().contains(&port) {
                self.inner.upstreams.lock().unwrap().remove(&port);
                return;
            }
            match tokio_tungstenite::connect_async(&url).await {
                Ok((ws, _)) => {
                    log::info!("[broker-ws] connected upstream port {}", port);
                    consecutive_failures = 0;
                    failing_since = None;
                    let (mut writer, mut reader) = ws.split();
                    let mut shutdown_check =
                        tokio::time::interval(std::time::Duration::from_millis(500));
                    loop {
                        tokio::select! {
                            _ = shutdown_check.tick() => {
                                if self.inner.disabled_ports.lock().unwrap().contains(&port) {
                                    self.inner.upstreams.lock().unwrap().remove(&port);
                                    return;
                                }
                            }
                            Some(outbound) = rx.recv() => {
                                if writer.send(Message::Text(outbound)).await.is_err() {
                                    break;
                                }
                            }
                            inbound = reader.next() => {
                                match inbound {
                                    Some(Ok(Message::Text(text))) => {
                                        if let Some(message) = self.wrap_upstream_message(port, &text) {
                                            self.broadcast(&message);
                                        }
                                    }
                                    Some(Ok(Message::Close(_))) | None => break,
                                    Some(Ok(_)) => {}
                                    Some(Err(err)) => {
                                        log::warn!("[broker-ws] upstream {} read failed: {}", port, err);
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    log::warn!(
                        "[broker-ws] upstream port {} disconnected; reconnecting",
                        port
                    );
                }
                Err(err) => {
                    log::warn!("[broker-ws] upstream {} connect failed: {}", port, err);
                }
            }
            consecutive_failures += 1;
            let failed_for = failing_since
                .get_or_insert_with(std::time::Instant::now)
                .elapsed();
            match reconnect_decision(consecutive_failures, failed_for) {
                ReconnectDecision::Retry(delay) => {
                    tokio::time::sleep(delay).await;
                }
                ReconnectDecision::GiveUp => {
                    log::error!(
                        "[broker-ws] upstream {} unreachable after {} attempts over {:.0}s; giving up (instance assumed dead)",
                        port,
                        consecutive_failures,
                        failed_for.as_secs_f64()
                    );
                    // Evict exactly like a managed stop (`unregister_port`):
                    // disable the port, drop the upstream sender, evict its
                    // session routes, clear active_port — then tell the UI the
                    // instance is dead. A later register_session /
                    // track_background_session for the same port re-enables it
                    // (both clear disabled_ports first), so a respawned omp is
                    // never wedged by the give-up.
                    self.unregister_port(port);
                    self.broadcast_upstream_dead(port, consecutive_failures);
                    return;
                }
            }
        }
    }

    /// Notify UI clients that an upstream omp instance is dead and has been
    /// evicted by the reconnect give-up path (R1). Reuses the standard
    /// `broker_event` envelope with an `error` payload — the frontend
    /// unwraps broker_event payloads and dispatches `type: "error"` frames
    /// through its existing `serverError` handler, which renders the message
    /// in the chat like any other runtime error, so the dead instance is
    /// visible instead of silently queueing commands forever.
    fn broadcast_upstream_dead(&self, port: u16, attempts: u32) {
        let message = json!({
            "type": "broker_event",
            "protocolVersion": PROTOCOL_VERSION,
            "workspaceId": Value::Null,
            "sessionId": Value::Null,
            "sourcePort": port,
            "payload": {
                "type": "error",
                "message": format!(
                    "The agent process on port {} is no longer reachable ({} reconnect attempts failed) and has been disconnected. Start a new session or reopen the workspace to continue.",
                    port, attempts
                ),
            },
        })
        .to_string();
        self.broadcast(&message);
    }

    fn wrap_upstream_message(&self, port: u16, text: &str) -> Option<String> {
        let Ok(payload) = serde_json::from_str::<Value>(text) else {
            return None;
        };
        if let Some(session_id) = extract_session_id(&payload) {
            log::debug!(
                "[broker-ws] learn route session_id={} -> port={}",
                session_id,
                port
            );
            // Use set_route (not a bare insert) so an in-place `new_session` —
            // which reuses the port and is only ever observed through this
            // learn path (`new_session_core` does not call register_session) —
            // evicts the previous session's now-defunct route on this port.
            self.set_route(port, session_id);
        }
        let workspace_id = payload.get("workspaceId").cloned().unwrap_or(Value::Null);
        let session_id = payload.get("sessionId").cloned().unwrap_or(Value::Null);
        Some(
            json!({
                "type": "broker_event",
                "protocolVersion": PROTOCOL_VERSION,
                "workspaceId": workspace_id,
                "sessionId": session_id,
                "sourcePort": port,
                "payload": payload,
            })
            .to_string(),
        )
    }

    fn broadcast(&self, message: &str) {
        let mut stale = Vec::new();
        let mut overflowed = 0usize;
        let mut delivered = 0usize;
        {
            let clients = self.inner.ui_clients.lock().unwrap();
            for (id, tx) in clients.iter() {
                match tx.try_send(message.to_string()) {
                    Ok(()) => delivered += 1,
                    // Bounded queues (R2): a client that stopped draining
                    // gets the frame dropped with a warning rather than an
                    // unbounded backlog; a closed queue means the client is
                    // gone and its entry can be reaped.
                    Err(mpsc::error::TrySendError::Full(_)) => overflowed += 1,
                    Err(mpsc::error::TrySendError::Closed(_)) => stale.push(*id),
                }
            }
        }
        if overflowed > 0 {
            log::warn!(
                "[broker-ws] broadcast: {} of {} UI clients saturated (capacity {}); dropped message",
                overflowed,
                delivered + overflowed + stale.len(),
                CHANNEL_CAPACITY
            );
        }
        if !stale.is_empty() {
            let mut clients = self.inner.ui_clients.lock().unwrap();
            for id in stale {
                clients.remove(&id);
            }
        }
    }
}

fn extract_session_id(payload: &Value) -> Option<&str> {
    payload
        .get("sessionId")
        .and_then(Value::as_str)
        .or_else(|| payload.get("sessionFile").and_then(Value::as_str))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_session_id_prefers_route_metadata() {
        let payload = json!({
            "sessionId": "session-id",
            "sessionFile": "session-file"
        });

        assert_eq!(extract_session_id(&payload), Some("session-id"));
    }

    #[test]
    fn command_routes_by_session_id_before_active_port() {
        let broker = BrokerWs {
            port: 49000,
            inner: Arc::new(BrokerInner::default()),
        };
        broker.set_active_port(47821);
        broker.register_session(47822, "/tmp/session-b.jsonl");

        let command = json!({
            "type": "broker_command",
            "sessionId": "/tmp/session-b.jsonl",
            "payload": { "type": "mirror_sync_request" }
        });

        assert_eq!(broker.resolve_command_port(&command), Some(47822));
    }

    #[test]
    fn command_falls_back_to_active_port_without_route() {
        let broker = BrokerWs {
            port: 49000,
            inner: Arc::new(BrokerInner::default()),
        };
        broker.set_active_port(47821);

        assert_eq!(
            broker.resolve_command_port(&json!({ "type": "broker_command" })),
            Some(47821)
        );
    }

    #[test]
    fn in_place_session_swap_evicts_previous_session_route() {
        let broker = BrokerWs {
            port: 49000,
            inner: Arc::new(BrokerInner::default()),
        };
        // An unrelated session the user is NOT viewing lives on its own port.
        broker.register_session(47822, "/tmp/other.jsonl");
        // Port 47821 first hosts session A...
        broker.register_session(47821, "/tmp/session-a.jsonl");
        // ...then swaps in-place to session B (same port reused).
        broker.register_session(47821, "/tmp/session-b.jsonl");

        let routes = broker.inner.routes.lock().unwrap();
        // The now-defunct session A must no longer resolve anywhere (F1).
        assert_eq!(routes.get("/tmp/session-a.jsonl"), None);
        assert_eq!(routes.get("/tmp/session-b.jsonl"), Some(&47821));
        // Eviction is scoped to the reused port — unrelated routes are intact.
        assert_eq!(routes.get("/tmp/other.jsonl"), Some(&47822));
    }

    #[test]
    fn evicted_session_id_does_not_override_source_port() {
        let broker = BrokerWs {
            port: 49000,
            inner: Arc::new(BrokerInner::default()),
        };
        // Port 50001 hosted session A, then swapped in-place to session B.
        broker.register_session(50001, "/tmp/session-a.jsonl");
        broker.register_session(50001, "/tmp/session-b.jsonl");

        // A command still tagged with the defunct session A but carrying the
        // correct live source port (50002) must fall back to source_port — the
        // stale A route is gone, so it cannot hijack the command (F2).
        assert_eq!(
            broker.resolve_command_port(&json!({
                "type": "broker_command",
                "sessionId": "/tmp/session-a.jsonl",
                "sourcePort": 50002,
                "payload": { "type": "prompt" }
            })),
            Some(50002)
        );
    }

    #[test]
    fn refuses_ambiguous_active_port_fallback_with_multiple_upstreams() {
        let broker = BrokerWs {
            port: 49000,
            inner: Arc::new(BrokerInner::default()),
        };
        // Two windows / workspaces are live; active_port is whichever registered
        // last (47822), which has nothing to do with where an unaddressed command
        // from the OTHER window should go.
        broker.register_session(47821, "/tmp/a.jsonl");
        broker.register_session(47822, "/tmp/b.jsonl");

        // A command with neither a known session route nor a sourcePort must not
        // be silently routed to the global active_port — it surfaces as
        // undeliverable instead of misrouting across windows (F4).
        assert_eq!(
            broker.resolve_command_port(&json!({
                "type": "broker_command",
                "payload": { "type": "prompt" }
            })),
            None
        );

        // An explicit sourcePort is still honored even with multiple upstreams.
        assert_eq!(
            broker.resolve_command_port(&json!({
                "type": "broker_command",
                "sourcePort": 47821,
                "payload": { "type": "prompt" }
            })),
            Some(47821)
        );
    }

    #[test]
    fn command_routes_by_source_port_when_session_route_is_unknown() {
        let broker = BrokerWs {
            port: 49000,
            inner: Arc::new(BrokerInner::default()),
        };
        broker.set_active_port(47821);

        assert_eq!(
            broker.resolve_command_port(&json!({
                "type": "broker_command",
                "sessionId": "/tmp/unknown-session.jsonl",
                "sourcePort": 47824,
                "payload": { "type": "mirror_sync_request" }
            })),
            Some(47824)
        );
    }

    #[test]
    fn reconnect_backoff_doubles_from_750ms_to_10s_cap() {
        fn delay_for(consecutive_failures: u32) -> std::time::Duration {
            match reconnect_decision(consecutive_failures, std::time::Duration::ZERO) {
                ReconnectDecision::Retry(delay) => delay,
                ReconnectDecision::GiveUp => {
                    panic!("must retry for {consecutive_failures} failures")
                }
            }
        }

        assert_eq!(delay_for(1), std::time::Duration::from_millis(750));
        assert_eq!(delay_for(2), std::time::Duration::from_millis(1500));
        assert_eq!(delay_for(3), std::time::Duration::from_millis(3000));
        assert_eq!(delay_for(4), std::time::Duration::from_millis(6000));
        assert_eq!(delay_for(5), std::time::Duration::from_millis(10_000));
        assert_eq!(delay_for(6), std::time::Duration::from_millis(10_000));
        // Shift-saturated (2^20 clamp, still under the give-up attempt cap)
        // without overflowing.
        assert_eq!(delay_for(30), std::time::Duration::from_millis(10_000));
        assert_eq!(delay_for(59), std::time::Duration::from_millis(10_000));
    }

    #[test]
    fn reconnect_gives_up_on_attempt_cap_or_wall_clock_deadline() {
        // Attempt cap (60 consecutive failures) regardless of elapsed time.
        assert_eq!(
            reconnect_decision(UPSTREAM_RECONNECT_MAX_ATTEMPTS, std::time::Duration::ZERO),
            ReconnectDecision::GiveUp
        );
        // Wall-clock cap: ~5 minutes of continuous failure.
        assert_eq!(
            reconnect_decision(1, UPSTREAM_RECONNECT_GIVE_UP_AFTER),
            ReconnectDecision::GiveUp
        );
        // Within both thresholds: keep retrying.
        assert!(matches!(
            reconnect_decision(5, std::time::Duration::from_secs(30)),
            ReconnectDecision::Retry(_)
        ));
    }

    #[test]
    fn reconnect_policy_gives_up_within_about_five_minutes() {
        // Documented wall-clock bound of the give-up policy: simulating the
        // sleep schedule must reach GiveUp around the 5-minute target (and
        // can never spin forever).
        let mut total = std::time::Duration::ZERO;
        let mut failures = 0u32;
        loop {
            failures += 1;
            match reconnect_decision(failures, total) {
                ReconnectDecision::Retry(delay) => total += delay,
                ReconnectDecision::GiveUp => break,
            }
            assert!(failures < 1_000, "policy must eventually give up");
        }
        assert!(total >= std::time::Duration::from_secs(4 * 60));
        assert!(total <= std::time::Duration::from_secs(6 * 60));
    }

    #[test]
    fn give_up_notice_reaches_ui_clients_as_broker_event_error() {
        let broker = BrokerWs {
            port: 49000,
            inner: Arc::new(BrokerInner::default()),
        };
        let (tx, mut rx) = mpsc::channel::<String>(CHANNEL_CAPACITY);
        broker.inner.ui_clients.lock().unwrap().insert(7, tx);

        broker.broadcast_upstream_dead(47821, UPSTREAM_RECONNECT_MAX_ATTEMPTS);

        let notice: Value =
            serde_json::from_str(&rx.try_recv().expect("death notice must be queued")).unwrap();
        assert_eq!(notice["type"], "broker_event");
        assert_eq!(notice["sourcePort"], 47821);
        assert_eq!(notice["payload"]["type"], "error");
        assert!(notice["payload"]["message"]
            .as_str()
            .expect("message must be a string")
            .contains("47821"));
    }

    #[test]
    fn ensure_upstream_is_a_noop_for_disabled_ports() {
        let broker = BrokerWs {
            port: 49000,
            inner: Arc::new(BrokerInner::default()),
        };
        // unregister_port (managed stop AND the give-up path) disables the
        // port; ensure_upstream must not respawn an upstream for it.
        broker.unregister_port(47821);
        broker.ensure_upstream(47821);
        assert!(broker.inner.upstreams.lock().unwrap().is_empty());
    }
}

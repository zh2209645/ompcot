use std::collections::HashMap;
use std::io::Write;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct OmpProcess {
    child: Child,
    stdin: ChildStdin,
}

pub struct OmpManager {
    processes: Arc<Mutex<HashMap<u16, OmpProcess>>>,
    /// Maps session_file -> port for dedicated per-session processes.
    session_ports: Arc<Mutex<HashMap<String, u16>>>,
    /// Maps workspace_port -> [dedicated session ports] for cleanup on window close.
    workspace_dedicated: Arc<Mutex<HashMap<u16, Vec<u16>>>>,
    static_dir: PathBuf,
    /// Tauri app-config dir holding `ompcot.json` (user's omp binary
    /// override). Injected at construction — see `main.rs` setup — instead of
    /// a global static, so the persistence helpers stay pure/testable.
    config_dir: PathBuf,
}

struct EmbeddedExtensionResolution {
    path: String,
    /// Tag describing which candidate matched, for diagnostic logging.
    /// Examples: "bundled", "dev:source", "env:OMCOT_EXTENSION".
    source: &'static str,
}

// ─── omp binary resolution + user override persistence ─────────────────────
//
// The omp binary is located through one shared chain (see `resolve_omp_binary`):
// `OMP_BIN` env var → user-saved override from `<app config dir>/ompcot.json`
// → PATH lookup. The persistence helpers are pure (they take an explicit base
// dir) so unit tests need neither a Tauri app nor process-global state;
// `OmpManager` receives the real Tauri app-config dir at construction time
// (see `OmpManager::new`), which we preferred over a global OnceLock for the
// config base so the helpers stay trivially testable.

/// File name for Ompcot host settings inside the Tauri app-config dir.
const SETTINGS_FILE_NAME: &str = "ompcot.json";
/// JSON key holding the user-specified omp binary path override.
const SETTINGS_KEY_OMP_BINARY: &str = "ompBinaryPath";

/// Source of a resolved omp binary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OmpBinarySource {
    /// `OMP_BIN` env var (escape hatch for testing a different binary).
    Env,
    /// `ompBinaryPath` saved in `<app config dir>/ompcot.json`.
    Override,
    /// `omp` / `omp.exe` found on PATH.
    Path,
}

impl OmpBinarySource {
    pub fn as_str(self) -> &'static str {
        match self {
            OmpBinarySource::Env => "env",
            OmpBinarySource::Override => "override",
            OmpBinarySource::Path => "path",
        }
    }
}

/// A resolved omp binary path plus the chain step that produced it.
#[derive(Debug, Clone)]
pub struct OmpBinaryResolution {
    pub path: PathBuf,
    pub source: OmpBinarySource,
}

/// Serializable snapshot of the current omp binary resolution for the UI
/// (broker control command `get_omp_binary_status`).
#[derive(Debug, serde::Serialize)]
pub struct OmpBinaryStatus {
    /// Absolute path of the binary in effect, or `null` when none resolved.
    pub path: Option<String>,
    /// One of "env", "override", "path", "none".
    pub source: String,
}

/// Not-found error. The frontend matches on the `Could not find omp binary`
/// prefix — keep it stable; only the tail text may evolve.
fn omp_not_found_error() -> String {
    "Could not find omp binary on PATH or via saved setting. Set it via the \
     startup window (Specify omp binary path) or Settings, or set OMP_BIN."
        .to_string()
}

/// Resolve the omp binary using the shared chain:
///
/// 1. `OMP_BIN` env var, when it names an existing file.
/// 2. Persisted `ompBinaryPath` override, when it names an existing file.
/// 3. `omp` / `omp.exe` on PATH (`which`).
///
/// Pure with respect to process-global state: both override inputs are passed
/// explicitly so unit tests never need to mutate env vars.
pub fn resolve_omp_binary(
    env_value: Option<&str>,
    override_path: Option<&Path>,
) -> Result<OmpBinaryResolution, String> {
    // 1. Explicit env override (rare; useful when smoke-testing a hand-built omp).
    if let Some(explicit) = env_value.map(str::trim).filter(|s| !s.is_empty()) {
        let candidate = PathBuf::from(explicit);
        if candidate.is_file() {
            return Ok(OmpBinaryResolution {
                path: candidate,
                source: OmpBinarySource::Env,
            });
        }
    }

    // 2. User-saved override (startup-window / Settings picker). A stale
    //    entry (binary deleted after saving) falls through to the PATH
    //    lookup instead of failing startup.
    if let Some(saved) = override_path {
        if saved.is_file() {
            return Ok(OmpBinaryResolution {
                path: saved.to_path_buf(),
                source: OmpBinarySource::Override,
            });
        }
    }

    // 3. System omp on PATH — the common case. `brew upgrade omp` updates this.
    let bin_name = if cfg!(target_os = "windows") {
        "omp.exe"
    } else {
        "omp"
    };
    if let Ok(path) = which::which(bin_name) {
        log::info!("[ompcot] using system omp: {}", path.display());
        return Ok(OmpBinaryResolution {
            path,
            source: OmpBinarySource::Path,
        });
    }

    Err(omp_not_found_error())
}

/// Read the persisted omp binary override from `<config_dir>/ompcot.json`.
///
/// Returns `None` when the file is missing/unparseable or the key is
/// absent/null/empty. Whether the target binary still exists is *not*
/// checked here — the shared resolver does, so a stale override degrades to
/// the PATH lookup instead of an error.
pub fn load_override(config_dir: &Path) -> Option<PathBuf> {
    let contents = std::fs::read_to_string(config_dir.join(SETTINGS_FILE_NAME)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&contents).ok()?;
    let path = value.get(SETTINGS_KEY_OMP_BINARY)?.as_str()?;
    let trimmed = path.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

/// Persist `path` as `ompBinaryPath` in `<config_dir>/ompcot.json`, creating
/// parent directories as needed and preserving any sibling keys.
pub fn save_override(config_dir: &Path, path: &Path) -> Result<(), String> {
    let file = config_dir.join(SETTINGS_FILE_NAME);
    let mut root: serde_json::Value = std::fs::read_to_string(&file)
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !root.is_object() {
        root = serde_json::json!({});
    }
    root[SETTINGS_KEY_OMP_BINARY] = serde_json::Value::String(path.to_string_lossy().into_owned());
    std::fs::create_dir_all(config_dir).map_err(|e| {
        format!(
            "Failed to create config dir {}: {}",
            config_dir.display(),
            e
        )
    })?;
    let serialized = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&file, serialized)
        .map_err(|e| format!("Failed to write {}: {}", file.display(), e))
}

/// Canonicalize a user-picked override path for persistence. Strips the
/// Windows `\\?\` verbatim prefix because the omp runtime misbehaves when
/// launched from extended-length paths (see `strip_verbatim_prefix`).
pub fn normalize_override_path(path: &Path) -> PathBuf {
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    PathBuf::from(strip_verbatim_prefix(&canonical.to_string_lossy()))
}

/// Validate a user-picked omp binary: it must be an existing file and
/// `<path> --version` must run successfully (exit 0).
pub fn validate_omp_binary(path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Err(format!(
            "Not a valid omp binary ({}): not an existing file",
            path.display()
        ));
    }
    let mut command = Command::new(path);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_child_process_for_windows(&mut command);
    match command.output() {
        Ok(output) if output.status.success() => Ok(()),
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let reason = if !stderr.is_empty() {
                stderr
            } else if !stdout.is_empty() {
                stdout
            } else {
                format!("`--version` exited with status {}", output.status)
            };
            Err(format!(
                "Not a valid omp binary ({}): {}",
                path.display(),
                reason
            ))
        }
        Err(e) => Err(format!(
            "Not a valid omp binary ({}): failed to execute `--version` ({})",
            path.display(),
            e
        )),
    }
}

/// Run `omp --version` and cache the output per binary path. Caching per path
/// (not a single global slot) means picking a new override automatically
/// invalidates the stale version string.
fn run_omp_version(bin: &Path) -> String {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, String>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(cached) = cache.lock().unwrap().get(bin) {
        return cached.clone();
    }
    let mut command = Command::new(bin);
    command.arg("--version");
    configure_child_process_for_windows(&mut command);
    let version = match command.output() {
        Ok(output) => String::from_utf8_lossy(&output.stdout).trim().to_string(),
        Err(e) => {
            log::warn!("[ompcot] failed to run omp --version: {}", e);
            "unknown".to_string()
        }
    };
    cache
        .lock()
        .unwrap()
        .insert(bin.to_path_buf(), version.clone());
    version
}

#[cfg(target_os = "windows")]
fn configure_child_process_for_windows(command: &mut Command) {
    // Prevent child `omp.exe` processes from creating a visible console window
    // when Ompcot runs as a GUI app on Windows.
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn configure_child_process_for_windows(_command: &mut Command) {}

/// Build an augmented PATH for child processes.
///
/// `fix_path_env::fix()` is called at app startup and already merges the
/// user's login-shell PATH into this process.  This function is a second
/// safety net: it appends any well-known tool directories that might still
/// be absent (e.g. nvm-managed node versions, Volta, Bun, Mise shims) so
/// that `npm`, `npx`, and friends are always reachable.
///
/// Directories already present in PATH are not duplicated.
fn build_augmented_path() -> String {
    use std::path::{Path, PathBuf};

    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|v| std::env::split_paths(&v).collect())
        .unwrap_or_default();

    #[cfg(not(target_os = "windows"))]
    {
        let mut extras: Vec<PathBuf> = vec![
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/opt/homebrew/sbin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/local/sbin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
        ];

        if let Ok(home) = std::env::var("HOME") {
            let h = Path::new(&home);
            extras.push(omp_extension_npm_bin_dir(h));
            extras.push(h.join(".local/bin"));
            extras.push(h.join(".bun/bin"));
            extras.push(h.join(".volta/bin"));
            extras.push(h.join(".cargo/bin"));
            extras.push(h.join(".local/share/mise/shims"));
            // nvm: enumerate all installed node versions
            let nvm_root = h.join(".nvm/versions/node");
            if let Ok(entries) = std::fs::read_dir(nvm_root) {
                for entry in entries.flatten() {
                    let bin = entry.path().join("bin");
                    if bin.is_dir() {
                        extras.push(bin);
                    }
                }
            }
        }

        for extra in extras {
            if !dirs.iter().any(|d| d == &extra) {
                dirs.push(extra);
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let mut extras: Vec<PathBuf> = Vec::new();
        if let Ok(appdata) = std::env::var("APPDATA") {
            extras.push(Path::new(&appdata).join("npm"));
        }
        if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
            let h = Path::new(&home);
            extras.push(omp_extension_npm_bin_dir(h));
            extras.push(h.join(".cargo").join("bin"));
            extras.push(h.join(".bun").join("bin"));
            extras.push(h.join("scoop").join("shims"));
        }
        for extra in extras {
            if !dirs.iter().any(|d| d == &extra) {
                dirs.push(extra);
            }
        }
    }

    std::env::join_paths(dirs)
        .ok()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default())
}

fn omp_extension_npm_bin_dir(home: &Path) -> PathBuf {
    home.join(".omp")
        .join("agent")
        .join("npm")
        .join("node_modules")
        .join(".bin")
}

fn log_child_path_diagnostics(context: &str, path: &str) {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok();
    let Some(home) = home else {
        log::info!(
            "[ompcot] child PATH diagnostics: context={} home=<unset> path={}",
            context,
            path
        );
        return;
    };

    let omp_extension_bin = omp_extension_npm_bin_dir(Path::new(&home));
    let hypa_bin = omp_extension_bin.join(if cfg!(target_os = "windows") {
        "hypa.cmd"
    } else {
        "hypa"
    });
    let dirs: Vec<PathBuf> = std::env::split_paths(path).collect();
    let contains_omp_extension_bin = dirs.iter().any(|dir| dir == &omp_extension_bin);

    log::info!(
        "[ompcot] child PATH diagnostics: context={} omp_extension_bin={} exists={} hypa_bin={} hypa_exists={} contains_omp_extension_bin={} path={}",
        context,
        omp_extension_bin.display(),
        omp_extension_bin.is_dir(),
        hypa_bin.display(),
        hypa_bin.is_file(),
        contains_omp_extension_bin,
        path
    );
}

/// Strip a Windows verbatim / extended-length path prefix (`\\?\` or
/// `\\?\UNC\`) from a path string.
///
/// Tauri's `resource_dir()` returns extended-length paths (e.g.
/// `\\?\C:\Users\...\Ompcot\pi\omp.exe`). The embedded omp (Bun 1.3.10,
/// Windows arm64, compiled standalone) segfaults (`Segmentation fault at
/// address 0x18`) when it is launched with — or asked to load an
/// `--extension` from — a `\\?\`-prefixed path. Passing the plain
/// `C:\Users\...` form avoids the crash. This is a no-op on non-Windows
/// platforms and for paths without the prefix.
fn strip_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        // `\\?\UNC\server\share` -> `\\server\share`
        format!(r"\\{}", rest)
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

/// Return a path to the embedded-server extension that is safe to pass as a
/// `--extension` argument to the embedded omp binary.
///
/// On Windows the Bun-compiled omp binary truncates `--extension` values at the
/// first space (e.g. `C:\...\Ompcot\...\embedded-server.mjs` is loaded as
/// `C:\...\OMP`), which then fails to load and segfaults the process. Since OMP
/// Studio always installs under a space-containing path, we mirror the
/// extension file into a space-free directory under the system temp dir and
/// return that path instead. The copy is idempotent (skipped when an existing
/// mirror already matches by length + mtime), so repeated spawns are cheap.
///
/// On non-Windows platforms, or when the path has no space, the original path
/// is returned unchanged.
#[cfg(not(target_os = "windows"))]
fn sanitize_extension_path_for_omp(original: &str) -> String {
    original.to_string()
}

#[cfg(target_os = "windows")]
fn sanitize_extension_path_for_omp(original: &str) -> String {
    if !original.contains(' ') {
        return original.to_string();
    }

    match mirror_to_space_free_dir(Path::new(original)) {
        Ok(mirrored) => {
            log::info!(
                "[ompcot] extension path contains spaces; mirrored to space-free path: {} -> {}",
                original,
                mirrored.display()
            );
            mirrored.to_string_lossy().to_string()
        }
        Err(e) => {
            // Non-fatal: fall back to the original path. Worst case is the
            // pre-existing crash, but we don't want the mirroring step itself
            // to be a new hard failure mode.
            log::warn!(
                "[ompcot] failed to mirror extension to space-free path ({}); using original: {}",
                e,
                original
            );
            original.to_string()
        }
    }
}

/// Copy `src` into `<temp>/ompcot-ext/<filename>` (a space-free directory),
/// skipping the copy when an up-to-date mirror already exists. Returns the
/// mirrored path.
#[cfg(target_os = "windows")]
fn mirror_to_space_free_dir(src: &Path) -> std::io::Result<PathBuf> {
    let file_name = src.file_name().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "extension path has no file name",
        )
    })?;

    let mut dest_dir = std::env::temp_dir();
    // Guard: if the temp dir itself contains a space, fall back to a
    // well-known space-free root so the workaround actually helps.
    if dest_dir.to_string_lossy().contains(' ') {
        dest_dir = PathBuf::from("C:\\ProgramData\\ompcot");
    }
    dest_dir.push("ompcot-ext");
    std::fs::create_dir_all(&dest_dir)?;

    let dest = dest_dir.join(file_name);

    if mirror_is_up_to_date(src, &dest) {
        return Ok(dest);
    }

    std::fs::copy(src, &dest)?;
    Ok(dest)
}

/// Cheap freshness check: the mirror is considered current when it exists and
/// matches the source by byte length and modified time. This avoids re-copying
/// the extension on every spawn while still picking up updated builds.
#[cfg(target_os = "windows")]
fn mirror_is_up_to_date(src: &Path, dest: &Path) -> bool {
    let (Ok(src_meta), Ok(dest_meta)) = (std::fs::metadata(src), std::fs::metadata(dest)) else {
        return false;
    };
    if src_meta.len() != dest_meta.len() {
        return false;
    }
    match (src_meta.modified(), dest_meta.modified()) {
        (Ok(src_mtime), Ok(dest_mtime)) => dest_mtime >= src_mtime,
        _ => false,
    }
}

impl OmpManager {
    pub fn new(static_dir: PathBuf, config_dir: PathBuf) -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
            session_ports: Arc::new(Mutex::new(HashMap::new())),
            workspace_dedicated: Arc::new(Mutex::new(HashMap::new())),
            static_dir,
            config_dir,
        }
    }

    /// Locate the omp binary via the shared chain (see [`resolve_omp_binary`]):
    /// `OMP_BIN` env → saved `ompcot.json` override → PATH lookup.
    fn resolve_omp(&self) -> Result<OmpBinaryResolution, String> {
        let env_value = std::env::var("OMP_BIN").ok();
        let saved_override = load_override(&self.config_dir);
        resolve_omp_binary(env_value.as_deref(), saved_override.as_deref())
    }

    /// omp version string (`omp --version`) for the binary the manager would
    /// currently spawn. Uses the same resolution chain as `spawn`.
    pub fn omp_version(&self) -> String {
        match self.resolve_omp() {
            Ok(resolution) => run_omp_version(&resolution.path),
            Err(_) => "unknown (omp not found on PATH)".to_string(),
        }
    }

    /// Snapshot of the current omp binary resolution for the UI
    /// (`get_omp_binary_status` broker control command).
    pub fn omp_binary_status(&self) -> OmpBinaryStatus {
        match self.resolve_omp() {
            Ok(resolution) => OmpBinaryStatus {
                path: Some(resolution.path.to_string_lossy().into_owned()),
                source: resolution.source.as_str().to_string(),
            },
            Err(_) => OmpBinaryStatus {
                path: None,
                source: "none".to_string(),
            },
        }
    }
    /// Locate the embedded-server extension shipped with this build.
    ///
    /// Returns the first existing candidate from this priority order:
    ///
    /// 1. `OMCOT_EXTENSION` env var (explicit override; useful for tests).
    /// 2. Bundled `extensions/embedded-server.mjs` next to `static_dir`. This
    ///    is what shipped Ompcot installs use; the bundle is produced by
    ///    `scripts/build-extensions.js` and is fully self-contained (no
    ///    `node_modules` lookup at runtime).
    /// 3. Source `extensions/embedded-server.ts` next to `static_dir`. Used
    ///    by `tauri dev` where omp loads the raw `.ts` via jiti against the
    ///    repo's `node_modules/`.
    /// 4. *Debug builds only:* repo-relative paths via `CARGO_MANIFEST_DIR`
    ///    and `cwd`. These are gated to debug builds because
    ///    `CARGO_MANIFEST_DIR` is a compile-time string and would otherwise
    ///    silently "work" only on the build machine.
    ///
    /// Returns `Err` (not `Ok(None)`) when nothing is found, so callers can
    /// fail-fast and surface the error to the user instead of silently
    /// spawning a pi that has no `/api` surface.
    fn resolve_embedded_extension_path(&self) -> Result<EmbeddedExtensionResolution, String> {
        if let Ok(explicit) = std::env::var("OMCOT_EXTENSION") {
            let candidate = explicit.trim();
            if !candidate.is_empty() && Path::new(candidate).exists() {
                return Ok(EmbeddedExtensionResolution {
                    path: candidate.to_string(),
                    source: "env:OMCOT_EXTENSION",
                });
            }
        }

        let mut candidates: Vec<(PathBuf, &'static str)> = Vec::new();

        // Compile-time path fallbacks: only useful while developing locally.
        // Prefer the live source in debug builds before any target/debug bundle:
        // that bundle can be stale after frontend/extension edits and causes the
        // dev app to serve old API behavior until a full resource copy happens.
        if cfg!(debug_assertions) {
            candidates.push((
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join("extensions")
                    .join("embedded-server.ts"),
                "dev:cargo-manifest-dir",
            ));
            if let Ok(cwd) = std::env::current_dir() {
                candidates.push((cwd.join("extensions").join("embedded-server.ts"), "dev:cwd"));
            }
        }

        if let Some(parent) = self.static_dir.parent() {
            candidates.push((
                parent.join("extensions").join("embedded-server.mjs"),
                "bundled",
            ));
            candidates.push((
                parent.join("extensions").join("embedded-server.ts"),
                "dev:source",
            ));
        }

        for (candidate, source) in &candidates {
            if candidate.exists() {
                return Ok(EmbeddedExtensionResolution {
                    path: candidate.to_string_lossy().to_string(),
                    source,
                });
            }
        }

        let tried = candidates
            .into_iter()
            .map(|(p, source)| format!("  - [{}] {}", source, p.display()))
            .collect::<Vec<_>>()
            .join("\n");
        Err(format!(
            "Could not find embedded-server extension. Tried:\n{}\n\n\
             For release builds, this means the .app bundle is missing \
             `extensions/embedded-server.mjs` (run `bun run build:extensions` \
             before `tauri build`). For dev, make sure `extensions/embedded-server.ts` \
             exists in this repo.",
            tried
        ))
    }

    pub fn spawn(&self, cwd: &str, port: u16, session_path: Option<&str>) -> Result<(), String> {
        let omp_bin = self.resolve_omp()?;
        log::info!(
            "[ompcot] omp binary resolved: source={} path={}",
            omp_bin.source.as_str(),
            omp_bin.path.display()
        );
        let pi_bin = omp_bin.path;
        // Tauri resolves resource paths as `\\?\`-prefixed extended-length
        // paths. Bun (the embedded omp runtime) segfaults on Windows arm64 when
        // launched from such a path, so normalize the binary path and every
        // path-shaped argument/env we hand to it back to the plain form.
        let pi_bin_str = strip_verbatim_prefix(&pi_bin.to_string_lossy());
        let static_dir = strip_verbatim_prefix(&self.static_dir.to_string_lossy());
        let cwd = strip_verbatim_prefix(cwd);

        // We treat a missing embedded-server extension as a hard error
        // rather than continuing to spawn omp without `--extension`. Without
        // the extension, omp runs as a plain RPC process with no
        // `/api/sessions` or `/ws`, which the web UI then renders as
        // "Failed to load sessions" / "Disconnected" — a confusing soft
        // failure that hides the real bundling bug.
        let extension = self.resolve_embedded_extension_path()?;
        log::info!(
            "[ompcot] embedded-server resolved: source={} path={}",
            extension.source,
            extension.path
        );

        // The embedded omp (Bun-compiled standalone) mis-parses `--extension`
        // paths that contain spaces on Windows: it truncates at the first
        // space, so `...\Ompcot\extensions\embedded-server.mjs` is loaded
        // as `...\OMP`, which then fails to load and crashes the process
        // (segfault) during extension-load error handling. The primary fix is
        // the space-free `productName` ("Ompcot") so the install dir has no
        // space; this mirroring remains as a defensive fallback for paths that
        // can still contain spaces out of our control (e.g. a Windows username
        // like `C:\Users\Shi Xin\...`). Work around it by mirroring the
        // extension into a space-free directory and passing that path instead.
        //
        // Also strip the `\\?\` verbatim prefix first: Bun on Windows arm64
        // segfaults when loading an extension from an extended-length path.
        let extension_path =
            sanitize_extension_path_for_omp(&strip_verbatim_prefix(&extension.path));

        let mut args: Vec<String> = vec![
            "--extension".to_string(),
            extension_path,
            "--mode".to_string(),
            "rpc".to_string(),
        ];
        if let Some(session) = session_path {
            args.push("--session".to_string());
            args.push(session.to_string());
        }

        log::info!(
            "[ompcot] spawning pi: bin={} args={:?} cwd={} port={} static_dir={}",
            pi_bin_str,
            args,
            cwd,
            port,
            static_dir
        );

        let augmented_path = build_augmented_path();
        log_child_path_diagnostics("spawn", &augmented_path);

        let mut child = Command::new(&pi_bin_str);
        configure_child_process_for_windows(&mut child);
        child
            .args(&args)
            .current_dir(&cwd)
            .env("PATH", augmented_path)
            .env("OMCOT_STATIC_DIR", &static_dir)
            .env("OMCOT_PORT", port.to_string())
            .env("OMCOT_OMP_VERSION", run_omp_version(&pi_bin))
            // Tell the embedded extension which omp binary to shell out to for
            // CLI fallbacks (`omp config …`). Inside a shim-style install
            // process.execPath is the bun runtime, NOT omp, so the extension
            // cannot derive this reliably on its own.
            .env("OMPCOT_OMP_BIN", &pi_bin_str)
            .stdin(Stdio::piped())
            // Drop stdout: omp emits RPC frames on it that we don't consume here, and
            // letting it fill an unread pipe would eventually block the child.
            .stdout(Stdio::null())
            // Inherit stderr so omp's startup/runtime errors are visible in the same
            // terminal running `bun run dev` — critical for diagnosing failures of
            // new_session / open_workspace that would otherwise be silent.
            .stderr(Stdio::inherit());

        let spawn_started_at = Instant::now();
        let mut child = child.spawn().map_err(|e| {
            format!(
                "Failed to spawn omp ({}): {}. \
                 Make sure omp is installed (brew install omp) and on your PATH.",
                pi_bin.display(),
                e,
            )
        })?;
        log::info!(
            "[ompcot] omp process spawned: port={} pid={} elapsed_ms={}",
            port,
            child.id(),
            spawn_started_at.elapsed().as_millis()
        );
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to get pi stdin".to_string())?;

        let mut lock = self.processes.lock().unwrap();
        lock.insert(port, OmpProcess { child, stdin });

        Ok(())
    }

    /// Send an RPC command to a omp instance (JSON line on stdin)
    pub fn send_rpc(&self, port: u16, cmd: serde_json::Value) -> Result<(), String> {
        let mut lock = self.processes.lock().unwrap();
        let proc = lock
            .get_mut(&port)
            .ok_or_else(|| format!("No omp instance on port {}", port))?;
        let mut line = cmd.to_string();
        line.push('\n');
        proc.stdin
            .write_all(line.as_bytes())
            .map_err(|e| e.to_string())
    }

    /// Returns `Some(exit_status_string)` if the process has already exited, `None` if still running.
    pub fn check_exited(&self, port: u16) -> Option<String> {
        let mut lock = self.processes.lock().unwrap();
        let proc = lock.get_mut(&port)?;
        match proc.child.try_wait() {
            Ok(Some(status)) => Some(format!("{}", status)),
            _ => None,
        }
    }

    pub fn kill(&self, port: u16) {
        let mut lock = self.processes.lock().unwrap();
        if let Some(mut proc) = lock.remove(&port) {
            let _ = proc.child.kill();
        }
    }

    pub fn kill_all(&self) {
        let mut lock = self.processes.lock().unwrap();
        for (_, mut proc) in lock.drain() {
            let _ = proc.child.kill();
        }
    }

    /// Spawn (or reuse) a dedicated omp process for a specific session file,
    /// so it can run concurrently with the workspace's primary process.
    /// Returns the port the dedicated process is listening on.
    pub fn spawn_session_dedicated(
        &self,
        workspace_port: u16,
        session_file: String,
        cwd: &str,
    ) -> Result<u16, String> {
        {
            let sp = self.session_ports.lock().unwrap();
            if let Some(&port) = sp.get(&session_file) {
                return Ok(port);
            }
        }
        let port = self.next_port();
        self.spawn(cwd, port, Some(&session_file))?;
        {
            let mut sp = self.session_ports.lock().unwrap();
            sp.insert(session_file, port);
        }
        {
            let mut wd = self.workspace_dedicated.lock().unwrap();
            wd.entry(workspace_port).or_default().push(port);
        }
        Ok(port)
    }

    /// Kill all dedicated session processes spawned for a workspace port.
    /// Called when the workspace window is destroyed.
    pub fn kill_workspace_dedicated(&self, workspace_port: u16) {
        let dedicated_ports = {
            let mut wd = self.workspace_dedicated.lock().unwrap();
            wd.remove(&workspace_port).unwrap_or_default()
        };
        for port in &dedicated_ports {
            self.kill(*port);
        }
        if !dedicated_ports.is_empty() {
            let port_set: std::collections::HashSet<u16> = dedicated_ports.into_iter().collect();
            let mut sp = self.session_ports.lock().unwrap();
            sp.retain(|_, v| !port_set.contains(v));
        }
    }

    pub fn next_port(&self) -> u16 {
        let lock = self.processes.lock().unwrap();
        let mut port = 47821u16;
        while lock.contains_key(&port) || is_port_in_use(port) {
            port += 1;
        }
        port
    }

    /// Run `pi <args...>` with the resolved omp binary and return stdout.
    /// Used by Settings UI package management operations (install/remove/list).
    pub fn run_pi_command(&self, args: &[String]) -> Result<String, String> {
        let pi_bin = self.resolve_omp()?.path;
        let pi_bin_str = strip_verbatim_prefix(&pi_bin.to_string_lossy());
        let augmented_path = build_augmented_path();
        log_child_path_diagnostics("run_pi_command", &augmented_path);
        let mut command = Command::new(&pi_bin_str);
        configure_child_process_for_windows(&mut command);
        command
            .args(args)
            .env("PATH", augmented_path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let output = command.output().map_err(|e| {
            format!(
                "Failed to run omp command ({} {:?}): {}",
                pi_bin_str, args, e
            )
        })?;
        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
        }
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let details = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("exit status {}", output.status)
        };
        Err(format!(
            "Omp command failed: {} {:?}: {}",
            pi_bin_str, args, details
        ))
    }

    /// Parse `omp list` output and extract package sources.
    pub fn list_configured_package_sources(&self) -> Result<Vec<String>, String> {
        let args = vec!["list".to_string()];
        let output = self.run_pi_command(&args)?;
        let mut sources = Vec::new();
        for line in output.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if trimmed.eq_ignore_ascii_case("No packages installed.") {
                continue;
            }
            if trimmed.ends_with(':') {
                continue;
            }
            if let Some(rest) = trimmed.strip_prefix('-') {
                let value = rest.trim();
                if !value.is_empty() {
                    sources.push(value.to_string());
                }
                continue;
            }
            // `omp list` currently emits entries prefixed with two spaces.
            if let Some(value) = trimmed.strip_prefix("npm:") {
                sources.push(format!("npm:{}", value));
                continue;
            }
            if let Some(value) = trimmed.strip_prefix("git:") {
                sources.push(format!("git:{}", value));
                continue;
            }
            if trimmed.starts_with('/') || trimmed.starts_with("./") || trimmed.starts_with("../") {
                sources.push(trimmed.to_string());
            }
        }
        Ok(sources)
    }

    pub fn install_package_source(&self, source: &str) -> Result<(), String> {
        let args = vec!["install".to_string(), source.to_string()];
        let _ = self.run_pi_command(&args)?;
        Ok(())
    }

    pub fn remove_package_source(&self, source: &str) -> Result<(), String> {
        let args = vec!["remove".to_string(), source.to_string()];
        let _ = self.run_pi_command(&args)?;
        Ok(())
    }
}

pub fn is_port_in_use(port: u16) -> bool {
    std::net::TcpListener::bind(format!("0.0.0.0:{}", port)).is_err()
}

pub async fn wait_for_health(port: u16, timeout_secs: u64) -> Result<(), String> {
    wait_for_endpoint(port, "/api/health", timeout_secs).await
}

/// Wait for a specific HTTP endpoint on the omp instance to respond with a non-5xx status.
/// Useful when we need to confirm the API surface the frontend will hit first (e.g. /api/sessions)
/// is ready before navigating, avoiding cold-start races where /api/health is up but route
/// handlers are still warming.
pub async fn wait_for_endpoint(port: u16, path: &str, timeout_secs: u64) -> Result<(), String> {
    let url = format!("http://localhost:{}{}", port, path);
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);
    loop {
        if std::time::Instant::now() > deadline {
            return Err(format!("Timed out waiting for {} on port {}", path, port));
        }
        if let Ok(resp) = reqwest::get(&url).await {
            if resp.status().as_u16() < 500 {
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Unique temp dir under the system temp dir, mirroring the helper in
    /// main.rs tests. Callers clean up with `fs::remove_dir_all`.
    fn unique_temp_dir(label: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("ompcot-omp-override-{label}-{suffix}"))
    }

    fn write_fake_binary(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, b"#!/bin/sh\nexit 0\n").expect("write fake binary");
        path
    }

    #[test]
    fn augmented_path_includes_omp_extension_npm_bin() {
        // Mirror build_augmented_path's own home lookup: HOME with a
        // USERPROFILE fallback so the test also works on Windows.
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .expect("HOME or USERPROFILE must be set for this test");
        let expected = Path::new(&home)
            .join(".omp")
            .join("agent")
            .join("npm")
            .join("node_modules")
            .join(".bin");

        let path = build_augmented_path();
        let dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();

        assert!(
            dirs.iter().any(|dir| dir == &expected),
            "expected augmented PATH to include {}",
            expected.display()
        );
    }

    #[test]
    fn port_in_use_detects_unspecified_ipv4_listener() {
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0))
            .expect("bind ephemeral port");
        let port = listener.local_addr().expect("listener addr").port();

        assert!(is_port_in_use(port));
    }

    #[test]
    fn override_save_load_roundtrip() {
        let root = unique_temp_dir("roundtrip");
        fs::create_dir_all(&root).unwrap();
        let bin = write_fake_binary(&root, "omp-fake");

        // 1. Saving into a not-yet-existing nested dir creates parents + file.
        let config_dir = root.join("nested").join("config");
        save_override(&config_dir, &bin).expect("save_override must succeed");
        assert!(config_dir.join(SETTINGS_FILE_NAME).is_file());
        assert_eq!(load_override(&config_dir).as_deref(), Some(bin.as_path()));

        // 2. Re-saving over an existing file with sibling keys preserves them.
        fs::write(
            config_dir.join(SETTINGS_FILE_NAME),
            r#"{"otherSetting": 42}"#,
        )
        .unwrap();
        save_override(&config_dir, &bin).unwrap();
        assert_eq!(load_override(&config_dir).as_deref(), Some(bin.as_path()));
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(config_dir.join(SETTINGS_FILE_NAME)).unwrap())
                .unwrap();
        assert_eq!(raw.get("otherSetting"), Some(&serde_json::json!(42)));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn env_beats_saved_override() {
        let root = unique_temp_dir("env-beats-override");
        fs::create_dir_all(&root).unwrap();
        let env_bin = write_fake_binary(&root, "env-omp");
        let saved_bin = write_fake_binary(&root, "saved-omp");
        save_override(&root, &saved_bin).unwrap();

        let env_value = env_bin.to_string_lossy().into_owned();
        let resolution =
            resolve_omp_binary(Some(env_value.as_str()), load_override(&root).as_deref())
                .expect("env candidate must resolve");

        assert_eq!(resolution.path, env_bin);
        assert_eq!(resolution.source, OmpBinarySource::Env);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn override_beats_path_lookup() {
        let root = unique_temp_dir("override-beats-path");
        fs::create_dir_all(&root).unwrap();
        let saved_bin = write_fake_binary(&root, "saved-omp");

        // Deterministic: the override is checked before the PATH lookup, so
        // this never reaches `which` regardless of the host environment.
        let resolution =
            resolve_omp_binary(None, Some(&saved_bin)).expect("saved override must resolve");

        assert_eq!(resolution.path, saved_bin);
        assert_eq!(resolution.source, OmpBinarySource::Override);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn missing_or_absent_override_falls_through() {
        let root = unique_temp_dir("missing-override");
        fs::create_dir_all(&root).unwrap();

        // No ompcot.json at all.
        assert_eq!(load_override(&root), None);
        // Key absent.
        fs::write(root.join(SETTINGS_FILE_NAME), r#"{"other": 1}"#).unwrap();
        assert_eq!(load_override(&root), None);
        // Key explicitly null.
        fs::write(root.join(SETTINGS_FILE_NAME), r#"{"ompBinaryPath": null}"#).unwrap();
        assert_eq!(load_override(&root), None);
        // Unparseable file.
        fs::write(root.join(SETTINGS_FILE_NAME), "not json").unwrap();
        assert_eq!(load_override(&root), None);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn not_found_error_keeps_stable_prefix() {
        assert!(omp_not_found_error().starts_with("Could not find omp binary"));
    }

    #[test]
    fn invalid_pick_fails_version_check() {
        let root = unique_temp_dir("invalid-pick");
        fs::create_dir_all(&root).unwrap();

        // A plain text file is not executable, so `--version` cannot succeed.
        let text_file = root.join("not-an-executable.txt");
        fs::write(&text_file, "definitely not a binary").unwrap();
        let err = validate_omp_binary(&text_file).expect_err("text file must be rejected");
        assert!(
            err.starts_with(&format!("Not a valid omp binary ({})", text_file.display())),
            "unexpected error: {err}"
        );

        // Nonexistent paths are rejected before any process is spawned.
        let missing_err = validate_omp_binary(&root.join("does-not-exist"))
            .expect_err("missing file must be rejected");
        assert!(
            missing_err.starts_with("Not a valid omp binary"),
            "unexpected error: {missing_err}"
        );

        let _ = fs::remove_dir_all(root);
    }
}

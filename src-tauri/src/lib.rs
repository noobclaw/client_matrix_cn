use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Listener, Manager,
};
use tauri_plugin_shell::process::CommandChild;

// ─── Windows Job Object — kernel-enforced child cleanup ──────────────
//
// Problem: On Windows the kernel has no parent-process-death signal
// equivalent to POSIX. If the main NoobClaw exe dies (clean exit, panic,
// `taskkill /F`, power loss, OOM kill, …) the spawned sidecar
// (noobclaw-server.exe) keeps running indefinitely. It then holds onto
// TCP port 12581 (hard-coded by the Chrome extension) and the
// native-messaging-host.bat file lock, so the next NoobClaw launch
// fails with "port 12581 held by another process".
//
// Fix: wrap every sidecar child in a Win32 Job Object whose
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE flag is set. The kernel terminates
// every process inside the job the instant the LAST handle to the job
// closes — and the only process holding that handle is the main exe.
// When main dies, kernel cleans up all sidecars synchronously, no
// userspace cooperation needed.
//
// This is the exact pattern Chrome / Edge / VS Code / Defender use for
// their own subprocess management; AV is fine with it (no registry
// writes, no cross-process injection, no service install).
#[cfg(target_os = "windows")]
mod win_job {
    use std::mem::{size_of, zeroed};
    use std::sync::OnceLock;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    // SAFETY wrapper: HANDLE is !Send by default in the windows crate, but
    // a Job Object handle is a kernel object referenced by an opaque value
    // that's safe to share across threads as long as we don't close it
    // until process exit. We guard the underlying handle behind OnceLock
    // so it's set exactly once and never freed (the OS reclaims on exit).
    struct JobHandle(HANDLE);
    unsafe impl Send for JobHandle {}
    unsafe impl Sync for JobHandle {}

    static JOB: OnceLock<JobHandle> = OnceLock::new();

    /// Lazily create a single shared Job Object configured to kill all
    /// assigned processes when the last handle (held by us in this
    /// process) closes. Returns Err on any Win32 failure; caller can
    /// log + continue (sidecar will simply not be auto-cleaned, same
    /// behaviour as before this fix).
    fn ensure_job() -> Result<HANDLE, String> {
        if let Some(h) = JOB.get() {
            return Ok(h.0);
        }
        unsafe {
            // lpjobattributes=None (default sec descriptor), lpname=PCWSTR::null()
            // (anonymous job — we don't share by name, just by handle).
            let h = CreateJobObjectW(None, PCWSTR::null())
                .map_err(|e| format!("CreateJobObjectW failed: {e}"))?;
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                h,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if let Err(e) = ok {
                let _ = CloseHandle(h);
                return Err(format!("SetInformationJobObject failed: {e}"));
            }
            // Store the handle. If another thread raced us, drop ours.
            match JOB.set(JobHandle(h)) {
                Ok(()) => Ok(h),
                Err(_) => {
                    let _ = CloseHandle(h);
                    Ok(JOB.get().unwrap().0)
                }
            }
        }
    }

    /// Attach a freshly-spawned child process (by PID) to the kill-on-
    /// close job. Idempotent + safe to call from any thread.
    pub fn attach_pid(pid: u32) -> Result<(), String> {
        let job = ensure_job()?;
        unsafe {
            // PROCESS_SET_QUOTA + PROCESS_TERMINATE are exactly what
            // AssignProcessToJobObject requires; nothing more.
            let proc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid)
                .map_err(|e| format!("OpenProcess({pid}) failed: {e}"))?;
            let res = AssignProcessToJobObject(job, proc);
            let _ = CloseHandle(proc);
            res.map_err(|e| format!("AssignProcessToJobObject({pid}) failed: {e}"))?;
        }
        Ok(())
    }
}

/// Cross-platform shim: on Windows wraps the child PID in a kill-on-
/// close Job Object; on macOS / Linux this is a no-op because POSIX
/// already supports proper signal-on-parent-death patterns and the
/// shell plugin's existing kill-in-Drop is sufficient there.
#[allow(unused_variables)]
fn attach_to_kill_on_close_job(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        match win_job::attach_pid(pid) {
            Ok(()) => {
                append_sidecar_log(&format!(
                    "[tauri] sidecar pid={} attached to kill-on-close Job Object",
                    pid
                ));
            }
            Err(e) => {
                // Log loudly but don't fail spawn — worst case we fall
                // back to the pre-fix behaviour (sidecar may outlive
                // parent), which is still functional for happy paths.
                append_sidecar_log(&format!(
                    "[tauri] WARN: failed to attach sidecar pid={} to Job Object: {}",
                    pid, e
                ));
            }
        }
    }
}

// ─── Win32 in-process Registry cleanup for legacy NM host residue ───
//
// Earlier client versions (<= v2.6.x) registered Native Messaging hosts
// by spawning `cmd.exe → reg.exe add ...` from Node. That subprocess
// chain is exactly the heuristic 360 / 火绒 / Defender flag as malware
// installer behaviour. v2.7+ stops registering NM hosts entirely (the
// chrome extension v1.3+ goes WS-first), but the registry entries our
// older builds wrote are still on user machines — and AV will keep
// scanning them on every boot.
//
// Solution: at next launch, clean those entries up ourselves *from
// inside the process via the Win32 API*. No cmd, no reg.exe, no shell
// — just a direct RegDeleteKeyExW call. Behavioural-detection-wise this
// is identical to the Tauri main exe writing its own settings file,
// because there's no child process spawn for AV to look at.
//
// Idempotent + safe-by-default: we read the (Default) value first and
// only delete if it points at a path that contains "noobclaw" — won't
// touch a user's hand-edited or third-party-installed key with the
// same name (extraordinarily unlikely but cheap to check).
#[cfg(target_os = "windows")]
mod win_nm_cleanup {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows::Win32::System::Registry::{
        RegCloseKey, RegDeleteKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY,
        HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_WOW64_64KEY,
    };

    // The three browsers' registration paths under HKCU. Built at runtime
    // because Rust 1.x can't const-construct PCWSTRs in a static slice
    // initialiser without a build script. Tiny cost (200B total), runs
    // once per app session.
    fn key_strs() -> Vec<Vec<u16>> {
        [
            "Software\\Google\\Chrome\\NativeMessagingHosts\\com.noobclaw.browser",
            "Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.noobclaw.browser",
            "Software\\Mozilla\\NativeMessagingHosts\\com.noobclaw.browser",
        ]
        .iter()
        .map(|s| {
            let mut v: Vec<u16> = s.encode_utf16().collect();
            v.push(0);
            v
        })
        .collect()
    }

    /// Read the `(Default)` value of `key_handle` as a UTF-16 string.
    /// Returns None if the value is missing, not a string, or read fails.
    unsafe fn read_default_value(key_handle: HKEY) -> Option<String> {
        let mut buf_bytes = [0u8; 2048];
        let mut data_size = buf_bytes.len() as u32;
        let mut value_type = windows::Win32::System::Registry::REG_VALUE_TYPE(0);
        // PCWSTR::null() asks for the unnamed (Default) value.
        let res = RegQueryValueExW(
            key_handle,
            PCWSTR::null(),
            None,
            Some(&mut value_type),
            Some(buf_bytes.as_mut_ptr()),
            Some(&mut data_size),
        );
        if res != ERROR_SUCCESS {
            return None;
        }
        // REG_SZ values are null-terminated UTF-16. Trim the NUL and decode.
        let len_u16 = (data_size as usize) / 2;
        if len_u16 == 0 {
            return None;
        }
        let bytes = &buf_bytes[..(len_u16 * 2)];
        let mut u16s: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        if u16s.last() == Some(&0) {
            u16s.pop();
        }
        String::from_utf16(&u16s).ok()
    }

    /// Try to delete one HKCU subkey. Returns:
    ///   - Ok(true)  : key existed, looked NoobClaw-owned, was deleted
    ///   - Ok(false) : key didn't exist OR didn't look like ours, skipped
    ///   - Err(...)  : Win32 returned an unexpected code
    fn delete_one(subkey_w: &[u16]) -> Result<bool, String> {
        unsafe {
            // Open with QUERY_VALUE so we can sanity-check the (Default)
            // value before deleting. KEY_WOW64_64KEY ensures we hit the
            // same view that NoobClaw originally wrote to.
            let mut h = HKEY::default();
            let open_res = RegOpenKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(subkey_w.as_ptr()),
                0,
                KEY_QUERY_VALUE | KEY_WOW64_64KEY,
                &mut h,
            );
            if open_res == ERROR_FILE_NOT_FOUND {
                return Ok(false); // not present, nothing to clean
            }
            if open_res != ERROR_SUCCESS {
                return Err(format!("RegOpenKeyExW failed: {:?}", open_res));
            }
            let default_val = read_default_value(h);
            let _ = RegCloseKey(h);

            // Belt-and-suspenders: only delete if the (Default) value
            // actually mentions "noobclaw". If a user (somehow) repurposed
            // this key for something else, leave it alone.
            let owned_by_noobclaw = match default_val {
                Some(ref s) => s.to_lowercase().contains("noobclaw"),
                None => true, // empty / unreadable defaults are fine to clean
            };
            if !owned_by_noobclaw {
                return Ok(false);
            }

            let del_res = RegDeleteKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(subkey_w.as_ptr()),
                // RegDeleteKeyExW takes a plain u32 here, not REG_SAM_FLAGS;
                // 0x100 = KEY_WOW64_64KEY which forces the 64-bit view that
                // the original `reg add` calls wrote to.
                KEY_WOW64_64KEY.0,
                0,
            );
            if del_res == ERROR_SUCCESS || del_res == ERROR_FILE_NOT_FOUND {
                return Ok(true);
            }
            Err(format!("RegDeleteKeyExW failed: {:?}", del_res))
        }
    }

    /// Best-effort cleanup of all three browsers' NM host keys.
    /// Returns the count of keys actually deleted.
    pub fn cleanup() -> u32 {
        let mut deleted: u32 = 0;
        for k in key_strs() {
            match delete_one(&k) {
                Ok(true) => deleted += 1,
                Ok(false) => {}
                Err(_e) => {} // swallow — cleanup is best-effort
            }
        }
        deleted
    }
}

/// Tauri command: clean up legacy Native Messaging host registry entries
/// left over from older client builds. Returns the number of keys
/// actually removed. No-op on macOS / Linux.
///
/// Called once from the Node side at app startup, gated by a once-flag in
/// settings so we don't re-scan on every launch.
#[tauri::command]
fn cleanup_legacy_nm_registration() -> u32 {
    #[cfg(target_os = "windows")]
    {
        let n = win_nm_cleanup::cleanup();
        append_sidecar_log(&format!(
            "[tauri] cleanup_legacy_nm_registration: removed {} legacy NM HKCU keys",
            n
        ));
        return n;
    }
    #[cfg(not(target_os = "windows"))]
    {
        return 0;
    }
}

// ─── macOS TCC bridge ────────────────────────────────────────────────
//
// The sidecar (noobclaw-server) is a separate Mach-O binary, so when it
// calls CGDisplayCreateImage or CGEventPost the TCC database attributes
// the request to `noobclaw-server` — NOT the main NoobClaw bundle — and
// the user finds NO "NoobClaw" row in System Settings → Privacy →
// Screen Recording / Accessibility. Solution: call the preflight
// functions from the MAIN Rust binary at startup so TCC registers the
// main bundle. Once the user toggles it on, everything inside the .app
// (including the sidecar) gains the permission too IF the sidecar is
// signed with the same team identifier, which it is in our CI.
//
// These are plain C functions linked from CoreGraphics /
// ApplicationServices — no objc2 crate needed.
#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

#[tauri::command]
fn check_screen_recording_permission() -> bool {
    #[cfg(target_os = "macos")]
    unsafe {
        return CGPreflightScreenCaptureAccess();
    }
    #[cfg(not(target_os = "macos"))]
    true
}

#[tauri::command]
fn request_screen_recording_permission() -> bool {
    #[cfg(target_os = "macos")]
    unsafe {
        return CGRequestScreenCaptureAccess();
    }
    #[cfg(not(target_os = "macos"))]
    true
}

#[tauri::command]
fn check_accessibility_permission() -> bool {
    #[cfg(target_os = "macos")]
    unsafe {
        return AXIsProcessTrusted();
    }
    #[cfg(not(target_os = "macos"))]
    true
}

#[tauri::command]
fn open_screen_recording_settings() {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            .spawn();
    }
}

#[tauri::command]
fn open_accessibility_settings() {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .spawn();
    }
}

#[tauri::command]
fn open_microphone_settings() {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
            .spawn();
    }
}

// ─── Dock badge (macOS) ──────────────────────────────────────────────
//
// Shows a small red indicator with optional text on the Dock icon —
// standard macOS pattern for "something is happening / pending count".
// Tauri v2.10.3 does not expose `set_badge_label` on WebviewWindow so
// we call NSApp.dockTile directly via the objc2 crate. Called from
// tauriShim whenever a cowork session starts/completes so the user
// sees a ● while an AI task is running even if the main window is
// hidden or the tray is overflowing.
//
// Windows/Linux: no-op. The renderer still calls the command on
// those platforms for simplicity; the target-cfg gate below makes
// the body compile to nothing.

#[tauri::command]
fn set_dock_badge(label: Option<String>) {
    #[cfg(target_os = "macos")]
    unsafe {
        use objc2::runtime::AnyObject;
        use objc2::{class, msg_send};
        use objc2_foundation::NSString;

        // NSApp.sharedApplication → NSApplication*
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        if app.is_null() {
            return;
        }

        // NSApplication.dockTile → NSDockTile*
        let dock_tile: *mut AnyObject = msg_send![app, dockTile];
        if dock_tile.is_null() {
            return;
        }

        // Set or clear the label.
        match label.as_deref() {
            Some(text) if !text.is_empty() => {
                let ns = NSString::from_str(text);
                let _: () = msg_send![dock_tile, setBadgeLabel: &*ns];
            }
            _ => {
                let nil: *mut AnyObject = std::ptr::null_mut();
                let _: () = msg_send![dock_tile, setBadgeLabel: nil];
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = label; // unused on non-mac
    }
}

/// Resolve the on-disk log path for sidecar stdout/stderr capture.
/// - macOS: ~/Library/Application Support/NoobClaw/logs/sidecar.log
/// - Linux: ~/.noobclaw/logs/sidecar.log
/// - Windows: %APPDATA%/NoobClaw/logs/sidecar.log
///
/// Created unconditionally so the user (or we, via the /api/diagnostic
/// endpoint) can tail it after a failed startup.
fn sidecar_log_path() -> Option<PathBuf> {
    let base = if cfg!(target_os = "macos") {
        dirs::home_dir()?.join("Library/Application Support/NoobClaw")
    } else if cfg!(target_os = "windows") {
        dirs::config_dir()?.join("NoobClaw")
    } else {
        dirs::home_dir()?.join(".noobclaw")
    };
    let logs = base.join("logs");
    let _ = fs::create_dir_all(&logs);
    Some(logs.join("sidecar.log"))
}

/// Ensure the default cowork workspace directory (`~/noobclaw/project`)
/// exists at app startup.
///
/// Tauri builds run the Node side as a sidecar whose entry is
/// `sidecar-server.ts`, **not** `main.ts`. The Electron-only path in
/// `main.ts` (mkdirSync at app.whenReady) therefore never executes for
/// Mac users running the Tauri .dmg, and `~/noobclaw/project` is left
/// uncreated. Every fresh-install Mac user then hits
/// `Working directory does not exist: ~/noobclaw/project` on the first
/// cowork chat, because the renderer skips its folder-required warning
/// in Tauri mode (CoworkPromptInput.tsx) under the assumption that the
/// sidecar will fall back to this default — but nobody actually
/// creates it.
///
/// Mirrors the Electron-side mkdir at `src/main/main.ts:3179`. Path
/// segments stay in lockstep with `coworkStore.ts:getDefaultWorkingDirectory`
/// (`path.join(os.homedir(), 'noobclaw', 'project')`). Idempotent —
/// `create_dir_all` is a no-op when the directory already exists. Silent
/// on failure (matches `sidecar_log_path` policy: never let filesystem
/// plumbing take down app startup).
fn ensure_default_workspace_dir() {
    let Some(home) = dirs::home_dir() else { return };
    let workspace = home.join("noobclaw").join("project");
    let _ = fs::create_dir_all(&workspace);
}

/// Append a line to the sidecar log. Silent on failure — we never want
/// log plumbing to take down the app. Rotates when the file exceeds
/// ~512 KB by renaming the current file to `sidecar.log.1` and starting
/// fresh; we only keep one generation since the log is for diagnostics,
/// not audit.
const SIDECAR_LOG_MAX_BYTES: u64 = 512 * 1024;

fn append_sidecar_log(line: &str) {
    let Some(path) = sidecar_log_path() else { return };
    // Rotate if needed — cheap stat call, ignored on error.
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > SIDECAR_LOG_MAX_BYTES {
            let rotated = path.with_extension("log.1");
            let _ = fs::remove_file(&rotated);
            let _ = fs::rename(&path, &rotated);
        }
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{}", line);
    }
}

/// State holding the sidecar child process so we can kill it on exit.
struct SidecarState {
    child: Mutex<Option<CommandChild>>,
    port: u16,
}

impl Drop for SidecarState {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                println!("Killing sidecar process on drop...");
                let _ = child.kill();
            }
        }
    }
}

/// Spawn the sidecar once and install the stdout/stderr pump. Used by
/// both the initial startup path AND the supervisor restart path below.
/// The caller is responsible for storing the returned CommandChild in
/// SidecarState so it can be killed on app shutdown.
fn spawn_sidecar_once(app: &tauri::AppHandle) -> Result<(u16, CommandChild), String> {
    use tauri_plugin_shell::ShellExt;

    let port: u16 = 18801;
    // Tauri's real PID. Pass it explicitly so the sidecar can monitor the
    // correct process — `process.ppid` on Windows is unreliable because the
    // shell plugin may spawn us through an intermediate helper that exits
    // immediately, causing the sidecar's parent-watchdog to false-positive
    // and shut itself down mid-cowork-session.
    let tauri_pid = std::process::id();

    append_sidecar_log(&format!(
        "\n========== sidecar start (tauri_pid={} port={}) ==========",
        tauri_pid, port
    ));

    let spawn_result = app
        .shell()
        .sidecar("noobclaw-server")
        .map_err(|e| {
            let msg = format!("Failed to create sidecar command: {}", e);
            append_sidecar_log(&format!("[tauri] {}", msg));
            msg
        })?
        .args(&[port.to_string(), format!("--tauri-pid={}", tauri_pid)])
        .spawn();
    let (mut rx, child) = spawn_result.map_err(|e| {
        let msg = format!("Failed to spawn sidecar: {}", e);
        append_sidecar_log(&format!("[tauri] {}", msg));
        msg
    })?;

    // Wrap the freshly-spawned sidecar in a Win32 Job Object so the
    // kernel kills it the instant the main process dies — even on
    // unclean exits (panic / taskkill /F / power loss). No-op on
    // macOS/Linux. See the win_job module above for rationale.
    attach_to_kill_on_close_job(child.pid());

    // Pump stdout/stderr in a background task and signal the supervisor
    // when the child terminates. We send the Terminated marker out via
    // an internal channel so the supervisor can decide whether to
    // restart without racing with a second spawn attempt.
    let app_for_pump = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let s = String::from_utf8_lossy(&line);
                    let trimmed = s.trim();
                    if !trimmed.is_empty() {
                        println!("[sidecar] {}", trimmed);
                        append_sidecar_log(&format!("[out] {}", trimmed));
                    }
                }
                CommandEvent::Stderr(line) => {
                    let s = String::from_utf8_lossy(&line);
                    let trimmed = s.trim();
                    if !trimmed.is_empty() {
                        eprintln!("[sidecar-err] {}", trimmed);
                        append_sidecar_log(&format!("[err] {}", trimmed));
                    }
                }
                CommandEvent::Terminated(status) => {
                    let msg = format!("[sidecar] Process terminated: {:?}", status);
                    eprintln!("{}", msg);
                    append_sidecar_log(&format!("[exit] {:?}", status));
                    // Tell the supervisor to consider a restart. We
                    // use a Tauri event rather than a channel so any
                    // listener (renderer, supervisor) can observe.
                    let _ = app_for_pump.emit(
                        "sidecar://terminated",
                        serde_json::json!({
                            "exitCode": format!("{:?}", status),
                        }),
                    );
                    break;
                }
                _ => {}
            }
        }
    });

    Ok((port, child))
}

/// Install the sidecar supervisor. Listens for "sidecar://terminated"
/// events and restarts the child with exponential backoff (500ms →
/// 30s ceiling). Three consecutive failed restarts within 10 seconds
/// trip a circuit breaker and the supervisor gives up — the assumption
/// is that something fundamental is broken (missing binary, corrupt
/// install) and restart-looping would just burn CPU without helping.
///
/// The supervisor emits "sidecar://restarting" and "sidecar://ready"
/// events so the renderer can show a "reconnecting…" banner.
///
/// Shutdown: on app exit, SidecarState::drop() kills the current child
/// and the pump task breaks out on its own. The supervisor listens
/// for "sidecar://shutdown" events fired from the WindowEvent::Destroyed
/// handler below so it doesn't try to restart during app quit.
fn install_sidecar_supervisor(app: tauri::AppHandle) {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    let shutting_down = Arc::new(AtomicBool::new(false));
    let shutting_down_clone = shutting_down.clone();
    let app_clone = app.clone();

    // Flip the flag when shutdown is announced so the supervisor stops
    // restarting. Wired from the main window Destroyed event.
    let _ = app.listen("sidecar://shutdown", move |_| {
        shutting_down_clone.store(true, Ordering::SeqCst);
    });

    tauri::async_runtime::spawn(async move {
        let mut recent_failures: Vec<std::time::Instant> = Vec::new();

        'outer: loop {
            // ── Wait for the next termination event ──
            // The initial spawn happens in setup(), so on first loop
            // iteration we just wait for that child to die. Subsequent
            // iterations wait for the next death.
            let (tx, rx) = tokio::sync::oneshot::channel::<()>();
            // Explicit type annotation — otherwise rustc can't infer
            // the Option's inner generic in the closure below (E0282),
            // because the only use-site is `slot.take()` which
            // returns Option<_>.
            let tx_cell: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>> =
                std::sync::Mutex::new(Some(tx));
            let handler = app_clone.listen("sidecar://terminated", move |_| {
                if let Ok(mut slot) = tx_cell.lock() {
                    if let Some(tx) = slot.take() {
                        let _ = tx.send(());
                    }
                }
            });
            let _ = rx.await;
            app_clone.unlisten(handler);

            if shutting_down.load(Ordering::SeqCst) {
                append_sidecar_log("[supervisor] shutdown flag set, not restarting");
                break;
            }

            // ── Retry loop: keep trying to spawn until success or
            //     circuit breaker trip. Unlike the termination wait,
            //     this is local to a single crash — if 3 spawns fail
            //     in 10s we give up entirely.
            let mut backoff_ms: u64 = 500;
            loop {
                // Circuit breaker check
                let now = std::time::Instant::now();
                recent_failures.retain(|t| now.duration_since(*t) < Duration::from_secs(10));
                if recent_failures.len() >= 3 {
                    append_sidecar_log("[supervisor] 3 failures in 10s, tripping circuit breaker");
                    let _ = app_clone.emit(
                        "sidecar://give-up",
                        serde_json::json!({ "reason": "3 restart failures within 10s" }),
                    );
                    break 'outer;
                }

                append_sidecar_log(&format!("[supervisor] restarting sidecar in {}ms", backoff_ms));
                let _ = app_clone.emit(
                    "sidecar://restarting",
                    serde_json::json!({ "delayMs": backoff_ms }),
                );
                tokio::time::sleep(Duration::from_millis(backoff_ms)).await;

                match spawn_sidecar_once(&app_clone) {
                    Ok((port, child)) => {
                        append_sidecar_log(&format!("[supervisor] sidecar restarted on port {}", port));
                        if let Some(state) = app_clone.try_state::<SidecarState>() {
                            if let Ok(mut guard) = state.child.lock() {
                                *guard = Some(child);
                            }
                        }
                        let _ = app_clone.emit("sidecar://ready", serde_json::json!({ "port": port }));
                        // Success — go back out to wait for the next
                        // termination signal.
                        break;
                    }
                    Err(e) => {
                        append_sidecar_log(&format!("[supervisor] spawn failed: {}", e));
                        recent_failures.push(now);
                        backoff_ms = (backoff_ms * 2).min(30_000);
                        // Loop again without waiting for a new
                        // termination event — the spawn failed so
                        // there is no child to die.
                        continue;
                    }
                }
            }
        }
    });
}

#[tauri::command]
fn get_server_port(state: tauri::State<'_, SidecarState>) -> u16 {
    state.port
}

/// Return the last ~200 lines of the sidecar log as a single string.
/// Invoked from the renderer's health-banner fallback so the user can
/// see *why* the sidecar failed to start without opening a terminal.
#[tauri::command]
fn get_sidecar_log_tail() -> String {
    let Some(path) = sidecar_log_path() else {
        return String::from("(sidecar log path unavailable)");
    };
    let Ok(contents) = fs::read_to_string(&path) else {
        return format!("(no sidecar log at {})", path.display());
    };
    let lines: Vec<&str> = contents.lines().collect();
    let start = lines.len().saturating_sub(200);
    lines[start..].join("\n")
}

// ─── Keychain token storage ──────────────────────────────────────────
//
// Historic behavior: the NoobClaw JWT auth token was persisted to the
// SQLite kv store as plaintext. That works but is not aligned with how
// native Mac apps store secrets, and it leaks the token to anyone who
// can read `~/Library/Application Support/NoobClaw/noobclaw.sqlite`.
// The keyring crate uses the macOS Security framework's Keychain
// Services under the hood, so tokens land in the login keychain where
// only this app bundle (codesigned with our identity) can read them.
//
// Semantics:
//   SERVICE = "com.noobclaw.desktop"       (matches bundle identifier)
//   ACCOUNT = "noobclaw-jwt"               (fixed, we only store one token)
//
// Called from the sidecar via the Tauri command bridge — see
// src/main/libs/claudeSettings.ts's keychain wrapper.

const KEYCHAIN_SERVICE: &str = "com.noobclaw.desktop";
const KEYCHAIN_ACCOUNT: &str = "noobclaw-jwt";

#[tauri::command]
fn keychain_set_token(token: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|e| format!("keyring Entry::new failed: {}", e))?;
    entry
        .set_password(&token)
        .map_err(|e| format!("keychain write failed: {}", e))
}

#[tauri::command]
fn keychain_get_token() -> Option<String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).ok()?;
    entry.get_password().ok()
}

#[tauri::command]
fn keychain_delete_token() -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|e| format!("keyring Entry::new failed: {}", e))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        // Absent-item is not an error for delete semantics.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keychain delete failed: {}", e)),
    }
}

// ─── NSPanel-style command bar (spotlight clone) ─────────────────────
//
// A second Tauri WebviewWindow (label "command-bar") is declared in
// tauri.conf.json with decorations:false, transparent:true,
// alwaysOnTop:true, skipTaskbar:true. On macOS that's *almost* enough to
// get a Spotlight-style floating panel — the remaining problem is that
// Tauri backs the window with a plain NSWindow, not NSPanel, so it
// steals key-window focus from whatever the user was typing in, and it
// does NOT float above full-screen apps. The fix is to flip three bits
// on the underlying NSWindow using objc2:
//
//   1. setLevel: NSStatusWindowLevel (floats above regular windows)
//   2. setCollectionBehavior: CanJoinAllSpaces | FullScreenAuxiliary
//      (shows on every Space including full-screen apps)
//   3. setHidesOnDeactivate: YES  (auto-hides when user clicks away)
//
// NSPanel subclass swap is possible but requires IMP-swizzling which
// objc2 doesn't expose ergonomically; setting the three properties above
// gives 95% of the user-visible behavior for 5% of the code.
//
// Windows/Linux: skipped — the alwaysOnTop + decorations:false window is
// already pretty close to spotlight behavior on those platforms.

#[tauri::command]
fn show_command_bar(app: AppHandle) {
    let Some(window) = app.get_webview_window("command-bar") else {
        return;
    };

    // Re-center on the active screen before showing. The user may have
    // moved between monitors since last invocation.
    if let Ok(Some(monitor)) = window.current_monitor() {
        let screen = monitor.size();
        let win_size = window.outer_size().unwrap_or(tauri::PhysicalSize {
            width: 680,
            height: 60,
        });
        let x = (screen.width as i32 - win_size.width as i32) / 2;
        // Place ~22% down from the top — Spotlight's position.
        let y = (screen.height as f64 * 0.22) as i32;
        let _ = window.set_position(tauri::PhysicalPosition { x, y });
    }

    let _ = window.show();
    let _ = window.set_focus();

    // Elevate to panel-like behavior on macOS.
    #[cfg(target_os = "macos")]
    elevate_command_bar_to_panel(&window);
}

#[tauri::command]
fn hide_command_bar(app: AppHandle) {
    if let Some(window) = app.get_webview_window("command-bar") {
        let _ = window.hide();
    }
}

#[tauri::command]
fn toggle_command_bar(app: AppHandle) {
    let Some(window) = app.get_webview_window("command-bar") else {
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    if visible {
        let _ = window.hide();
    } else {
        show_command_bar(app);
    }
}

#[cfg(target_os = "macos")]
fn elevate_command_bar_to_panel(window: &tauri::WebviewWindow) {
    use objc2::runtime::AnyObject;
    use objc2::msg_send;

    // NSStatusWindowLevel = 25, floats above regular app windows.
    const NS_STATUS_WINDOW_LEVEL: i64 = 25;
    // NSWindowCollectionBehaviorCanJoinAllSpaces = 1 << 0
    // NSWindowCollectionBehaviorFullScreenAuxiliary = 1 << 8
    const CAN_JOIN_ALL_SPACES: u64 = 1 << 0;
    const FULL_SCREEN_AUX: u64 = 1 << 8;

    let Ok(ns_window_ptr) = window.ns_window() else {
        return;
    };
    let ns_window = ns_window_ptr as *mut AnyObject;
    if ns_window.is_null() {
        return;
    }

    unsafe {
        let _: () = msg_send![ns_window, setLevel: NS_STATUS_WINDOW_LEVEL];
        let behavior: u64 = CAN_JOIN_ALL_SPACES | FULL_SCREEN_AUX;
        let _: () = msg_send![ns_window, setCollectionBehavior: behavior];
        // Auto-hide when user clicks away — Spotlight behavior.
        let _: () = msg_send![ns_window, setHidesOnDeactivate: true];
        // Make sure we sit above all app windows but do not steal
        // first-responder status from the app the user was in — the
        // webview's own input element will grab focus on mousedown.
        let _: () = msg_send![ns_window, orderFrontRegardless];
    }
}

// ─── Toggle main window visibility ───────────────────────────────────
// Shared helper used by the global-shortcut hotkey, the tray icon click,
// and the single-instance second-launch callback. Keeping one place for
// the show+focus sequence avoids subtle bugs where some paths focus but
// forget to unminimize etc.
fn toggle_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    let focused = window.is_focused().unwrap_or(false);
    if visible && focused {
        let _ = window.hide();
    } else {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn show_main_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Handle a single `noobclaw://` deep link delivered either via argv
/// (Windows/Linux single-instance second launch) or via the macOS
/// `application:openURL:` Apple Event (tauri-plugin-deep-link's
/// `on_open_url` callback). macOS does NOT put the URL in argv, so
/// without this code path the existing app instance would silently
/// drop the auth redirect and the user's click would appear to "open
/// a new application" (the OS launching a fresh process because nobody
/// claimed the URL). Keep this function sync + side-effect-free aside
/// from the window.eval + focus, so both callers can reuse it.
fn handle_deep_link(app: &AppHandle, raw: &str) {
    if !raw.starts_with("noobclaw://") {
        return;
    }
    let Ok(parsed) = url::Url::parse(raw) else { return };
    if parsed.host_str() != Some("auth") {
        return;
    }
    let mut token: Option<String> = None;
    let mut wallet: Option<String> = None;
    let mut email: Option<String> = None;
    let mut social_provider: Option<String> = None;
    for (k, v) in parsed.query_pairs() {
        match k.as_ref() {
            "token" => token = Some(v.to_string()),
            "wallet" => wallet = Some(v.to_string()),
            "email" => email = Some(v.to_string()),
            "socialProvider" => social_provider = Some(v.to_string()),
            _ => {}
        }
    }
    let (Some(t), Some(w)) = (token, wallet) else { return };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        // Escape single-quotes in every value before embedding in JS literal.
        let esc = |s: &str| s.replace('\\', "\\\\").replace('\'', "\\'");
        let js = format!(
            "window.dispatchEvent(new CustomEvent('noobclaw-auth', {{detail: {{token: '{}', wallet: '{}', email: '{}', socialProvider: '{}'}}}}));",
            esc(&t),
            esc(&w),
            esc(email.as_deref().unwrap_or("")),
            esc(social_provider.as_deref().unwrap_or(""))
        );
        let _ = window.eval(&js);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Default global hotkey to summon the window: ⌥⌘N on macOS, Ctrl+Alt+N
    // everywhere else. Deliberately NOT ⌘Space (Spotlight) or ⌘Tab (app
    // switcher). Chosen to be unlikely to collide with Finder, browsers,
    // or VS Code keybindings.
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};
    #[cfg(target_os = "macos")]
    let toggle_shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::ALT), Code::KeyN);
    #[cfg(not(target_os = "macos"))]
    let toggle_shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyN);

    // Spotlight-style command bar: ⌥⌘Space on macOS, Ctrl+Alt+Space on
    // Windows/Linux. Chosen so it does NOT clash with ⌘Space (Spotlight)
    // or Win+Space (Input language switcher). Toggles the command-bar
    // window's visibility via toggle_command_bar.
    #[cfg(target_os = "macos")]
    let command_bar_shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::ALT), Code::Space);
    #[cfg(not(target_os = "macos"))]
    let command_bar_shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space);

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if shortcut == &toggle_shortcut {
                        toggle_main_window(app);
                    } else if shortcut == &command_bar_shortcut {
                        // Toggle the floating command bar. Same semantics
                        // as clicking the tray menu: show if hidden, hide
                        // if visible.
                        let cloned = app.clone();
                        toggle_command_bar(cloned);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Windows/Linux: second-instance launch delivers the deep link
            // via argv. macOS uses the on_open_url path below — never argv.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            for arg in args.iter() {
                handle_deep_link(app, arg);
            }
        }))
        .setup(move |app| {
            let handle = app.handle().clone();

            // ── Ensure default cowork workspace dir exists ──
            // Tauri sidecar entry (sidecar-server.ts) does NOT mkdir
            // ~/noobclaw/project the way the Electron main.ts path does,
            // so without this every fresh-install Mac user hits
            // "Working directory does not exist: ~/noobclaw/project" on
            // their first cowork chat. Idempotent + silent on failure.
            ensure_default_workspace_dir();

            // ── Windows: clean up legacy NM host registry residue ──
            // Older client builds (<= v2.6.x) registered Native Messaging
            // hosts via `cmd.exe → reg.exe add`, and that subprocess chain
            // is what AV (360 / 火绒 / Defender) flagged as malware-installer
            // behaviour. v2.7+ uses WS-only and these keys are dead weight
            // that AV would still scan on every boot. Wipe them here, in-
            // process, via the Win32 Registry API (no spawned subprocess,
            // not a heuristic match for any AV signature). Idempotent —
            // running on a clean machine just returns 0 deleted.
            #[cfg(target_os = "windows")]
            {
                let _ = cleanup_legacy_nm_registration();
            }

            // Register the deep-link listener. Without this, clicking
            // `noobclaw://auth?...` from the system browser never reaches
            // the running app — macOS would silently drop the URL (or, in
            // some launch paths, appear to spawn a duplicate process).
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let dl_handle = handle.clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        handle_deep_link(&dl_handle, url.as_str());
                    }
                });

                // ── Windows/Linux: write the OS protocol-handler entry on
                // every launch. The NSIS installer does NOT do this for us
                // (Tauri v2 deep-link plugin does NOT hook the installer);
                // without an explicit register() call here, HKCU\Software\
                // Classes\noobclaw\shell\open\command stays empty and
                // browsers report "找不到应用程序" / "could not find app".
                // macOS uses Info.plist CFBundleURLTypes (set via tauri.conf
                // bundle config), so we skip the runtime call there.
                #[cfg(any(target_os = "windows", target_os = "linux"))]
                if let Err(e) = app.deep_link().register_all() {
                    eprintln!("Failed to register deep-link protocol: {}", e);
                }
            }

            // ── Global shortcut registration ─────────────────────────
            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                if let Err(e) = app.global_shortcut().register(toggle_shortcut) {
                    eprintln!("Failed to register toggle shortcut: {}", e);
                }
                if let Err(e) = app.global_shortcut().register(command_bar_shortcut) {
                    eprintln!("Failed to register command-bar shortcut: {}", e);
                }
            }

            // ── Command bar NSPanel elevation on startup ─────────────
            // The command-bar window is declared `visible:false` in
            // tauri.conf.json, but we still need to elevate it to panel
            // level so the first show is instant. Doing it here avoids
            // a visible window frame flash on the first ⌥⌘Space press.
            #[cfg(target_os = "macos")]
            {
                if let Some(cb) = app.get_webview_window("command-bar") {
                    elevate_command_bar_to_panel(&cb);
                    // Hide esc-hide behavior: close on ESC or focus loss.
                    // The renderer handles ESC; here we just ensure the
                    // window is actually hidden after the panel upgrade
                    // (setHidesOnDeactivate sometimes flashes it on startup).
                    let _ = cb.hide();
                }
            }

            // ── Dock menu (macOS) ─────────────────────────────────────
            // Tauri v2.10 does not expose `set_dock_menu` on either App or
            // AppHandle — it's still in the private API pending their menu
            // rewrite. We could call -[NSApp setDockMenu:] directly via
            // objc2 (same pattern as set_dock_badge) but building an
            // NSMenu tree from scratch in objc2 is ~150 lines of obj-c
            // glue for a minor feature. Leaving the OS default dock menu
            // for now — right-click still gives Show / Hide / Quit which
            // covers the common cases. Tracked to revisit when Tauri
            // promotes their Menu API out of the private-api gate.

            // ── Drag & drop wiring (main window) ──────────────────────
            // Tauri v2 webviews have drag&drop enabled by default. The
            // Rust side sees DragDrop events on the main window; we
            // forward full file paths to the renderer as a custom
            // `nc://file-drop` JS event (the renderer listens for it
            // in tauriShim.ts and injects the files into the chat
            // composer). HTML5 drag&drop inside the webview only
            // exposes File blobs without real paths, so this native
            // path is strictly better for our "drag a PDF into chat"
            // use case.
            if let Some(window) = app.get_webview_window("main") {
                let win_clone = window.clone();
                let shutdown_handle = handle.clone();
                window.on_window_event(move |event| {
                    // Drag-drop: forward native paths to the renderer
                    // as a custom JS event.
                    if let tauri::WindowEvent::DragDrop(drag) = event {
                        if let tauri::DragDropEvent::Drop { paths, .. } = drag {
                            let json_paths: Vec<String> = paths
                                .iter()
                                .filter_map(|p| p.to_str().map(|s| s.to_string()))
                                .collect();
                            let arr = serde_json::to_string(&json_paths)
                                .unwrap_or_else(|_| "[]".into());
                            let js = format!(
                                "window.dispatchEvent(new CustomEvent('nc://file-drop', {{detail: {{paths: {}}}}}));",
                                arr
                            );
                            let _ = win_clone.eval(&js);
                        }
                    }
                    // Window destroyed: tell the sidecar supervisor
                    // to stop restarting (otherwise it would race with
                    // SidecarState::drop() during app quit).
                    if matches!(event, tauri::WindowEvent::Destroyed) {
                        let _ = shutdown_handle.emit("sidecar://shutdown", ());
                    }
                    // User clicked close (X) — force full app exit across
                    // all platforms. Without this, macOS keeps the process
                    // alive in the dock after closing the last window, and
                    // the sidecar may linger on Windows if Destroyed races
                    // with the Tokio runtime shutdown.
                    if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                        let _ = shutdown_handle.emit("sidecar://shutdown", ());
                        // Explicitly kill the sidecar child BEFORE app.exit().
                        // Don't rely only on SidecarState::drop() — on Windows
                        // the Tokio runtime may tear down before the managed-
                        // state Drop runs, leaving the Node.js sidecar alive
                        // in the task manager. Synchronously call child.kill()
                        // here so the sidecar dies deterministically on close.
                        if let Some(state) = shutdown_handle.try_state::<SidecarState>() {
                            if let Ok(mut guard) = state.child.lock() {
                                if let Some(mut child) = guard.take() {
                                    println!("Killing sidecar explicitly on window close...");
                                    let _ = child.kill();
                                }
                            }
                        }
                        // Then exit the whole app after a brief tick so any
                        // pending shutdown listeners can react.
                        let exit_handle = shutdown_handle.clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                            exit_handle.exit(0);
                        });
                    }
                });
            }

            // Tray icon disabled — close = quit, no hiding to tray.
            // (Was: menubar tray with Show/Quit menu items)

            // ── macOS TCC — LAZY, not at startup ─────────────────────
            // Previously we called CGRequestScreenCaptureAccess() +
            // AXIsProcessTrusted() here, which triggered two system
            // permission dialogs the instant a new user opened the app.
            // Most users don't need either permission on day one (the
            // XHS scenario flow goes through the browser extension, not
            // mac APIs), so they experience the popups as aggressive /
            // suspicious-looking and often just click Deny.
            //
            // New policy: don't ask for any mac permission up front.
            // Features that actually need Screen Recording or
            // Accessibility call the exposed tauri commands
            // (`request_screen_recording_permission`,
            // `check_accessibility_permission`) lazily, right before
            // they try to invoke the capability. The OS shows its
            // consent dialog at that point, in context, so users
            // understand why the app is asking.
            //
            // Side effect: until the user triggers such a feature,
            // NoobClaw will NOT appear in System Settings → Privacy →
            // Screen Recording / Accessibility. Users who want to
            // pre-grant have to trigger the feature once. Acceptable
            // trade-off — onboarding friction is more expensive than
            // a power-user edge case.

            // Start the Node.js sidecar and install the crash-restart
            // supervisor. The supervisor listens for sidecar://terminated
            // events (fired by spawn_sidecar_once's stdout pump when the
            // child dies) and re-spawns with exponential backoff.
            match spawn_sidecar_once(&handle) {
                Ok((port, child)) => {
                    app.manage(SidecarState {
                        child: Mutex::new(Some(child)),
                        port,
                    });
                    println!("NoobClaw Tauri started, sidecar on port {}", port);
                }
                Err(e) => {
                    eprintln!("Sidecar start failed: {}", e);
                    app.manage(SidecarState {
                        child: Mutex::new(None),
                        port: 18801,
                    });
                }
            }
            // Supervisor runs regardless of whether the initial spawn
            // succeeded — on failed initial spawn, the first "terminated"
            // never fires and the supervisor sits idle, but that's
            // harmless. (If we wanted to auto-retry the initial spawn
            // we'd emit a synthetic event here.)
            install_sidecar_supervisor(handle.clone());
            // Note: the sidecar://shutdown event is emitted from the
            // main window's WindowEvent::Destroyed handler above,
            // folded into the same on_window_event closure that
            // handles native drag-drop so we only register one
            // listener on the window.

            // DevTools: only in debug builds (release builds use F12/Ctrl+Shift+I)
            #[cfg(debug_assertions)]
            if let Some(window) = app.get_webview_window("main") {
                window.open_devtools();
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_server_port,
            get_sidecar_log_tail,
            keychain_set_token,
            keychain_get_token,
            keychain_delete_token,
            show_main_window,
            check_screen_recording_permission,
            request_screen_recording_permission,
            check_accessibility_permission,
            open_screen_recording_settings,
            open_accessibility_settings,
            open_microphone_settings,
            set_dock_badge,
            show_command_bar,
            hide_command_bar,
            toggle_command_bar,
            cleanup_legacy_nm_registration,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Windows Enterprise takes priority over a consumer instance at the shared
//! control port. This runs before Tauri or the embedded database is opened.

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use sysinfo::{Pid, PidExt, ProcessExt, System, SystemExt};

pub(crate) const LOG_NAME: &str = "enterprise-takeover.log";
const MAX_LOG_BYTES: u64 = 32 * 1024;
const CREATE_NO_WINDOW: u32 = 0x08000000;
static LOG_WRITER: Mutex<()> = Mutex::new(());

pub(crate) fn is_takeover_log(name: &str) -> bool {
    name == LOG_NAME
        || name
            .strip_prefix("enterprise-takeover.")
            .and_then(|suffix| suffix.strip_suffix(".log"))
            .is_some_and(|rotation| {
                !rotation.is_empty()
                    && rotation
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            })
}

#[derive(Clone, Debug)]
struct Owner {
    pid: u32,
    start_time: u64,
    exe: PathBuf,
}

pub(crate) async fn take_over_screenpipe_owner(port: u16) -> Result<(), String> {
    let owner = resolve_verified_owner(port).await.map_err(|cause| {
        record("verification_failed", &cause, "enterprise_start_aborted");
        cause
    })?;

    record(
        "verified_competing_screenpipe",
        &format!("pid={} port={port}", owner.pid),
        "termination_started",
    );

    if let Err(cause) = run_taskkill(owner.pid, false).await {
        record(
            "graceful_termination_failed",
            &format!("pid={} Windows cause: {cause}", owner.pid),
            "force_fallback_required",
        );
    }

    if wait_for_owner_exit(&owner, port, Duration::from_secs(8)).await {
        record(
            "takeover_complete",
            &format!("pid={} port={port} graceful=true", owner.pid),
            "enterprise_start_allowed",
        );
        return Ok(());
    }

    verify_same_process(&owner).map_err(|cause| {
        let detail = format!("pid={} identity changed before force: {cause}", owner.pid);
        record("termination_failed", &detail, "enterprise_start_aborted");
        detail
    })?;
    run_taskkill(owner.pid, true).await.map_err(|cause| {
        let detail = format!("pid={} forced termination failed: {cause}", owner.pid);
        record("termination_failed", &detail, "enterprise_start_aborted");
        detail
    })?;

    if !wait_for_owner_exit(&owner, port, Duration::from_secs(8)).await {
        let detail = format!("pid={} port={port} remained alive or retained control ownership after timeout", owner.pid);
        record("termination_timeout", &detail, "enterprise_start_aborted");
        return Err(detail);
    }

    record(
        "takeover_complete",
        &format!("pid={} port={port} graceful=false", owner.pid),
        "enterprise_start_allowed",
    );
    Ok(())
}

async fn resolve_verified_owner(port: u16) -> Result<Owner, String> {
    let pid = listening_pid(port).await?;
    if pid == std::process::id() {
        return Err("control owner resolved to the launching Enterprise process".into());
    }

    let mut system = System::new();
    let sys_pid = Pid::from_u32(pid);
    system.refresh_process(sys_pid);
    let process = system
        .process(sys_pid)
        .ok_or_else(|| format!("control owner pid={pid} exited before verification"))?;
    let exe = process.exe().to_path_buf();
    if !looks_like_screenpipe_exe(&exe) {
        return Err(format!(
            "refused to terminate pid={pid}: verified control responder executable was not Screenpipe ({})",
            exe.display()
        ));
    }
    let current_exe = std::env::current_exe()
        .map_err(|error| format!("could not resolve Enterprise executable: {error}"))?;
    if same_path(&exe, &current_exe) {
        return Err(format!(
            "refused Enterprise self-takeover for pid={pid} executable={}",
            exe.display()
        ));
    }
    verify_current_session(pid)?;

    Ok(Owner {
        pid,
        start_time: process.start_time(),
        exe,
    })
}

fn verify_same_process(owner: &Owner) -> Result<(), String> {
    let mut system = System::new();
    let pid = Pid::from_u32(owner.pid);
    system.refresh_process(pid);
    let process = system
        .process(pid)
        .ok_or_else(|| "process exited while its control port remained occupied".to_string())?;
    if process.start_time() != owner.start_time || !same_path(process.exe(), &owner.exe) {
        return Err("process id was reused by a different executable".into());
    }
    verify_current_session(owner.pid)
}

fn looks_like_screenpipe_exe(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            let name = name.to_ascii_lowercase();
            name == "screenpipe.exe" || name == "screenpipe-app.exe"
        })
}

fn same_path(left: &Path, right: &Path) -> bool {
    let left = std::fs::canonicalize(left).unwrap_or_else(|_| left.to_path_buf());
    let right = std::fs::canonicalize(right).unwrap_or_else(|_| right.to_path_buf());
    left.to_string_lossy().eq_ignore_ascii_case(&right.to_string_lossy())
}

fn verify_current_session(pid: u32) -> Result<(), String> {
    use windows::Win32::System::{
        RemoteDesktop::ProcessIdToSessionId,
        Threading::GetCurrentProcessId,
    };
    let mut owner_session = 0;
    let mut current_session = 0;
    unsafe {
        ProcessIdToSessionId(pid, &mut owner_session)
            .map_err(|error| format!("could not inspect owner session: {error}"))?;
        ProcessIdToSessionId(GetCurrentProcessId(), &mut current_session)
            .map_err(|error| format!("could not inspect Enterprise session: {error}"))?;
    }
    if owner_session != current_session {
        return Err(format!(
            "refused to terminate pid={pid} in session {owner_session}; Enterprise is in session {current_session}"
        ));
    }
    Ok(())
}

async fn listening_pid(port: u16) -> Result<u32, String> {
    use std::os::windows::process::CommandExt;
    let mut command = tokio::process::Command::new("netstat.exe");
    command.args(["-ano", "-p", "tcp"]);
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command
        .output()
        .await
        .map_err(|error| format!("netstat failed: {error}"))?;
    if !output.status.success() {
        return Err(format!("netstat exited with {}", output.status));
    }
    let mut owners = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| listening_pid_from_line(line, port))
        .collect::<std::collections::HashSet<_>>();
    if owners.len() != 1 {
        return Err(format!(
            "expected one listener for control port {port}, found {}",
            owners.len()
        ));
    }
    let owner = owners.drain().next().expect("one owner checked");
    Ok(owner)
}

fn listening_pid_from_line(line: &str, port: u16) -> Option<u32> {
    let fields: Vec<_> = line.split_whitespace().collect();
    if fields.len() < 5 || !fields[0].eq_ignore_ascii_case("TCP") {
        return None;
    }
    let local_port = fields[1].rsplit(':').next()?.parse::<u16>().ok()?;
    let remote_port = fields[2].rsplit(':').next()?.parse::<u16>().ok()?;
    (local_port == port && remote_port == 0).then(|| fields[4].parse().ok())?
}

async fn run_taskkill(pid: u32, force: bool) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let mut command = tokio::process::Command::new("taskkill.exe");
    if force {
        command.arg("/F");
    }
    command.args(["/PID", &pid.to_string()]);
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command
        .output()
        .await
        .map_err(|error| format!("taskkill could not start: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "taskkill exited {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

async fn wait_for_owner_exit(owner: &Owner, port: u16, timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        let process_gone = verify_same_process(owner).is_err();
        let port_free = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
            .await
            .is_ok();
        if process_gone && port_free {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    false
}

fn record(event: &str, cause: &str, outcome: &str) {
    let _guard = LOG_WRITER.lock().unwrap_or_else(|error| error.into_inner());
    if let Err(error) = append_record(event, cause, outcome) {
        eprintln!("screenpipe: could not persist Enterprise takeover diagnostic: {error}");
    }
}

fn append_record(event: &str, cause: &str, outcome: &str) -> std::io::Result<()> {
    let root = screenpipe_core::paths::default_screenpipe_data_dir();
    append_record_to(&root, event, cause, outcome)
}

fn append_record_to(root: &Path, event: &str, cause: &str, outcome: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(&root)?;
    let path = root.join(LOG_NAME);
    if std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(std::io::Error::other("takeover diagnostic path is a symlink"));
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(path)?;
    if file.metadata()?.len() > MAX_LOG_BYTES {
        file.seek(SeekFrom::End(-(MAX_LOG_BYTES as i64 / 2)))?;
        let mut tail = Vec::new();
        file.read_to_end(&mut tail)?;
        let start = tail.iter().position(|byte| *byte == b'\n').map_or(tail.len(), |i| i + 1);
        file.set_len(0)?;
        file.rewind()?;
        file.write_all(&tail[start..])?;
    }
    file.seek(SeekFrom::End(0))?;
    writeln!(
        file,
        "{} event={} cause={} outcome={}",
        chrono::Utc::now().to_rfc3339(),
        event,
        cause.replace(['\r', '\n'], " ").chars().take(2048).collect::<String>(),
        outcome
    )?;
    file.sync_data()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_exact_screenpipe_executables_are_eligible() {
        assert!(looks_like_screenpipe_exe(Path::new(r"C:\Program Files\screenpipe\screenpipe-app.exe")));
        assert!(looks_like_screenpipe_exe(Path::new(r"C:\Program Files\screenpipe\SCREENPIPE.EXE")));
        assert!(!looks_like_screenpipe_exe(Path::new(r"C:\Temp\screenpipe-helper.exe")));
        assert!(!looks_like_screenpipe_exe(Path::new(r"C:\Temp\not-screenpipe.exe")));
    }

    #[test]
    fn listener_parser_is_exact_and_locale_independent() {
        assert_eq!(listening_pid_from_line("TCP 127.0.0.1:11435 0.0.0.0:0 LISTENING 42", 11435), Some(42));
        assert_eq!(listening_pid_from_line("TCP [::1]:11435 [::]:0 NASLUCHIWANIE 43", 11435), Some(43));
        assert_eq!(listening_pid_from_line("TCP 127.0.0.1:114350 0.0.0.0:0 LISTENING 42", 11435), None);
        assert_eq!(listening_pid_from_line("TCP 127.0.0.1:50100 127.0.0.1:11435 ESTABLISHED 42", 11435), None);
    }

    #[tokio::test]
    async fn failure_survives_restart_rotation_and_real_support_redaction() {
        let root = tempfile::tempdir().unwrap();
        append_record_to(
            root.path(),
            "termination_failed",
            "pid=42 Windows cause: Access is denied. (os error 5) contact=private@example.com",
            "enterprise_start_aborted",
        )
        .unwrap();
        std::fs::rename(
            root.path().join(LOG_NAME),
            root.path().join("enterprise-takeover.previous.log"),
        )
        .unwrap();
        append_record_to(
            root.path(),
            "startup_after_restart",
            "previous takeover failure retained",
            "support_collection_available",
        )
        .unwrap();

        let report = crate::diagnostic_logs::collect_redacted_from_dirs(&[
            root.path().to_path_buf(),
        ])
        .await
        .unwrap();
        assert!(report.contains("termination_failed"));
        assert!(report.contains("Access is denied"));
        assert!(report.contains("os error 5"));
        assert!(report.contains("enterprise_start_aborted"));
        assert!(report.contains("startup_after_restart"));
        assert!(!report.contains("private@example.com"));
    }
}

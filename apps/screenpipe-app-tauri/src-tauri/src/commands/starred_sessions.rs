// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use crate::window::GatedWindowPlacement;
use tauri::{Emitter, Manager};

const LABEL: &str = "starred-sessions";
const WIDTH: f64 = 360.0;
const HEIGHT: f64 = 420.0;

/// Place below the trigger, or above it at the bottom edge, in one coordinate space.
fn attached_origin(anchor: (f64, f64, f64, f64), screen: (f64, f64, f64, f64)) -> (f64, f64) {
    let (x, y, w, h) = anchor;
    let (sx, sy, sw, sh) = screen;
    let left = (x + w / 2.0 - WIDTH / 2.0).clamp(sx, (sx + sw - WIDTH).max(sx));
    let below = y + h + 6.0;
    let top = if below + HEIGHT <= sy + sh {
        below
    } else {
        y - HEIGHT - 6.0
    };
    (left, top.clamp(sy, (sy + sh - HEIGHT).max(sy)))
}

#[cfg(target_os = "macos")]
fn position(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> Result<(), String> {
    use objc::{msg_send, sel, sel_impl};
    use tauri_nspanel::cocoa::{
        appkit::{NSEvent, NSScreen},
        base::{id, nil},
        foundation::{NSArray, NSPoint, NSRect},
    };
    // Keep AppKit points throughout, including displays above/left of the primary.
    unsafe {
        let anchor = crate::native_shortcut_reminder::get_frame();
        let mouse = NSEvent::mouseLocation(nil);
        let point = anchor
            .map(|(x, y, w, h)| NSPoint::new(x + w / 2.0, y + h / 2.0))
            .unwrap_or(mouse);
        let screens = NSScreen::screens(nil);
        for i in 0..NSArray::count(screens) {
            let screen: id = NSArray::objectAtIndex(screens, i);
            let frame = NSScreen::frame(screen);
            if point.x < frame.origin.x
                || point.x >= frame.origin.x + frame.size.width
                || point.y < frame.origin.y
                || point.y >= frame.origin.y + frame.size.height
            {
                continue;
            }
            let visible = NSScreen::visibleFrame(screen);
            // Flip y for the shared top-down placement calculation, then back.
            let (x, y, w, h) = anchor.unwrap_or((
                visible.origin.x + visible.size.width / 2.0 - 11.0,
                visible.origin.y + visible.size.height - 28.0,
                22.0,
                16.0,
            ));
            let (left, top) = attached_origin(
                (x, -y - h, w, h),
                (
                    visible.origin.x,
                    -visible.origin.y - visible.size.height,
                    visible.size.width,
                    visible.size.height,
                ),
            );
            let native = window.ns_window().map_err(|e| e.to_string())? as id;
            let _: () = msg_send![native, setFrameOrigin: NSPoint::new(left,-top-HEIGHT)];
            return Ok(());
        }
    }
    let _ = app;
    Err("No display available for session controls".into())
}

/// Native Windows rectangles and Tauri monitor origins are physical pixels.
/// Convert the whole coordinate space together so negative origins and mixed
/// display scales do not move the picker onto the primary display.
#[cfg(any(not(target_os = "macos"), test))]
fn physical_origin(
    anchor: (f64, f64, f64, f64),
    work_area: (f64, f64, f64, f64),
    scale: f64,
) -> (i32, i32) {
    let logical = |(x, y, w, h)| (x / scale, y / scale, w / scale, h / scale);
    let (x, y) = attached_origin(logical(anchor), logical(work_area));
    ((x * scale).round() as i32, (y * scale).round() as i32)
}

#[cfg(not(target_os = "macos"))]
fn position(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> Result<(), String> {
    let overlay = app
        .get_webview_window("shortcut-reminder")
        .filter(|w| w.is_visible().unwrap_or(false));
    let web_anchor = overlay
        .as_ref()
        .and_then(|w| Some((w.outer_position().ok()?, w.outer_size().ok()?)))
        .map(|(p, s)| (p.x as f64, p.y as f64, s.width as f64, s.height as f64));
    #[cfg(target_os = "windows")]
    let anchor = crate::native_shortcut_reminder::is_reminder_visible()
        .then(crate::native_shortcut_reminder::get_frame)
        .flatten()
        .or(web_anchor);
    #[cfg(not(target_os = "windows"))]
    let anchor = web_anchor;

    let monitor = anchor
        .and_then(|(x, y, w, h)| {
            app.monitor_from_point(x + w / 2.0, y + h / 2.0)
                .ok()
                .flatten()
        })
        .or_else(|| {
            app.cursor_position()
                .ok()
                .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        })
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or("No display available")?;
    let scale = monitor.scale_factor();
    let work = monitor.work_area();
    let screen = (
        work.position.x as f64,
        work.position.y as f64,
        work.size.width as f64,
        work.size.height as f64,
    );
    let anchor = anchor.unwrap_or((screen.0 + screen.2 / 2.0, screen.1, 0.0, 12.0 * scale));
    let (x, y) = physical_origin(anchor, screen, scale);
    window
        .set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    // Moving to another display can change DPI. Resolve logical dimensions
    // only after moving, including when reusing a window on a different display.
    window
        .set_size(tauri::LogicalSize::new(WIDTH, HEIGHT))
        .map_err(|e| e.to_string())
}

pub(crate) fn hide(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        #[cfg(target_os = "macos")]
        {
            use tauri_nspanel::ManagerExt;
            if let Ok(panel) = app.get_webview_panel(LABEL) {
                panel.order_out(None);
            }
        }
        window.hide().map_err(|e| e.to_string())?;
        let _ = window.emit("starred-sessions-visibility", false);
    }
    Ok(())
}

// Serialize shortcut/button presses through the persisted engine state. Window
// visibility is independent: dismissing controls must never end a session.
static TOGGLE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn toggle_body(
    rows: &[serde_json::Value],
    now: chrono::DateTime<chrono::Utc>,
) -> serde_json::Value {
    let active = rows.iter().find(|row| {
        let start = row["start"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok());
        let end = row["end"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok());
        matches!((start, end), (Some(start), Some(end)) if start <= now && end > now)
    });
    if let Some(active) = active {
        let mut row = active.clone();
        let start = chrono::DateTime::parse_from_rfc3339(row["start"].as_str().unwrap()).unwrap();
        row["end"] = serde_json::json!(
            now.max(start.with_timezone(&chrono::Utc) + chrono::Duration::milliseconds(1))
        );
        row
    } else {
        serde_json::json!({
            "id": uuid::Uuid::new_v4().to_string(), "start": now,
            "end": now + chrono::Duration::minutes(60), "hd_requested": false, "revision": 0
        })
    }
}

fn toggle_saved_session(app: &tauri::AppHandle) -> Result<(), String> {
    let _guard = TOGGLE_LOCK.lock().map_err(|e| e.to_string())?;
    let api = crate::recording::local_api_context_from_app(app);
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let now = chrono::Utc::now();
    let result: serde_json::Value = api
        .apply_auth_blocking(client.get(api.url("/starred-sessions")).query(&[
            ("start_time", now.to_rfc3339()),
            (
                "end_time",
                (now + chrono::Duration::milliseconds(1)).to_rfc3339(),
            ),
        ]))
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;
    let rows = result["data"]
        .as_array()
        .ok_or("Could not read starred sessions")?;
    let body = toggle_body(rows, now);
    api.apply_auth_blocking(client.post(api.url("/starred-sessions")).json(&body))
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let until = body["end"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|date| date.timestamp_millis())
        .unwrap_or(0);
    crate::native_shortcut_reminder::set_starred_until(until);
    let _ = app.emit("starred-sessions-changed", ());
    Ok(())
}

/// Both the global shortcut and overlay button start/stop the saved session.
/// HTTP stays off the UI thread, and every press reads the latest persisted state.
pub(crate) fn toggle(app: &tauri::AppHandle) -> Result<(), String> {
    let app = app.clone();
    std::thread::Builder::new()
        .name("starred-session-toggle".into())
        .spawn(move || {
            if let Err(error) = toggle_saved_session(&app) {
                tracing::warn!("could not toggle starred session: {error}");
                crate::notifications::client::send(
                    "Could not update starred session",
                    "Try again. Your saved sessions have not been removed.",
                );
                return;
            }
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Err(error) = show(&handle) {
                    tracing::warn!("could not show starred session controls: {error}");
                }
            });
        })
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn show(app: &tauri::AppHandle) -> Result<(), String> {
    let window = match app.get_webview_window(LABEL) {
        Some(window) => window,
        None => {
            let window = tauri::WebviewWindowBuilder::new(
                app,
                LABEL,
                tauri::WebviewUrl::App("starred-sessions".into()),
            )
            .title("Starred work sessions")
            .inner_size(WIDTH, HEIGHT)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .resizable(false)
            .skip_taskbar(true)
            .always_on_top_gated(true)
            .visible_on_all_workspaces_gated(true)
            .focused_gated(false)
            .visible(false)
            .build()
            .map(crate::window::finalize_webview_window)
            .map_err(|e| e.to_string())?;
            let handle = app.clone();
            window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Focused(false)) {
                    let _ = hide(&handle);
                }
            });
            window
        }
    };
    // Wayland compositors may refuse absolute placement. The controls must
    // still open; the compositor chooses their position in that case.
    #[cfg(target_os = "linux")]
    if let Err(error) = position(app, &window) {
        tracing::warn!("starred session placement unavailable: {error}");
    }
    #[cfg(not(target_os = "linux"))]
    position(app, &window)?;
    #[cfg(target_os = "macos")]
    {
        use crate::window::GatedPanelPlacement;
        use objc::{msg_send, sel, sel_impl};
        use tauri_nspanel::{
            cocoa::appkit::NSWindowCollectionBehavior as Behavior, ManagerExt, WebviewWindowExt,
        };
        let panel = match app.get_webview_panel(LABEL) {
            Ok(panel) => panel,
            Err(_) => window.to_panel().map_err(|e| e.to_string())?,
        };
        panel.set_style_mask(128); // NSNonactivatingPanelMask: no app/Space activation.
        panel.set_level_gated(1002);
        panel.set_hides_on_deactivate(false);
        panel.set_collection_behaviour_gated(
            Behavior::NSWindowCollectionBehaviorCanJoinAllSpaces
                | Behavior::NSWindowCollectionBehaviorFullScreenAuxiliary
                | Behavior::NSWindowCollectionBehaviorIgnoresCycle,
        );
        let sharing: u64 = if crate::window::native_overlay_is_capturable(app) {
            1
        } else {
            0
        };
        unsafe {
            let _: () = msg_send![&*panel,setSharingType: sharing];
        }
        window.show().map_err(|e| e.to_string())?;
        panel.order_front_regardless();
        crate::window::make_panel_key_if_allowed(&panel);
        unsafe {
            crate::window::make_webview_first_responder(&panel);
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        window.show().map_err(|e| e.to_string())?;
        crate::window::focus_window(&window);
    }
    let _ = window.emit("starred-sessions-visibility", true);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn toggle_starred_sessions(app_handle: tauri::AppHandle) -> Result<(), String> {
    let (send, recv) = tokio::sync::oneshot::channel();
    let app = app_handle.clone();
    app_handle
        .run_on_main_thread(move || {
            let _ = send.send(toggle(&app));
        })
        .map_err(|e| e.to_string())?;
    recv.await.map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn hide_starred_sessions(app_handle: tauri::AppHandle) -> Result<(), String> {
    let (send, recv) = tokio::sync::oneshot::channel();
    let app = app_handle.clone();
    app_handle
        .run_on_main_thread(move || {
            let _ = send.send(hide(&app));
        })
        .map_err(|e| e.to_string())?;
    recv.await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shortcut_starts_for_an_hour_and_second_press_ends_the_same_session() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-07T17:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let mut first = toggle_body(&[], now);
        assert_eq!(first["revision"], 0);
        assert_eq!(first["hd_requested"], false);
        assert_eq!(
            chrono::DateTime::parse_from_rfc3339(first["end"].as_str().unwrap()).unwrap(),
            now + chrono::Duration::minutes(60)
        );
        first["revision"] = serde_json::json!(1);
        let stopped = toggle_body(&[first.clone()], now + chrono::Duration::minutes(1));
        assert_eq!(stopped["id"], first["id"]);
        assert_eq!(stopped["revision"], 1);
        assert_eq!(
            chrono::DateTime::parse_from_rfc3339(stopped["end"].as_str().unwrap()).unwrap(),
            now + chrono::Duration::minutes(1)
        );
        let next = toggle_body(&[stopped], now + chrono::Duration::minutes(2));
        assert_ne!(next["id"], first["id"]);
        let immediate = toggle_body(&[first], now);
        assert_eq!(
            chrono::DateTime::parse_from_rfc3339(immediate["end"].as_str().unwrap()).unwrap(),
            now + chrono::Duration::milliseconds(1)
        );
    }

    #[test]
    fn starred_panel_hugs_trigger_and_stays_on_its_display() {
        assert_eq!(
            attached_origin((700.0, 12.0, 22.0, 16.0), (0.0, 0.0, 1440.0, 900.0)),
            (531.0, 34.0)
        );
        assert_eq!(
            attached_origin((1400.0, 850.0, 22.0, 16.0), (0.0, 0.0, 1440.0, 900.0)),
            (1080.0, 424.0)
        );
        assert_eq!(
            attached_origin(
                (-1440.0, -880.0, 22.0, 16.0),
                (-1440.0, -900.0, 1440.0, 900.0)
            ),
            (-1440.0, -858.0)
        );
    }
    #[test]
    fn starred_panel_uses_physical_work_area_at_mixed_dpi() {
        // A 150% display to the left, with a taskbar reserving its bottom 60px.
        assert_eq!(
            physical_origin(
                (-1500.0, 1500.0, 300.0, 30.0),
                (-2560.0, 0.0, 2560.0, 1540.0),
                1.5
            ),
            (-1620, 861),
        );
        // A 200% display above the primary, with reserved space on the left.
        assert_eq!(
            physical_origin(
                (0.0, -1550.0, 44.0, 32.0),
                (80.0, -1600.0, 2480.0, 1600.0),
                2.0
            ),
            (80, -1506),
        );
        // Right edge at 125%: the entire 450px picker stays inside the work area.
        assert_eq!(
            physical_origin(
                (3730.0, 20.0, 28.0, 20.0),
                (1920.0, 0.0, 1840.0, 1000.0),
                1.25
            ),
            (3310, 48),
        );
    }
}

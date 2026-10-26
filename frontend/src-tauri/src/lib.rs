mod sidecar;
mod update;

use serde_json::Value;
use std::sync::Arc;
use tauri::image::Image;
use tauri::Manager;

use sidecar::Sidecar;

struct AppState {
    sidecar: Arc<Sidecar>,
}

#[tauri::command]
async fn sidecar_request(
    state: tauri::State<'_, AppState>,
    cmd: String,
    payload: Value,
) -> Result<Value, String> {
    let sidecar = state.sidecar.clone();
    tauri::async_runtime::spawn_blocking(move || sidecar.request(cmd, payload))
        .await
        .map_err(|e| format!("사이드카 스레드 오류: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let sidecar = Sidecar::spawn(app.handle())?;
            app.manage(AppState { sidecar });
            update::manage(app.handle());

            let icon = Image::from_bytes(include_bytes!("../icons/icon.png"))?;
            if let Some(win) = app.get_webview_window("main") {
                win.set_icon(icon)?;
                let name = app.config().product_name.clone().unwrap_or_else(|| "KODEX AI".into());
                win.set_title(&format!("{} v{}", name, app.package_info().version))?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sidecar_request,
            update::check_app_update,
            update::install_pending_update
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 앱이 종료될 때 사이드카 node 프로세스를 반드시 정리한다.
            // Windows에서는 job이 최종 방어선이지만, 정상 종료는 여기서 즉시 끝낸다.
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    state.sidecar.shutdown();
                }
            }
        });
}

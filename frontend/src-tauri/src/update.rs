use std::sync::Mutex;

use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::UpdaterExt;

const RELEASES: &str = "https://api.github.com/repos/egibiz/egi-ai-chat/releases/latest";

struct PendingUpdate {
    update: Mutex<Option<tauri_plugin_updater::Update>>,
}

#[derive(Deserialize)]
struct GhAsset {
    name: String,
    url: String,
}

#[derive(Deserialize)]
struct GhRelease {
    assets: Vec<GhAsset>,
}

fn token() -> Result<&'static str, String> {
    match option_env!("EGI_UPDATE_TOKEN").map(str::trim) {
        Some(value) if !value.is_empty() => Ok(value),
        _ => Err("업데이트 토큰이 빌드에 없습니다.".into()),
    }
}

fn fail(message: &str) -> impl Fn(&dyn std::fmt::Display) -> String + '_ {
    move |err| format!("{message} ({err})")
}

async fn manifest_url(token: &str) -> Result<String, String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let response = reqwest::Client::builder()
        .user_agent("egi-ai-chat")
        .build()
        .map_err(|e| fail("업데이트 확인에 실패했습니다.")(&e))?
        .get(RELEASES)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "egi-ai-chat")
        .send()
        .await
        .map_err(|e| fail("업데이트 서버에 연결하지 못했습니다.")(&e))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("업데이트 목록을 받지 못했습니다. (HTTP {status})"));
    }
    let release: GhRelease = response
        .json()
        .await
        .map_err(|e| fail("업데이트 목록을 읽지 못했습니다.")(&e))?;
    release
        .assets
        .into_iter()
        .find(|asset| asset.name == "latest.json")
        .map(|asset| asset.url)
        .ok_or_else(|| "업데이트 목록에 설치 정보가 없습니다.".to_string())
}

async fn find_update(app: &AppHandle) -> Result<Option<tauri_plugin_updater::Update>, String> {
    let token = token()?;
    let manifest = manifest_url(token).await?;
    let endpoint = reqwest::Url::parse(&manifest).map_err(|e| fail("업데이트 주소가 올바르지 않습니다.")(&e))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| fail("업데이트 주소를 열지 못했습니다.")(&e))?
        .header("Authorization", format!("Bearer {token}"))
        .map_err(|e| fail("업데이트 인증에 실패했습니다.")(&e))?
        .header("Accept", "application/octet-stream")
        .map_err(|e| fail("업데이트 인증에 실패했습니다.")(&e))?
        .build()
        .map_err(|e| fail("업데이트 확인을 시작하지 못했습니다.")(&e))?;
    updater
        .check()
        .await
        .map_err(|e| fail("업데이트를 확인하지 못했습니다.")(&e))
}

pub fn manage(app: &AppHandle) {
    app.manage(PendingUpdate {
        update: Mutex::new(None),
    });
}

#[tauri::command]
pub async fn check_app_update(app: AppHandle) -> Result<String, String> {
    // 개발 실행은 설치본이 아니라서 업데이트 대상이 아니고, 빌드 토큰도 없다.
    if cfg!(debug_assertions) {
        return Ok("dev".into());
    }
    let found = find_update(&app).await?;
    let Some(update) = found else {
        return Ok("latest".into());
    };
    let version = update.version.clone();
    let state = app.state::<PendingUpdate>();
    let mut slot = state.update.lock().map_err(|_| "업데이트 상태가 깨졌습니다.".to_string())?;
    *slot = Some(update);
    Ok(version)
}

#[tauri::command]
pub async fn install_pending_update(app: AppHandle) -> Result<(), String> {
    let update = {
        let state = app.state::<PendingUpdate>();
        let mut slot = state.update.lock().map_err(|_| "업데이트 상태가 깨졌습니다.".to_string())?;
        slot.take()
    };
    let Some(update) = update else {
        return Err("확인할 업데이트가 없습니다.".into());
    };
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| fail("업데이트 설치에 실패했습니다.")(&e))
}

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// Windows Job Object 핸들. 이 핸들이 닫히면(=앱 프로세스가 어떤 이유로든 종료되면)
// OS가 job 안의 모든 프로세스(node 사이드카와 그 자식 CLI들)를 강제 종료한다.
#[cfg(windows)]
struct JobHandle(isize);

#[cfg(windows)]
unsafe impl Send for JobHandle {}

#[cfg(windows)]
impl Drop for JobHandle {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0 as _);
        }
    }
}

pub struct Sidecar {
    stdin: Mutex<ChildStdin>,
    pending: Arc<Mutex<HashMap<String, mpsc::Sender<Value>>>>,
    _child: Mutex<Child>,
    // 프로세스 생애 동안 열어둔다. 앱이 죽으면 이 핸들이 닫히며 node가 함께 종료된다.
    #[cfg(windows)]
    _job: Option<JobHandle>,
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        if let Ok(child) = self._child.get_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

// 자식 프로세스를 kill-on-close job에 넣는다. 성공하면 job 핸들을 돌려준다.
// 앱이 정상 종료되든 크래시로 죽든, 부모가 사라지면 OS가 node를 확실히 정리한다.
#[cfg(windows)]
fn confine_to_job(child: &Child) -> Option<JobHandle> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return None;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 {
            CloseHandle(job);
            return None;
        }
        if AssignProcessToJobObject(job, child.as_raw_handle() as _) == 0 {
            CloseHandle(job);
            return None;
        }
        Some(JobHandle(job as isize))
    }
}

impl Sidecar {
    pub fn spawn(app: &AppHandle) -> Result<Arc<Self>, String> {
        let script = resolve_sidecar_script(app)?;
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("앱 데이터 경로를 찾을 수 없습니다: {e}"))?;
        std::fs::create_dir_all(&data_dir)
            .map_err(|e| format!("앱 데이터 폴더를 만들 수 없습니다: {e}"))?;

        let sidecar_dir = script.parent().unwrap_or(std::path::Path::new("."));
        let mut node_paths = vec![
            sidecar_dir.join("node_modules"),
            sidecar_dir.join("..").join("node_modules"),
        ];
        if let Ok(resource) = app.path().resource_dir() {
            node_paths.push(resource.join("node_modules"));
        }
        let node_path = std::env::join_paths(&node_paths).unwrap_or_default();

        let mut command = Command::new(find_node(app)?);
        command
            .arg(&script)
            .env("SIDECAR_DATA_DIR", &data_dir)
            .env("NODE_PATH", node_path)
            .current_dir(sidecar_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);

        let mut child = command
            .spawn()
            .map_err(|e| format!("Node 사이드카를 시작할 수 없습니다: {e}"))?;

        // 앱이 종료되면 node도 반드시 함께 죽도록 job에 묶는다.
        // 이게 없으면 종료 시 node.exe가 고아로 남아 재설치 때 파일이 잠긴다.
        #[cfg(windows)]
        let job = confine_to_job(&child);

        std::thread::sleep(Duration::from_millis(400));
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!(
                "사이드카가 바로 종료되었습니다 ({status}). 설치 파일을 다시 빌드해주세요."
            ));
        }

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "사이드카 stdin을 열 수 없습니다.".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "사이드카 stdout을 열 수 없습니다.".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "사이드카 stderr를 열 수 없습니다.".to_string())?;

        let pending = Arc::new(Mutex::new(HashMap::new()));
        let sidecar = Arc::new(Self {
            stdin: Mutex::new(stdin),
            pending: pending.clone(),
            _child: Mutex::new(child),
            #[cfg(windows)]
            _job: job,
        });

        let handle = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    log::warn!("사이드카 응답 파싱 실패: {line}");
                    continue;
                };
                if value.get("event").and_then(|v| v.as_bool()).unwrap_or(false) {
                    let payload = value.get("payload").cloned().unwrap_or(Value::Null);
                    let _ = handle.emit("assistant-event", payload);
                    continue;
                }
                if let Some(id) = value.get("id").and_then(|v| v.as_str()) {
                    if let Some(tx) = pending.lock().unwrap().remove(id) {
                        let _ = tx.send(value);
                    }
                }
            }
        });

        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                log::info!("[sidecar] {line}");
            }
        });

        Ok(sidecar)
    }

    // 앱 종료 시 명시적으로 사이드카를 정리한다. (Windows는 job이 최종 방어선)
    pub fn shutdown(&self) {
        if let Ok(mut child) = self._child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    pub fn request(&self, cmd: String, payload: Value) -> Result<Value, String> {
        {
            let mut child = self._child.lock().unwrap();
            match child.try_wait() {
                Ok(Some(status)) => {
                    return Err(format!(
                        "사이드카가 종료되었습니다. Node.js가 설치되어 있는지 확인하세요. ({status})"
                    ));
                }
                Err(err) => return Err(format!("사이드카 상태 확인 실패: {err}")),
                Ok(None) => {}
            }
        }

        let id = Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);

        let message = json!({ "id": id, "cmd": cmd, "payload": payload });
        {
            let mut stdin = self.stdin.lock().unwrap();
            writeln!(stdin, "{message}").map_err(|e| format!("사이드카 전송 실패: {e}"))?;
            stdin.flush().map_err(|e| format!("사이드카 flush 실패: {e}"))?;
        }

        let response = rx
            .recv_timeout(Duration::from_secs(300))
            .map_err(|_| "사이드카 응답 시간이 초과되었습니다.".to_string())?;

        if response.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
            Ok(response.get("result").cloned().unwrap_or(Value::Null))
        } else {
            Err(response
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("사이드카 오류")
                .to_string())
        }
    }
}

fn find_node(app: &AppHandle) -> Result<PathBuf, String> {
    // Do not execute the copy in target/debug during development. On Windows a
    // sidecar can briefly outlive an interrupted Tauri process, which prevents
    // tauri-build from replacing that executable during the next compilation.
    if cfg!(debug_assertions) {
        if let Some(node) = find_node_on_path() {
            return Ok(node);
        }
    }

    let names = [
        "node.exe",
        "node-x86_64-pc-windows-msvc.exe",
        "node",
    ];

    let mut dirs = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            dirs.push(dir.to_path_buf());
        }
    }
    if let Ok(resource) = app.path().resource_dir() {
        dirs.push(resource.clone());
        dirs.push(resource.join("binaries"));
    }

    for dir in &dirs {
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    if let Some(node) = find_node_on_path() {
        return Ok(node);
    }
    for candidate in [
        r"C:\Program Files\nodejs\node.exe",
        r"C:\Program Files (x86)\nodejs\node.exe",
    ] {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return Ok(path);
        }
    }

    Err("이 PC에 Node.js가 없습니다. 설치 파일을 다시 빌드해 Node가 포함되게 해주세요.".into())
}

fn find_node_on_path() -> Option<PathBuf> {
    let file_name = if cfg!(windows) { "node.exe" } else { "node" };
    let paths = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&paths) {
        let candidate = dir.join(file_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn dev_sidecar_script() -> Option<PathBuf> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let dev = manifest.join("..").join("sidecar").join("index.js");
    if dev.exists() {
        return Some(dev.canonicalize().unwrap_or(dev));
    }
    None
}

fn resolve_sidecar_script(app: &AppHandle) -> Result<PathBuf, String> {
    // 개발 중에는 항상 원본 소스를 쓴다.
    // dev 빌드도 resources를 target 폴더로 복사하므로, 오래된 bundle.js가 먼저 잡힌다.
    if cfg!(debug_assertions) {
        if let Some(dev) = dev_sidecar_script() {
            return Ok(dev);
        }
    }

    if let Ok(resource) = app.path().resource_dir() {
        let packaged = resource.join("sidecar").join("bundle.js");
        if packaged.exists() {
            return Ok(packaged);
        }
    }

    if let Some(dev) = dev_sidecar_script() {
        return Ok(dev);
    }
    Err("sidecar/index.js를 찾을 수 없습니다.".to_string())
}

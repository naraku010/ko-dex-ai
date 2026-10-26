import { isTauri } from "@/lib/tauri";

async function call<T>(command: string): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<T>(command);
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export async function installAppUpdate(
  onProgress?: (message: string) => void,
): Promise<"latest" | "installed" | "dev"> {
  if (!isTauri()) throw new Error("데스크톱 앱에서만 업데이트할 수 있습니다.");
  const version = await call<string>("check_app_update");
  if (version === "latest" || version === "dev") return version;
  onProgress?.(`${version} 업데이트를 받는 중입니다`);
  await call("install_pending_update");
  return "installed";
}

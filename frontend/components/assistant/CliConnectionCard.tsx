"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, CheckCircle2, Copy, Download, FolderOpen, Loader2, LogIn, Search, Sparkles } from "lucide-react";
import { useAssistantStore } from "@/store/assistantStore";
import type { DetectResult } from "@/types/assistant";

type Step = "detect" | "install" | "login" | "ready";

function stepOf(detect: DetectResult | null, connected: boolean): Step {
  if (!detect) return "detect";
  if (!detect.installed) return "install";
  if (!detect.loggedIn) return "login";
  return connected ? "ready" : "detect";
}

export default function CliConnectionCard({
  autoDetect = false,
  onConnected,
}: {
  autoDetect?: boolean;
  onConnected?: () => void;
}) {
  const { status, fetchStatus, detectCli, connect, installCli, loginCli, saveApiKey, clearSetupLog, setupLog } = useAssistantStore();
  const [detect, setDetect] = useState<DetectResult | null>(null);
  const [adapterId, setAdapterId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyKind, setBusyKind] = useState<"detect" | "install" | "login" | "connect" | null>(null);
  const [message, setMessage] = useState<{ type: "success" | "error" | "info"; text: string } | null>(null);
  const [manualPath, setManualPath] = useState("");
  const [showManual, setShowManual] = useState(false);
  const [copied, setCopied] = useState(false);
  const [loginOpened, setLoginOpened] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const didAutoDetect = useRef(false);
  const logEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (status?.manualPath) setManualPath(status.manualPath);
    if (status?.lastDetect && !detect && status.lastDetect.adapterId === (adapterId || status.adapterId)) {
      setDetect(status.lastDetect);
    }
    if (!adapterId && status?.adapterId) setAdapterId(status.adapterId);
  }, [status, detect, adapterId]);

  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: "end" });
  }, [setupLog]);

  const adapters = status?.adapters ?? [];
  const selectedInfo = adapters.find((a) => a.id === adapterId) ?? null;
  const adapterLabel = selectedInfo?.label ?? status?.adapterLabel ?? "CLI";
  const installHint = selectedInfo?.installHint ?? status?.installHint;
  const loginHint = selectedInfo?.loginHint ?? status?.loginHint;
  const canInstall = selectedInfo?.canInstall ?? true;
  const canLogin = selectedInfo?.canLogin ?? true;
  const apiMode = selectedInfo?.kind === "api";

  const runDetect = async (adapterOverride?: string) => {
    setBusy(true);
    setBusyKind("detect");
    setMessage(null);
    try {
      const targetId = adapterOverride ?? adapterId ?? undefined;
      const result = await detectCli(manualPath || undefined, targetId);
      setDetect(result);
      const usingApi = (status?.adapters ?? []).find((item) => item.id === (targetId || result.adapterId))?.kind === "api" || result.source === "api";
      if (usingApi) {
        setMessage({ type: "info", text: result.message });
      } else if (!result.installed) {
        setMessage({ type: "info", text: `${result.adapterLabel ?? adapterLabel}가 없습니다. 아래에서 설치를 진행해주세요.` });
      } else if (!result.loggedIn) {
        setMessage({ type: "info", text: "CLI는 찾았습니다. 계정 로그인을 진행해주세요." });
      } else {
        setMessage({ type: "info", text: "CLI와 계정 모두 확인됐습니다. 연결하기를 눌러 마무리해주세요." });
      }
      return result;
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : String(err) });
      return null;
    } finally {
      setBusy(false);
      setBusyKind(null);
    }
  };

  const selectAdapter = (id: string) => {
    if (id === adapterId || busy) return;
    setAdapterId(id);
    setDetect(null);
    setMessage(null);
    setManualPath("");
    setApiKey("");
    setLoginOpened(false);
    clearSetupLog();
    void runDetect(id);
  };

  useEffect(() => {
    if (!autoDetect || didAutoDetect.current) return;
    didAutoDetect.current = true;
    void runDetect();
  }, [autoDetect]);

  const runInstall = async () => {
    setBusy(true);
    setBusyKind("install");
    setMessage({ type: "info", text: `${adapterLabel} 설치를 시작합니다. 1~2분 걸릴 수 있습니다.` });
    clearSetupLog();
    try {
      const result = await installCli(adapterId ?? undefined);
      setDetect(result);
      if (result.installed && result.loggedIn) {
        setMessage({ type: "success", text: "설치와 로그인이 모두 확인됐습니다." });
      } else if (result.installed) {
        setMessage({ type: "success", text: "설치가 끝났습니다. 이제 계정으로 로그인해주세요." });
      } else {
        setMessage({ type: "error", text: result.message || "설치 후 실행 파일을 찾지 못했습니다." });
      }
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
      setBusyKind(null);
    }
  };

  const runLogin = async () => {
    setBusy(true);
    setBusyKind("login");
    setMessage(null);
    try {
      await loginCli(adapterId ?? undefined);
      setLoginOpened(true);
      setMessage({ type: "info", text: "로그인 창을 열었습니다. 브라우저 안내를 마친 뒤 아래 확인을 눌러주세요." });
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
      setBusyKind(null);
    }
  };

  const confirmLogin = async () => {
    const result = await runDetect();
    if (result?.installed && result.loggedIn) {
      setLoginOpened(false);
      await runConnect();
    }
  };

  const runConnect = async () => {
    if (apiMode && !apiKey.trim() && !selectedInfo?.hasApiKey) {
      setMessage({ type: "error", text: "API 키를 입력해주세요." });
      return;
    }
    setBusy(true);
    setBusyKind("connect");
    setMessage(null);
    try {
      const result = await connect(manualPath || undefined, adapterId ?? undefined, apiMode ? apiKey : undefined);
      if (apiMode) setApiKey("");
      setDetect(result);
      setMessage({ type: "success", text: "에이든 연결이 완료되었습니다." });
      onConnected?.();
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : String(err) });
      await fetchStatus();
    } finally {
      setBusy(false);
      setBusyKind(null);
    }
  };

  const copyInstallCommand = async () => {
    try {
      await navigator.clipboard.writeText(installHint ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setMessage({ type: "error", text: "클립보드 복사에 실패했습니다." });
    }
  };

  const clearApiKey = async () => {
    if (!adapterId) return;
    setBusy(true);
    setMessage(null);
    try {
      await saveApiKey(adapterId, "");
      setApiKey("");
      setDetect(null);
      setMessage({ type: "info", text: "저장된 API 키를 지웠습니다." });
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const step = stepOf(detect, Boolean(status?.connected));
  const connected = Boolean(status?.connected) && step === "ready";
  const installing = busyKind === "install";

  return (
    <section className="rounded-lg p-4" style={{ background: "var(--dc-sidebar)", border: "1px solid var(--dc-border)" }}>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold" style={{ color: "var(--dc-text)" }}>{apiMode ? `${adapterLabel} 연결` : `${adapterLabel} CLI 연결`}</h3>
          <p className="mt-1 text-xs" style={{ color: "var(--dc-muted)" }}>
            {apiMode
              ? "API 키로 연결합니다. 키는 이 PC에만 저장되고, 채널 도구는 그대로 씁니다."
              : "설치되지 않았으면 앱에서 설치하고, 계정 로그인까지 이어서 진행합니다."}
          </p>
        </div>
        <span
          className="rounded-full px-2 py-0.5 text-[11px] font-medium"
          style={{
            background: connected ? "rgba(35,165,89,0.15)" : "rgba(237,66,69,0.12)",
            color: connected ? "var(--dc-online)" : "var(--dc-danger)",
          }}
        >
          {connected ? "연결됨" : "연결 안 됨"}
        </span>
      </div>

      {!apiMode && <ol className="mb-4 grid grid-cols-3 gap-1.5 text-[11px]">
        {[
          { id: "install", label: "1. 설치" },
          { id: "login", label: "2. 로그인" },
          { id: "ready", label: "3. 연결" },
        ].map((item) => {
          const done =
            (item.id === "install" && Boolean(detect?.installed)) ||
            (item.id === "login" && Boolean(detect?.loggedIn)) ||
            (item.id === "ready" && connected);
          const current =
            (item.id === "install" && step === "install") ||
            (item.id === "login" && step === "login") ||
            (item.id === "ready" && detect?.installed && detect?.loggedIn && !connected);
          return (
            <li
              key={item.id}
              className="rounded px-2 py-1.5 text-center"
              style={{
                background: done ? "rgba(35,165,89,0.12)" : current ? "var(--accent-10)" : "var(--dc-bg)",
                color: done ? "var(--dc-online)" : current ? "#c9cdfb" : "var(--dc-muted)",
                border: `1px solid ${done ? "rgba(35,165,89,0.35)" : current ? "var(--dc-blurple)" : "var(--dc-border)"}`,
              }}
            >
              {item.label}
            </li>
          );
        })}
      </ol>}

      {adapters.length > 1 && (
        <div className="mb-4">
          <p className="mb-1.5 text-xs" style={{ color: "var(--dc-muted)" }}>사용할 연결</p>
          <div className="grid grid-cols-2 gap-1.5">
            {adapters.map((a) => {
              const active = a.id === adapterId;
              return (
                <button
                  key={a.id}
                  onClick={() => selectAdapter(a.id)}
                  disabled={busy}
                  className="flex-1 rounded py-2 text-xs font-medium disabled:opacity-50"
                  style={{
                    background: active ? "var(--accent-10)" : "var(--dc-bg)",
                    color: active ? "#c9cdfb" : "var(--dc-secondary)",
                    border: `1px solid ${active ? "var(--dc-blurple)" : "var(--dc-border)"}`,
                  }}
                >
                  {a.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {apiMode && (
        <div className="mb-4">
          <p className="mb-2 text-xs leading-5" style={{ color: "var(--dc-secondary)" }}>
            {loginHint}
            {selectedInfo?.keyHint ? ` 저장된 키 · ••••${selectedInfo.keyHint}` : ""}
          </p>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder={selectedInfo?.hasApiKey ? "바꾸려면 새 키를 입력" : "API 키"}
            className="h-9 w-full rounded px-3 text-xs outline-none"
            style={{ background: "var(--dc-bg)", color: "var(--dc-text)", border: "1px solid var(--dc-border)", fontFamily: "var(--font-mono)" }}
          />
          {selectedInfo?.hasApiKey && (
            <button
              onClick={() => void clearApiKey()}
              disabled={busy}
              className="mt-2 text-xs disabled:opacity-50"
              style={{ color: "var(--dc-muted)" }}
            >
              저장된 키 지우기
            </button>
          )}
        </div>
      )}

      {detect && !apiMode ? (
        <div className="mb-4 divide-y rounded-md" style={{ background: "var(--dc-bg)", border: "1px solid var(--dc-border)" }}>
          <Row label="설치" ok={detect.installed} text={detect.installed ? (detect.version ?? "확인됨") : "찾을 수 없음"} />
          <Row
            label="로그인"
            ok={detect.loggedIn}
            text={detect.loggedIn ? (detect.account ? `로그인됨 (${detect.account})` : "로그인됨") : "로그인 필요"}
          />
          {detect.path ? (
            <div className="px-3.5 py-2.5">
              <p className="mb-1 text-xs" style={{ color: "var(--dc-muted)" }}>
                실행 파일 {detect.source ? `— ${detect.source}` : ""}
              </p>
              <p className="break-all text-xs" style={{ color: "var(--dc-secondary)", fontFamily: "var(--font-mono)" }}>
                {detect.path}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      {detect && apiMode ? (
        <div className="mb-4 divide-y rounded-md" style={{ background: "var(--dc-bg)", border: "1px solid var(--dc-border)" }}>
          <Row label="API 키" ok={detect.loggedIn} text={detect.loggedIn ? "확인됨" : detect.message} />
        </div>
      ) : null}

      {!apiMode && step === "install" && (
        <div className="mb-4 rounded-md p-3.5" style={{ background: "var(--dc-bg)", border: "1px solid var(--dc-border)" }}>
          <p className="mb-3 text-xs leading-5" style={{ color: "var(--dc-secondary)" }}>
            {adapterLabel}가 이 PC에 없습니다. 설치하기를 누르면 앱이 대신 설치합니다.
          </p>
          {canInstall && (
            <button
              onClick={() => void runInstall()}
              disabled={busy}
              className="mb-3 flex w-full items-center justify-center gap-2 rounded py-2.5 text-sm font-semibold text-white disabled:opacity-50"
              style={{ background: "var(--dc-blurple)" }}
            >
              {installing ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              {installing ? "설치 중…" : `${adapterLabel} 설치하기`}
            </button>
          )}
          <p className="mb-2 text-[11px]" style={{ color: "var(--dc-muted)" }}>
            자동 설치가 안 되면 PowerShell에서 직접 실행하세요.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded px-2.5 py-2 text-xs" style={{ background: "var(--dc-sidebar)", color: "#c9cdfb" }}>
              {installHint}
            </code>
            <button
              onClick={() => void copyInstallCommand()}
              className="shrink-0 rounded p-2"
              style={{ border: "1px solid var(--dc-border)", color: "var(--dc-muted)" }}
            >
              {copied ? <Check size={13} style={{ color: "var(--dc-online)" }} /> : <Copy size={13} />}
            </button>
          </div>
        </div>
      )}

      {!apiMode && (installing || setupLog.length > 0) ? (
        <div className="mb-4 max-h-40 overflow-y-auto rounded-md px-3 py-2.5" style={{ background: "var(--dc-bg)", border: "1px solid var(--dc-border)" }}>
          {setupLog.length === 0 ? (
            <p className="text-[11px]" style={{ color: "var(--dc-muted)" }}>설치 로그를 기다리는 중…</p>
          ) : (
            setupLog.map((line, i) => (
              <p key={`${i}-${line}`} className="break-all text-[11px] leading-5" style={{ color: "var(--dc-secondary)", fontFamily: "var(--font-mono)" }}>
                {line}
              </p>
            ))
          )}
          <div ref={logEnd} />
        </div>
      ) : null}

      {!apiMode && step === "login" && (
        <div className="mb-4 rounded-md p-3.5" style={{ background: "var(--dc-bg)", border: "1px solid var(--dc-border)" }}>
          <p className="mb-3 text-xs leading-5" style={{ color: "var(--dc-secondary)" }}>
            {loginHint} 로그인 창이 열리면 브라우저에서 계정을 인증한 뒤, 앱으로 돌아와 확인을 누르세요.
          </p>
          <div className="flex gap-2">
            {canLogin && (
              <button
                onClick={() => void runLogin()}
                disabled={busy}
                className="flex flex-1 items-center justify-center gap-2 rounded py-2.5 text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: "var(--dc-blurple)" }}
              >
                {busyKind === "login" ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />}
                {loginOpened ? "로그인 창 다시 열기" : "로그인 창 열기"}
              </button>
            )}
            <button
              onClick={() => void confirmLogin()}
              disabled={busy}
              className="flex flex-1 items-center justify-center gap-2 rounded py-2.5 text-sm font-medium disabled:opacity-50"
              style={{ border: "1px solid var(--dc-border)", color: "var(--dc-secondary)" }}
            >
              {busyKind === "detect" ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
              로그인 확인
            </button>
          </div>
        </div>
      )}

      {!apiMode && <button
        onClick={() => setShowManual((v) => !v)}
        className="mb-3 flex items-center gap-1.5 text-xs"
        style={{ color: "var(--dc-muted)" }}
      >
        <FolderOpen size={12} />
        {showManual ? "경로 직접 지정 닫기" : "자동 탐지가 안 되면 경로 직접 지정"}
      </button>}

      {!apiMode && showManual && (
        <div className="mb-4">
          <input
            value={manualPath}
            onChange={(e) => setManualPath(e.target.value)}
            placeholder={adapterId === "codex" ? "예: C:\\Users\\사용자\\...\\codex.exe" : "예: C:\\Users\\사용자\\.local\\bin\\claude.exe"}
            className="h-9 w-full rounded px-3 text-xs outline-none"
            style={{ background: "var(--dc-bg)", color: "var(--dc-text)", border: "1px solid var(--dc-border)", fontFamily: "var(--font-mono)" }}
          />
        </div>
      )}

      {message ? (
        <div
          className="mb-4 flex items-start gap-2 rounded-md px-3 py-2.5 text-xs"
          style={{
            background: message.type === "success" ? "rgba(35,165,89,0.12)" : message.type === "error" ? "rgba(237,66,69,0.12)" : "var(--accent-10)",
            color: message.type === "success" ? "var(--dc-online)" : message.type === "error" ? "#f87171" : "#c9cdfb",
          }}
        >
          {message.type === "success" ? <CheckCircle2 size={13} className="mt-0.5 shrink-0" /> : message.type === "error" ? <AlertCircle size={13} className="mt-0.5 shrink-0" /> : <Sparkles size={13} className="mt-0.5 shrink-0" />}
          <span>{message.text}</span>
        </div>
      ) : null}

      <div className="flex gap-2">
        <button
          onClick={() => void runDetect()}
          disabled={busy}
          className="flex flex-1 items-center justify-center gap-2 rounded py-2.5 text-sm font-medium disabled:opacity-50"
          style={{ border: "1px solid var(--dc-border)", color: "var(--dc-secondary)" }}
        >
          {busyKind === "detect" ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
          {apiMode ? "키 확인" : "CLI 탐지"}
        </button>
        <button
          onClick={() => void runConnect()}
          disabled={busy || (apiMode ? !apiKey.trim() && !selectedInfo?.hasApiKey : !detect?.installed || !detect?.loggedIn)}
          className="flex flex-1 items-center justify-center gap-2 rounded py-2.5 text-sm font-semibold text-white disabled:opacity-40"
          style={{ background: "var(--dc-blurple)" }}
        >
          {busyKind === "connect" ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {connected ? "다시 연결" : "연결하기"}
        </button>
      </div>
    </section>
  );
}

function Row({ label, ok, text }: { label: string; ok: boolean; text: string }) {
  return (
    <div className="flex items-center gap-3 px-3.5 py-2.5">
      {ok ? <CheckCircle2 size={14} style={{ color: "var(--dc-online)" }} /> : <AlertCircle size={14} style={{ color: "var(--dc-danger)" }} />}
      <span className="w-14 shrink-0 text-xs" style={{ color: "var(--dc-muted)" }}>{label}</span>
      <span className="text-xs" style={{ color: "var(--dc-secondary)" }}>{text}</span>
    </div>
  );
}

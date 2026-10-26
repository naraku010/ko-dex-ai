"use client";

import { useState } from "react";
import { Check, Loader2, X } from "lucide-react";
import { useAssistantStore } from "@/store/assistantStore";
import type { ChannelPreview } from "@/types/assistant";
import { ChannelIcon, channelTypeLabel } from "./ChannelMark";
import CredentialFields from "./CredentialFields";

export default function AddChannelDialog({ onClose }: { onClose: () => void }) {
  const previewChannel = useAssistantStore((s) => s.previewChannel);
  const addChannel = useAssistantStore((s) => s.addChannel);
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [preview, setPreview] = useState<ChannelPreview | null>(null);
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const reset = () => {
    setPreview(null);
    setCreds({});
  };

  const check = async () => {
    setBusy(true);
    setError("");
    reset();
    try {
      const result = await previewChannel(url.trim(), apiKey.trim());
      setPreview(result);
      setCreds({});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    setError("");
    try {
      await addChannel(url.trim(), apiKey.trim(), creds);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const fields = preview?.credentialFields ?? [];
  const credsFilled = fields.every((field) => !field.required || (creds[field.key] ?? "").trim());

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: "rgba(0,0,0,0.6)" }}
    >
      <div
        className="dc-scroll max-h-full w-full max-w-lg overflow-y-auto rounded-lg p-5"
        style={{ background: "var(--dc-main)", border: "1px solid var(--dc-border)" }}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-base font-semibold" style={{ color: "var(--dc-text)" }}>채널 추가</h2>
            <p className="mt-1 text-xs" style={{ color: "var(--dc-muted)" }}>
              채널 서버 주소를 넣으면 규격을 확인하고 그 채널의 툴을 등록합니다.
            </p>
          </div>
          <button onClick={onClose} className="rounded p-1" style={{ color: "var(--dc-muted)" }} title="닫기">
            <X size={16} />
          </button>
        </div>

        <label className="mb-1 block text-xs font-semibold" style={{ color: "var(--dc-secondary)" }}>
          채널 URL
        </label>
        <input
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            reset();
          }}
          placeholder="http://10.0.0.10:8801"
          className="h-9 w-full rounded px-3 text-sm outline-none"
          style={{
            background: "var(--dc-bg)",
            color: "var(--dc-text)",
            border: "1px solid var(--dc-border)",
            fontFamily: "var(--font-mono)",
          }}
        />
        <p className="mb-3 mt-1 text-xs" style={{ color: "var(--dc-muted)" }}>
          http와 https 모두 됩니다. 생략하면 사내 주소·포트는 http, 도메인은 https로 붙습니다.
        </p>

        <label className="mb-1 block text-xs font-semibold" style={{ color: "var(--dc-secondary)" }}>
          API 키
        </label>
        <input
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value);
            reset();
          }}
          type="password"
          placeholder="채널 담당자에게 받은 키"
          className="h-9 w-full rounded px-3 text-sm outline-none"
          style={{
            background: "var(--dc-bg)",
            color: "var(--dc-text)",
            border: "1px solid var(--dc-border)",
            fontFamily: "var(--font-mono)",
          }}
        />

        {error ? (
          <p className="mt-3 text-xs leading-5" style={{ color: "var(--dc-danger)" }}>{error}</p>
        ) : null}

        {preview ? (
          <section
            className="mt-4 rounded-md p-3.5"
            style={{ background: "var(--dc-sidebar)", border: "1px solid var(--dc-border)" }}
          >
            <div className="flex items-center gap-2">
              <Check size={14} style={{ color: "var(--dc-online)" }} />
              <span
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
                style={{ background: "var(--dc-bg)", color: "var(--dc-text)" }}
              >
                <ChannelIcon icon={preview.channel.icon} size={14} />
              </span>
              <span className="text-sm font-semibold" style={{ color: "var(--dc-text)" }}>
                {preview.channel.name}
              </span>
              <span className="rounded-full px-2 py-0.5 text-[10px]" style={{ background: "var(--dc-bg)", color: "var(--dc-muted)" }}>
                {channelTypeLabel(preview.channel.type)}
              </span>
              <span className="text-[11px]" style={{ color: "var(--dc-faint)" }}>
                {preview.channel.id}
                {preview.channel.version ? ` · v${preview.channel.version}` : ""}
              </span>
            </div>
            {preview.channel.description ? (
              <p className="mt-1 text-xs" style={{ color: "var(--dc-muted)" }}>{preview.channel.description}</p>
            ) : null}
            <p className="mt-2 text-xs" style={{ color: "var(--dc-secondary)" }}>
              툴 {preview.channel.toolCount}개
              {preview.replaces ? " · 이미 있는 채널을 갱신합니다" : ""}
            </p>
            <div className="mt-2 flex flex-wrap gap-1">
              {preview.tools.slice(0, 12).map((tool) => (
                <span
                  key={tool.name}
                  className="rounded-full px-2 py-0.5 text-[11px]"
                  style={{ background: "var(--dc-bg)", color: "var(--dc-muted)" }}
                  title={tool.description}
                >
                  {tool.label ?? tool.name}
                </span>
              ))}
              {preview.tools.length > 12 ? (
                <span className="text-[11px]" style={{ color: "var(--dc-faint)" }}>
                  +{preview.tools.length - 12}
                </span>
              ) : null}
            </div>
          </section>
        ) : null}

        {fields.length > 0 ? (
          <section className="mt-4">
            <h3 className="text-sm font-semibold" style={{ color: "var(--dc-text)" }}>계정 정보</h3>
            <p className="mt-1 mb-3 text-xs leading-5" style={{ color: "var(--dc-muted)" }}>
              이 채널은 조회할 때 본인 계정으로 접속합니다. 입력한 정보는 이 PC에만 저장되고, 채널 서버에는
              보관되지 않습니다.
            </p>
            <CredentialFields
              fields={fields}
              values={creds}
              disabled={busy}
              onChange={(key, value) => setCreds((prev) => ({ ...prev, [key]: value }))}
            />
          </section>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded px-3 py-2 text-sm" style={{ color: "var(--dc-muted)" }}>
            취소
          </button>
          {preview ? (
            <button
              onClick={() => void confirm()}
              disabled={busy || !credsFilled}
              className="flex items-center gap-1.5 rounded px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
              style={{ background: "var(--dc-blurple)" }}
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : null}
              추가
            </button>
          ) : (
            <button
              onClick={() => void check()}
              disabled={busy || !url.trim()}
              className="flex items-center gap-1.5 rounded px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
              style={{ background: "var(--dc-blurple)" }}
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : null}
              확인
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import { Loader2, X } from "lucide-react";
import { useAssistantStore } from "@/store/assistantStore";
import type { ChannelInfo } from "@/types/assistant";
import CredentialFields from "./CredentialFields";

export default function EditCredentialsDialog({
  channel,
  onClose,
}: {
  channel: ChannelInfo;
  onClose: () => void;
}) {
  const setChannelCredentials = useAssistantStore((s) => s.setChannelCredentials);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await setChannelCredentials(channel.id, values);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const filled = channel.credentialFields.every(
    (field) => !field.required || (values[field.key] ?? "").trim(),
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: "rgba(0,0,0,0.6)" }}
    >
      <div
        className="w-full max-w-md rounded-lg p-5"
        style={{ background: "var(--dc-main)", border: "1px solid var(--dc-border)" }}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-base font-semibold" style={{ color: "var(--dc-text)" }}>
              {channel.name} 계정 정보
            </h2>
            <p className="mt-1 text-xs leading-5" style={{ color: "var(--dc-muted)" }}>
              이 채널은 조회할 때 본인 계정으로 접속합니다. 이 PC에만 저장됩니다.
            </p>
          </div>
          <button onClick={onClose} className="rounded p-1" style={{ color: "var(--dc-muted)" }} title="닫기">
            <X size={16} />
          </button>
        </div>

        <CredentialFields
          fields={channel.credentialFields}
          values={values}
          disabled={busy}
          onChange={(key, value) => setValues((prev) => ({ ...prev, [key]: value }))}
        />

        {error ? (
          <p className="mt-3 text-xs leading-5" style={{ color: "var(--dc-danger)" }}>{error}</p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded px-3 py-2 text-sm" style={{ color: "var(--dc-muted)" }}>
            취소
          </button>
          <button
            onClick={() => void save()}
            disabled={busy || !filled}
            className="flex items-center gap-1.5 rounded px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
            style={{ background: "var(--dc-blurple)" }}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : null}
            확인하고 저장
          </button>
        </div>
      </div>
    </div>
  );
}

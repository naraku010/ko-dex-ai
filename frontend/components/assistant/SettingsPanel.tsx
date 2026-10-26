"use client";

import { useState } from "react";
import { ArrowLeft, Mail } from "lucide-react";
import ChannelPanel from "@/components/channels/ChannelPanel";
import { installAppUpdate } from "@/lib/appUpdate";
import { CONTACT_EMAIL, openContactMail } from "@/lib/contact";
import CliConnectionCard from "./CliConnectionCard";
import UsagePanel from "./UsagePanel";

type SettingsTab = "cli" | "channels" | "usage";

export default function SettingsPanel({
  onBack,
  onConnected,
  setup = false,
}: {
  onBack: () => void;
  onConnected?: () => void;
  setup?: boolean;
}) {
  const [picked, setTab] = useState<SettingsTab>("cli");
  const [updating, setUpdating] = useState(false);
  const [updateNote, setUpdateNote] = useState("");

  async function updateApp() {
    setUpdating(true);
    setUpdateNote("확인 중입니다");
    try {
      const result = await installAppUpdate(setUpdateNote);
      if (result === "latest") setUpdateNote("이미 최신 버전입니다");
      if (result === "dev") setUpdateNote("개발 실행에서는 업데이트를 확인하지 않습니다");
    } catch (err) {
      setUpdateNote(err instanceof Error ? err.message : "업데이트에 실패했습니다.");
    } finally {
      setUpdating(false);
    }
  }
  // 처음 설정 중에는 CLI 탭만 쓴다.
  const tab = setup ? "cli" : picked;

  const tabs: { id: SettingsTab; label: string }[] = setup
    ? [{ id: "cli", label: "모델 연결" }]
    : [
        { id: "cli", label: "모델 연결" },
        { id: "channels", label: "채널" },
        { id: "usage", label: "사용량" },
      ];

  return (
    <div className="flex h-full flex-col" style={{ background: "var(--dc-main)" }}>
      <header className="flex h-12 items-center gap-3 px-4 shadow-[0_1px_0_var(--dc-border)]">
        {setup ? (
          <h1 className="text-sm font-semibold" style={{ color: "var(--dc-text)" }}>처음 설정 · 모델 연결</h1>
        ) : (
          <>
            <button onClick={onBack} className="flex items-center gap-1.5 text-sm" style={{ color: "var(--dc-muted)" }}>
              <ArrowLeft size={16} />
              채팅으로
            </button>
            <h1 className="text-sm font-semibold" style={{ color: "var(--dc-text)" }}>설정</h1>
          </>
        )}
        <button
          type="button"
          onClick={() => void openContactMail().catch(() => setUpdateNote(`문의: ${CONTACT_EMAIL}`))}
          className="ml-auto flex items-center gap-1 rounded px-3 py-1 text-xs font-semibold"
          style={{ color: "var(--dc-muted)", border: "1px solid var(--dc-border)" }}
          title={CONTACT_EMAIL}
        >
          <Mail size={13} />
          문의하기
        </button>
        <button
          type="button"
          onClick={() => void updateApp()}
          disabled={updating}
          className="rounded px-3 py-1 text-xs font-semibold text-white disabled:opacity-60"
          style={{ background: "var(--dc-blurple)" }}
        >
          업데이트
        </button>
        {updateNote ? (
          <span className="max-w-[220px] truncate text-xs" style={{ color: "var(--dc-muted)" }} title={updateNote}>
            {updateNote}
          </span>
        ) : null}
      </header>

      <nav className="flex gap-1 px-6 pt-3" style={{ borderBottom: "1px solid var(--dc-border)" }}>
        {tabs.map((item) => {
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => setTab(item.id)}
              className="px-3 py-2 text-sm"
              style={{
                color: active ? "var(--dc-text)" : "var(--dc-muted)",
                borderBottom: active ? "2px solid var(--dc-blurple)" : "2px solid transparent",
                fontWeight: active ? 600 : 500,
              }}
            >
              {item.label}
            </button>
          );
        })}
      </nav>

      <div className="dc-scroll w-full max-w-2xl flex-1 overflow-y-auto px-6 py-5">
        {tab === "cli" && (
          <>
            {setup && (
              <p className="mb-5 text-sm" style={{ color: "var(--dc-secondary)" }}>
                이 PC의 AI CLI를 연결해야 대화를 시작할 수 있습니다. 없으면 설치하고, 계정 로그인까지 이어서 진행합니다.
              </p>
            )}
            <CliConnectionCard autoDetect={setup} onConnected={onConnected} />
          </>
        )}

        {tab === "channels" && <ChannelPanel />}

        {tab === "usage" && <UsagePanel />}
      </div>
    </div>
  );
}

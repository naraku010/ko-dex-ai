"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, KeyRound, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useAssistantStore } from "@/store/assistantStore";
import { useAuthStore } from "@/store/authStore";
import { useConversationStore } from "@/store/conversationStore";
import * as db from "@/lib/db";
import type { ChannelInfo } from "@/types/assistant";
import AddChannelDialog from "./AddChannelDialog";
import { ChannelIcon, channelTypeLabel } from "./ChannelMark";
import EditCredentialsDialog from "./EditCredentialsDialog";

export default function ChannelPanel() {
  const channels = useAssistantStore((s) => s.channels);
  const channelId = useAssistantStore((s) => s.channelId);
  const fetchChannels = useAssistantStore((s) => s.fetchChannels);
  const refreshChannel = useAssistantStore((s) => s.refreshChannel);
  const removeChannel = useAssistantStore((s) => s.removeChannel);
  const user = useAuthStore((s) => s.user);
  const removeByChannel = useConversationStore((s) => s.removeByChannel);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ChannelInfo | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<{ channel: ChannelInfo; count: number | null } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  useEffect(() => {
    void fetchChannels();
  }, [fetchChannels]);

  const run = async (id: string, action: () => Promise<void>) => {
    setPending(id);
    setError("");
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  };

  // 삭제 전에 이 채널에 딸린 대화 수를 세어 경고에 보여준다.
  const openConfirm = async (channel: ChannelInfo) => {
    setError("");
    setConfirm({ channel, count: null });
    if (!user) return;
    try {
      const list = await db.listConversations(user.user_id, channel.id);
      setConfirm((prev) => (prev && prev.channel.id === channel.id ? { channel, count: list.length } : prev));
    } catch {
      // 대화 수를 못 세도 삭제는 가능하다.
    }
  };

  const confirmDelete = async () => {
    if (!confirm || !user) return;
    setConfirmBusy(true);
    setError("");
    try {
      await removeChannel(confirm.channel.id);
      await removeByChannel(user.user_id, confirm.channel.id);
      setConfirm(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConfirmBusy(false);
    }
  };

  return (
    <div>
      <div className="mb-4 flex items-start justify-between gap-4">
        <p className="text-xs leading-5" style={{ color: "var(--dc-muted)" }}>
          채널은 AI가 쓸 수 있는 툴 묶음입니다. 채널 서버 URL을 넣으면 규격(egi.channel/v1)을 확인하고 그 툴만 올립니다.
        </p>
        <button
          onClick={() => setAdding(true)}
          className="flex shrink-0 items-center gap-1.5 rounded px-3 py-2 text-sm font-semibold text-white"
          style={{ background: "var(--dc-blurple)" }}
        >
          <Plus size={14} />
          채널 추가
        </button>
      </div>

      {error ? (
        <p className="mb-3 text-xs leading-5" style={{ color: "var(--dc-danger)" }}>{error}</p>
      ) : null}

      <div className="space-y-2">
        {channels.length === 0 ? (
          <p className="rounded-md px-3.5 py-6 text-center text-xs" style={{ background: "var(--dc-sidebar)", color: "var(--dc-faint)" }}>
            추가된 채널이 없습니다.
          </p>
        ) : null}
        {channels.map((channel) => (
          <section
            key={channel.id}
            className="rounded-md p-3.5"
            style={{
              background: "var(--dc-sidebar)",
              border: `1px solid ${channel.id === channelId ? "var(--dc-blurple)" : "var(--dc-border)"}`,
            }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md"
                    style={{ background: "var(--dc-bg)", color: "var(--dc-text)" }}
                  >
                    <ChannelIcon icon={channel.icon} size={16} />
                  </span>
                  <h3 className="truncate text-sm font-semibold" style={{ color: "var(--dc-text)" }}>
                    {channel.name}
                  </h3>
                  <span className="rounded-full px-2 py-0.5 text-[10px]" style={{ background: "var(--dc-bg)", color: "var(--dc-muted)" }}>
                    {channelTypeLabel(channel.type)}
                  </span>
                  {channel.id === channelId ? (
                    <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold text-white" style={{ background: "var(--dc-blurple)" }}>
                      사용 중
                    </span>
                  ) : null}
                  {!channel.credentialsReady ? (
                    <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold text-white" style={{ background: "var(--dc-danger)" }}>
                      계정 정보 필요
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 truncate text-xs" style={{ color: "var(--dc-muted)" }}>
                  {channel.description || "-"}
                </p>
                <p className="mt-1 truncate text-[11px]" style={{ color: "var(--dc-faint)", fontFamily: "var(--font-mono)" }}>
                  {channel.url}
                  {channel.toolCount ? ` · 툴 ${channel.toolCount}개` : ""}
                  {channel.version ? ` · v${channel.version}` : ""}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-1">
                {pending === channel.id ? (
                  <Loader2 size={14} className="animate-spin" style={{ color: "var(--dc-muted)" }} />
                ) : null}
                {channel.credentialFields.length > 0 ? (
                  <button
                    onClick={() => setEditing(channel)}
                    className="rounded p-1.5"
                    style={{ color: channel.credentialsReady ? "var(--dc-muted)" : "var(--dc-danger)" }}
                    title="계정 정보 입력"
                  >
                    <KeyRound size={14} />
                  </button>
                ) : null}
                <button
                  onClick={() => void run(channel.id, () => refreshChannel(channel.id))}
                  disabled={pending !== null}
                  className="rounded p-1.5 disabled:opacity-40"
                  style={{ color: "var(--dc-muted)" }}
                  title="채널 새로고침 (툴 목록 다시 받기)"
                >
                  <RefreshCw size={14} />
                </button>
                <button
                  onClick={() => void openConfirm(channel)}
                  disabled={pending !== null}
                  className="rounded p-1.5 disabled:opacity-40"
                  style={{ color: "var(--dc-danger)" }}
                  title="채널 삭제"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          </section>
        ))}
      </div>

      {adding && <AddChannelDialog onClose={() => setAdding(false)} />}
      {editing && <EditCredentialsDialog channel={editing} onClose={() => setEditing(null)} />}

      {confirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-6"
          style={{ background: "rgba(0,0,0,0.6)" }}
          onClick={() => !confirmBusy && setConfirm(null)}
        >
          <div
            className="w-full max-w-md rounded-lg p-5"
            style={{ background: "var(--dc-main)", border: "1px solid var(--dc-border)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center gap-2">
              <AlertTriangle size={18} style={{ color: "var(--dc-danger)" }} />
              <h2 className="text-base font-semibold" style={{ color: "var(--dc-text)" }}>채널 삭제</h2>
            </div>
            <p className="text-sm leading-6" style={{ color: "var(--dc-secondary)" }}>
              <b style={{ color: "var(--dc-text)" }}>{confirm.channel.name}</b> 채널을 삭제하면 이 채널의 대화
              {confirm.count === null ? "" : ` ${confirm.count}개`}와 모든 메시지가 함께 삭제됩니다. 되돌릴 수 없습니다.
            </p>
            {error ? <p className="mt-3 text-xs leading-5" style={{ color: "var(--dc-danger)" }}>{error}</p> : null}
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setConfirm(null)}
                disabled={confirmBusy}
                className="rounded px-3 py-2 text-sm disabled:opacity-50"
                style={{ color: "var(--dc-muted)" }}
              >
                취소
              </button>
              <button
                onClick={() => void confirmDelete()}
                disabled={confirmBusy}
                className="flex items-center gap-1.5 rounded px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: "var(--dc-danger)" }}
              >
                {confirmBusy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                삭제
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

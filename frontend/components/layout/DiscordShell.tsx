"use client";

import { useEffect, useState } from "react";
import { Plus, Settings } from "lucide-react";
import AppMark from "@/components/brand/AppMark";
import ChatView from "@/components/assistant/ChatView";
import ConversationList from "@/components/assistant/ConversationList";
import SettingsPanel from "@/components/assistant/SettingsPanel";
import UserPanel from "@/components/assistant/UserPanel";
import AddChannelDialog from "@/components/channels/AddChannelDialog";
import { ChannelIcon } from "@/components/channels/ChannelMark";
import { installAppUpdate } from "@/lib/appUpdate";
import { isTauri } from "@/lib/tauri";
import { useAssistantStore } from "@/store/assistantStore";
import { useAuthStore } from "@/store/authStore";
import { useConversationStore } from "@/store/conversationStore";

export default function DiscordShell() {
  const user = useAuthStore((s) => s.user);
  const load = useConversationStore((s) => s.load);
  const subscribe = useAssistantStore((s) => s.subscribe);
  const fetchStatus = useAssistantStore((s) => s.fetchStatus);
  const fetchChannels = useAssistantStore((s) => s.fetchChannels);
  const setChannel = useAssistantStore((s) => s.setChannel);
  const channels = useAssistantStore((s) => s.channels);
  const channelId = useAssistantStore((s) => s.channelId);
  const busy = useAssistantStore((s) => s.isSending || Boolean(s.status?.busy));
  const connected = useAssistantStore((s) => Boolean(s.status?.connected));
  const [view, setView] = useState<"chat" | "settings">("settings");
  const [statusReady, setStatusReady] = useState(false);
  const [adding, setAdding] = useState(false);
  const [updateNote, setUpdateNote] = useState("");

  useEffect(() => {
    if (!isTauri()) return;
    let cancel = false;
    void installAppUpdate((message) => {
      if (!cancel) setUpdateNote(message);
    }).catch((err: unknown) => {
      if (!cancel) setUpdateNote(err instanceof Error ? err.message : "업데이트 확인에 실패했습니다");
    });
    return () => {
      cancel = true;
    };
  }, []);

  // 채널 목록을 받기 전에 불러오면, 활성 채널이 아닌 채널에 빈 대화가 생긴다.
  useEffect(() => {
    if (user && channels.length > 0) void load(user.user_id, channelId);
  }, [user, load, channelId, channels.length]);

  useEffect(() => {
    const unsub = subscribe();
    void fetchChannels();
    void fetchStatus().finally(() => {
      const ok = Boolean(useAssistantStore.getState().status?.connected);
      setView(ok ? "chat" : "settings");
      setStatusReady(true);
    });
    return unsub;
  }, [subscribe, fetchStatus, fetchChannels]);

  const openChat = () => {
    if (!connected) return;
    setView("chat");
  };

  const openChannel = (id: string) => {
    if (!connected || busy) return;
    setView("chat");
    void setChannel(id);
  };

  const activeChannel = channels.find((c) => c.id === channelId);

  return (
    <div className="relative flex h-screen overflow-hidden">
      {updateNote ? (
        <p className="absolute left-0 right-0 top-0 z-50 px-3 py-1 text-center text-xs" style={{ background: "#fbbf24", color: "#1c1917" }}>
          {updateNote}
        </p>
      ) : null}
      <nav className="flex w-[72px] shrink-0 flex-col items-center gap-2 py-3" style={{ background: "var(--dc-bg)" }}>
        <button
          onClick={openChat}
          className="flex h-12 w-12 shrink-0 items-center justify-center"
          title="KODEX AI"
        >
          <AppMark size={48} />
        </button>
        <div className="h-0.5 w-8 shrink-0 rounded" style={{ background: "var(--dc-border)" }} />
        <div className="dc-scroll flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto">
          {channels.map((channel) => {
            const current = channel.id === channelId;
            return (
              <div key={channel.id} className="relative flex w-14 shrink-0 flex-col items-center gap-0.5">
                <button
                  onClick={() => (current ? openChat() : openChannel(channel.id))}
                  className="flex h-12 w-12 items-center justify-center"
                  style={{
                    background: current ? "var(--dc-blurple)" : "#313338",
                    color: "#fff",
                    opacity: connected ? 1 : 0.45,
                    borderRadius: current ? 16 : 24,
                  }}
                  title={
                    connected
                      ? `${channel.name}${channel.description ? ` — ${channel.description}` : ""}`
                      : "모델 연결 후 이용할 수 있습니다"
                  }
                >
                  <ChannelIcon icon={channel.icon} size={22} />
                </button>
                <span
                  className="w-14 truncate text-center text-[9px] leading-3"
                  style={{ color: current ? "var(--dc-text)" : "var(--dc-muted)" }}
                >
                  {channel.name}
                </span>
                {!channel.credentialsReady ? (
                  <span
                    className="pointer-events-none absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full"
                    style={{ background: "var(--dc-danger)", border: "2px solid var(--dc-bg)" }}
                    title="계정 정보가 필요합니다"
                  />
                ) : null}
              </div>
            );
          })}

          <button
            onClick={() => setAdding(true)}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[16px]"
            style={{ background: "#313338", color: "var(--dc-online)" }}
            title="채널 추가"
          >
            <Plus size={22} />
          </button>
        </div>

        <div className="my-1 h-0.5 w-8 shrink-0 rounded" style={{ background: "var(--dc-border)" }} />
        <button
          onClick={() => setView("settings")}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[16px]"
          style={{ background: view === "settings" ? "var(--dc-blurple)" : "#313338", color: "#fff" }}
          title="설정"
        >
          <Settings size={22} />
        </button>
      </nav>

      <aside className="flex w-60 shrink-0 flex-col" style={{ background: "var(--dc-sidebar)" }}>
        <div className="flex h-12 flex-col justify-center px-4 shadow-[0_1px_0_var(--dc-border)]">
          <span className="truncate text-sm font-semibold" style={{ color: "var(--dc-text)" }}>
            {activeChannel?.name ?? (channels.length === 0 ? "채널 없음" : "KODEX AI")}
          </span>
          {activeChannel && !activeChannel.credentialsReady ? (
            <button
              onClick={() => setView("settings")}
              className="truncate text-left text-[11px]"
              style={{ color: "var(--dc-danger)" }}
            >
              계정 정보 필요 · 설정에서 입력
            </button>
          ) : activeChannel?.toolCount ? (
            <span className="truncate text-[11px]" style={{ color: "var(--dc-faint)" }}>
              툴 {activeChannel.toolCount}개
            </span>
          ) : null}
        </div>
        {!connected ? (
          <div className="flex flex-1 items-start px-4 py-4">
            <p className="text-xs leading-5" style={{ color: "var(--dc-muted)" }}>
              먼저 CLI를 설치하고 계정에 로그인한 뒤 연결하면 대화를 시작할 수 있습니다.
            </p>
          </div>
        ) : channels.length === 0 ? (
          <div className="flex flex-1 items-start px-4 py-4">
            <p className="text-xs leading-5" style={{ color: "var(--dc-muted)" }}>
              조회할 데이터는 채널이 제공합니다. 채널을 추가하면 대화를 시작할 수 있습니다.
            </p>
          </div>
        ) : (
          <ConversationList onOpenChat={openChat} />
        )}
        <UserPanel onOpenSettings={() => setView("settings")} />
      </aside>

      <main className="min-w-0 flex-1">
        {!statusReady ? (
          <div className="flex h-full items-center justify-center" style={{ background: "var(--dc-main)" }}>
            <p className="text-sm" style={{ color: "var(--dc-muted)" }}>연결 상태 확인 중…</p>
          </div>
        ) : view === "settings" || !connected ? (
          <SettingsPanel
            setup={!connected}
            onBack={openChat}
            onConnected={() => setView("chat")}
          />
        ) : channels.length === 0 ? (
          <div
            className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center"
            style={{ background: "var(--dc-main)" }}
          >
            <div className="app-mark-glow h-16 w-16">
              <AppMark size={64} />
            </div>
            <h2 className="text-lg font-semibold" style={{ color: "var(--dc-text)" }}>연결된 채널이 없습니다</h2>
            <p className="max-w-md text-sm leading-6" style={{ color: "var(--dc-muted)" }}>
              채널은 AI가 조회할 데이터와 툴을 제공합니다. 담당자에게 받은 채널 URL과 API 키를 넣어 추가하세요.
            </p>
            <button
              onClick={() => setAdding(true)}
              className="flex items-center gap-1.5 rounded px-4 py-2 text-sm font-semibold text-white"
              style={{ background: "var(--dc-blurple)" }}
            >
              <Plus size={16} />
              채널 추가
            </button>
          </div>
        ) : (
          <ChatView />
        )}
      </main>

      {adding && <AddChannelDialog onClose={() => setAdding(false)} />}
    </div>
  );
}

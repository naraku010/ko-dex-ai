"use client";

import { useRef, useState } from "react";
import { Archive, FolderOpen, FolderPlus, MessageSquarePlus, Pencil, RotateCcw, Trash2, Users } from "lucide-react";
import { sidecarRequest } from "@/lib/tauri";
import { useAssistantStore } from "@/store/assistantStore";
import { useAuthStore } from "@/store/authStore";
import { useConversationStore } from "@/store/conversationStore";
import type { Conversation } from "@/types/assistant";

export default function ConversationList({ onOpenChat }: { onOpenChat?: () => void }) {
  const user = useAuthStore((s) => s.user);
  const busy = useAssistantStore((s) => s.isSending || Boolean(s.status?.busy));
  const { conversations, currentId, projects, create, select, rename, remove, addProject } =
    useConversationStore();
  const sync = useConversationStore((s) => s.sync);
  const sharedSupported = useConversationStore((s) => s.sharedSupported);
  const listError = useConversationStore((s) => s.projectError);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [projectError, setProjectError] = useState("");
  const [picking, setPicking] = useState(false);
  const [editingProject, setEditingProject] = useState<string | null>(null);
  const renameProject = useConversationStore((s) => s.renameProject);
  const cancelRename = useRef(false);

  if (!user) return null;

  const general = conversations.filter((c) => !c.project_id);

  const newProject = async () => {
    setProjectError("");
    setPicking(true);
    try {
      const project = await addProject(user.user_id);
      if (project) onOpenChat?.();
    } catch (err) {
      setProjectError(err instanceof Error ? err.message : String(err));
    } finally {
      setPicking(false);
    }
  };

  const startRename = (id: string, name: string) => {
    cancelRename.current = false;
    setEditingId(null);
    setEditingProject(id);
    setDraft(name);
  };

  const saveProjectName = (id: string, current: string) => {
    if (cancelRename.current) {
      cancelRename.current = false;
      return;
    }
    if (editingProject !== id) return;
    setEditingProject(null);
    const name = draft.trim();
    if (!name || name === current) return;
    setProjectError("");
    renameProject(id, name).catch((err) => setProjectError(err instanceof Error ? err.message : String(err)));
  };

  const renderRow = (c: Conversation) => {
    const active = c.id === currentId;
    return (
      <div
        key={c.id}
        className="group flex items-center gap-1 rounded px-2 py-1.5"
        style={{ background: active ? "var(--dc-active)" : "transparent" }}
      >
        {editingId === c.id ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              void rename(user.user_id, c.id, draft);
              setEditingId(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                void rename(user.user_id, c.id, draft);
                setEditingId(null);
              }
              if (e.key === "Escape") setEditingId(null);
            }}
            className="h-7 min-w-0 flex-1 rounded px-2 text-sm outline-none"
            style={{ background: "var(--dc-bg)", color: "var(--dc-text)" }}
          />
        ) : (
          <button
            onClick={() => {
              void select(user.user_id, c.id);
              onOpenChat?.();
            }}
            disabled={busy && !active}
            className="min-w-0 flex-1 truncate text-left text-sm disabled:cursor-not-allowed disabled:opacity-50"
            style={{ color: active ? "var(--dc-text)" : "var(--dc-muted)" }}
            title={busy && !active ? "응답이 끝난 뒤에 옮길 수 있습니다" : c.title}
          >
            {c.title}
          </button>
        )}
        <button
          className="hidden rounded p-1 group-hover:block"
          style={{ color: "var(--dc-faint)" }}
          onClick={() => {
            setEditingProject(null);
            setEditingId(c.id);
            setDraft(c.title);
          }}
          title="이름 바꾸기"
        >
          <Pencil size={12} />
        </button>
        <button
          className="hidden rounded p-1 group-hover:block disabled:cursor-not-allowed disabled:opacity-40"
          style={{ color: "var(--dc-danger)" }}
          onClick={() => void remove(user.user_id, c.id)}
          disabled={busy}
          title={busy ? "응답이 끝난 뒤에 삭제할 수 있습니다" : "삭제"}
        >
          <Trash2 size={12} />
        </button>
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="dc-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div className="flex items-center justify-between px-1 py-3">
          <h2 className="text-xs font-bold uppercase tracking-wide" style={{ color: "var(--dc-muted)" }}>
            프로젝트
          </h2>
          <button
            onClick={() => void newProject()}
            disabled={busy || picking}
            className="rounded p-1 disabled:cursor-not-allowed disabled:opacity-40"
            style={{ color: "var(--dc-muted)" }}
            title={
              picking
                ? "프로젝트를 만드는 중입니다"
                : sharedSupported
                  ? "프로젝트 만들기 (고른 폴더를 서버에 올려 채널 사용자 모두와 공유)"
                  : "프로젝트 만들기 (폴더 연결)"
            }
          >
            <FolderPlus size={16} />
          </button>
        </div>
        {picking && sync && sync.projectId === null && (
          <p className="px-2 pb-2 text-xs" style={{ color: "var(--dc-blurple)" }}>
            서버에 올리는 중 {sync.done}/{sync.total}
          </p>
        )}
        {(projectError || listError) && (
          <p className="px-2 pb-2 text-xs" style={{ color: "var(--dc-danger)" }}>
            {projectError || `공유 프로젝트 목록을 못 받았습니다: ${listError}`}
          </p>
        )}
        {projects.length === 0 && (
          <p className="px-2 pb-2 text-xs" style={{ color: "var(--dc-faint)" }}>
            {sharedSupported
              ? "문서 폴더를 고르면 서버에 올려 채널 사용자 모두가 같은 프로젝트를 씁니다. 대화는 각자 따로입니다."
              : "문서 폴더를 연결하면 그 폴더 기준으로 대화합니다."}
          </p>
        )}
        {projects.map((p) => {
          const rows = conversations.filter((c) => c.project_id === p.id);
          return (
            <div key={p.id} className="mb-2">
              <div className="group flex items-center gap-1 px-1 py-1">
                {p.shared ? (
                  <Users size={14} style={{ color: "var(--dc-blurple)" }} />
                ) : (
                  <FolderOpen size={14} style={{ color: "var(--dc-muted)" }} />
                )}
                {editingProject === p.id ? (
                  <input
                    autoFocus
                    value={draft}
                    maxLength={60}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => saveProjectName(p.id, p.name)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") {
                        cancelRename.current = true;
                        setEditingProject(null);
                      }
                    }}
                    className="h-7 min-w-0 flex-1 rounded px-2 text-sm font-semibold outline-none"
                    style={{ background: "var(--dc-bg)", color: "var(--dc-text)" }}
                  />
                ) : (
                  <span
                    className="min-w-0 flex-1 truncate text-sm font-semibold"
                    style={{ color: "var(--dc-text)" }}
                    title={p.shared ? `공유 프로젝트${p.createdBy ? ` · 만든 사람 ${p.createdBy}` : ""}` : p.folder}
                    onDoubleClick={() => startRename(p.id, p.name)}
                  >
                    {p.name}
                  </span>
                )}
                <button
                  className="hidden rounded p-1 group-hover:block"
                  style={{ color: "var(--dc-faint)" }}
                  onClick={() => startRename(p.id, p.name)}
                  title={p.shared ? "이름 바꾸기 (채널 사용자 모두에게 바뀝니다)" : "이름 바꾸기"}
                >
                  <Pencil size={12} />
                </button>
                <button
                  onClick={() => {
                    void create(user.user_id, p.id);
                    onOpenChat?.();
                  }}
                  disabled={busy}
                  className="rounded p-1 disabled:cursor-not-allowed disabled:opacity-40"
                  style={{ color: "var(--dc-muted)" }}
                  title="이 프로젝트에서 새 대화"
                >
                  <MessageSquarePlus size={14} />
                </button>
              </div>
              <div className="space-y-0.5 pl-3">{rows.map(renderRow)}</div>
            </div>
          );
        })}
        {sharedSupported && <ProjectTrash busy={busy} onError={setProjectError} />}

        <div className="flex items-center justify-between px-1 py-3">
          <h2 className="text-xs font-bold uppercase tracking-wide" style={{ color: "var(--dc-muted)" }}>
            일반 대화
          </h2>
          <button
            onClick={() => {
              void create(user.user_id);
              onOpenChat?.();
            }}
            disabled={busy}
            className="rounded p-1 disabled:cursor-not-allowed disabled:opacity-40"
            style={{ color: "var(--dc-muted)" }}
            title={busy ? "응답이 끝난 뒤에 만들 수 있습니다" : "새 대화"}
          >
            <MessageSquarePlus size={16} />
          </button>
        </div>
        <div className="space-y-0.5">{general.map(renderRow)}</div>
      </div>
    </div>
  );
}

type TrashItem = { id: string; name: string; deletedBy?: string; deletedAt: string; purgeAt: string; fileCount: number };

function ProjectTrash({ busy, onError }: { busy: boolean; onError: (message: string) => void }) {
  const user = useAuthStore((s) => s.user);
  const channelId = useConversationStore((s) => s.channelId);
  const restoreProject = useConversationStore((s) => s.restoreProject);
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  const fail = (err: unknown) => onError(err instanceof Error ? err.message : String(err));
  const load = () =>
    sidecarRequest<{ projects: TrashItem[] }>("listProjectTrash", { channelId }).then(
      (res) => setItems(res.projects ?? []),
      fail,
    );
  const day = (iso: string) => new Date(iso).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });

  if (!user) return null;
  return (
    <div className="mb-2 px-1">
      <button
        onClick={() => (items ? setItems(null) : void load())}
        className="flex items-center gap-1 py-1 text-xs"
        style={{ color: "var(--dc-faint)" }}
        title="지운 공유 프로젝트는 30일 동안 보관됩니다"
      >
        <Archive size={12} />
        {items ? "휴지통 닫기" : "휴지통"}
      </button>
      {items && items.length === 0 && (
        <p className="px-1 pb-1 text-xs" style={{ color: "var(--dc-faint)" }}>
          휴지통이 비어 있습니다.
        </p>
      )}
      {items?.map((item) => (
        <div key={item.id} className="flex items-center gap-1 rounded px-1 py-1">
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs" style={{ color: "var(--dc-muted)" }}>
              {item.name}
            </div>
            <div className="truncate text-[11px]" style={{ color: "var(--dc-faint)" }}>
              {item.deletedBy ? `${item.deletedBy} · ` : ""}
              {day(item.deletedAt)} 삭제 · {day(item.purgeAt)} 영구 삭제
            </div>
          </div>
          <button
            disabled={busy || working !== null}
            onClick={() => {
              setWorking(item.id);
              onError("");
              restoreProject(user.user_id, item.id)
                .then(() => setItems((list) => list?.filter((x) => x.id !== item.id) ?? null), fail)
                .finally(() => setWorking(null));
            }}
            className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs disabled:cursor-not-allowed disabled:opacity-40"
            style={{ color: "var(--dc-blurple)" }}
            title="되살리기"
          >
            <RotateCcw size={12} />
            {working === item.id ? "되살리는 중" : "되살리기"}
          </button>
        </div>
      ))}
    </div>
  );
}

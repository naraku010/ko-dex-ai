"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { Loader2, Plus, Send, Square, X } from "lucide-react";
import AppMark from "@/components/brand/AppMark";
import DocsTree from "@/components/channels/DocsTree";
import { isFilesChannel } from "@/components/channels/ChannelMark";
import { useAssistantStore } from "@/store/assistantStore";
import { useAuthStore } from "@/store/authStore";
import { useConversationStore } from "@/store/conversationStore";
import { useFilesStore } from "@/store/filesStore";
import MessageBubble from "./MessageBubble";
import DateDivider, { dayKey } from "./DateDivider";
import ModelPicker, { AdapterPicker } from "./ModelPicker";
import ProjectBar from "./ProjectBar";
import IndexLog from "./IndexLog";
import DrawingPagePicker, { type DrawingPage } from "./DrawingPagePicker";
import { sidecarRequest } from "@/lib/tauri";

type PendingFile = {
  id: string;
  file: File;
  name: string;
  mime: string;
  previewUrl: string | null;
};

const MAX_ATTACH = 6;
const MAX_BYTES = 20 * 1024 * 1024;

function fallbackName(mime: string) {
  if (mime === "image/jpeg") return "붙여넣은-이미지.jpg";
  if (mime === "image/webp") return "붙여넣은-이미지.webp";
  if (mime === "image/gif") return "붙여넣은-이미지.gif";
  if (mime.startsWith("image/")) return "붙여넣은-이미지.png";
  return "붙여넣은-파일";
}

function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const raw = String(reader.result || "");
      const comma = raw.indexOf(",");
      resolve(comma >= 0 ? raw.slice(comma + 1) : raw);
    };
    reader.onerror = () => reject(reader.error ?? new Error("파일을 읽지 못했습니다."));
    reader.readAsDataURL(file);
  });
}

export default function ChatView() {
  const user = useAuthStore((s) => s.user);
  const conversations = useConversationStore((s) => s.conversations);
  const currentId = useConversationStore((s) => s.currentId);
  const { messages, status, isSending, error, send, cancel, setModel, setAdapter, followups, followupsLoading, pushNote, reviseNote } = useAssistantStore();
  const channels = useAssistantStore((s) => s.channels);
  const channelId = useAssistantStore((s) => s.channelId);
  const refreshActiveChannel = useAssistantStore((s) => s.refreshActiveChannel);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<PendingFile[]>([]);
  const [attachBusy, setAttachBusy] = useState(false);
  const [encoding, setEncoding] = useState(false);
  const [attachError, setAttachError] = useState("");
  const [picker, setPicker] = useState<{ file: File; bytesBase64: string; pages: DrawingPage[]; max: number } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const smoothScroll = useRef(false);
  const current = conversations.find((c) => c.id === currentId);
  const indexLog = useConversationStore((s) => s.indexLog);
  const logFor = current?.project_id && indexLog?.projectId === current.project_id ? indexLog : null;
  // 로그는 시작될 때의 마지막 메시지 뒤에 붙는다. -1은 맨 앞, 그 메시지가 이 대화에 없으면 맨 끝.
  const logAt = !logFor
    ? -2
    : logFor.afterId === null
      ? -1
      : (() => {
          const index = messages.findIndex((m) => m.id === logFor.afterId);
          return index < 0 ? messages.length : index;
        })();
  const indexLogView = logFor && current?.project_id ? <IndexLog projectId={current.project_id} /> : null;

  // 탭이나 대화를 바꿀 때는 애니메이션 없이 맨 아래에서 시작한다.
  useEffect(() => {
    smoothScroll.current = false;
  }, [currentId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({
      behavior: smoothScroll.current ? "smooth" : "auto",
      block: "end",
    });
  }, [messages, followups, followupsLoading]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  useEffect(() => {
    if (!channelId) return;
    void refreshActiveChannel();
  }, [channelId, refreshActiveChannel]);

  // 사이드카가 아직 이전 턴을 물고 있으면 status.busy로도 막는다.
  const busy = isSending || Boolean(status?.busy) || attachBusy || encoding;
  const channel = channels.find((c) => c.id === channelId);
  const canAttachPdf = isFilesChannel(channel);

  const addFiles = (list: File[]) => {
    setAttachError("");
    setAttachments((prev) => {
      const next = [...prev];
      for (const file of list) {
        if (next.length >= MAX_ATTACH) {
          setAttachError("파일은 한 번에 6개까지 붙일 수 있습니다.");
          break;
        }
        if (file.size > MAX_BYTES) {
          setAttachError("20MB보다 큰 파일은 붙일 수 없습니다.");
          continue;
        }
        const mime = file.type || "";
        const name = file.name || fallbackName(mime);
        next.push({
          id: crypto.randomUUID(),
          file,
          name,
          mime,
          previewUrl: mime.startsWith("image/") ? URL.createObjectURL(file) : null,
        });
      }
      return next;
    });
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((item) => item.id !== id);
    });
  };

  const submit = (value?: string) => {
    const next = (value ?? text).trim();
    const files = value !== undefined ? [] : attachments;
    if ((!next && files.length === 0) || !user || busy) return;
    smoothScroll.current = true;
    setText("");
    setAttachments([]);
    if (inputRef.current) inputRef.current.style.height = "auto";
    if (files.length === 0) {
      void send(next, user.user_id);
      return;
    }
    setEncoding(true);
    void (async () => {
      try {
        const payload = await Promise.all(files.map(async (item) => ({
          name: item.name,
          mime: item.mime,
          bytesBase64: await fileToBase64(item.file),
          previewUrl: item.previewUrl ?? undefined,
        })));
        await send(next, user.user_id, payload);
      } catch (err) {
        setAttachError(err instanceof Error ? err.message : String(err));
      } finally {
        setEncoding(false);
      }
    })();
  };

  const sendDrawing = async (file: File, bytesBase64: string, pages: DrawingPage[]) => {
    if (!user) return;
    const names = pages.map((item) => item.tag || `${item.page}쪽`);
    const text = names.length
      ? `'${file.name}' 도면을 올렸습니다. 이미지로 만들 도면: ${names.join(", ")}`
      : `'${file.name}' 도면을 올렸습니다.`;
    await send(text, user.user_id, [{
      name: file.name,
      mime: file.type || "application/pdf",
      bytesBase64,
      drawing: true,
      pages: pages.map((item) => item.page),
    }]);
  };

  const pickDrawings = async (pages: DrawingPage[]) => {
    const pending = picker;
    setPicker(null);
    if (!pending) return;
    setAttachBusy(true);
    try {
      await sendDrawing(pending.file, pending.bytesBase64, pages);
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : String(err));
    } finally {
      setAttachBusy(false);
    }
  };

  const uploadPdf = async (file: File) => {
    if (!channelId || !user) return;
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setAttachError("PDF만 올릴 수 있습니다.");
      return;
    }
    setAttachBusy(true);
    setAttachError("");
    smoothScroll.current = true;
    if (status?.imageGen?.connected) {
      try {
        const bytesBase64 = await fileToBase64(file);
        const listed = await sidecarRequest<{ pages: number; items: DrawingPage[]; max: number }>("drawingPages", {
          name: file.name,
          bytesBase64,
        });
        const tagged = listed.items.filter((item) => item.tag);
        const choices = tagged.length ? tagged : listed.items;
        if (choices.length > 1) {
          setPicker({ file, bytesBase64, pages: choices, max: listed.max || 4 });
          return;
        }
        await sendDrawing(file, bytesBase64, choices);
      } catch (err) {
        setAttachError(err instanceof Error ? err.message : String(err));
      } finally {
        setAttachBusy(false);
        if (fileRef.current) fileRef.current.value = "";
      }
      return;
    }
    const lines = [`'${file.name}' 도면을 이 PC에 받는 중입니다. 서버로는 안 보냅니다.`];
    const noteId = pushNote(lines[0]);
    const say = (line: string) => {
      lines.push(line);
      reviseNote(noteId, lines.join("\n"));
    };
    const comments = [
      [2500, "도면에서 글자를 읽고 있습니다. 도면이 크면 이 단계가 깁니다."],
      [8000, "아직 글자를 읽는 중입니다."],
      [16000, "큰 도면이라 조금 더 걸립니다. 끝나면 부품명과 재질을 정리합니다."],
    ] as const;
    const timers = comments.map(([delay, line]) => window.setTimeout(() => say(line), delay));
    try {
      useFilesStore.getState().bind(channelId);
      await useFilesStore.getState().upload(file);
      timers.forEach((timer) => window.clearTimeout(timer));
      say(`'${file.name}' 을 이 PC에 저장했습니다. 이어서 그리드를 뽑겠습니다.`);
      const drawing = channel?.id === "woosung";
      const note = drawing
        ? `방금 '${file.name}' 도면을 이 PC에 올렸습니다. pmi_grid는 한 번만 호출하고, 만들어진 엑셀 경로와 건수만 말해주세요. 표는 다시 그리지 마세요. PMI Yes인 태그가 없어 확인필요가 오면 전체 태그로 만들지 저에게 물어보세요.`
        : `방금 '${file.name}' 문서를 올렸습니다. 목록을 확인하고 분류를 도와주세요.`;
      void send(note, user.user_id);
    } catch (err) {
      timers.forEach((timer) => window.clearTimeout(timer));
      const message = err instanceof Error ? err.message : String(err);
      say(`도면을 저장하지 못했습니다. ${message}`);
      setAttachError(message);
    } finally {
      setAttachBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="flex h-full min-w-0">
    <div className="flex min-w-0 flex-1 flex-col" style={{ background: "var(--dc-main)" }}>
      <header className="flex h-12 items-center justify-between px-4 shadow-[0_1px_0_var(--dc-border)]">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold" style={{ color: "var(--dc-text)" }}>
            {current?.title ?? channel?.name ?? "EGI AI"}
          </h1>
          <p className="text-[11px]" style={{ color: busy ? "var(--dc-blurple)" : status?.connected ? "var(--dc-online)" : "var(--dc-faint)" }}>
            {busy
              ? attachBusy
                ? status?.imageGen?.connected
                  ? "도면 이미지를 만드는 중입니다"
                  : "도면을 읽는 중입니다"
                : "에이든이 생각 중입니다"
              : status?.connected
                ? `${status.adapterLabel} 연결됨`
                : "설정에서 CLI를 연결하세요"}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {(status?.adapters ?? []).filter((a) => a.ready).length > 1 && (
            <AdapterPicker
              adapters={(status?.adapters ?? []).filter((a) => a.ready)}
              selected={status?.adapterId ?? "claude"}
              disabled={busy}
              onSelect={(id) => void setAdapter(id)}
            />
          )}
          <ModelPicker
            models={status?.models ?? []}
            selected={status?.model ?? ""}
            disabled={busy}
            onSelect={(model) => void setModel(model)}
          />
        </div>
      </header>

      {current?.project_id ? (
        <ProjectBar key={current.project_id} projectId={current.project_id} busy={busy} />
      ) : null}

      <div className="dc-scroll min-h-0 flex-1 overflow-y-auto py-4">
        {messages.length === 0 ? (
          <div className="mx-auto flex max-w-xl flex-col items-center px-6 pt-16 text-center">
            <div className="app-mark-glow mb-4 h-16 w-16">
              <AppMark size={64} />
            </div>
            <h2 className="text-xl font-semibold" style={{ color: "var(--dc-text)" }}>
              {channel?.name ?? "EGI AI"}
            </h2>
            <p className="mt-2 text-sm" style={{ color: "var(--dc-muted)" }}>
              {channel?.description || `이 채널의 툴 ${channel?.toolCount ?? 0}개로 답합니다. 무엇을 조회할까요?`}
            </p>
            {channel?.toolLabels.length ? (
              <div className="mt-6 flex flex-wrap justify-center gap-1.5">
                {channel.toolLabels.slice(0, 10).map((label) => (
                  <span
                    key={label}
                    className="rounded-full px-2.5 py-1 text-xs"
                    style={{ background: "var(--dc-sidebar)", color: "var(--dc-secondary)", border: "1px solid var(--dc-border)" }}
                  >
                    {label}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <>
            {logAt === -1 && indexLogView}
            {messages.map((m, index) => (
              <Fragment key={m.id}>
                {dayKey(m.createdAt) !== dayKey(messages[index - 1]?.createdAt) && (
                  <DateDivider iso={m.createdAt} />
                )}
                <MessageBubble message={m} />
                {index === logAt && indexLogView}
              </Fragment>
            ))}
          </>
        )}
        {(messages.length === 0 || logAt === messages.length) && indexLogView}
        <div ref={bottomRef} />
      </div>

      {(error || attachError) && (
        <p className="px-4 pb-2 text-xs" style={{ color: "var(--dc-danger)" }}>{error || attachError}</p>
      )}

      {(followupsLoading || followups.length > 0) && !busy && (
        <div className="flex flex-col gap-1.5 px-4 pb-2">
          <p className="text-[11px]" style={{ color: "var(--dc-faint)" }}>이어서 물어볼까요</p>
          <div className="flex flex-wrap gap-1.5">
            {followupsLoading && followups.length === 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs" style={{ color: "var(--dc-faint)" }}>
                <Loader2 size={11} className="animate-spin" />
                다음 질문 만드는 중
              </span>
            )}
            {followups.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => submit(item)}
                disabled={busy}
                className="rounded-full px-3 py-1.5 text-left text-xs disabled:cursor-not-allowed disabled:opacity-40"
                style={{ background: "var(--dc-sidebar)", color: "var(--dc-text)", border: "1px solid var(--dc-border)" }}
              >
                {item}
              </button>
            ))}
          </div>
        </div>
      )}

      <form
        className="px-4 pb-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          if (busy) return;
          addFiles(Array.from(e.dataTransfer.files));
        }}
      >
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachments.map((item) => (
              <span
                key={item.id}
                className="inline-flex max-w-full items-center gap-1.5 rounded-lg py-1 pr-1 pl-1.5 text-xs"
                style={{ background: "var(--dc-sidebar)", color: "var(--dc-text)", border: "1px solid var(--dc-border)" }}
              >
                {item.previewUrl ? (
                  <img src={item.previewUrl} alt="" className="h-8 w-8 rounded object-cover" />
                ) : null}
                <span className="max-w-40 truncate">{item.name}</span>
                <button
                  type="button"
                  onClick={() => removeAttachment(item.id)}
                  className="flex h-5 w-5 items-center justify-center rounded"
                  style={{ color: "var(--dc-faint)" }}
                  title="빼기"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div
          className="flex items-end gap-2 rounded-lg px-3 py-2"
          style={{ background: "var(--dc-input)" }}
        >
          {canAttachPdf ? (
            <>
              <input
                ref={fileRef}
                type="file"
                accept="application/pdf,.pdf"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void uploadPdf(file);
                }}
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => fileRef.current?.click()}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full disabled:opacity-40"
                style={{ background: "var(--dc-sidebar)", color: "var(--dc-text)", border: "1px solid var(--dc-border)" }}
                title="도면 업로드"
              >
                {attachBusy ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
              </button>
            </>
          ) : null}
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const pasted: File[] = [];
              for (const item of Array.from(e.clipboardData.items)) {
                if (item.kind !== "file") continue;
                const file = item.getAsFile();
                if (file) pasted.push(file);
              }
              if (!pasted.length) return;
              e.preventDefault();
              addFiles(pasted);
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
              e.preventDefault();
              submit();
            }}
            disabled={busy}
            placeholder={
              busy
                ? attachBusy
                  ? "PDF 올리는 중"
                  : "이전 요청을 처리하는 중입니다"
                : canAttachPdf
                  ? "이미지나 파일을 붙여 넣거나, 도면은 업로드 버튼으로 보내세요"
                  : "메시지 보내기 · 이미지나 파일은 붙여 넣기"
            }
            rows={1}
            className="max-h-40 min-h-8 flex-1 resize-none overflow-y-auto bg-transparent py-1.5 text-sm leading-5 outline-none disabled:cursor-not-allowed"
            style={{ color: "var(--dc-text)", whiteSpace: "pre-wrap" }}
          />
          {busy ? (
            <button type="button" onClick={() => void cancel()} className="flex h-8 w-8 items-center justify-center rounded-full" style={{ color: "var(--dc-danger)" }} title="중단">
              <Square size={16} />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!text.trim() && attachments.length === 0}
              className="flex h-8 w-8 items-center justify-center rounded-full disabled:opacity-40"
              style={{ color: "var(--dc-blurple)" }}
            >
              <Send size={16} />
            </button>
          )}
        </div>
      </form>
    </div>
    {picker ? (
      <DrawingPagePicker
        fileName={picker.file.name}
        pages={picker.pages}
        max={picker.max}
        onCancel={() => setPicker(null)}
        onConfirm={(pages) => void pickDrawings(pages)}
      />
    ) : null}
    {channelId ? (
      <DocsTree
        key={`${channelId}:${current?.project_id ?? ""}:${canAttachPdf ? 1 : 0}`}
        channelId={channelId}
        tools={channel?.tools ?? []}
        toolLabels={channel?.toolLabels ?? []}
        showFiles={canAttachPdf}
        projectId={current?.project_id ?? null}
      />
    ) : null}
    </div>
  );
}

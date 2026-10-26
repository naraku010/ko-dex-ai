"use client";

import { memo, useEffect, useState } from "react";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import AppMark from "@/components/brand/AppMark";
import { collapseCardBlocks } from "@/lib/cards";
import { collapseReports } from "@/lib/reports";
import { sidecarRequest } from "@/lib/tauri";
import type { ChatMessage, FileSpec } from "@/types/assistant";
import CalendarView from "./CalendarView";
import CardsView from "./CardsView";
import ChartView from "./ChartView";
import DatasheetDbCard from "./DatasheetDbCard";
import MarkdownText from "./MarkdownText";
import ExcelView from "./ExcelView";
import FileView from "./FileView";
import ImageViewer from "./ImageViewer";
import ReportView from "./ReportView";

function visibleTools(message: ChatMessage) {
  return message.tools.filter((tool) => tool.tool !== "propose_followups");
}

function thinkingLabel(message: ChatMessage) {
  const tools = visibleTools(message);
  const running = tools.find((tool) => tool.status === "running");
  if (running) return `${running.label} 중`;
  if (message.text) return "이어서 작성하는 중";
  if (tools.length > 0) return "결과를 정리하는 중";
  return "생각하는 중";
}

function ThinkingStatus({ message }: { message: ChatMessage }) {
  return (
    <div
      className="inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs"
      style={{ background: "var(--dc-sidebar)", border: "1px solid var(--dc-border)", color: "var(--dc-muted)" }}
    >
      <span className="thinking-dots" aria-hidden>
        <i />
        <i />
        <i />
      </span>
      {thinkingLabel(message)}
    </div>
  );
}

function isImageName(name: string) {
  return /\.(png|jpe?g|webp|gif|bmp)$/i.test(name);
}

function LocalImage({ file }: { file: FileSpec }) {
  const [src, setSrc] = useState(file.previewUrl || "");
  useEffect(() => {
    if (src || !file.path || !isImageName(file.name)) return;
    let gone = false;
    void sidecarRequest<{ bytesBase64?: string; mime?: string }>("previewImage", { path: file.path })
      .then((res) => {
        if (!gone && res?.bytesBase64) setSrc(`data:${res.mime || "image/png"};base64,${res.bytesBase64}`);
      })
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [file.name, file.path, src]);
  const [open, setOpen] = useState(false);
  if (!src) return null;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="block cursor-zoom-in" title="크게 보기">
        <img src={src} alt={file.name} className="max-h-64 max-w-full rounded-lg" />
      </button>
      {open && <ImageViewer src={src} alt={file.name} onClose={() => setOpen(false)} />}
    </>
  );
}

/** 말풍선 왼쪽의 시각. 날짜는 목록의 구분선이 맡는다. */
function formatTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" });
}

function MessageTime({ iso }: { iso: string | undefined }) {
  if (!iso) return null;
  const label = formatTime(iso);
  if (!label) return null;
  return (
    <time
      dateTime={iso}
      title={new Date(iso).toLocaleString("ko-KR")}
      className="shrink-0 self-end pb-1 text-[11px] leading-none"
      style={{ color: "var(--dc-faint)" }}
    >
      {label}
    </time>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    const files = message.files ?? [];
    return (
      <div className="flex items-end justify-end gap-1.5 px-4 py-1.5">
        <MessageTime iso={message.createdAt} />
        <div
          className="max-w-[75%] space-y-2 rounded-2xl rounded-br-md px-4 py-2.5 text-sm break-words whitespace-pre-wrap"
          style={{ background: "var(--dc-blurple)", color: "#fff" }}
        >
            {files.map((file) => (
              <div key={file.id}>
                <LocalImage file={file} />
                {!isImageName(file.name) ? <p className="text-xs opacity-80">{file.name}</p> : null}
              </div>
            ))}
            {message.text}
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3 px-4 py-2">
      <div
        className={`-mt-1.5 h-8 w-8 shrink-0 overflow-hidden rounded-full ${message.pending ? "thinking-avatar" : ""}`}
      >
        <AppMark size={32} variant="avatar" />
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm leading-5">
          <span className="font-semibold" style={{ color: "var(--dc-text)" }}>에이든</span>
        </p>

        {visibleTools(message).length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {visibleTools(message).map((tool, index) => (
              <span
                key={`${tool.id}-${index}`}
                title={tool.preview}
                className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs"
                style={{
                  background: "var(--dc-sidebar)",
                  border: `1px solid ${
                    tool.status === "error"
                      ? "rgba(237,66,69,0.5)"
                      : tool.status === "warn"
                        ? "rgba(251,191,36,0.7)"
                        : "var(--dc-border)"
                  }`,
                  color: tool.status === "error" ? "#f87171" : tool.status === "warn" ? "#fbbf24" : "var(--dc-muted)",
                }}
              >
                {tool.status === "running" ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : tool.status === "error" ? (
                  <AlertCircle size={11} />
                ) : tool.status === "warn" ? (
                  <AlertCircle size={11} />
                ) : (
                  <Check size={11} style={{ color: "var(--dc-online)" }} />
                )}
                {tool.label}
              </span>
            ))}
          </div>
        )}

        {message.text && (
          <div className="text-sm leading-relaxed" style={{ color: message.isError ? "#f87171" : "var(--dc-secondary)" }}>
            <MarkdownText text={message.text} />
          </div>
        )}

        {message.pending && <ThinkingStatus message={message} />}

        {!message.pending && collapseCardBlocks(message.cards).map((cards) => (
          <CardsView key={cards.id} cards={cards} />
        ))}

        {(message.files ?? []).map((item) => (
          <div key={item.id} className="space-y-2">
            <LocalImage file={item} />
            <FileView file={item} />
            {item.datasheetProjectId && <DatasheetDbCard projectId={item.datasheetProjectId} />}
          </div>
        ))}

        {!message.pending && (message.excels ?? []).map((item) => (
          <ExcelView key={item.id} book={item} />
        ))}

        {!message.pending && collapseReports(message.reports ?? []).map((item) => (
          <ReportView key={item.id} report={item} />
        ))}

        {!message.pending && (message.calendars ?? []).map((item) => (
          <CalendarView key={item.id} calendar={item} />
        ))}

        {!message.pending && message.charts.map((chart) => (
          <ChartView key={chart.id} chart={chart} />
        ))}

        {!message.pending && <MessageTime iso={message.createdAt} />}
      </div>
    </div>
  );
}

export default memo(MessageBubble);

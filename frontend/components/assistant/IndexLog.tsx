"use client";

import { useEffect, useRef } from "react";
import { Loader2, X } from "lucide-react";
import { useConversationStore } from "@/store/conversationStore";

export default function IndexLog({ projectId }: { projectId: string }) {
  const indexLog = useConversationStore((s) => s.indexLog);
  const job = useConversationStore((s) => s.job);
  const clearIndexLog = useConversationStore((s) => s.clearIndexLog);
  const boxRef = useRef<HTMLDivElement>(null);
  const lines = indexLog?.projectId === projectId ? indexLog.lines : null;
  const running = Boolean(job?.running && job.projectId === projectId);

  useEffect(() => {
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [lines?.length]);

  if (!lines?.length) return null;

  return (
    <div className="mx-4 my-2 rounded-lg" style={{ background: "var(--dc-sidebar)", border: "1px solid var(--dc-border)" }}>
      <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs" style={{ color: "var(--dc-muted)" }}>
        {running ? <Loader2 size={12} className="animate-spin" style={{ color: "var(--dc-blurple)" }} /> : null}
        <span className="flex-1">
          색인 로그{job?.projectId === projectId && job.total > 0 ? ` · ${job.done}/${job.total}${job.failed ? ` · 실패 ${job.failed}` : ""}` : ""}
        </span>
        {!running && (
          <button type="button" onClick={clearIndexLog} className="rounded p-0.5" style={{ color: "var(--dc-faint)" }} title="로그 닫기">
            <X size={12} />
          </button>
        )}
      </div>
      <div
        ref={boxRef}
        className="dc-scroll max-h-60 overflow-y-auto px-3 pb-2 font-mono text-[11px] leading-5 whitespace-pre-wrap"
        style={{ color: "var(--dc-text)" }}
      >
        {lines.map((line, index) => (
          <div
            key={index}
            style={{ color: line.includes("실패:") || line.includes("오류") || line.includes("중단") ? "var(--dc-danger)" : undefined }}
          >
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

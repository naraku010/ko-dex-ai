"use client";

import { memo, useState } from "react";
import { FileSpreadsheet, FileText, FolderOpen, ExternalLink } from "lucide-react";
import { openLocalFile, revealLocalFile } from "@/lib/openFile";
import type { FileSpec } from "@/types/assistant";

function sizeLabel(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function FileView({ file }: { file: FileSpec }) {
  const [error, setError] = useState("");
  const sheet = /\.(xlsx|xls|csv)$/i.test(file.name);
  const Icon = sheet ? FileSpreadsheet : FileText;

  const run = (action: (path: string) => Promise<void>) => {
    setError("");
    action(file.path).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  return (
    <div
      className="flex max-w-md items-center gap-3 rounded-xl px-3 py-2.5"
      style={{ background: "var(--dc-sidebar)", border: "1px solid var(--dc-border)" }}
    >
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
        style={{ background: sheet ? "rgba(33,115,70,0.15)" : "rgba(88,101,242,0.15)", color: sheet ? "#21a366" : "var(--dc-blurple)" }}
      >
        <Icon size={18} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" style={{ color: "var(--dc-text)" }} title={file.path}>
          {file.name}
        </p>
        <p className="truncate text-xs" style={{ color: error ? "#f87171" : "var(--dc-muted)" }}>
          {error || ["다운로드 폴더에 저장됨", sizeLabel(file.size)].filter(Boolean).join(" · ")}
        </p>
      </div>
      <button
        type="button"
        onClick={() => run(openLocalFile)}
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-opacity hover:opacity-80"
        style={{ background: "var(--dc-blurple)", color: "#fff" }}
      >
        <ExternalLink size={12} />
        열기
      </button>
      <button
        type="button"
        onClick={() => run(revealLocalFile)}
        title="폴더에서 보기"
        className="inline-flex items-center rounded-md p-1.5 transition-opacity hover:opacity-80"
        style={{ border: "1px solid var(--dc-border)", color: "var(--dc-muted)" }}
      >
        <FolderOpen size={14} />
      </button>
    </div>
  );
}

export default memo(FileView);

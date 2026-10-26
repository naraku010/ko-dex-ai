"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, FileText, Folder, Loader2, Trash2, Wrench } from "lucide-react";
import { openLocalFile } from "@/lib/openFile";
import { useFilesStore } from "@/store/filesStore";
import ProjectFilesPane from "@/components/assistant/ProjectFilesPane";
import type { ChannelTool } from "@/types/assistant";

const TYPE_LABEL: Record<string, string> = {
  string: "문자",
  number: "숫자",
  integer: "정수",
  boolean: "예/아니오",
  array: "목록",
};

export default function DocsTree({
  channelId,
  tools,
  toolLabels,
  showFiles,
  projectId,
}: {
  channelId: string;
  tools: ChannelTool[];
  toolLabels: string[];
  showFiles: boolean;
  projectId?: string | null;
}) {
  // 채널·프로젝트가 바뀌면 부모가 key로 새로 그려 탭을 처음 상태로 돌린다.
  const [tab, setTab] = useState<"tools" | "files" | "project">(projectId ? "project" : showFiles ? "files" : "tools");
  const [tool, setTool] = useState<ChannelTool | null>(null);

  const current = tab === "project" && !projectId ? (showFiles ? "files" : "tools") : tab;

  return (
    <aside
      className="flex h-full w-80 shrink-0 flex-col"
      style={{ background: "var(--dc-sidebar)", borderLeft: "1px solid var(--dc-border)" }}
    >
      <div className="flex h-12 items-center gap-1 px-2 shadow-[0_1px_0_var(--dc-border)]">
        {projectId ? (
          <TabButton active={current === "project"} onClick={() => setTab("project")}>
            프로젝트 파일
          </TabButton>
        ) : null}
        <TabButton active={current === "tools"} onClick={() => { setTool(null); setTab("tools"); }}>
          {`툴 ${visibleTools(tools, toolLabels).length || ""}`.trim()}
        </TabButton>
        {showFiles ? (
          <TabButton active={current === "files"} onClick={() => setTab("files")}>
            문서함
          </TabButton>
        ) : null}
      </div>

      {current === "project" && projectId ? (
        <ProjectFilesPane key={projectId} projectId={projectId} />
      ) : current === "tools" ? (
        tool ? (
          <ToolDetail tool={tool} onBack={() => setTool(null)} />
        ) : (
          <ToolList tools={visibleTools(tools, toolLabels)} detailed={tools.length > 0} onOpen={setTool} />
        )
      ) : (
        <FilesPane channelId={channelId} />
      )}
    </aside>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded px-2.5 py-1 text-xs font-semibold"
      style={{
        background: active ? "var(--dc-bg)" : "transparent",
        color: active ? "var(--dc-text)" : "var(--dc-muted)",
      }}
    >
      {children}
    </button>
  );
}

function visibleTools(tools: ChannelTool[], labels: string[]): ChannelTool[] {
  if (tools.length > 0) return tools;
  return labels.filter(Boolean).map((label) => ({ name: label, label, description: "", params: [] }));
}

function ToolList({
  tools,
  detailed,
  onOpen,
}: {
  tools: ChannelTool[];
  detailed: boolean;
  onOpen: (tool: ChannelTool) => void;
}) {
  if (tools.length === 0) {
    return (
      <p className="px-3 py-3 text-[11px] leading-5" style={{ color: "var(--dc-faint)" }}>
        툴 목록을 아직 받지 못했습니다. 앱을 완전히 종료한 뒤 다시 실행해주세요.
      </p>
    );
  }
  return (
    <div className="dc-scroll min-h-0 flex-1 overflow-y-auto px-2 py-2">
      {detailed ? null : (
        <p className="px-2 pb-2 text-[11px] leading-5" style={{ color: "var(--dc-faint)" }}>
          이름만 보입니다. 설명과 입력 항목은 앱을 완전히 종료한 뒤 다시 실행하면 나옵니다.
        </p>
      )}
      {tools.map((item) => (
        <button
          key={item.name}
          type="button"
          onClick={() => onOpen(item)}
          className="mb-0.5 flex w-full items-start gap-2 rounded px-2 py-1.5 text-left"
          style={{ color: "var(--dc-secondary)" }}
        >
          <Wrench size={12} className="mt-0.5 shrink-0" style={{ color: "var(--dc-faint)" }} />
          <span className="min-w-0">
            <span className="block truncate text-[12px]" style={{ color: "var(--dc-text)" }}>{item.label || item.name}</span>
            <span className="block truncate text-[10px]" style={{ color: "var(--dc-faint)" }}>
              {item.description || item.name}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

function ToolDetail({ tool, onBack }: { tool: ChannelTool; onBack: () => void }) {
  return (
    <div className="dc-scroll min-h-0 flex-1 overflow-y-auto px-3 py-2">
      <button
        type="button"
        onClick={onBack}
        className="mb-2 inline-flex items-center gap-1 text-[11px]"
        style={{ color: "var(--dc-muted)" }}
      >
        <ChevronLeft size={12} />
        툴 목록
      </button>
      <h3 className="text-sm font-semibold" style={{ color: "var(--dc-text)" }}>{tool.label || tool.name}</h3>
      <p className="mt-0.5 text-[10px]" style={{ color: "var(--dc-faint)", fontFamily: "var(--font-mono)" }}>{tool.name}</p>
      <p className="mt-2 text-[12px] leading-5" style={{ color: "var(--dc-secondary)" }}>
        {tool.description || "설명이 아직 없습니다. 앱을 완전히 종료한 뒤 다시 실행해주세요."}
      </p>
      <p className="mt-4 mb-1 text-[11px] font-semibold" style={{ color: "var(--dc-muted)" }}>입력</p>
      {tool.params.length === 0 ? (
        <p className="text-[11px]" style={{ color: "var(--dc-faint)" }}>받는 값이 없습니다.</p>
      ) : (
        <div className="space-y-2">
          {tool.params.map((param) => (
            <div key={param.name}>
              <div className="flex items-center gap-1.5">
                <span className="text-[12px]" style={{ color: "var(--dc-text)", fontFamily: "var(--font-mono)" }}>{param.name}</span>
                <span className="text-[10px]" style={{ color: "var(--dc-faint)" }}>{TYPE_LABEL[param.type] || param.type}</span>
                {param.required ? (
                  <span className="text-[10px]" style={{ color: "var(--dc-danger)" }}>필수</span>
                ) : null}
              </div>
              {param.description ? (
                <p className="text-[11px] leading-4" style={{ color: "var(--dc-muted)" }}>{param.description}</p>
              ) : null}
              {param.enum && param.enum.length > 0 ? (
                <p className="text-[10px] leading-4" style={{ color: "var(--dc-faint)" }}>{param.enum.join(" · ")}</p>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FilesPane({ channelId }: { channelId: string }) {
  const bind = useFilesStore((s) => s.bind);
  const remove = useFilesStore((s) => s.remove);
  const inbox = useFilesStore((s) => s.inbox);
  const docs = useFilesStore((s) => s.docs);
  const loading = useFilesStore((s) => s.loading);
  const error = useFilesStore((s) => s.error);
  const [open, setOpen] = useState<Record<string, boolean>>({ inbox: true, docs: true });
  const [opening, setOpening] = useState("");
  const [openError, setOpenError] = useState("");
  const openDoc = useFilesStore((s) => s.open);

  const openItem = async (id: string, filename?: string) => {
    setOpening(id);
    setOpenError("");
    try {
      const filePath = await openDoc(id, filename);
      await openLocalFile(filePath);
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpening("");
    }
  };

  useEffect(() => {
    bind(channelId);
  }, [bind, channelId]);

  const toggle = (key: string) => setOpen((prev) => ({ ...prev, [key]: !(prev[key] ?? true) }));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-end px-3 pt-2">
        {loading || opening ? <Loader2 size={12} className="animate-spin" style={{ color: "var(--dc-faint)" }} /> : null}
      </div>

      <div className="dc-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {error || openError ? (
          <p className="px-1 pb-2 text-[11px]" style={{ color: "var(--dc-danger)" }}>{error || openError}</p>
        ) : null}

        {inbox.length === 0 && docs.length === 0 && !loading ? (
          <p className="px-1 text-[11px] leading-5" style={{ color: "var(--dc-faint)" }}>
            아직 올린 PDF가 없습니다. 채팅창 앞 + 로 올리세요.
          </p>
        ) : null}

        {inbox.length > 0 ? (
          <TreeGroup
            label={`미분류 (${inbox.length})`}
            open={open.inbox !== false}
            onToggle={() => toggle("inbox")}
          >
            {inbox.map((item) => (
              <TreeLeaf
                key={item.id || item.파일명}
                label={item.파일명 || "이름 없음"}
                hint={item.추출 === "needs_ocr" ? "스캔" : item.쪽수 != null ? `${item.쪽수}쪽` : ""}
                busy={opening === item.id}
                onOpen={item.id ? () => void openItem(item.id!, item.파일명) : undefined}
                onRemove={item.id ? () => void remove(item.id!) : undefined}
              />
            ))}
          </TreeGroup>
        ) : null}

        {docs.length > 0 ? (
          <TreeGroup
            label={`문서 (${docs.length})`}
            open={open.docs !== false}
            onToggle={() => toggle("docs")}
          >
            {docs.map((doc) => {
              const key = doc.문서id || doc.문서명 || "doc";
              const versions = doc.버전 ?? [];
              return (
                <div key={key}>
                  <TreeRow
                    icon={<Folder size={13} />}
                    label={doc.문서명 || "문서"}
                    open={open[key] !== false}
                    onToggle={() => toggle(key)}
                  />
                  {open[key] !== false
                    ? versions.map((ver) => (
                        <TreeLeaf
                          key={`${key}-v${ver.버전}`}
                          indent
                          label={`v${ver.버전 ?? "-"}`}
                          hint={ver.파일명}
                          busy={opening === `${doc.문서id}:v${ver.버전}`}
                          onOpen={
                            doc.문서id && ver.버전 != null
                              ? () => void openItem(`${doc.문서id}:v${ver.버전}`, ver.파일명)
                              : undefined
                          }
                          onRemove={
                            doc.문서id && ver.버전 != null
                              ? () => void remove(`${doc.문서id}:v${ver.버전}`)
                              : undefined
                          }
                        />
                      ))
                    : null}
                </div>
              );
            })}
          </TreeGroup>
        ) : null}
      </div>
    </div>
  );
}

function TreeGroup({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="mb-2">
      <TreeRow icon={<Folder size={13} />} label={label} open={open} onToggle={onToggle} strong />
      {open ? <div className="ml-1">{children}</div> : null}
    </div>
  );
}

function TreeRow({
  icon,
  label,
  open,
  onToggle,
  strong,
}: {
  icon: ReactNode;
  label: string;
  open: boolean;
  onToggle: () => void;
  strong?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-1 rounded px-1 py-1 text-left"
      style={{ color: strong ? "var(--dc-text)" : "var(--dc-secondary)" }}
    >
      {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      <span className="shrink-0" style={{ color: "var(--dc-muted)" }}>{icon}</span>
      <span className={`min-w-0 truncate ${strong ? "text-[11px] font-semibold" : "text-[12px]"}`}>{label}</span>
    </button>
  );
}

function TreeLeaf({
  label,
  hint,
  indent,
  busy,
  onOpen,
  onRemove,
}: {
  label: string;
  hint?: string;
  indent?: boolean;
  busy?: boolean;
  onOpen?: () => void;
  onRemove?: () => void;
}) {
  return (
    <div
      className={`group flex items-center gap-1 rounded px-1 py-0.5 ${indent ? "ml-5" : "ml-4"}`}
      style={{ color: "var(--dc-secondary)" }}
    >
      {busy ? (
        <Loader2 size={12} className="shrink-0 animate-spin" style={{ color: "var(--dc-faint)" }} />
      ) : (
        <FileText size={12} className="shrink-0" style={{ color: "var(--dc-faint)" }} />
      )}
      <button
        type="button"
        onClick={onOpen}
        disabled={!onOpen}
        className="min-w-0 flex-1 truncate text-left text-[12px] disabled:cursor-default"
        title={onOpen ? "열기" : undefined}
      >
        {label}
      </button>
      {hint ? <span className="max-w-[72px] truncate text-[10px]" style={{ color: "var(--dc-faint)" }}>{hint}</span> : null}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className="hidden rounded p-0.5 group-hover:block"
          style={{ color: "var(--dc-danger)" }}
          title="삭제"
        >
          <Trash2 size={11} />
        </button>
      ) : null}
    </div>
  );
}

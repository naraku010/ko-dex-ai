"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FilePlus, FileText, Folder, FolderUp, Loader2, Search, Star, Trash2 } from "lucide-react";
import { openLocalFile } from "@/lib/openFile";
import { sidecarRequest } from "@/lib/tauri";
import { useConversationStore } from "@/store/conversationStore";
import type { ProjectDetail, ProjectFile } from "@/types/assistant";

const STATE: Record<ProjectFile["state"], { label: string; color: string }> = {
  ok: { label: "색인됨", color: "var(--dc-online)" },
  failed: { label: "실패", color: "var(--dc-danger)" },
  new: { label: "대기", color: "var(--dc-faint)" },
  stale: { label: "바뀜", color: "#fbbf24" },
  dup: { label: "중복", color: "var(--dc-faint)" },
  skipped: { label: "제외", color: "var(--dc-faint)" },
};

type Node = { name: string; path: string; dirs: Map<string, Node>; files: ProjectFile[] };
type UploadResult = { uploaded: number; skipped: number; failed: string[]; cancelled?: boolean };

function buildTree(files: ProjectFile[]): Node {
  const root: Node = { name: "", path: "", dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.rel.split(/[\\/]/);
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const key = node.path ? `${node.path}\\${part}` : part;
      if (!node.dirs.has(part)) node.dirs.set(part, { name: part, path: key, dirs: new Map(), files: [] });
      node = node.dirs.get(part)!;
    }
    node.files.push(file);
  }
  return root;
}

function baseName(rel: string) {
  return rel.split(/[\\/]/).pop() || rel;
}

function resultNote(res: UploadResult, verb: string) {
  const parts = [`${verb} ${res.uploaded}개`];
  if (res.skipped) parts.push(`같은 파일 ${res.skipped}개 건너뜀`);
  if (res.failed?.length) parts.push(`실패 ${res.failed.length}개 (${res.failed[0]})`);
  return parts.join(" · ");
}

// 우측 탭의 프로젝트 파일 관리. 공유 프로젝트는 서버 파일, 이 PC 프로젝트는 연결한 폴더를 다룬다.
export default function ProjectFilesPane({ projectId }: { projectId: string }) {
  const rev = useConversationStore((s) => s.projectRev);
  const bump = useConversationStore((s) => s.bumpProject);
  const loadProjects = useConversationStore((s) => s.loadProjects);
  const job = useConversationStore((s) => s.job);
  const sync = useConversationStore((s) => (s.sync?.projectId === projectId ? s.sync : null));
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<Record<string, boolean>>({});

  const running = Boolean(job?.running && job.projectId === projectId);
  const finishedAt = job?.projectId === projectId && !job.running ? `${job.done}/${job.total}` : "";

  useEffect(() => {
    let alive = true;
    sidecarRequest<ProjectDetail>("projectDetail", { id: projectId })
      .then((res) => {
        if (!alive) return;
        setDetail(res);
        setError("");
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [projectId, rev, finishedAt]);

  const files = useMemo(() => {
    const all = detail?.files ?? [];
    const q = query.trim().toLowerCase();
    return q ? all.filter((f) => f.rel.toLowerCase().includes(q)) : all;
  }, [detail, query]);
  const tree = useMemo(() => buildTree(files), [files]);

  if (!detail) {
    return (
      <p className="px-3 py-3 text-[11px]" style={{ color: error ? "var(--dc-danger)" : "var(--dc-faint)" }}>
        {error || "프로젝트 파일을 불러오는 중"}
      </p>
    );
  }

  const { project } = detail;
  const shared = Boolean(project.shared);

  const changed = () => {
    bump();
    void loadProjects();
  };

  const add = async (kind: "files" | "folder") => {
    setError("");
    setNote("");
    setBusy(kind);
    try {
      const res = await sidecarRequest<UploadResult>(kind === "files" ? "addProjectFiles" : "uploadProjectFolder", { id: projectId });
      if (!res.cancelled) {
        setNote(resultNote(res, shared ? "올림" : "추가"));
        changed();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
      useConversationStore.getState().setSync(null);
    }
  };

  const remove = async (file: ProjectFile) => {
    const sheet = project.datasheet?.toLowerCase() === file.rel.toLowerCase() ? "\n데이터시트 지정도 풀립니다." : "";
    const message = shared
      ? `'${file.rel}' 을 서버에서 지웁니다.\n채널 사용자 모두에게서 사라지고 이 파일의 색인도 지워집니다.${sheet}`
      : `'${file.rel}' 을 휴지통으로 보냅니다.\n연결한 폴더에서 빠지고 이 파일의 색인도 지워집니다. 휴지통에서 되살릴 수 있습니다.${sheet}`;
    if (!window.confirm(message)) return;
    setError("");
    setNote("");
    setBusy(file.rel);
    try {
      await sidecarRequest("deleteProjectFile", { id: projectId, rel: file.rel });
      setNote(`'${baseName(file.rel)}' 을 ${shared ? "서버에서 지웠습니다" : "휴지통으로 보냈습니다"}.`);
      changed();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
    }
  };

  const open = async (file: ProjectFile) => {
    setError("");
    try {
      await openLocalFile(`${project.folder}\\${file.rel}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const locked = running || Boolean(busy);
  const button = "inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] disabled:opacity-40";

  const renderNode = (node: Node, depth: number): React.ReactNode => (
    <>
      {[...node.dirs.values()]
        .sort((a, b) => a.name.localeCompare(b.name, "ko"))
        .map((dir) => {
          const isOpen = query.trim() ? true : !closed[dir.path];
          return (
            <div key={dir.path}>
              <button
                type="button"
                onClick={() => setClosed((prev) => ({ ...prev, [dir.path]: isOpen }))}
                className="flex w-full items-center gap-1 rounded py-1 text-left text-[12px]"
                style={{ paddingLeft: depth * 12 + 4, color: "var(--dc-secondary)" }}
              >
                {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <Folder size={13} style={{ color: "var(--dc-muted)" }} />
                <span className="min-w-0 truncate">{dir.name}</span>
              </button>
              {isOpen ? renderNode(dir, depth + 1) : null}
            </div>
          );
        })}
      {node.files.map((file) => {
        const state = STATE[file.state];
        const isSheet = project.datasheet?.toLowerCase() === file.rel.toLowerCase();
        return (
          <div
            key={file.rel}
            className="group flex items-center gap-1 rounded py-0.5 pr-1"
            style={{ paddingLeft: depth * 12 + 20, color: "var(--dc-secondary)" }}
          >
            {busy === file.rel ? (
              <Loader2 size={12} className="shrink-0 animate-spin" style={{ color: "var(--dc-faint)" }} />
            ) : isSheet ? (
              <Star size={12} className="shrink-0" style={{ color: "#fbbf24" }} />
            ) : (
              <FileText size={12} className="shrink-0" style={{ color: "var(--dc-faint)" }} />
            )}
            <button
              type="button"
              onClick={() => void open(file)}
              className="min-w-0 flex-1 truncate text-left text-[12px]"
              title={`${file.rel}${isSheet ? " (데이터시트)" : ""}${file.error ? `\n${file.error}` : ""}${file.dupOf ? `\n= ${file.dupOf}` : ""}`}
            >
              {baseName(file.rel)}
            </button>
            <span className="shrink-0 text-[10px]" style={{ color: state.color }}>
              {state.label}
              {file.state === "ok" && file.items ? ` ${file.items}` : ""}
            </span>
            <button
              type="button"
              disabled={locked}
              onClick={() => void remove(file)}
              className="hidden shrink-0 rounded p-0.5 group-hover:block disabled:opacity-40"
              style={{ color: "var(--dc-danger)" }}
              title={shared ? "서버에서 지우기" : "휴지통으로 보내기"}
            >
              <Trash2 size={11} />
            </button>
          </div>
        );
      })}
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 px-3 pt-2 pb-1">
        <p className="truncate text-[11px]" style={{ color: "var(--dc-faint)" }} title={shared ? "채널 서버의 공유 프로젝트" : project.folder}>
          {shared ? `서버 공유 · 파일 ${detail.total}개` : `${project.folder} · 파일 ${detail.total}개`}
        </p>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            disabled={locked}
            onClick={() => void add("files")}
            className={button}
            style={{ background: "var(--dc-input)", color: "var(--dc-text)" }}
            title={shared ? "파일을 골라 서버에 올립니다 (맨 위 폴더)" : "파일을 골라 연결한 폴더 맨 위에 복사합니다"}
          >
            {busy === "files" ? <Loader2 size={12} className="animate-spin" /> : <FilePlus size={12} />}
            파일 추가
          </button>
          {shared && (
            <button
              type="button"
              disabled={locked}
              onClick={() => void add("folder")}
              className={button}
              style={{ background: "var(--dc-input)", color: "var(--dc-text)" }}
              title="PC 폴더를 골라 새로 생기거나 바뀐 파일을 서버에 올립니다 (폴더 구조 유지)"
            >
              {busy === "folder" ? <Loader2 size={12} className="animate-spin" /> : <FolderUp size={12} />}
              폴더 올리기
            </button>
          )}
        </div>
        {sync && (
          <p className="text-[11px]" style={{ color: "var(--dc-blurple)" }}>
            {sync.phase === "upload" ? "서버에 올리는 중" : "서버에서 받는 중"} {sync.done}/{sync.total}
          </p>
        )}
        {running && <p className="text-[11px]" style={{ color: "var(--dc-faint)" }}>색인 중에는 파일을 바꿀 수 없습니다.</p>}
        {error && <p className="text-[11px]" style={{ color: "var(--dc-danger)" }}>{error}</p>}
        {note && !error && <p className="text-[11px]" style={{ color: "var(--dc-online)" }}>{note}</p>}
        {detail.total > 8 && (
          <label className="flex items-center gap-1.5 rounded px-2 py-1" style={{ background: "var(--dc-input)" }}>
            <Search size={12} style={{ color: "var(--dc-faint)" }} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="파일 이름 찾기"
              className="min-w-0 flex-1 bg-transparent text-[12px] outline-none"
              style={{ color: "var(--dc-text)" }}
            />
          </label>
        )}
      </div>

      <div className="dc-scroll min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {files.length === 0 ? (
          <p className="px-2 py-2 text-[11px]" style={{ color: "var(--dc-faint)" }}>
            {query ? "찾는 파일이 없습니다." : "파일이 없습니다. 위의 '파일 추가'로 넣으세요."}
          </p>
        ) : (
          renderNode(tree, 0)
        )}
      </div>
    </div>
  );
}

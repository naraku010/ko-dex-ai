"use client";

import { useCallback, useEffect, useState } from "react";
import { CloudDownload, CloudUpload, FolderOpen, Loader2, RefreshCw, Square, Table2, Users } from "lucide-react";
import { sidecarRequest } from "@/lib/tauri";
import { useConversationStore } from "@/store/conversationStore";
import type { ProjectDetail } from "@/types/assistant";

type SyncResult = {
  shared: boolean;
  downloaded?: number;
  removed?: number;
  lock?: { holder: string; purpose: string } | null;
};

type UploadResult = { uploaded: number; skipped: number; failed: string[] };

function failedNote(res: UploadResult) {
  return res.failed?.length ? ` · 실패 ${res.failed.length}개 (${res.failed[0]})` : "";
}

export default function ProjectBar({
  projectId,
  busy,
}: {
  projectId: string;
  busy: boolean;
}) {
  const job = useConversationStore((s) => s.job);
  const loadProjects = useConversationStore((s) => s.loadProjects);
  const sharedSupported = useConversationStore((s) => s.sharedSupported);
  const sync = useConversationStore((s) => (s.sync?.projectId === projectId ? s.sync : null));
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState(true);
  const [syncNote, setSyncNote] = useState("");
  const version = useConversationStore((s) => s.projectRev);
  const refresh = useConversationStore((s) => s.bumpProject);

  // 공유 프로젝트는 열 때마다 서버에서 바뀐 파일·색인을 받는다.
  const syncNow = useCallback(
    () =>
      sidecarRequest<SyncResult>("syncProject", { id: projectId })
        .then((res) => {
          if (!res.shared) return;
          const parts = [];
          if (res.downloaded) parts.push(`받은 파일 ${res.downloaded}개`);
          if (res.removed) parts.push(`지운 파일 ${res.removed}개`);
          const lock = res.lock ? ` · ${res.lock.holder}님이 ${res.lock.purpose || "작업"} 중` : "";
          setSyncNote(`${parts.length ? parts.join(" · ") : "서버와 같습니다"}${lock}`);
          refresh();
        })
        .catch((err) => {
          setError(`서버에서 받지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => {
          setSyncing(false);
          useConversationStore.getState().setSync(null);
        }),
    [projectId, refresh],
  );

  const pull = () => {
    setSyncing(true);
    void syncNow();
  };

  useEffect(() => {
    void syncNow();
  }, [syncNow]);

  const mine = job?.projectId === projectId ? job : null;
  const running = Boolean(mine?.running);
  const otherRunning = Boolean(job?.running && job.projectId !== projectId);
  const finishedAt = mine && !mine.running ? `${mine.done}/${mine.total}/${mine.error}` : "";

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
  }, [projectId, version, finishedAt]);

  const run = async (force = false) => {
    setError("");
    try {
      await sidecarRequest("indexProject", { id: projectId, force });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const exportReport = async () => {
    setError("");
    try {
      await sidecarRequest("exportProjectReport", { id: projectId });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const migrate = async () => {
    if (!window.confirm("이 프로젝트를 채널 서버로 옮깁니다. 폴더의 파일과 색인 결과를 올리고, 채널 사용자 모두가 같은 프로젝트를 쓰게 됩니다. 대화는 각자 PC에 남습니다.")) return;
    setError("");
    setSyncing(true);
    try {
      const res = await sidecarRequest<UploadResult & { entries: number }>("migrateProject", { id: projectId });
      setSyncNote(`서버로 옮겼습니다: 파일 ${res.uploaded}개 올림, 색인 ${res.entries}개 올림${failedNote(res)}`);
      refresh();
      void loadProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
      useConversationStore.getState().setSync(null);
    }
  };

  const chooseSheet = async (rel: string) => {
    setError("");
    try {
      await sidecarRequest("setProjectDatasheet", { id: projectId, rel: rel || null });
      refresh();
      void loadProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const toggleImages = async (skipImages: boolean) => {
    setError("");
    try {
      await sidecarRequest("setProjectOptions", { id: projectId, skipImages });
      refresh();
      void loadProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!detail) {
    return (
      <div className="px-4 py-2 text-xs" style={{ color: error ? "var(--dc-danger)" : "var(--dc-faint)" }}>
        {error || "프로젝트를 불러오는 중"}
      </div>
    );
  }

  const { project } = detail;
  const sheetState = detail.files.find((f) => f.rel === project.datasheet)?.state;
  const todo = detail.pending + detail.failed;
  const candidates = detail.sheetCandidates ?? [];

  return (
    <div className="px-4 py-2 shadow-[0_1px_0_var(--dc-border)]" style={{ background: "var(--dc-sidebar)" }}>
      <div className="flex flex-wrap items-center gap-2 text-xs" style={{ color: "var(--dc-muted)" }}>
        {project.shared ? (
          <span className="inline-flex items-center gap-1" style={{ color: "var(--dc-blurple)" }} title="채널 서버에 있는 공유 프로젝트입니다. 파일·색인은 모두 같고 대화는 각자 따로입니다">
            <Users size={14} />
            공유{project.createdBy ? ` · ${project.createdBy}` : ""}
          </span>
        ) : (
          <>
            <FolderOpen size={14} />
            <span className="max-w-72 truncate" title={project.folder}>{project.folder}</span>
          </>
        )}
        <span>
          문서 {detail.total}개 · 색인 {detail.indexed}
          {detail.failed ? ` · 실패 ${detail.failed}` : ""}
          {detail.pending ? ` · 대기 ${detail.pending}` : ""}
          {detail.duplicates ? ` · 중복 제외 ${detail.duplicates}` : ""}
          {detail.skipped ? ` · 이미지 제외 ${detail.skipped}` : ""}
        </span>
        {detail.truncated && <span style={{ color: "var(--dc-danger)" }}>500개까지만 다룹니다</span>}
        {detail.folderMissing && <span style={{ color: "var(--dc-danger)" }}>연결한 폴더가 없습니다</span>}

        <div className="ml-auto flex items-center gap-1.5">
          {syncing && (
            <span className="inline-flex items-center gap-1" style={{ color: "var(--dc-blurple)" }}>
              <Loader2 size={12} className="animate-spin" />
              {sync
                ? `${sync.phase === "upload" ? "서버에 올리는 중" : "서버에서 받는 중"} ${sync.done}/${sync.total}`
                : "서버 확인 중"}
            </span>
          )}
          {project.shared && (
            <>
              <button
                type="button"
                disabled={syncing || running}
                onClick={pull}
                className="inline-flex items-center gap-1 rounded px-2 py-1 disabled:opacity-40"
                style={{ background: "var(--dc-input)", color: "var(--dc-text)" }}
                title="서버에서 바뀐 파일·색인을 다시 받습니다"
              >
                <CloudDownload size={12} />
                받기
              </button>
            </>
          )}
          {!project.shared && sharedSupported && (
            <button
              type="button"
              disabled={syncing || running || otherRunning || detail.folderMissing}
              onClick={() => void migrate()}
              className="inline-flex items-center gap-1 rounded px-2 py-1 disabled:opacity-40"
              style={{ background: "var(--dc-input)", color: "var(--dc-text)" }}
              title="파일과 색인 결과를 채널 서버에 올려 다른 사람과 공유합니다"
            >
              <CloudUpload size={12} />
              서버로 옮기기
            </button>
          )}
          {running ? (
            <>
              <span className="inline-flex items-center gap-1" style={{ color: "var(--dc-blurple)" }}>
                <Loader2 size={12} className="animate-spin" />
                색인 {mine?.done ?? 0}/{mine?.total ?? 0}
              </span>
              <button
                type="button"
                disabled={Boolean(mine?.cancelling)}
                onClick={() => {
                  sidecarRequest("cancelProjectIndex").catch((err) => {
                    setError(err instanceof Error ? err.message : String(err));
                  });
                }}
                className="inline-flex items-center gap-1 rounded px-2 py-1 disabled:opacity-50"
                style={{ color: "var(--dc-danger)" }}
                title="색인 멈추기 (끝난 파일은 남습니다)"
              >
                <Square size={12} />
                {mine?.cancelling ? "멈추는 중" : "멈춤"}
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={busy || otherRunning || detail.folderMissing || !project.datasheet || (todo === 0 && detail.total > 0)}
              onClick={() => void run(false)}
              className="inline-flex items-center gap-1 rounded px-2 py-1 disabled:opacity-40"
              style={{ background: "var(--dc-input)", color: "var(--dc-text)" }}
              title={
                !project.datasheet
                  ? "데이터시트를 먼저 고르세요. 다른 문서는 데이터시트 항목을 기준으로 색인합니다"
                  : otherRunning
                    ? "다른 프로젝트를 색인하는 중입니다"
                    : "새로 생기거나 바뀐 파일만 AI가 색인합니다"
              }
            >
              <RefreshCw size={12} />
              {todo ? `색인 (${todo}개)` : "색인 완료"}
            </button>
          )}
          <button
            type="button"
            disabled={running || otherRunning || detail.indexed === 0}
            onClick={() => void exportReport()}
            className="inline-flex items-center gap-1 rounded px-2 py-1 disabled:opacity-40"
            style={{ background: "var(--dc-blurple)", color: "#fff" }}
            title="지금 색인으로 데이터시트 항목별 지시 엑셀을 다시 만듭니다 (색인이 끝나면 자동으로 만들어집니다)"
          >
            <Table2 size={12} />
            엑셀 만들기
          </button>
        </div>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs" style={{ color: "var(--dc-muted)" }}>
        <span>데이터시트</span>
        <select
          value={project.datasheet ?? ""}
          disabled={running}
          onChange={(e) => void chooseSheet(e.target.value)}
          className="max-w-96 rounded px-1.5 py-1 outline-none"
          style={{ background: "var(--dc-input)", color: "var(--dc-text)" }}
        >
          <option value="">고르지 않음</option>
          {candidates.length > 0 && (
            <optgroup label="추천 (Tag No 표가 있는 엑셀)">
              {candidates.map((c) => (
                <option key={`c:${c.rel}`} value={c.rel}>{c.rel} (태그 {c.tags}개)</option>
              ))}
            </optgroup>
          )}
          <optgroup label="모든 파일">
            {detail.files.filter((f) => f.state !== "dup" && !candidates.some((c) => c.rel === f.rel)).map((f) => (
              <option key={f.rel} value={f.rel}>{f.rel}</option>
            ))}
          </optgroup>
        </select>
        {!project.datasheet && (
          <span style={{ color: "var(--dc-danger)" }}>
            데이터시트를 먼저 고르세요
            {candidates[0] && (
              <button
                type="button"
                disabled={running}
                onClick={() => void chooseSheet(candidates[0].rel)}
                className="ml-1 underline"
                style={{ color: "var(--dc-blurple)" }}
              >
                추천: {candidates[0].rel} 지정
              </button>
            )}
          </span>
        )}
        <label
          className="inline-flex cursor-pointer items-center gap-1"
          title="이미지 파일(png·jpg 등)과 글자 없이 스캔된 PDF는 AI가 그림으로 읽어야 해서 오래 걸립니다. 켜면 색인에서 뺍니다."
        >
          <input
            type="checkbox"
            checked={Boolean(project.skipImages)}
            disabled={running}
            onChange={(e) => void toggleImages(e.target.checked)}
          />
          이미지·스캔본 제외
        </label>
        {project.datasheet && sheetState !== "ok" && (
          <span style={{ color: "var(--dc-faint)" }}>색인하면 이 파일을 먼저 읽습니다</span>
        )}
        {detail.indexed > 0 && !running && (
          <button
            type="button"
            disabled={busy || otherRunning}
            onClick={() => {
              if (window.confirm("모든 파일을 처음부터 다시 색인합니다. 파일 수만큼 AI 호출이 다시 듭니다.")) void run(true);
            }}
            className="ml-auto text-[11px] underline disabled:opacity-40"
            style={{ color: "var(--dc-faint)" }}
            title="파일 관리는 오른쪽 '프로젝트 파일' 탭에서 합니다"
          >
            전체 다시 색인
          </button>
        )}
      </div>

      {mine?.error && <p className="mt-1 text-xs" style={{ color: "var(--dc-danger)" }}>{mine.error}</p>}
      {error && <p className="mt-1 text-xs" style={{ color: "var(--dc-danger)" }}>{error}</p>}
      {syncNote && !syncing && <p className="mt-1 text-[11px]" style={{ color: "var(--dc-faint)" }}>{syncNote}</p>}
      {running && mine?.current && (
        <p className="mt-1 truncate text-[11px]" style={{ color: "var(--dc-faint)" }}>읽는 중: {mine.current}</p>
      )}

    </div>
  );
}

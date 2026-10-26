"use client";

import { useState } from "react";
import { AlertTriangle, Check, Database, Loader2 } from "lucide-react";
import AppMark from "@/components/brand/AppMark";
import { sidecarRequest } from "@/lib/tauri";

type Existing = { batches: number; tags: number; savedAt: string | null; savedBy: string | null; verified: number };

type SaveResult =
  | { exists: Existing }
  | {
      exists?: undefined;
      batchId: string;
      tags: number;
      items: number;
      added: number;
      changed: number;
      replaced: Existing | null;
    };

type Step =
  | { kind: "ask" }
  | { kind: "saving"; replace: boolean }
  | { kind: "exists"; found: Existing }
  | { kind: "done"; text: string }
  | { kind: "skipped" }
  | { kind: "error"; text: string; replace: boolean };

// 데이터시트 엑셀 메시지 아래에 붙는 대화형 저장 카드. 같은 프로젝트로 넣은 게 있으면 지우고 새로 넣을지 묻는다.
export default function DatasheetDbCard({ projectId }: { projectId: string }) {
  const [step, setStep] = useState<Step>({ kind: "ask" });

  const save = async (replace: boolean) => {
    setStep({ kind: "saving", replace });
    try {
      const res = await sidecarRequest<SaveResult>("saveProjectDatasheet", { id: projectId, replace });
      if (res.exists) {
        setStep({ kind: "exists", found: res.exists });
        return;
      }
      const head = res.replaced ? `이전 저장(태그 ${res.replaced.tags}개)을 지우고 새로 넣었습니다.` : "검증용 DB에 넣었습니다.";
      setStep({
        kind: "done",
        text: `${head} 저장번호 ${res.batchId} · 태그 ${res.tags}개 · 항목 ${res.items}개 (추가사항 ${res.added}칸, 변경 ${res.changed}칸). 채팅에서 "검증용 데이터시트 보여줘"로 조회할 수 있습니다.`,
      });
    } catch (err) {
      setStep({ kind: "error", text: err instanceof Error ? err.message : String(err), replace });
    }
  };

  const button = "inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50";

  return (
    <div className="flex gap-3 pt-2">
      <div className="h-8 w-8 shrink-0 overflow-hidden rounded-full">
        <AppMark size={32} variant="avatar" />
      </div>
      <div
        className="min-w-0 flex-1 space-y-2 rounded-lg px-3 py-2.5 text-sm"
        style={{ background: "var(--dc-sidebar)", border: "1px solid var(--dc-border)", color: "var(--dc-secondary)" }}
      >
        {(step.kind === "ask" || step.kind === "saving") && !(step.kind === "saving" && step.replace) && (
          <>
            <p className="flex items-center gap-1.5">
              <Database size={14} style={{ color: "var(--dc-blurple)" }} />
              이 데이터시트를 검증용 DB(AI_DS_MST·AI_DS_DTL)에 저장할까요?
            </p>
            <p className="text-xs" style={{ color: "var(--dc-faint)" }}>
              태그는 마스터, 항목은 디테일로 들어갑니다. ERP 실테이블에는 넣지 않고, 사람이 검증한 뒤 옮기는 용도입니다.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={step.kind === "saving"}
                onClick={() => void save(false)}
                className={button}
                style={{ background: "var(--dc-blurple)", color: "#fff" }}
              >
                {step.kind === "saving" ? <Loader2 size={12} className="animate-spin" /> : <Database size={12} />}
                {step.kind === "saving" ? "저장하는 중" : "DB에 저장"}
              </button>
              {step.kind === "ask" && (
                <button
                  type="button"
                  onClick={() => setStep({ kind: "skipped" })}
                  className={button}
                  style={{ background: "var(--dc-input)", color: "var(--dc-text)" }}
                >
                  나중에
                </button>
              )}
            </div>
          </>
        )}

        {(step.kind === "exists" || (step.kind === "saving" && step.replace)) && (
          <>
            <p className="flex items-center gap-1.5">
              <AlertTriangle size={14} style={{ color: "#fbbf24" }} />
              이 프로젝트로 이미 등록된 내용이 있습니다. 지우고 새로 올릴까요?
            </p>
            {step.kind === "exists" && (
              <p className="text-xs" style={{ color: "var(--dc-faint)" }}>
                태그 {step.found.tags}개
                {step.found.batches > 1 ? ` (저장 ${step.found.batches}번)` : ""}
                {step.found.savedAt ? ` · 마지막 저장 ${step.found.savedAt}` : ""}
                {step.found.savedBy ? ` · ${step.found.savedBy}` : ""}
              </p>
            )}
            {step.kind === "exists" && step.found.verified > 0 && (
              <p className="text-xs" style={{ color: "var(--dc-danger)" }}>
                검증완료로 표시된 태그 {step.found.verified}개의 검증 내용도 함께 지워집니다.
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                disabled={step.kind === "saving"}
                onClick={() => void save(true)}
                className={button}
                style={{ background: "var(--dc-danger)", color: "#fff" }}
              >
                {step.kind === "saving" ? <Loader2 size={12} className="animate-spin" /> : null}
                {step.kind === "saving" ? "바꾸는 중" : "지우고 새로 올리기"}
              </button>
              {step.kind === "exists" && (
                <button
                  type="button"
                  onClick={() => setStep({ kind: "skipped" })}
                  className={button}
                  style={{ background: "var(--dc-input)", color: "var(--dc-text)" }}
                >
                  그대로 두기
                </button>
              )}
            </div>
          </>
        )}

        {step.kind === "done" && (
          <p className="flex items-start gap-1.5">
            <Check size={14} className="mt-0.5 shrink-0" style={{ color: "var(--dc-online)" }} />
            {step.text}
          </p>
        )}

        {step.kind === "skipped" && (
          <div className="flex items-center gap-2 text-xs" style={{ color: "var(--dc-faint)" }}>
            DB에 저장하지 않았습니다.
            <button type="button" onClick={() => setStep({ kind: "ask" })} className="underline" style={{ color: "var(--dc-blurple)" }}>
              다시 묻기
            </button>
          </div>
        )}

        {step.kind === "error" && (
          <div className="space-y-2">
            <p className="text-xs" style={{ color: "var(--dc-danger)" }}>{step.text}</p>
            <button
              type="button"
              onClick={() => void save(step.replace)}
              className={button}
              style={{ background: "var(--dc-input)", color: "var(--dc-text)" }}
            >
              다시 시도
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

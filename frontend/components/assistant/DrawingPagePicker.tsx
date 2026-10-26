"use client";

import { useMemo, useState } from "react";
import { X } from "lucide-react";

export type DrawingPage = {
  page: number;
  tag: string;
  list: boolean;
  pmi: string;
};

export default function DrawingPagePicker({
  fileName,
  pages,
  max,
  onCancel,
  onConfirm,
}: {
  fileName: string;
  pages: DrawingPage[];
  max: number;
  onCancel: () => void;
  onConfirm: (pages: DrawingPage[]) => void;
}) {
  const [picked, setPicked] = useState<number[]>([]);
  const [query, setQuery] = useState("");
  const [pmiOnly, setPmiOnly] = useState(false);
  const hasPmi = pages.some((item) => item.pmi === "Yes");

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return pages.filter((item) => {
      if (pmiOnly && item.pmi !== "Yes") return false;
      if (!needle) return true;
      return item.tag.toLowerCase().includes(needle) || String(item.page) === needle;
    });
  }, [pages, query, pmiOnly]);

  const toggle = (page: number) => {
    setPicked((prev) => {
      if (prev.includes(page)) return prev.filter((value) => value !== page);
      if (prev.length >= max) return prev;
      return [...prev, page];
    });
  };

  const confirm = () => {
    const chosen = pages.filter((item) => picked.includes(item.page));
    if (chosen.length) onConfirm(chosen);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: "rgba(0,0,0,0.6)" }}>
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-lg p-5"
        style={{ background: "var(--dc-main)", border: "1px solid var(--dc-border)" }}
      >
        <div className="mb-3 flex items-start justify-between">
          <div className="min-w-0">
            <h2 className="text-base font-semibold" style={{ color: "var(--dc-text)" }}>
              이미지로 만들 도면 고르기
            </h2>
            <p className="mt-1 truncate text-xs leading-5" style={{ color: "var(--dc-muted)" }}>
              {fileName}에 도면이 {pages.length}장 있습니다. 한 번에 {max}장까지 고를 수 있고, 한 장에 몇 분 걸립니다.
            </p>
          </div>
          <button onClick={onCancel} className="rounded p-1" style={{ color: "var(--dc-muted)" }} title="닫기">
            <X size={16} />
          </button>
        </div>

        <div className="mb-2 flex items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="태그나 쪽 번호로 찾기"
            className="min-w-0 flex-1 rounded px-2.5 py-1.5 text-sm outline-none"
            style={{ background: "var(--dc-input)", color: "var(--dc-text)" }}
          />
          {hasPmi ? (
            <label className="flex shrink-0 items-center gap-1.5 text-xs" style={{ color: "var(--dc-secondary)" }}>
              <input type="checkbox" checked={pmiOnly} onChange={(e) => setPmiOnly(e.target.checked)} />
              PMI Yes만
            </label>
          ) : null}
        </div>

        <div className="dc-scroll min-h-0 flex-1 overflow-y-auto rounded" style={{ border: "1px solid var(--dc-border)" }}>
          {shown.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs" style={{ color: "var(--dc-faint)" }}>맞는 도면이 없습니다.</p>
          ) : (
            shown.map((item) => {
              const checked = picked.includes(item.page);
              const full = !checked && picked.length >= max;
              return (
                <label
                  key={item.page}
                  className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-sm"
                  style={{
                    color: full ? "var(--dc-faint)" : "var(--dc-text)",
                    background: checked ? "var(--dc-sidebar)" : "transparent",
                    borderBottom: "1px solid var(--dc-border)",
                  }}
                >
                  <input type="checkbox" checked={checked} disabled={full} onChange={() => toggle(item.page)} />
                  <span className="min-w-0 flex-1 truncate">{item.tag || `${item.page}쪽`}</span>
                  {item.pmi ? (
                    <span
                      className="shrink-0 rounded px-1.5 py-0.5 text-[10px]"
                      style={{
                        background: item.pmi === "Yes" ? "var(--dc-blurple)" : "var(--dc-sidebar)",
                        color: item.pmi === "Yes" ? "white" : "var(--dc-muted)",
                      }}
                    >
                      PMI {item.pmi}
                    </span>
                  ) : null}
                  {item.tag ? (
                    <span className="w-12 shrink-0 text-right text-xs" style={{ color: "var(--dc-faint)" }}>{item.page}쪽</span>
                  ) : null}
                </label>
              );
            })
          )}
        </div>

        <div className="mt-4 flex items-center justify-between gap-2">
          <span className="text-xs" style={{ color: "var(--dc-muted)" }}>
            {picked.length}/{max}장 선택
          </span>
          <div className="flex gap-2">
            <button onClick={onCancel} className="rounded px-3 py-2 text-sm" style={{ color: "var(--dc-muted)" }}>
              취소
            </button>
            <button
              onClick={confirm}
              disabled={!picked.length}
              className="rounded px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
              style={{ background: "var(--dc-blurple)" }}
            >
              이미지 만들기
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

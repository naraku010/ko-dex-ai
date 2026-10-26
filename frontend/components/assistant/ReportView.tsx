"use client";

import { memo, useCallback, useRef, useState } from "react";
import { Printer } from "lucide-react";
import type { ReportSpec } from "@/types/assistant";

function ReportView({ report }: { report: ReportSpec }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(280);

  const onLoad = useCallback(() => {
    const body = iframeRef.current?.contentDocument?.body;
    if (!body) return;
    setHeight(Math.min(Math.max(body.scrollHeight + 16, 200), 640));
  }, []);

  const print = useCallback(() => {
    iframeRef.current?.contentWindow?.print();
  }, []);

  return (
    <div
      className="overflow-hidden rounded-lg"
      style={{ background: "var(--dc-input)", border: "1px solid var(--dc-border)" }}
    >
      <div
        className="flex items-center justify-between gap-2 px-3 py-2"
        style={{ borderBottom: "1px solid var(--dc-border)" }}
      >
        <p className="truncate text-xs font-semibold" style={{ color: "var(--dc-text)" }}>
          {report.title}
        </p>
        <button
          type="button"
          onClick={print}
          className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px]"
          style={{
            background: "var(--dc-sidebar)",
            border: "1px solid var(--dc-border)",
            color: "var(--dc-muted)",
          }}
        >
          <Printer size={12} />
          인쇄
        </button>
      </div>
      <iframe
        ref={iframeRef}
        title={report.title}
        sandbox="allow-same-origin allow-modals"
        srcDoc={report.html}
        onLoad={onLoad}
        className="block w-full bg-white"
        style={{ height, border: 0 }}
      />
    </div>
  );
}

export default memo(ReportView);

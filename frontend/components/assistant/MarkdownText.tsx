"use client";

import { Fragment, useState, type ReactNode } from "react";
import { Download } from "lucide-react";
import { sidecarRequest } from "@/lib/tauri";
import { openLocalFile } from "@/lib/openFile";
import {
  AlertTriangle,
  ChartColumn,
  Check,
  CircleAlert,
  ClipboardList,
  Factory,
  Info,
  Lightbulb,
  Search,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";

const EMOJI_ICONS: { test: RegExp; Icon: LucideIcon }[] = [
  { test: /^(?:✅|✔️|☑|✔)/u, Icon: Check },
  { test: /^(?:❌|✖️|✖|❎)/u, Icon: X },
  { test: /^(?:⚠️|⚠)/u, Icon: AlertTriangle },
  { test: /^(?:📊|📈|📉)/u, Icon: ChartColumn },
  { test: /^(?:🔧|⚙️|⚙)/u, Icon: Wrench },
  { test: /^(?:🏭|🏢)/u, Icon: Factory },
  { test: /^(?:📋|📝|📄)/u, Icon: ClipboardList },
  { test: /^(?:🔍|🔎)/u, Icon: Search },
  { test: /^(?:💡)/u, Icon: Lightbulb },
  { test: /^(?:ℹ️|ℹ)/u, Icon: Info },
  { test: /^(?:❗|‼️|❕)/u, Icon: CircleAlert },
];

const EMOJI_SPLIT = /(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)/u;

function EmojiIcon({ Icon }: { Icon: LucideIcon }) {
  return (
    <Icon
      size={14}
      className="inline-block align-[-2px]"
      style={{ color: "var(--dc-muted)" }}
    />
  );
}

function iconForEmoji(token: string): LucideIcon | null {
  for (const { test, Icon } of EMOJI_ICONS) {
    if (test.test(token)) return Icon;
  }
  return null;
}

function renderWithIcons(text: string, keyPrefix: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const chunks = text.split(EMOJI_SPLIT);
  let i = 0;
  for (const chunk of chunks) {
    if (!chunk) continue;
    if (/\p{Extended_Pictographic}/u.test(chunk)) {
      const Icon = iconForEmoji(chunk);
      if (Icon) parts.push(<EmojiIcon key={`${keyPrefix}-e${i++}`} Icon={Icon} />);
      continue;
    }
    parts.push(...renderInline(chunk, `${keyPrefix}-${i++}`));
  }
  return parts;
}

function isAmount(text: string) {
  const t = text.trim();
  if (/\$\s*[\d,.]+/.test(t) || /\d\s*(USD|KRW)/i.test(t)) return true;
  if (/\d[\d,.]*\s*억/.test(t)) return true;
  if (/\d[\d,.]*\s*만(?:원)?/.test(t)) return true;
  if (/\d[\d,.]*\s*원/.test(t)) return true;
  return /^-?[\d]{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(t);
}

function emphasisStyle(text: string) {
  const t = text.trim();
  const amount = isAmount(t);
  const numeric = /\d/.test(t);
  const danger =
    /적자|손실|미수|연체|초과|미달|위험|체납|체불|미완료|미입고|감소|하락|▼/.test(t) ||
    /(?:^|[\s(])-[\d,]/.test(t);
  const ok = !danger && /흑자|이익|달성|양호|정상|증가|상승|▲/.test(t);
  const warn = !danger && !ok && /임박|주의|경고|지연|미정/.test(t);

  const color = danger
    ? "#f87171"
    : ok
      ? "var(--dc-online)"
      : warn
        ? "#fbbf24"
        : amount
          ? "inherit"
          : "var(--dc-emphasis)";

  return {
    color,
    fontWeight: amount || numeric || danger || ok ? 700 : 500,
  };
}

const FILE_PATH = /[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n]+[\\/])*[^\\/:*?"<>|\r\n]+?\.(?:xlsx|xls|pdf|csv|docx|txt)/gi;

function FilePathLink({ path }: { path: string }) {
  const [error, setError] = useState("");
  return (
    <span className="inline-flex max-w-full flex-col items-start">
      <button
        type="button"
        className="max-w-full break-all text-left underline"
        style={{ color: "var(--dc-blurple)", fontFamily: "var(--font-mono)" }}
        title={error || path}
        onClick={() => {
          setError("");
          void openLocalFile(path).catch((err: unknown) => {
            setError(err instanceof Error ? err.message : "파일을 열지 못했습니다.");
          });
        }}
      >
        {path}
      </button>
      {error && (
        <span className="text-[11px]" style={{ color: "#f87171" }}>
          {error}
        </span>
      )}
    </span>
  );
}

function withPaths(text: string, keyPrefix: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = new RegExp(FILE_PATH.source, "gi");
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(<FilePathLink key={`${keyPrefix}-f${i++}`} path={match[0]} />);
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length > 0 ? parts : [text];
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) parts.push(...withPaths(text.slice(last, match.index), `${keyPrefix}-t${i}`));
    const token = match[0];
    if (token.startsWith("**")) {
      const inner = token.slice(2, -2);
      parts.push(
        <strong key={`${keyPrefix}-b${i++}`} style={emphasisStyle(inner)}>
          {withPaths(inner, `${keyPrefix}-bi${i}`)}
        </strong>,
      );
    } else {
      const inner = token.slice(1, -1);
      const linked = withPaths(inner, `${keyPrefix}-ci${i}`);
      const onlyPath = linked.length === 1 && typeof linked[0] !== "string";
      parts.push(
        onlyPath ? (
          <span key={`${keyPrefix}-c${i++}`}>{linked}</span>
        ) : (
          <code
            key={`${keyPrefix}-c${i++}`}
            className="rounded px-1.5 py-0.5 text-[0.9em]"
            style={{ background: "var(--dc-bg)", fontFamily: "var(--font-mono)", color: "#c9cdfb" }}
          >
            {linked}
          </code>
        ),
      );
    }
    last = match.index + token.length;
  }
  if (last < text.length) parts.push(...withPaths(text.slice(last), `${keyPrefix}-t${i}`));
  return parts;
}

function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());
}

const isTableSeparator = (line: string) => /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes("-");

/** 표의 굵게·코드 표시를 빼고 칸 내용만 남긴다. */
function plainCell(text: string) {
  return text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").trim();
}

function ExportTableButton({ headers, rows }: { headers: string[]; rows: string[][] }) {
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState("");

  const save = () => {
    setState("saving");
    setMessage("");
    sidecarRequest<{ saved: boolean; path?: string }>("exportTable", {
      title: plainCell(headers[0] || "표"),
      headers: headers.map(plainCell),
      rows: rows.map((row) => row.map(plainCell)),
    })
      .then((res) => {
        setState(res?.saved ? "saved" : "idle");
        if (res?.saved && res.path) setMessage(res.path);
      })
      .catch((err: unknown) => {
        setState("error");
        setMessage(err instanceof Error ? err.message : "엑셀로 저장하지 못했습니다.");
      });
  };

  return (
    <div className="mb-1 flex items-center justify-end gap-2">
      {message && (
        <span className="truncate text-[11px]" style={{ color: state === "error" ? "#f87171" : "var(--dc-faint)" }} title={message}>
          {state === "saved" ? message.split(/[\\/]/).pop() : message}
        </span>
      )}
      <button
        type="button"
        onClick={save}
        disabled={state === "saving"}
        className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] disabled:opacity-50"
        style={{ color: "var(--dc-muted)", border: "1px solid var(--dc-border)", background: "var(--dc-sidebar)" }}
        title="이 표를 엑셀 파일로 저장합니다"
      >
        <Download size={12} />
        {state === "saving" ? "저장 중" : state === "saved" ? "저장됨" : "엑셀로 저장"}
      </button>
    </div>
  );
}

export default function MarkdownText({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  const isTableStart = (idx: number) =>
    lines[idx].trim().startsWith("|") && idx + 1 < lines.length && isTableSeparator(lines[idx + 1]);

  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    const cursorBefore = i;

    if (isTableStart(i)) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push(
        <div key={`t${key++}`} className="my-2">
          <ExportTableButton headers={header} rows={rows} />
          <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                {header.map((cell, ci) => (
                  <th
                    key={ci}
                    className="px-2.5 py-1.5 text-left font-semibold"
                    style={{ color: "var(--dc-muted)", borderBottom: "1px solid var(--dc-border)", background: "var(--dc-sidebar)" }}
                  >
                    {renderWithIcons(cell, `th${ci}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      className="px-2.5 py-1.5 align-top"
                      style={{ borderBottom: "1px solid var(--dc-border)", color: "var(--dc-secondary)" }}
                    >
                      {renderWithIcons(cell, `td${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>,
      );
      continue;
    }

    const listMatch = line.match(/^\s*(?:([-*])|(\d+)\.)\s+(.*)$/);
    if (listMatch) {
      const ordered = Boolean(listMatch[2]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
        if (!m) break;
        items.push(m[1]);
        i++;
      }
      const ListTag = ordered ? "ol" : "ul";
      blocks.push(
        <ListTag
          key={`l${key++}`}
          className={`my-1.5 space-y-1 pl-5 ${ordered ? "list-decimal" : "list-disc"}`}
          style={{ color: "var(--dc-secondary)" }}
        >
          {items.map((item, ii) => (
            <li key={ii}>{renderWithIcons(item, `li${ii}`)}</li>
          ))}
        </ListTag>,
      );
      continue;
    }

    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      blocks.push(
        <p key={`h${key++}`} className="mt-3 mb-1 font-semibold" style={{ color: "var(--dc-text)" }}>
          {renderWithIcons(headingMatch[2], `h${key}`)}
        </p>,
      );
      i++;
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !isTableStart(i) &&
      !/^\s*(?:[-*]|\d+\.)\s+/.test(lines[i]) &&
      !/^#{1,4}\s+/.test(lines[i])
    ) {
      paragraph.push(lines[i]);
      i++;
    }
    if (paragraph.length > 0) {
      blocks.push(
        <p key={`p${key++}`} className="my-1">
          {paragraph.map((pl, pi) => (
            <Fragment key={pi}>
              {pi > 0 && <br />}
              {renderWithIcons(pl, `p${key}-${pi}`)}
            </Fragment>
          ))}
        </p>,
      );
    }

    if (i === cursorBefore) i++;
  }

  return <>{blocks}</>;
}

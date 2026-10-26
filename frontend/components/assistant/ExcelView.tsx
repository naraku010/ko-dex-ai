"use client";

import { memo, useMemo, type CSSProperties } from "react";
import type { ExcelMerge, ExcelSpec } from "@/types/assistant";

const COLS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function cellKey(row: number, col: number) {
  return `${row}:${col}`;
}

function excelWidthPx(width: number) {
  const digit = 7;
  return Math.max(28, Math.trunc(((256 * width + Math.trunc(128 / digit)) / 256) * digit));
}

function rowPx(points: number | undefined) {
  const pt = points && points > 0 ? points : 15;
  return Math.round((pt * 96) / 72);
}

function edgeCss(mark: string) {
  if (mark === "m") return "2px solid #000";
  if (mark === "k") return "3px solid #000";
  if (mark === "d") return "3px double #000";
  if (mark === "h") return "1px solid #bfbfbf";
  if (mark === "t") return "1px solid #000";
  return "0";
}

function outerBorder(borders: string[][], row: number, col: number, rows: number, cols: number): CSSProperties {
  const here = borders[row]?.[col] || "....";
  const right = borders[row]?.[col + cols - 1] || here;
  const bottom = borders[row + rows - 1]?.[col] || here;
  return {
    borderLeft: edgeCss(here[0] || "."),
    borderRight: edgeCss(right[1] || "."),
    borderTop: edgeCss(here[2] || "."),
    borderBottom: edgeCss(bottom[3] || "."),
  };
}

function cellLook(mark: string) {
  if (/^[01][clr.][ctb.][01]\d{2}$/.test(mark)) {
    const size = Number(mark.slice(4));
    return {
      bold: mark[0] === "1",
      align: mark[1] === "c" ? "center" : mark[1] === "r" ? "right" : "left",
      valign: mark[2] === "t" ? "top" : mark[2] === "c" ? "middle" : "bottom",
      wrap: mark[3] === "1",
      size: size > 0 ? size : 11,
    } as const;
  }
  return {
    bold: mark.includes("b"),
    align: mark.includes("c") ? "center" : mark.includes("r") ? "right" : "left",
    valign: "middle",
    wrap: true,
    size: 11,
  } as const;
}

function ExcelView({ book }: { book: ExcelSpec }) {
  const filePath = (book.path || "").trim();
  const hasSheetStyle = (book.borders?.length ?? 0) > 0;

  const { span, hidden } = useMemo(() => {
    const span = new Map<string, ExcelMerge>();
    const hidden = new Set<string>();
    for (const merge of book.merges ?? []) {
      if (merge.rows < 1 || merge.cols < 1) continue;
      span.set(cellKey(merge.r, merge.c), merge);
      for (let r = merge.r; r < merge.r + merge.rows; r += 1) {
        for (let c = merge.c; c < merge.c + merge.cols; c += 1) {
          if (r === merge.r && c === merge.c) continue;
          hidden.add(cellKey(r, c));
        }
      }
    }
    return { span, hidden };
  }, [book.merges]);

  const width = Math.max(8, ...book.rows.map((row) => row.length));
  const colPx = Array.from({ length: width }, (_, col) => {
    const excelWidth = book.widths?.[col];
    return excelWidth && excelWidth > 0 ? excelWidthPx(excelWidth) : excelWidthPx(12);
  });

  return (
    <div className="overflow-hidden rounded-lg" style={{ background: "#f3f3f3", border: "1px solid #d0d7de" }}>
      <div className="flex items-center gap-2 px-2 py-1" style={{ background: "#217346", color: "#fff" }}>
        <span className="shrink-0 text-[11px] font-semibold">{book.title}</span>
        <span className="min-w-0 truncate text-[11px] opacity-90">{filePath || `${book.sheet}.xlsx`}</span>
      </div>
      <div className="max-h-[520px] overflow-auto bg-white">
        <table
          className="border-collapse text-black"
          style={{
            tableLayout: "fixed",
            width: 32 + colPx.reduce((sum, px) => sum + px, 0),
            fontFamily: "Arial, Helvetica, sans-serif",
            background: "#fff",
          }}
        >
          <colgroup>
            <col style={{ width: 32 }} />
            {colPx.map((px, col) => (
              <col key={col} style={{ width: px }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="sticky top-0 left-0 z-20 w-8 border border-[#d0d7de] bg-[#f3f3f3]" />
              {Array.from({ length: width }, (_, col) => (
                <th
                  key={col}
                  className="sticky top-0 z-10 border border-[#d0d7de] bg-[#f3f3f3] px-1 py-1 text-[11px] font-semibold"
                >
                  {COLS[col] ?? col + 1}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {book.rows.map((row, r) => (
              <tr key={r} style={{ height: rowPx(book.heights?.[r]) }}>
                <th className="sticky left-0 z-10 border border-[#d0d7de] bg-[#f3f3f3] px-1 text-center text-[11px] font-normal text-[#667]">
                  {r + 1}
                </th>
                {Array.from({ length: width }, (_, c) => {
                  if (hidden.has(cellKey(r, c))) return null;
                  const merge = span.get(cellKey(r, c));
                  const spanRows = merge?.rows ?? 1;
                  const spanCols = merge?.cols ?? 1;
                  const look = cellLook(book.styles?.[r]?.[c] || "");
                  let height = 0;
                  for (let offset = 0; offset < spanRows; offset += 1) height += rowPx(book.heights?.[r + offset]);
                  const sheetBorder = hasSheetStyle && book.borders ? outerBorder(book.borders, r, c, spanRows, spanCols) : null;
                  return (
                    <td
                      key={c}
                      rowSpan={spanRows}
                      colSpan={spanCols}
                      className={sheetBorder ? "overflow-hidden px-[3px]" : "overflow-hidden border border-[#b4b4b4] px-1 py-0.5 align-middle"}
                      style={{
                        height,
                        boxSizing: "border-box",
                        textAlign: look.align,
                        verticalAlign: look.valign,
                        fontWeight: look.bold ? 700 : 400,
                        fontSize: `${look.size}pt`,
                        whiteSpace: look.wrap ? "pre-line" : "pre",
                        lineHeight: 1.05,
                        color: "#000",
                        background: "#fff",
                        ...(sheetBorder ?? {}),
                      }}
                    >
                      {row[c] ?? ""}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-end gap-1 px-2 pt-1" style={{ background: "#e6e6e6" }}>
        <span
          className="rounded-t px-3 py-1 text-[11px] font-semibold"
          style={{ background: "#fff", color: "#217346" }}
        >
          {book.sheet}
        </span>
      </div>
    </div>
  );
}

export default memo(ExcelView);

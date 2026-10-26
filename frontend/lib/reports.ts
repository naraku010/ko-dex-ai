import type { ReportSpec } from '@/types/assistant'

function reportKey(report: ReportSpec) {
  const title = report.title.trim()
  const html = report.html.replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?/g, '')
  return `${title}\n${html}`
}

/** 같은 제목·내용의 리포트가 툴 재호출로 두 번 오면 하나만 남긴다. */
export function collapseReports(reports: ReportSpec[]): ReportSpec[] {
  const seen = new Set<string>()
  const out: ReportSpec[] = []
  for (const item of reports) {
    const key = reportKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

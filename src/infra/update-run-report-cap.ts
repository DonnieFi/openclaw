import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

const REPORT_DETAILS_OMITTED_COMPACT = "… run openclaw update status";

function bounded(text: string, limit: number): string {
  return text.length <= limit ? text : `${sliceUtf16Safe(text, 0, limit - 1)}…`;
}

function protectedLabelLength(text: string): number {
  const separator = text.indexOf(":");
  if (separator < 0) {
    return Math.min(text.length, 40);
  }
  return separator + (text[separator + 1] === " " ? 2 : 1);
}

function boundedEdges(text: string, limit: number, protectedPrefix: number): string {
  if (text.length <= limit) {
    return text;
  }
  if (limit <= 1) {
    return limit === 1 ? "…" : "";
  }
  const prefix = Math.min(protectedPrefix, limit - 1);
  if (limit === prefix + 1) {
    return `${sliceUtf16Safe(text, 0, prefix)}…`;
  }
  // Protected facts keep their complete label and trailing operator detail; prefix-only
  // truncation can retain prose while hiding the action that makes the warning useful.
  const tail = Math.max(1, Math.floor((limit - prefix - 1) / 2));
  return `${sliceUtf16Safe(text, 0, limit - tail - 1)}…${sliceUtf16Safe(text, -tail)}`;
}

export function boundedProtectedLine(text: string, limit: number): string {
  return boundedEdges(text, limit, protectedLabelLength(text));
}

export function renderProtectedReport(
  lines: string[],
  limit: number,
  reservedLine?: string,
): string {
  const required = lines.filter(Boolean);
  const contentBudget = limit - REPORT_DETAILS_OMITTED_COMPACT.length - required.length;
  if (required.length === 0 || contentBudget < required.length) {
    return bounded(REPORT_DETAILS_OMITTED_COMPACT, limit);
  }
  const entries = required.map((line) => {
    const labelLength = protectedLabelLength(line);
    return {
      line,
      labelLength,
      allocation: Math.min(line.length, labelLength + (line.length > labelLength ? 1 : 0)),
    };
  });
  const reserved = reservedLine ? entries.find((entry) => entry.line === reservedLine) : undefined;
  let remaining = contentBudget - entries.reduce((sum, entry) => sum + entry.allocation, 0);
  if (remaining < 0) {
    return bounded(REPORT_DETAILS_OMITTED_COMPACT, limit);
  }
  // The owner-provided restart command gets first claim after every label. Flexible facts then
  // water-fill the residual budget, so short lines donate unused capacity to longer facts.
  if (reserved) {
    const grant = Math.min(reserved.line.length - reserved.allocation, remaining);
    reserved.allocation += grant;
    remaining -= grant;
  }
  while (remaining > 0) {
    const expandable = entries.filter(
      (entry) => entry !== reserved && entry.allocation < entry.line.length,
    );
    if (expandable.length === 0) {
      break;
    }
    const share = Math.max(1, Math.floor(remaining / expandable.length));
    for (const entry of expandable) {
      const grant = Math.min(entry.line.length - entry.allocation, share, remaining);
      entry.allocation += grant;
      remaining -= grant;
    }
  }
  const protectedLines = entries.map((entry) =>
    boundedEdges(entry.line, entry.allocation, entry.labelLength),
  );
  return [protectedLines[0], REPORT_DETAILS_OMITTED_COMPACT, ...protectedLines.slice(1)].join("\n");
}

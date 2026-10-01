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
  const reservedIndex = reservedLine ? required.indexOf(reservedLine) : -1;
  const labelLengths = required.map(protectedLabelLength);
  const allocations = required.map((line, index) =>
    Math.min(line.length, labelLengths[index] + (line.length > labelLengths[index] ? 1 : 0)),
  );
  let remaining = contentBudget - allocations.reduce((sum, size) => sum + size, 0);
  if (remaining < 0) {
    return bounded(REPORT_DETAILS_OMITTED_COMPACT, limit);
  }
  // The owner-provided restart command gets first claim after every label. Flexible facts then
  // water-fill the residual budget, so short lines donate unused capacity to longer facts.
  if (reservedIndex >= 0) {
    const grant = Math.min(required[reservedIndex].length - allocations[reservedIndex], remaining);
    allocations[reservedIndex] += grant;
    remaining -= grant;
  }
  while (remaining > 0) {
    const expandable = allocations
      .map((size, index) => ({ index, size }))
      .filter(({ index, size }) => index !== reservedIndex && size < required[index].length);
    if (expandable.length === 0) {
      break;
    }
    const share = Math.max(1, Math.floor(remaining / expandable.length));
    for (const { index } of expandable) {
      const grant = Math.min(required[index].length - allocations[index], share, remaining);
      allocations[index] += grant;
      remaining -= grant;
    }
  }
  const protectedLines = required.map((line, index) =>
    boundedEdges(line, allocations[index], labelLengths[index]),
  );
  return [protectedLines[0], REPORT_DETAILS_OMITTED_COMPACT, ...protectedLines.slice(1)].join("\n");
}

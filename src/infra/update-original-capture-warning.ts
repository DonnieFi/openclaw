const RETRY_UPDATE = /then retry the update\.?$/u;

/** The inspection diagnostic says to retry. Best-effort capture has already continued. */
export function formatBestEffortOriginalCaptureWarning(detail: string): string {
  const replaced = detail.replace(RETRY_UPDATE, "the update continues without this capture.");
  const continued =
    replaced === detail ? `${detail} The update continues without this capture.` : replaced;
  return `Original state capture is unavailable: ${continued} A completed update does not need to be restarted because of this warning.`;
}

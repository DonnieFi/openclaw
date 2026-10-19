import { formatChannelProgressDraftLineForEntry } from "openclaw/plugin-sdk/channel-outbound";

type ProgressEntry = Parameters<typeof formatChannelProgressDraftLineForEntry>[0];
type ProgressInput = Parameters<typeof formatChannelProgressDraftLineForEntry>[1];

/** Feishu card rows opt into the shared tool glyphs. The formatter default is plain. */
export function formatFeishuToolProgressLine(
  entry: ProgressEntry,
  input: ProgressInput,
): string | undefined {
  return formatChannelProgressDraftLineForEntry(entry, input, { toolIcons: true });
}

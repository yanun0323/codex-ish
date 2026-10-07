import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { compact, SettingsManager, type ExtensionAPI, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

const DETAILS_MARKER = "codexIshAutoCompaction";

function carryFileHistory(event: SessionBeforeCompactEvent): void {
  const previous = event.branchEntries.findLast(entry => entry.type === "compaction");
  if (!previous || previous.summary !== event.preparation.previousSummary || !previous.fromHook) return;
  const details = previous.details as Record<string, unknown> | undefined;
  if (!details || details[DETAILS_MARKER] !== true) return;

  // Pi skips file metadata from extension summaries. Restore our own metadata for
  // the next compaction, including a manual one, without changing its thinking.
  const fileOps = event.preparation.fileOps;
  for (const [key, target] of [["readFiles", fileOps.read], ["modifiedFiles", fileOps.edited]] as const) {
    const files = details[key];
    if (Array.isArray(files)) for (const file of files) if (typeof file === "string") target.add(file);
  }
}

export function registerAutoCompaction(pi: ExtensionAPI, agentDir: string): void {
  pi.on("session_before_compact", async (event, ctx) => {
    carryFileHistory(event);
    if (event.reason !== "threshold" && event.reason !== "overflow") return;
    const model = ctx.model;
    if (!model) return;

    try {
      event.signal.throwIfAborted();
      const thinking = getSupportedThinkingLevels(model)[0];
      if (thinking === undefined) throw new Error("The model has no supported thinking level.");
      // Read settings only; never change the selected model, thinking, or user files.
      const settings = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
      const result = await compact(event.preparation, model, undefined, undefined,
        event.customInstructions, event.signal, thinking, async (selected, context, options) => {
          event.signal.throwIfAborted();
          // The registry preserves provider authentication, custom endpoints, and headers.
          const stream = ctx.modelRegistry.streamSimple(selected, context, { ...options,
            ...settings.getProviderRetrySettings(), reasoning: thinking === "off" ? undefined : thinking });
          const response = await stream.result();
          event.signal.throwIfAborted();
          // Let Pi retry transient error responses, but never save an incomplete/empty summary.
          if (response.stopReason !== "error" && (response.stopReason !== "stop" ||
            !response.content.some(part => part.type === "text" && part.text.trim()))) {
            throw new Error("Compaction did not return a complete summary.");
          }
          return stream;
        }, undefined, settings.getRetrySettings());
      event.signal.throwIfAborted();
      return { compaction: { ...result, details: { ...result.details as Record<string, unknown>, [DETAILS_MARKER]: true } } };
    } catch {
      if (!event.signal.aborted) ctx.ui.notify(
        "Auto-compaction failed at the lowest thinking level. No summary was saved. Try /compact to retry with your current thinking setting.", "error");
      // Returning nothing would silently repeat the request at the main conversation's thinking level.
      return { cancel: true };
    }
  });
}

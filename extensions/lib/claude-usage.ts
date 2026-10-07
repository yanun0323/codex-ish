// Claude Code exposes plan usage as a control request, not a model prompt.
// Keep this optional/experimental SDK surface isolated from the rest of the footer.
export const CLAUDE_USAGE_METHOD = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";

export type ClaudeUsageQuery = {
  [CLAUDE_USAGE_METHOD]?: (options: { skipBehaviors: boolean }) => Promise<unknown>;
  close(): void;
};

export type StartClaudeUsageQuery = (
  prompt: AsyncIterable<never>,
  controller: AbortController,
) => Promise<ClaudeUsageQuery>;

/** One idle process while this provider is visible. Never submits a user message. */
export class ClaudeUsageReader {
  private readonly controller = new AbortController();
  private readonly stopped: Promise<undefined>;
  private query?: ClaudeUsageQuery;
  private pending?: Promise<unknown>;
  private readonly onAbort = () => this.close();

  constructor(
    private readonly start: StartClaudeUsageQuery,
    private readonly signal: AbortSignal,
    private readonly timeoutMs = 10_000,
  ) {
    this.stopped = new Promise(resolve => {
      this.controller.signal.addEventListener("abort", () => resolve(undefined), { once: true });
    });
    signal.addEventListener("abort", this.onAbort, { once: true });
    if (signal.aborted) this.close();
  }

  read(): Promise<unknown> {
    if (this.controller.signal.aborted) return Promise.resolve(undefined);
    if (this.pending) return this.pending;
    this.pending = this.readOnce().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async readOnce(): Promise<unknown> {
    const timeout = setTimeout(() => this.close(), this.timeoutMs);
    let onAbort!: () => void;
    // A separate, removable listener avoids accumulating Promise.race reactions
    // on the process-lifetime promise during long-running sessions.
    const cancelled = new Promise<undefined>(resolve => {
      onAbort = () => resolve(undefined);
      this.controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    const work = async () => {
      if (!this.query) {
        const stopped = this.stopped;
        // An open, empty input stream permits control requests without inference.
        const prompt = (async function* () { await stopped; })();
        const query = await this.start(prompt, this.controller);
        if (this.controller.signal.aborted) {
          query.close(); // Startup may finish after a switch, timeout, or shutdown.
          return undefined;
        }
        this.query = query;
      }
      const readUsage = this.query[CLAUDE_USAGE_METHOD];
      if (typeof readUsage !== "function") {
        this.close();
        return undefined;
      }
      const result = await readUsage.call(this.query, { skipBehaviors: true });
      return this.controller.signal.aborted ? undefined : result;
    };
    try {
      return await Promise.race([work(), cancelled]);
    } catch {
      // Do not repeatedly spawn processes for a missing or broken experimental API.
      this.close();
      return undefined;
    } finally {
      clearTimeout(timeout);
      this.controller.signal.removeEventListener("abort", onAbort);
    }
  }

  close(): void {
    if (this.controller.signal.aborted) return;
    this.signal.removeEventListener("abort", this.onAbort);
    this.controller.abort();
    try { this.query?.close(); } catch { /* The SDK process may have already exited. */ }
    this.query = undefined;
  }
}

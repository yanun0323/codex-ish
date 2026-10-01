import { object, RpcError, type JsonObject } from "./types.js";

// Desktop sends its own defaults even to third-party hosts. These are recognized
// but NOT enabled: Pi's tools, instructions, extensions and permissions stay local.
// Keep this list explicit; unknown config keys must still be rejected.
export const DESKTOP_FEATURES = [
  "code_mode_interrupt", "collaboration_modes", "request_rule", "image_generation", "item_ids",
  "image_detail_original", "image_resize_notice", "workspace_dependencies", "guardian_approval",
  "guardian_reuse_parent_compaction", "apps_mcp_path_override", "concurrent_reasoning_summaries",
  "enable_mcp_apps", "guardianv2", "realtime_conversation", "memories", "auth_elicitation", "tool_suggest",
  "mcp_2026_07_28", "remote_plugin", "background_paginated_rollout_migration", "api_key_model_discovery",
  "codex_apps_mcp_2026_07_28", "windows_sandbox_service",
] as const;
const features = new Set<string>(DESKTOP_FEATURES);
export const disabledFeatures = (): Record<string, boolean> => Object.fromEntries(DESKTOP_FEATURES.map(name => [name, false]));
export function declinedEnablement(value: unknown): Record<string, boolean> {
  const entries = Object.entries(object(value));
  if (entries.length > 100 || entries.some(([name, enabled]) => !features.has(name) || typeof enabled !== "boolean")) {
    throw new RpcError(-32602, "This Pi host cannot change those Codex features. Configure tools and extensions in Pi.");
  }
  return Object.fromEntries(entries.map(([name]) => [name, false]));
}
const pageTools = new Set(["create_presentation", "create_spreadsheet", "create_canvas", "execute_artifact_code", "inspect_artifact"]
  .map(name => `chatgpt_space.${name}`));
function desktopConfig(value: unknown): void {
  const entries = Object.entries(object(value));
  if (entries.length > 100) throw new RpcError(-32602, "Too many configuration overrides.");
  for (const [key, setting] of entries) {
    if (key.startsWith("features.") && features.has(key.slice(9)) && typeof setting === "boolean") continue;
    if (key === "apps.connector_openai_pages.tools") {
      const tools = Object.entries(object(setting));
      if (tools.every(([name, value]) => pageTools.has(name) && value && typeof value === "object" &&
          !Array.isArray(value) && Object.keys(value).length === 1 && value.enabled === false)) continue;
    }
    throw new RpcError(-32602, "This configuration override is not supported. Keep Pi's local settings.");
  }
}

/** Translate supported fields and explicitly report defaults which Pi does not apply. */
export function desktopOptions(raw: JsonObject): { params: JsonObject; notice: boolean } {
  const params = { ...raw };
  let notice = false;
  if (params.config != null) {
    const settings = { ...object(params.config) };
    // iOS echoes the thinking selection here when resuming an existing conversation.
    if (Object.hasOwn(settings, "model_reasoning_effort")) {
      const effort = settings.model_reasoning_effort;
      if (effort != null) {
        if (typeof effort !== "string" || params.effort != null && params.effort !== effort) throw new RpcError(-32602, "Use the same thinking level in the conversation and its settings.");
        params.effort = effort;
      }
      delete settings.model_reasoning_effort;
    }
    desktopConfig(settings); notice ||= Object.keys(settings).length > 0; delete params.config;
  }
  if (params.developerInstructions != null) {
    if (typeof params.developerInstructions !== "string" || Buffer.byteLength(params.developerInstructions) > 64 * 1024) {
      throw new RpcError(-32602, "Desktop instructions must be text up to 64 KiB.");
    }
    notice ||= params.developerInstructions.length > 0; delete params.developerInstructions;
  }
  if (params.personality != null) {
    if (!["none", "friendly", "pragmatic"].includes(params.personality)) throw new RpcError(-32602, "Unknown desktop personality.");
    notice = true; delete params.personality;
  }
  if (params.collaborationMode != null) {
    const mode = object(params.collaborationMode);
    if (mode.mode !== "default" || Object.keys(mode).some(key => !["mode", "settings"].includes(key))) {
      throw new RpcError(-32602, "Use the default chat mode. Codex planning modes are not supported by this Pi host.");
    }
    const settings = object(mode.settings ?? {});
    if (Object.keys(settings).some(key => !["model", "reasoning_effort", "developer_instructions"].includes(key))) {
      throw new RpcError(-32602, "Unsupported collaboration settings.");
    }
    for (const [source, target] of [["model", "model"], ["reasoning_effort", "effort"]] as const) {
      if (settings[source] == null) continue;
      if (typeof settings[source] !== "string" || params[target] != null && params[target] !== settings[source]) {
        throw new RpcError(-32602, "Use the same model and reasoning effort in the chat and mode settings.");
      }
      params[target] = settings[source];
    }
    if (settings.developer_instructions != null) {
      const nested = desktopOptions({ developerInstructions: settings.developer_instructions }); notice ||= nested.notice;
    }
    delete params.collaborationMode;
  }
  // An empty list registers no tools. Never acknowledge actual unsupported tool definitions.
  if (Array.isArray(params.dynamicTools) && params.dynamicTools.length === 0) delete params.dynamicTools;
  return { params, notice };
}

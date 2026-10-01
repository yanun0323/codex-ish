// Sanitized request shapes observed from the macOS desktop on 2026-10-01.
// No real conversation text, paths, identifiers, or credentials are stored here.
export const desktopConfig = {
  "features.code_mode_interrupt": true,
  "features.collaboration_modes": true,
  "features.request_rule": true,
  "features.image_generation": true,
  "features.item_ids": true,
  "features.image_detail_original": true,
  "features.image_resize_notice": true,
  "features.workspace_dependencies": true,
  "features.guardian_approval": true,
  "features.guardian_reuse_parent_compaction": true,
  "features.apps_mcp_path_override": true,
  "features.concurrent_reasoning_summaries": true,
  "features.enable_mcp_apps": true,
  "features.guardianv2": true,
  "features.realtime_conversation": true,
  "apps.connector_openai_pages.tools": Object.fromEntries([
    "create_presentation", "create_spreadsheet", "create_canvas", "execute_artifact_code", "inspect_artifact",
  ].map(name => [`chatgpt_space.${name}`, { enabled: false }])),
};
export const desktopResume = {
  history: null, model: null, modelProvider: null, serviceTier: null,
  developerInstructions: "Desktop-only context that must not replace Pi instructions.",
  personality: "friendly", excludeTurns: true,
  initialTurnsPage: { limit: 5, itemsView: "full", sortDirection: "desc" },
  config: desktopConfig,
};
export const desktopEnablement = { memories: false, apps_mcp_path_override: true, auth_elicitation: true,
  tool_suggest: false, mcp_2026_07_28: false, remote_plugin: true, background_paginated_rollout_migration: true,
  api_key_model_discovery: false, codex_apps_mcp_2026_07_28: false, windows_sandbox_service: true };

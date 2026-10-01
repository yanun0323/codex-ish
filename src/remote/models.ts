import { findPackageJSON } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RpcError, text, type JsonObject } from "./types.js";

export type ModelOptions = { model?: string; effort?: string };
export type ThinkingLevels = (model: JsonObject) => string[];
export const reasoningEffort = (level: string) => level === "off" ? "none" : level;
export const thinkingLevel = (effort: string) => effort === "none" ? "off" : effort;

/** Resolve ESM-only Pi packages relative to the host, not a bundled development copy. */
export function hostModulePath(name: string, from: string): string {
  const path = findPackageJSON(name, pathToFileURL(from));
  if (!path) throw new Error("The installed Pi library was not found.");
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  const entry = pkg.exports?.["."]?.import ?? pkg.main;
  if (typeof entry !== "string") throw new Error("The installed Pi library is not supported.");
  return fileURLToPath(new URL(entry, pathToFileURL(path)));
}
/** Use the same capability rules as the installed Pi, including provider overrides. */
export async function hostThinkingLevels(sdkPath: string): Promise<ThinkingLevels> {
  const ai = await import(pathToFileURL(hostModulePath("@earendil-works/pi-ai", sdkPath)).href);
  if (typeof ai.getSupportedThinkingLevels !== "function") throw new Error("Update Pi to read model thinking levels.");
  return ai.getSupportedThinkingLevels;
}
export function modelCatalog(models: JsonObject[], levels: ThinkingLevels, current?: string): JsonObject[] {
  return models.map((model, index) => {
    const id = `${model.provider}/${model.id}`;
    const efforts = levels(model).map(reasoningEffort);
    return { id, model: id, displayName: model.name ?? model.id, description: `${model.provider} · Pi`, hidden: false,
      upgrade: null, upgradeInfo: null, availabilityNux: null, modelSpecialty: null,
      supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })),
      defaultReasoningEffort: efforts.includes("medium") ? "medium" : efforts[0] ?? "none", inputModalities: model.input ?? ["text"],
      supportsPersonality: false, multiAgentVersion: null, additionalSpeedTiers: [], serviceTiers: [],
      defaultServiceTier: null, availableAccessPrograms: null, isDefault: current ? id === current : index === 0 };
  });
}
export function resolveModel(models: readonly JsonObject[], name: unknown): JsonObject {
  const id = text(name, "model", 512);
  const exact = models.find(model => `${model.provider}/${model.id}` === id);
  if (exact) return exact;
  const matches = models.filter(model => model.id === id);
  if (matches.length !== 1) throw new RpcError(-32602, "Select an available model from the model list.");
  return matches[0]!;
}
export function validateModelOptions(options: ModelOptions, model: JsonObject, levels: ThinkingLevels): void {
  if (options.effort != null && !levels(model).map(reasoningEffort).includes(options.effort)) {
    throw new RpcError(-32602, "Select a thinking level supported by this model.");
  }
}

import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { RpcError, text, type JsonObject } from "./types.js";

export interface RemoteSkill { name: string; description: string; path: string; scope: "user" | "repo"; }
export const escapeAttribute = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function skillMetadata(skills: RemoteSkill[]): JsonObject[] {
  return skills.map(skill => ({ ...skill, enabled: true, pluginId: null }));
}
export function commandSkills(commands: JsonObject[]): RemoteSkill[] {
  return commands.filter(command => command.source === "skill" && command.name.startsWith("skill:") && isAbsolute(command.sourceInfo?.path ?? ""))
    .map(command => ({ name: command.name.slice(6), description: command.description ?? "", path: command.sourceInfo.path,
      scope: command.sourceInfo.scope === "project" ? "repo" : "user" }));
}
export function resourceSkills(skills: JsonObject[]): RemoteSkill[] {
  return skills.filter(skill => isAbsolute(skill.filePath ?? "")).map(skill => ({ name: skill.name, description: skill.description ?? "",
    path: skill.filePath, scope: skill.sourceInfo?.scope === "project" ? "repo" : "user" }));
}

/** Only a skill discovered by this Pi session may be loaded, never a peer-supplied arbitrary path. */
export async function skillBlock(item: JsonObject, skills: RemoteSkill[]): Promise<string> {
  const name = text(item.name, "skill name", 256);
  const path = text(item.path, "skill path");
  const skill = skills.find(skill => skill.name === name && skill.path === path);
  if (!skill) throw new RpcError(-32602, "This skill is not available in this Pi session. Refresh the skill list.");
  let file;
  try {
    // Symlinked skill installations are supported, but only the discovered Markdown entry is read.
    const canonical = await realpath(skill.path);
    if (!/\.md$/i.test(canonical)) throw new Error("Not a Markdown skill.");
    file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    const max = 256 * 1024;
    if (!info.isFile() || info.size > max) throw new Error("Invalid skill file.");
    const buffer = Buffer.alloc(max + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > max) throw new Error("Skill is too large.");
    const body = buffer.subarray(0, used).toString("utf8").replace(/^\uFEFF/, "").replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
    return `<skill name="${escapeAttribute(skill.name)}" location="${escapeAttribute(skill.path)}">\nReferences are relative to ${dirname(skill.path)}.\n\n${body}\n</skill>`;
  } catch {
    throw new RpcError(-32602, "Unable to load this skill. Check that its Markdown file is readable and no larger than 256 KiB.");
  } finally { await file?.close(); }
}

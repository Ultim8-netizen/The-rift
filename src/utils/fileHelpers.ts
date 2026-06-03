import { readDir, stat } from "@tauri-apps/plugin-fs";

export function fmt(bytes: number): string {
  if (!bytes) return "0 B";
  const k = 1024, s = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / k ** i).toFixed(1))} ${s[i]}`;
}

function joinPath(dir: string, name: string): string {
  if (!name) return dir;
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir.endsWith("/") || dir.endsWith("\\") ? dir + name : dir + sep + name;
}

async function enumFilesRecursive(dirPath: string): Promise<string[]> {
  try {
    const entries = await readDir(dirPath);
    const results: string[] = [];
    for (const entry of entries) {
      if (!entry.name) continue;
      const fullPath = joinPath(dirPath, entry.name);
      if (entry.isDirectory) results.push(...(await enumFilesRecursive(fullPath)));
      else if (entry.isFile) results.push(fullPath);
    }
    return results;
  } catch {
    return [];
  }
}

export async function expandToPaths(rawPaths: string[]): Promise<string[]> {
  const result: string[] = [];
  for (const p of rawPaths) {
    try {
      const info = await stat(p);
      if (info.isDirectory) result.push(...(await enumFilesRecursive(p)));
      else result.push(p);
    } catch {
      result.push(p);
    }
  }
  return result;
}
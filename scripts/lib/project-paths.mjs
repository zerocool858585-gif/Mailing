import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function resolveProjectPath(value) {
  if (!value) return value;
  const raw = String(value);
  if (!path.isAbsolute(raw)) return path.resolve(PROJECT_ROOT, raw);

  const normalized = raw.replace(/\\/g, "/");
  const marker = "/senler_salebot_mailer/";
  const markerIndex = normalized.toLowerCase().indexOf(marker);
  if (markerIndex !== -1) {
    return path.resolve(PROJECT_ROOT, normalized.slice(markerIndex + marker.length));
  }
  return path.normalize(raw);
}

export function toProjectRelative(value) {
  if (!value) return value;
  const absolute = resolveProjectPath(value);
  const relative = path.relative(PROJECT_ROOT, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return value;
  return relative.split(path.sep).join("/");
}

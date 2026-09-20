/**
 * Structured, metadata-only logging.
 * HARD RULE: never pass prompts, completions, API keys or Authorization values here.
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: Level = "info";

export function setLogLevel(level: string | undefined): void {
  if (level && level in LEVEL_ORDER) minLevel = level as Level;
}

export interface LogFields {
  [key: string]: string | number | boolean | null | undefined;
}

function emit(level: Level, event: string, fields: LogFields): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const entry = { ts: new Date().toISOString(), level, event, ...fields };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (event: string, fields: LogFields = {}) => emit("debug", event, fields),
  info: (event: string, fields: LogFields = {}) => emit("info", event, fields),
  warn: (event: string, fields: LogFields = {}) => emit("warn", event, fields),
  error: (event: string, fields: LogFields = {}) => emit("error", event, fields),
};

import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

export type VoicePerformanceFields = Record<string, string | number | boolean | null | undefined>;

export function logVoicePerformance(event: string, fields: VoicePerformanceFields = {}): void {
  const entry = {
    timestamp: new Date().toISOString(),
    pid: process.pid,
    event,
    ...fields,
  };
  const line = JSON.stringify(entry);
  console.log(`[VoicePerf] ${line}`);
  try {
    fs.appendFileSync(path.join(app.getPath("userData"), "voice-performance.jsonl"), `${line}\n`, "utf8");
  } catch (error) {
    console.warn("[VoicePerf] Unable to persist timing log:", error);
  }
}


import { randomUUID } from "node:crypto";

export type VoiceSource = "system-audio" | "microphone";
export type VoicePhase = "idle" | "starting" | "recording" | "finalizing" | "processing";

export interface VoiceSessionSnapshot {
  id: string;
  source: VoiceSource;
  phase: Exclude<VoicePhase, "idle">;
  stopRequested: boolean;
  finalizationClaimed: boolean;
  llmClaimed: boolean;
  historyClaimed: boolean;
}

export type VoiceToggleResult =
  | { action: "start"; session: VoiceSessionSnapshot }
  | { action: "stop"; session: VoiceSessionSnapshot }
  | { action: "wait"; session: VoiceSessionSnapshot }
  | { action: "ignored"; session: VoiceSessionSnapshot }
  | { action: "conflict"; message: string; session: VoiceSessionSnapshot };

/** Main-process source of truth for the mutually-exclusive voice modes. */
export class VoiceSessionStateMachine {
  private session: VoiceSessionSnapshot | null = null;

  public snapshot(): VoiceSessionSnapshot | null {
    return this.session ? { ...this.session } : null;
  }

  public toggle(source: VoiceSource, sessionId = randomUUID()): VoiceToggleResult {
    if (!this.session) {
      this.session = {
        id: sessionId,
        source,
        phase: "starting",
        stopRequested: false,
        finalizationClaimed: false,
        llmClaimed: false,
        historyClaimed: false,
      };
      return { action: "start", session: this.snapshot()! };
    }

    if (this.session.source !== source) {
      return {
        action: "conflict",
        message: this.session.source === "system-audio"
          ? "Stop System Audio recording first."
          : "Stop Microphone recording first.",
        session: this.snapshot()!,
      };
    }

    if (this.session.phase === "starting") {
      this.session.stopRequested = true;
      return { action: "wait", session: this.snapshot()! };
    }
    if (this.session.phase === "recording") {
      this.session.phase = "finalizing";
      return { action: "stop", session: this.snapshot()! };
    }
    return { action: "ignored", session: this.snapshot()! };
  }

  public captureReady(sessionId: string): "record" | "stop" | "stale" {
    if (!this.session || this.session.id !== sessionId || this.session.phase !== "starting") return "stale";
    if (this.session.stopRequested) {
      this.session.phase = "finalizing";
      return "stop";
    }
    this.session.phase = "recording";
    return "record";
  }

  public acceptsAudio(sessionId: string, source: VoiceSource): boolean {
    return Boolean(
      this.session &&
      this.session.id === sessionId &&
      this.session.source === source &&
      ["starting", "recording", "finalizing"].includes(this.session.phase),
    );
  }

  public claimFinalization(sessionId: string): boolean {
    if (!this.session || this.session.id !== sessionId || this.session.phase !== "finalizing" || this.session.finalizationClaimed) {
      return false;
    }
    this.session.finalizationClaimed = true;
    return true;
  }

  public claimLlm(sessionId: string): boolean {
    if (!this.session || this.session.id !== sessionId || !this.session.finalizationClaimed || this.session.llmClaimed) return false;
    this.session.llmClaimed = true;
    this.session.phase = "processing";
    return true;
  }

  public claimHistory(sessionId: string): boolean {
    if (!this.session || this.session.id !== sessionId || !this.session.llmClaimed || this.session.historyClaimed) return false;
    this.session.historyClaimed = true;
    return true;
  }

  public finish(sessionId: string): boolean {
    if (!this.session || this.session.id !== sessionId) return false;
    this.session = null;
    return true;
  }
}

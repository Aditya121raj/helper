import { app } from "electron";
import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { logVoicePerformance } from "./VoicePerformanceLogger";
import {
  IncrementalTranscriptionSession,
  LocalTranscriptionRequest,
} from "./voice/IncrementalTranscriptionSession";

const INCREMENTAL_TIMEOUT_MS = 45000;
type WorkerOperation = "warmup" | "incremental" | "fallback";

type PendingRequest = {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  startedAt: number;
  sessionId: string | null;
  operation: WorkerOperation;
  timeout: NodeJS.Timeout | null;
};

export class VoiceTranscriptionHelper {
  private worker: ChildProcessWithoutNullStreams | null = null;
  private workerStartPromise: Promise<void> | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly warmedModels = new Set<string>();
  private readonly warmupPromises = new Map<string, Promise<void>>();
  private readonly voiceRoot = path.join(app.getPath("temp"), "noview-voice");
  private sessionId: string | null = null;
  private incrementalSession: IncrementalTranscriptionSession | null = null;
  private model = "small";
  private chunkCount = 0;
  private recordingStartedAt = 0;
  private finalizePromise: Promise<string> | null = null;

  public constructor(
    private readonly onIncrementalTranscript?: (sessionId: string, transcript: string) => void,
  ) {}

  public isRecording(): boolean {
    return this.sessionId !== null;
  }

  public getSessionId(): string | null {
    return this.sessionId;
  }

  public prewarm(model: "base" | "small" | "tiny" = "small"): void {
    logVoicePerformance("voice_startup_warmup_requested", { model });
    void this.ensureModelWarm(model, null).catch((error) => {
      logVoicePerformance("voice_startup_warmup_failed", { model, error: error.message });
    });
  }

  public async start(
    model: "base" | "small" | "tiny" = "small",
    requestedSessionId?: string,
  ): Promise<string> {
    if (this.sessionId) {
      if (!requestedSessionId || requestedSessionId === this.sessionId) return this.sessionId;
      throw new Error("Another voice recording is already active.");
    }
    this.sessionId = requestedSessionId || randomUUID();
    const activeSessionId = this.sessionId;
    this.finalizePromise = null;
    this.model = model;
    this.chunkCount = 0;
    this.recordingStartedAt = performance.now();
    await fs.mkdir(this.getSessionDir(), { recursive: true });
    logVoicePerformance("voice_session_started", { sessionId: this.sessionId, model });

    const sessionDir = this.getSessionDir();
    this.incrementalSession = new IncrementalTranscriptionSession({
      transcribe: (request) =>
        this.transcribePcm(request, activeSessionId, sessionDir),
      onTranscript: (transcript) => {
        if (this.sessionId === activeSessionId) {
          this.onIncrementalTranscript?.(activeSessionId, transcript);
        }
      },
      log: (event, fields) => {
        logVoicePerformance(event, {
          sessionId: activeSessionId,
          ...fields,
        });
      },
    });

    void this.ensureModelWarm(model, this.sessionId).catch((error) => {
      logVoicePerformance("voice_model_warmup_failed", { sessionId: this.sessionId, model, error: error.message });
    });
    return this.sessionId;
  }

  public enqueueChunk(base64Pcm: string, sampleRate: number): Promise<void> {
    if (!this.sessionId) return Promise.reject(new Error("Voice recording is not active."));
    if (!this.incrementalSession) {
      return Promise.reject(new Error("Incremental transcription session is not active."));
    }
    const pcm = Buffer.from(base64Pcm, "base64");
    if (!pcm.length) return Promise.resolve();
    try {
      this.incrementalSession.append(pcm, sampleRate);
      this.chunkCount += 1;
      logVoicePerformance("voice_chunk_buffered", {
        sessionId: this.sessionId,
        chunk: this.chunkCount,
        bytes: pcm.length,
        audioMs: Math.round((pcm.length / 2 / sampleRate) * 1000),
      });
      return Promise.resolve();
    } catch (error: any) {
      return Promise.reject(error);
    }
  }

  public finalize(): Promise<string> {
    if (this.finalizePromise) return this.finalizePromise;
    this.finalizePromise = this.finalizeOnce().finally(() => {
      this.finalizePromise = null;
    });
    return this.finalizePromise;
  }

  private async finalizeOnce(): Promise<string> {
    if (!this.sessionId) throw new Error("Voice recording is not active.");
    if (!this.incrementalSession) throw new Error("Incremental transcription session is not active.");
    const finishedSession = this.sessionId;
    const incrementalSession = this.incrementalSession;
    const finalizeStartedAt = performance.now();
    try {
      await this.ensureModelWarm(this.model, finishedSession);
      const result = await incrementalSession.finalize();
      logVoicePerformance("voice_finalize_completed", {
        sessionId: finishedSession,
        totalMs: Math.round(performance.now() - finalizeStartedAt),
        transcriptChars: result.transcript.length,
        usedFallback: result.usedFallback,
      });
      return result.transcript;
    } finally {
      this.sessionId = null;
      incrementalSession.cancel();
      this.incrementalSession = null;
      this.chunkCount = 0;
      await fs.rm(path.join(this.voiceRoot, finishedSession), { recursive: true, force: true });
    }
  }

  public async cancel(): Promise<void> {
    const id = this.sessionId;
    this.sessionId = null;
    this.incrementalSession?.cancel();
    this.incrementalSession = null;
    this.chunkCount = 0;
    this.finalizePromise = null;
    logVoicePerformance("voice_session_cancelled", { sessionId: id });
    if (id) await fs.rm(path.join(this.voiceRoot, id), { recursive: true, force: true });
  }

  public shutdown(): void {
    const id = this.sessionId;
    this.sessionId = null;
    this.incrementalSession?.cancel();
    this.incrementalSession = null;
    this.chunkCount = 0;
    this.finalizePromise = null;
    if (id) {
      try {
        fsSync.rmSync(path.join(this.voiceRoot, id), { recursive: true, force: true });
      } catch (error) {
        console.warn("Unable to remove active voice session during shutdown:", error);
      }
    }
    this.worker?.kill();
    this.worker = null;
    this.workerStartPromise = null;
    this.warmedModels.clear();
    this.warmupPromises.clear();
    for (const request of this.pending.values()) {
      if (request.timeout) clearTimeout(request.timeout);
      request.reject(new Error("Local transcription worker stopped."));
    }
    this.pending.clear();
  }

  private getSessionDir(): string {
    if (!this.sessionId) throw new Error("Voice recording is not active.");
    return path.join(this.voiceRoot, this.sessionId);
  }

  private async transcribePcm(
    request: LocalTranscriptionRequest,
    sessionId: string,
    sessionDir: string,
  ): Promise<string> {
    if (this.sessionId !== sessionId) {
      throw new Error("Voice transcription request belongs to a stale session.");
    }
    await this.ensureModelWarm(this.model, sessionId);
    const audioPath = path.join(
      sessionDir,
      request.kind === "fallback"
        ? "fallback.wav"
        : `incremental-${request.windowIndex}.wav`,
    );
    await fs.writeFile(audioPath, this.createWav(request.pcm, request.sampleRate));
    try {
      return await this.sendWorkerRequest(
        { audioPath, model: this.model },
        request.kind,
        sessionId,
      );
    } finally {
      await fs.rm(audioPath, { force: true });
    }
  }

  private ensureModelWarm(model: string, sessionId: string | null): Promise<void> {
    if (this.warmedModels.has(model)) return Promise.resolve();
    const existing = this.warmupPromises.get(model);
    if (existing) return existing;
    const warmup = this.sendWorkerRequest({ type: "warmup", model }, "warmup", sessionId)
      .then(() => { this.warmedModels.add(model); })
      .finally(() => { this.warmupPromises.delete(model); });
    this.warmupPromises.set(model, warmup);
    return warmup;
  }

  private async sendWorkerRequest(
    payload: Record<string, string>,
    operation: WorkerOperation,
    sessionId: string | null,
  ): Promise<string> {
    await this.ensureWorker();
    const worker = this.worker;
    if (!worker) throw new Error("Local transcription worker is unavailable.");
    const id = randomUUID();
    const startedAt = performance.now();
    return new Promise<string>((resolve, reject) => {
      const timeout = operation === "incremental"
        ? setTimeout(() => {
            const pending = this.pending.get(id);
            if (!pending) return;
            this.pending.delete(id);
            pending.reject(new Error(
              `Incremental local transcription timed out after ${INCREMENTAL_TIMEOUT_MS} ms.`,
            ));
            this.resetWorker(
              worker,
              new Error("Local transcription worker was restarted after a timeout."),
              true,
            );
          }, INCREMENTAL_TIMEOUT_MS)
        : null;
      this.pending.set(id, {
        resolve,
        reject,
        startedAt,
        sessionId,
        operation,
        timeout,
      });
      worker.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
    });
  }

  private async ensureWorker(): Promise<void> {
    if (this.worker && !this.worker.killed) return;
    if (this.workerStartPromise) return this.workerStartPromise;
    const python = process.env.NOVIEW_PYTHON || (process.platform === "win32" ? "python" : "python3");
    const workerPath = app.isPackaged
      ? path.join(process.resourcesPath, "app.asar.unpacked", "electron", "voice", "voice_transcriber.py")
      : path.join(app.getAppPath(), "electron", "voice", "voice_transcriber.py");
    const packagedWindowsWorker = path.join(process.resourcesPath, "voice-runtime", "voice_transcriber.exe");
    const usePackagedWindowsWorker = app.isPackaged && process.platform === "win32" && fsSync.existsSync(packagedWindowsWorker);
    const executable = usePackagedWindowsWorker ? packagedWindowsWorker : python;
    const args = usePackagedWindowsWorker ? [] : ["-u", workerPath];

    const startedAt = performance.now();
    this.workerStartPromise = new Promise<void>((resolve, reject) => {
      const worker = spawn(executable, args, { windowsHide: true });
      const fail = (error: Error) => {
        worker.kill();
        this.workerStartPromise = null;
        reject(new Error(`Local transcription could not start. ${error.message}. Reinstall NoView or install electron/voice/requirements.txt for development.`));
      };
      worker.once("error", fail);
      worker.once("spawn", () => {
        worker.removeListener("error", fail);
        this.worker = worker;
        this.attachWorkerListeners(worker);
        logVoicePerformance("voice_worker_spawned", { ms: Math.round(performance.now() - startedAt) });
        resolve();
      });
    });
    return this.workerStartPromise;
  }

  private attachWorkerListeners(worker: ChildProcessWithoutNullStreams): void {
    const lines = readline.createInterface({ input: worker.stdout });
    lines.on("line", (line) => {
      try {
        const result = JSON.parse(line);
        const pending = this.pending.get(result.id);
        if (!pending) return;
        this.pending.delete(result.id);
        if (pending.timeout) clearTimeout(pending.timeout);
        logVoicePerformance("voice_worker_request_completed", {
          sessionId: pending.sessionId,
          operation: pending.operation,
          roundTripMs: Math.round(performance.now() - pending.startedAt),
          success: Boolean(result.success),
          inferenceMs: result.timings?.inferenceMs ?? null,
          modelLoadMs: result.timings?.modelLoadMs ?? null,
          audioSeconds: result.timings?.audioSeconds ?? null,
        });
        result.success ? pending.resolve(result.text || "") : pending.reject(new Error(result.error || "Local transcription failed."));
      } catch (error) {
        console.error("Invalid response from voice worker:", error);
      }
    });
    worker.stderr.on("data", (data) => console.warn("[Voice worker]", data.toString()));
    worker.on("exit", () => {
      this.resetWorker(
        worker,
        new Error("Local transcription worker exited unexpectedly."),
        false,
      );
    });
  }

  private resetWorker(
    worker: ChildProcessWithoutNullStreams,
    error: Error,
    kill: boolean,
  ): void {
    if (this.worker !== worker) return;
    this.worker = null;
    this.workerStartPromise = null;
    this.warmedModels.clear();
    this.warmupPromises.clear();
    for (const pending of this.pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    if (kill && !worker.killed) worker.kill();
  }

  private createWav(pcm: Buffer, sampleRate: number): Buffer {
    const header = Buffer.alloc(44);
    header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8);
    header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
  }
}

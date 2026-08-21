const PCM_BYTES_PER_SAMPLE = 2;
const WINDOW_MS = 5000;
const OVERLAP_MS = 750;
const MAX_BACKLOG_WINDOWS = 3;
const MAX_DEDUP_WORDS = 20;
const MIN_DEDUP_WORDS = 2;

export type LocalTranscriptionKind = "incremental" | "fallback";

export interface LocalTranscriptionRequest {
  pcm: Buffer;
  sampleRate: number;
  kind: LocalTranscriptionKind;
  windowIndex: number;
}

export interface IncrementalTranscriptionResult {
  transcript: string;
  usedFallback: boolean;
}

type LogFields = Record<string, string | number | boolean | null>;

export interface IncrementalTranscriptionOptions {
  transcribe: (request: LocalTranscriptionRequest) => Promise<string>;
  onTranscript?: (transcript: string) => void;
  log?: (event: string, fields: LogFields) => void;
}

type ComparableToken = {
  normalized: string;
  end: number;
};

function comparableTokens(text: string): ComparableToken[] {
  const tokens: ComparableToken[] = [];
  for (const match of text.matchAll(/\S+/gu)) {
    const raw = match[0];
    const start = match.index || 0;
    const normalized = raw
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (normalized) {
      tokens.push({ normalized, end: start + raw.length });
    }
  }
  return tokens;
}

export function mergeAdjacentTranscripts(
  mergedTranscript: string,
  previousChunkTranscript: string,
  currentChunkTranscript: string,
): string {
  const current = currentChunkTranscript.trim();
  if (!current) return mergedTranscript.trim();
  if (!mergedTranscript.trim() || !previousChunkTranscript.trim()) {
    return [mergedTranscript.trim(), current].filter(Boolean).join(" ");
  }

  const previousTokens = comparableTokens(previousChunkTranscript);
  const currentTokens = comparableTokens(current);
  const maximum = Math.min(
    MAX_DEDUP_WORDS,
    previousTokens.length,
    currentTokens.length,
  );

  let duplicateWords = 0;
  for (let size = maximum; size >= MIN_DEDUP_WORDS; size -= 1) {
    const previousStart = previousTokens.length - size;
    let matches = true;
    for (let index = 0; index < size; index += 1) {
      if (
        previousTokens[previousStart + index].normalized !==
        currentTokens[index].normalized
      ) {
        matches = false;
        break;
      }
    }
    if (matches) {
      duplicateWords = size;
      break;
    }
  }

  const uniqueCurrent = duplicateWords
    ? current.slice(currentTokens[duplicateWords - 1].end).trimStart()
    : current;

  return [mergedTranscript.trim(), uniqueCurrent.trim()]
    .filter(Boolean)
    .join(" ");
}

export class IncrementalTranscriptionSession {
  private readonly transcribe: IncrementalTranscriptionOptions["transcribe"];
  private readonly onTranscript: NonNullable<
    IncrementalTranscriptionOptions["onTranscript"]
  >;
  private readonly log: NonNullable<IncrementalTranscriptionOptions["log"]>;

  private sampleRate: number | null = null;
  private fullAudioChunks: Buffer[] = [];
  private pendingAudio = Buffer.alloc(0);
  private previousOverlap = Buffer.alloc(0);
  private mergedTranscript = "";
  private previousChunkTranscript = "";
  private chain: Promise<void> = Promise.resolve();
  private finalizePromise: Promise<IncrementalTranscriptionResult> | null = null;
  private incrementalFailed = false;
  private cancelled = false;
  private closed = false;
  private outstandingWindows = 0;
  private windowIndex = 0;

  public constructor(options: IncrementalTranscriptionOptions) {
    this.transcribe = options.transcribe;
    this.onTranscript = options.onTranscript || (() => undefined);
    this.log = options.log || (() => undefined);
  }

  public append(pcm: Buffer, sampleRate: number): void {
    if (this.closed || this.cancelled) {
      throw new Error("Incremental transcription session is closed.");
    }
    if (!pcm.length) return;
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error("Audio sample rate is invalid.");
    }
    if (this.sampleRate !== null && this.sampleRate !== sampleRate) {
      throw new Error("Audio sample rate changed during recording.");
    }

    this.sampleRate = sampleRate;
    this.fullAudioChunks.push(pcm);
    if (this.incrementalFailed) return;

    this.pendingAudio = Buffer.concat([this.pendingAudio, pcm]);
    const windowBytes = this.bytesForMilliseconds(WINDOW_MS);
    const overlapBytes = this.bytesForMilliseconds(OVERLAP_MS);

    while (
      !this.incrementalFailed &&
      this.pendingAudio.length >= windowBytes
    ) {
      const newAudio = this.pendingAudio.subarray(0, windowBytes);
      this.pendingAudio = this.pendingAudio.subarray(windowBytes);
      const windowPcm = this.previousOverlap.length
        ? Buffer.concat([this.previousOverlap, newAudio])
        : Buffer.from(newAudio);
      this.previousOverlap = Buffer.from(
        newAudio.subarray(Math.max(0, newAudio.length - overlapBytes)),
      );
      this.scheduleWindow(windowPcm);
    }
  }

  public finalize(): Promise<IncrementalTranscriptionResult> {
    if (this.finalizePromise) return this.finalizePromise;
    this.finalizePromise = this.finalizeOnce();
    return this.finalizePromise;
  }

  public cancel(): void {
    this.cancelled = true;
    this.closed = true;
    this.fullAudioChunks = [];
    this.pendingAudio = Buffer.alloc(0);
    this.previousOverlap = Buffer.alloc(0);
  }

  private async finalizeOnce(): Promise<IncrementalTranscriptionResult> {
    if (this.cancelled) {
      throw new Error("Incremental transcription session was cancelled.");
    }
    this.closed = true;
    const fullPcm = Buffer.concat(this.fullAudioChunks);
    if (!fullPcm.length || this.sampleRate === null) {
      throw new Error("No microphone audio was captured.");
    }

    if (!this.incrementalFailed && this.pendingAudio.length) {
      const finalWindow = this.previousOverlap.length
        ? Buffer.concat([this.previousOverlap, this.pendingAudio])
        : Buffer.from(this.pendingAudio);
      this.pendingAudio = Buffer.alloc(0);
      this.scheduleWindow(finalWindow);
    }

    await this.chain;

    if (this.incrementalFailed || !this.mergedTranscript.trim()) {
      this.log("voice_incremental_fallback_started", {
        bytes: fullPcm.length,
        incrementalFailed: this.incrementalFailed,
      });
      const transcript = (
        await this.transcribe({
          pcm: fullPcm,
          sampleRate: this.sampleRate,
          kind: "fallback",
          windowIndex: 0,
        })
      ).trim();
      if (!transcript) {
        throw new Error("No speech was detected in the recording.");
      }
      return { transcript, usedFallback: true };
    }

    return {
      transcript: this.mergedTranscript.trim(),
      usedFallback: false,
    };
  }

  private scheduleWindow(pcm: Buffer): void {
    if (this.incrementalFailed || this.cancelled) return;
    if (this.outstandingWindows >= MAX_BACKLOG_WINDOWS) {
      this.incrementalFailed = true;
      this.pendingAudio = Buffer.alloc(0);
      this.log("voice_incremental_backlog_exceeded", {
        outstandingWindows: this.outstandingWindows,
        maximum: MAX_BACKLOG_WINDOWS,
      });
      return;
    }

    const windowIndex = ++this.windowIndex;
    this.outstandingWindows += 1;
    this.log("voice_incremental_window_queued", {
      windowIndex,
      outstandingWindows: this.outstandingWindows,
      audioMs: Math.round(
        (pcm.length / PCM_BYTES_PER_SAMPLE / this.sampleRate!) * 1000,
      ),
    });

    this.chain = this.chain
      .then(async () => {
        if (this.incrementalFailed || this.cancelled) return;
        const startedAt = performance.now();
        const transcript = (
          await this.transcribe({
            pcm,
            sampleRate: this.sampleRate!,
            kind: "incremental",
            windowIndex,
          })
        ).trim();
        if (this.cancelled) return;

        if (transcript) {
          this.mergedTranscript = mergeAdjacentTranscripts(
            this.mergedTranscript,
            this.previousChunkTranscript,
            transcript,
          );
          this.previousChunkTranscript = transcript;
          this.onTranscript(this.mergedTranscript);
        }
        this.log("voice_incremental_window_completed", {
          windowIndex,
          ms: Math.round(performance.now() - startedAt),
          transcriptChars: transcript.length,
        });
      })
      .catch((error: unknown) => {
        this.incrementalFailed = true;
        this.log("voice_incremental_window_failed", {
          windowIndex,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.outstandingWindows = Math.max(0, this.outstandingWindows - 1);
        this.log("voice_incremental_backlog", {
          outstandingWindows: this.outstandingWindows,
          incrementalFailed: this.incrementalFailed,
        });
      });
  }

  private bytesForMilliseconds(milliseconds: number): number {
    return Math.floor(
      (this.sampleRate! * milliseconds * PCM_BYTES_PER_SAMPLE) / 1000,
    );
  }
}

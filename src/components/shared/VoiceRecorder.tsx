import { useEffect, useRef } from "react";

const CHUNK_MS = 1000;
type VoiceSource = "system-audio" | "microphone";
type CaptureState = "idle" | "starting" | "recording" | "stopping";

/** Captures exactly one local audio source and sends isolated PCM to Electron. */
export function VoiceRecorder() {
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const silentOutputRef = useRef<GainNode | null>(null);
  const buffersRef = useRef<Int16Array[]>([]);
  const timerRef = useRef<number | null>(null);
  const captureStateRef = useRef<CaptureState>("idle");
  const sessionIdRef = useRef<string | null>(null);
  const voiceSourceRef = useRef<VoiceSource | null>(null);
  const flushChainRef = useRef<Promise<void>>(Promise.resolve());

  const teardownCapture = () => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    sourceNodeRef.current?.disconnect();
    processorRef.current?.disconnect();
    silentOutputRef.current?.disconnect();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    contextRef.current?.close().catch(() => undefined);
    sourceNodeRef.current = null;
    processorRef.current = null;
    silentOutputRef.current = null;
    streamRef.current = null;
    contextRef.current = null;
  };

  const clearSession = () => {
    captureStateRef.current = "idle";
    sessionIdRef.current = null;
    voiceSourceRef.current = null;
    buffersRef.current = [];
      window.sessionStorage.removeItem("noview.voiceSessionId");
      window.sessionStorage.removeItem("noview.voiceSource");
  };

  const queueFlush = (sampleRate = contextRef.current?.sampleRate || 16000) => {
    const sessionId = sessionIdRef.current;
    const source = voiceSourceRef.current;
    const chunks = buffersRef.current;
    buffersRef.current = [];
    if (!chunks.length || !sessionId || !source) return flushChainRef.current;
    const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const combined = new Int16Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    const bytes = new Uint8Array(combined.buffer);
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    const pcm = btoa(binary);
    flushChainRef.current = flushChainRef.current.then(async () => {
      const result = await window.electronAPI.voiceAudioChunk(sessionId, source, pcm, sampleRate);
      if (!result.success) throw new Error(result.error || "Voice audio chunk was rejected.");
    });
    return flushChainRef.current;
  };

  const readableCaptureError = (error: any, source: VoiceSource): string => {
    const name = String(error?.name || "");
    const detail = String(error?.message || "");
    if (source === "system-audio") {
      if (name === "NotFoundError") return "No Windows output device is available.";
      if (name === "NotAllowedError") return "Windows system-audio capture permission was denied.";
      if (name === "NotReadableError") return "The Windows output device is busy or disconnected.";
      return detail ? `Windows WASAPI loopback could not start: ${detail}` : "Windows WASAPI loopback could not start.";
    }
    if (name === "NotAllowedError" || name === "SecurityError") return "Microphone permission was denied.";
    if (name === "NotFoundError" || name === "DevicesNotFoundError") return "No microphone is available.";
    if (name === "NotReadableError" || name === "TrackStartError") return "The microphone is busy or unavailable.";
    return detail ? `Microphone capture could not start: ${detail}` : "Microphone capture could not start.";
  };

  const getCaptureStream = async (source: VoiceSource): Promise<MediaStream> => {
    if (source === "microphone") {
      return navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        video: false,
      });
    }
    if (window.electronAPI.getPlatform() !== "win32") throw new Error("System Audio capture is available only on Windows.");
    const displayStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    displayStream.getVideoTracks().forEach((track) => track.stop());
    if (!displayStream.getAudioTracks().length) {
      displayStream.getTracks().forEach((track) => track.stop());
      throw new DOMException("No loopback audio track was provided by the default output device.", "NotFoundError");
    }
    return displayStream;
  };

  const stop = async ({ sessionId, source }: { sessionId: string; source: VoiceSource }) => {
    if (sessionIdRef.current !== sessionId || voiceSourceRef.current !== source) return;
    if (captureStateRef.current !== "recording") return;
    captureStateRef.current = "stopping";
    const sampleRate = contextRef.current?.sampleRate || 16000;
    teardownCapture();
    try {
      await queueFlush(sampleRate);
      const result = await window.electronAPI.finalizeVoiceRecording(sessionId, source);
      if (!result.success) throw new Error(result.error || "Voice recording could not be finalized.");
    } catch (error) {
      console.error("Unable to finalize local voice recording", error);
    } finally {
      clearSession();
    }
  };

  const start = async ({ sessionId, source }: { sessionId: string; source: VoiceSource }) => {
    if (captureStateRef.current !== "idle") return;
    captureStateRef.current = "starting";
    sessionIdRef.current = sessionId;
    voiceSourceRef.current = source;
      window.sessionStorage.setItem("noview.voiceSessionId", sessionId);
      window.sessionStorage.setItem("noview.voiceSource", source);
    flushChainRef.current = Promise.resolve();
    buffersRef.current = [];
    try {
      const stream = await getCaptureStream(source);
      const context = new AudioContext();
      if (context.state === "suspended") await context.resume();
      const sourceNode = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const silentOutput = context.createGain();
      silentOutput.gain.value = 0;
      processor.onaudioprocess = (event) => {
        if (captureStateRef.current !== "recording") return;
        const input = event.inputBuffer.getChannelData(0);
        const pcm = new Int16Array(input.length);
        for (let index = 0; index < input.length; index += 1) {
          pcm[index] = Math.max(-1, Math.min(1, input[index])) * 0x7fff;
        }
        buffersRef.current.push(pcm);
      };
      sourceNode.connect(processor);
      processor.connect(silentOutput);
      silentOutput.connect(context.destination);
      streamRef.current = stream;
      contextRef.current = context;
      sourceNodeRef.current = sourceNode;
      processorRef.current = processor;
      silentOutputRef.current = silentOutput;
      captureStateRef.current = "recording";

      stream.getAudioTracks().forEach((track) => {
        track.onended = () => {
          if (captureStateRef.current !== "recording") return;
          captureStateRef.current = "stopping";
          teardownCapture();
          const message = source === "system-audio"
            ? "The Windows output device was disconnected."
            : "The microphone became unavailable.";
          void window.electronAPI.reportVoiceRecordingError(sessionId, message).finally(clearSession);
        };
      });

      const ready = await window.electronAPI.voiceCaptureReady(sessionId, source);
      if (!ready.success) throw new Error(ready.error || "Voice session was rejected.");
      timerRef.current = window.setInterval(() => { queueFlush().catch(console.error); }, CHUNK_MS);
      window.electronAPI.voicePerformanceEvent("voice_capture_active", sessionId, {
        source,
        sampleRate: context.sampleRate,
      });
    } catch (error: any) {
      teardownCapture();
      const message = readableCaptureError(error, source);
      await window.electronAPI.reportVoiceRecordingError(sessionId, message);
      clearSession();
    }
  };

  useEffect(() => {
    const cleanups = [
      window.electronAPI.onVoiceRecordingStarted(start),
      window.electronAPI.onVoiceRecordingStopRequested(stop),
    ];
    return () => {
      cleanups.forEach((cleanup) => cleanup());
      const sessionId = sessionIdRef.current;
      teardownCapture();
      if (sessionId) void window.electronAPI.cancelVoiceRecording(sessionId);
      clearSession();
    };
  }, []);

  return null;
}

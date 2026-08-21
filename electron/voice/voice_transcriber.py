"""Persistent local faster-whisper worker used by NoView.

It reads newline-delimited JSON from stdin and writes one JSON result per line.
Audio files never leave the machine; faster-whisper downloads its selected model
to its local Hugging Face cache on first use.
"""

import json
import sys
import time
import traceback
import wave


model_cache = {}


def get_model(model_name):
    load_started = time.perf_counter()
    if model_name not in model_cache:
        try:
            from faster_whisper import WhisperModel
        except ModuleNotFoundError as error:
            raise RuntimeError(
                "Local transcription requires faster-whisper and CTranslate2. "
                "Install electron/voice/requirements.txt with the configured Python runtime."
            ) from error

        model_cache[model_name] = WhisperModel(
            model_name,
            device="cpu",
            compute_type="int8",
        )
    return model_cache[model_name], round((time.perf_counter() - load_started) * 1000)


def transcribe(request):
    total_started = time.perf_counter()
    audio_path = request["audioPath"]
    model_name = request.get("model", "small")
    model, model_load_ms = get_model(model_name)
    try:
        with wave.open(audio_path, "rb") as audio:
            audio_seconds = audio.getnframes() / audio.getframerate()
    except Exception:
        audio_seconds = None
    inference_started = time.perf_counter()
    segments, _info = model.transcribe(
        audio_path,
        beam_size=1,
        vad_filter=True,
        condition_on_previous_text=False,
    )
    text = " ".join(segment.text.strip() for segment in segments).strip()
    return text, {
        "modelLoadMs": model_load_ms,
        "inferenceMs": round((time.perf_counter() - inference_started) * 1000),
        "totalMs": round((time.perf_counter() - total_started) * 1000),
        "audioSeconds": round(audio_seconds, 3) if audio_seconds is not None else None,
    }


for line in sys.stdin:
    try:
        request = json.loads(line)
        if request.get("type") == "shutdown":
            print(json.dumps({"id": request.get("id"), "success": True}), flush=True)
            break

        if request.get("type") == "health":
            import av
            import ctranslate2
            import faster_whisper
            import tokenizers

            print(
                json.dumps(
                    {
                        "id": request.get("id"),
                        "success": True,
                        "text": "",
                        "runtime": {
                            "fasterWhisper": getattr(faster_whisper, "__version__", "unknown"),
                            "ctranslate2": getattr(ctranslate2, "__version__", "unknown"),
                            "tokenizers": getattr(tokenizers, "__version__", "unknown"),
                            "av": getattr(av, "__version__", "unknown"),
                        },
                    }
                ),
                flush=True,
            )
            continue

        if request.get("type") == "warmup":
            _model, model_load_ms = get_model(request.get("model", "small"))
            print(json.dumps({"id": request.get("id"), "success": True, "text": "", "timings": {"modelLoadMs": model_load_ms}}), flush=True)
            continue

        text, timings = transcribe(request)
        print(json.dumps({"id": request.get("id"), "success": True, "text": text, "timings": timings}), flush=True)
    except Exception as error:
        print(
            json.dumps(
                {
                    "id": request.get("id") if "request" in locals() else None,
                    "success": False,
                    "error": str(error),
                    "details": traceback.format_exc(limit=1),
                }
            ),
            flush=True,
        )

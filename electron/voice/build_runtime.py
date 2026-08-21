"""Build the self-contained Windows faster-whisper worker used by the NSIS app."""

from pathlib import Path
import shutil
import sys


def main():
    if sys.platform != "win32":
        raise SystemExit("The NoView voice runtime must be built on Windows.")

    try:
        import PyInstaller.__main__
    except ModuleNotFoundError as error:
        raise SystemExit(
            "PyInstaller is required. Install electron/voice/requirements.txt first."
        ) from error

    voice_dir = Path(__file__).resolve().parent
    dist_dir = voice_dir / "runtime-dist"
    work_dir = voice_dir / "runtime-build"
    spec_dir = voice_dir / "runtime-spec"
    for target in (dist_dir, work_dir, spec_dir):
        resolved = target.resolve()
        if voice_dir not in resolved.parents:
            raise SystemExit(f"Refusing to clean unexpected path: {resolved}")
        shutil.rmtree(resolved, ignore_errors=True)

    PyInstaller.__main__.run(
        [
            str(voice_dir / "voice_transcriber.py"),
            "--name=voice_transcriber",
            "--onedir",
            "--console",
            "--noconfirm",
            "--clean",
            "--log-level=INFO",
            f"--distpath={dist_dir}",
            f"--workpath={work_dir}",
            f"--specpath={spec_dir}",
            "--collect-all=faster_whisper",
            "--collect-binaries=ctranslate2",
            "--collect-data=ctranslate2",
            "--hidden-import=ctranslate2._ext",
            "--collect-all=tokenizers",
            "--collect-all=av",
            "--exclude-module=torch",
            "--exclude-module=tensorflow",
            "--exclude-module=transformers",
            "--exclude-module=onnx",
            "--exclude-module=pandas",
            "--exclude-module=scipy",
            "--exclude-module=sklearn",
            "--copy-metadata=faster-whisper",
            "--copy-metadata=ctranslate2",
            "--copy-metadata=huggingface-hub",
        ]
    )

    executable = dist_dir / "voice_transcriber" / "voice_transcriber.exe"
    if not executable.is_file():
        raise SystemExit(f"Voice runtime build did not create {executable}")
    print(f"NoView voice runtime created at {executable}")


if __name__ == "__main__":
    main()


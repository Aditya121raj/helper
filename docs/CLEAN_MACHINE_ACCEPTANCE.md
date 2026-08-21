# NoView Windows Clean-Machine Acceptance Checklist

Date: 2026-08-02  
Installer: `release/NoView-Windows-1.2.0.exe`
Installer size: 317,212,756 bytes  
SHA-256: `09F7587F62B7A008A214649A364FDE39AF648F9F3DD914E5F96730068D293BFA`

## Status definitions

- **passed** — the exact check was executed and produced the required evidence.
- **failed** — the check was executed and did not meet the expected result.
- **blocked** — the check could not be executed because a required environment or dependency was unavailable.
- **not run** — the check was intentionally not executed; no claim is made.

## Environment qualification

| Test | Status | Evidence / notes |
|---|---|---|
| Genuine clean Windows VM with no system Python or preinstalled faster-whisper | **blocked** | Windows Sandbox, Docker, VMware, VirtualBox, and an accessible Hyper-V VM were unavailable. The host has Python 3.14 installed, so it is not a genuine clean machine. |
| Python-independent simulation | **passed** | The final packaged worker and unpacked application were launched with `python.exe` absent from `PATH`, and with `PYTHONHOME`/`PYTHONPATH` cleared. This is useful isolation evidence but is not a substitute for a clean VM. |

## Acceptance results

| Test | Status | Expected result | Evidence / notes |
|---|---|---|---|
| Installer launch on genuine clean machine | **blocked** | NSIS installer opens and completes without Python prerequisites | No clean Windows VM was available. The installer was built successfully but was not installed over the user's existing installation. |
| Installer build | **passed** | NSIS artifact is produced | `release/NoView-Windows-1.2.0.exe`, 317,212,756 bytes. |
| Bundled runtime present | **passed** | `resources/voice-runtime/voice_transcriber.exe` exists | Verified in `release/win-unpacked`. |
| Bundled runtime imports | **passed** | Worker imports every required runtime without system Python | Packaged health response reported faster-whisper 1.2.1, CTranslate2 4.8.1, tokenizers 0.22.2, and PyAV 18.0.0. |
| First base-model download with empty cache | **passed** | Model downloads and initializes locally | With Python unavailable in `PATH` and a new empty cache, base model warmup succeeded in 187 seconds; cache contained 10 files / approximately 141 MB. Temporary cache was removed after recording evidence. |
| App first launch from final unpacked payload | **passed** | App stays alive and bundled worker warms | Isolated `--user-data-dir`; app remained alive. Worker spawned in 140 ms and base warmup completed in 2,249 ms using the populated host model cache. |
| App restart from final unpacked payload | **passed** | App launches again and worker warms | Second isolated launch remained alive. Worker spawned in 110 ms and warmup completed in 2,126 ms. |
| Restart after installation on genuine clean machine | **blocked** | Installed app restarts successfully | Depends on the blocked clean-machine installer run. |
| Ctrl+M Windows system loopback | **not run** | Only default Windows output audio is captured | Requires an interactive isolated Windows audio session and actual playback. No hardware claim is made. |
| Ctrl+Shift+M microphone | **not run** | Only default microphone audio is captured | Requires microphone hardware/permission in the target environment. No hardware claim is made. |
| Final system-audio transcription | **not run** | Final transcript is produced locally after Ctrl+M stop | Blocked by the unrun loopback hardware test. |
| Final microphone transcription | **not run** | Final transcript is produced locally after Ctrl+Shift+M stop | Blocked by the unrun microphone hardware test. |
| Exactly one LLM request — automated guard | **passed** | A session can claim LLM dispatch only once | `npm run test:voice`; duplicate LLM claims were rejected. |
| Exactly one LLM request — installed end-to-end | **not run** | Provider observes one request for one completed recording | Requires a completed hardware recording and provider observation. |
| No duplicate history — automated guard | **passed** | A session can claim history insertion only once | `npm run test:voice`; duplicate history claims were rejected. |
| No duplicate history — installed end-to-end | **not run** | One completed recording produces one visible history entry | Requires a completed hardware recording in the installed app. |
| No-speech behavior — installed end-to-end | **not run** | No LLM request and no history entry | Requires an actual silent capture session and provider/history observation. |

## Required clean-VM procedure

1. Start a fresh supported Windows x64 VM with speakers/output and microphone devices exposed.
2. Confirm `where python`, `py --version`, and `pip show faster-whisper ctranslate2` find nothing.
3. Copy only `NoView-Windows-1.2.0.exe` into the VM.
4. Launch the installer normally and record whether it completes.
5. Launch NoView and wait for first model download/warmup to finish.
6. Play known speech through the default output, toggle Ctrl+M, and verify the final system transcript.
7. Speak known English/Hindi/Hinglish phrases, toggle Ctrl+Shift+M, and verify the final microphone transcript.
8. For each completed session, compare the session ID across capture, finalization, LLM, and history logs; require exactly one LLM completion and one history entry.
9. Run a silence session; require no LLM event and no history entry.
10. Exit the application, restart it, and repeat one system-audio and one microphone session.

Do not promote the blocked/not-run rows to passed without retaining the corresponding VM, audio, provider, and history evidence.

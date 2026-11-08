# omp-asr-zh

OMP extension for local Chinese speech input. It uses the sherpa-onnx streaming
X-ASR Zipformer2 transducer (zh/en, punctuation, int8) and adds two dictation
paths without patching OMP:

- **Buffered dictation** through OMP's normal `openai-transcriptions` provider
  and the `dictation` role. Recording stops, the WAV is transcribed, and the
  final text is committed.
- **Live dictation** owned by this extension. A shortcut records audio, streams
  PCM to a local WebSocket, and mirrors partial text into the core editor while
  you speak. On stop, the final transcript replaces the preview.

There is no TTS code in this extension. The model is downloaded on demand; no
model files are committed to the repository.

The extension starts one background child process with OMP's bundled Bun
(`BUN_BE_BUN=1`). It exposes a token-protected loopback transcription endpoint
and a token-protected WebSocket on a random port. No OMP source, native
runtime, or bundled model is modified.

`<agent-dir>` below means `$PI_CODING_AGENT_DIR` when set, otherwise
`$HOME/.omp/agent`.

## Requirements

- OMP 18.x with extension and shortcut support.
- Bun to install this package's dependencies once.
- `tar` with bzip2 support (`tar -xjf`) for the model archive.
- A capture tool for live dictation: `parec` (PipeWire/PulseAudio),
  `pw-record`, or `arecord`.
- No manual model download. The extension downloads and verifies the pinned
  X-ASR release on first use.

## Install

```bash
git clone <repository-url> omp-asr-zh
cd omp-asr-zh
bun install

agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"
mkdir -p "$agent_dir/extensions"
ln -sfn "$PWD" "$agent_dir/extensions/omp-asr-zh"
```

Restart OMP. The first start downloads the model in the background; the
assistant UI stays usable while it runs. A one-shot `omp -p` process exits
before a background download can finish, so keep an interactive session open,
or run:

```bash
omp -p '/asr-zh selftest'
```

That command waits for the download, installs the model, and transcribes the
bundled test WAV.

```bash
omp -p '/asr-zh status'
```

`/asr-zh status` reports `model: downloading <n>%` until the archive is
installed, then `model: ready`.

## Configuration

The extension reads `<agent-dir>/omp-asr-zh.json`. The file is optional; these
are the defaults:

```json
{
  "asr": {
    "enabled": true,
    "modelType": "zipformer2",
    "numThreads": 2,
    "tailPaddingSeconds": 1.5
  },
  "live": {
    "enabled": true,
    "shortcut": "ctrl+alt+space",
    "capture": "auto"
  },
  "autoSelectRoles": true
}
```

The model directory defaults to the shared OMP tiny-model cache:

```text
<agent-dir>/cache/tiny-models/x-asr-960ms-streaming-zh-en-int8
```

Set `asr.modelDir` or `OMP_ASR_ZH_MODEL_DIR` only to use a different prepared
directory. The extension does not search other applications' data directories.

Environment overrides:

| Variable | Effect |
| --- | --- |
| `OMP_ASR_ZH_ENABLED` | `0` disables the ASR server |
| `OMP_ASR_ZH_MODEL_DIR` | X-ASR model directory |
| `OMP_ASR_ZH_MODEL_TYPE` | sherpa model type, default `zipformer2` |
| `OMP_ASR_ZH_THREADS` | inference threads, default `2` |
| `OMP_ASR_ZH_LIVE_ENABLED` | `0` disables the live shortcut |
| `OMP_ASR_ZH_SHORTCUT` | live shortcut, default `ctrl+alt+space` |
| `OMP_ASR_ZH_CAPTURE` | raw PCM capture command, default `auto` |
| `OMP_ASR_ZH_AUTOSELECT` | `0` keeps the configured dictation role unchanged |
| `OMP_ASR_ZH_CONFIG` | alternate config file path |
| `OMP_ASR_ZH_SELFTEST_WAV` | WAV used by `/asr-zh selftest` |

### Role selection

At session start the extension sets:

```yaml
modelRoles:
  dictation: omp-asr-zh/x-asr-960ms-zh-en
```

It replaces an unset role or OMP's built-in local dictation defaults
(`local/parakeet-tdt-0.6b-v3`, `local/nemotron-streaming-en-0.6b`, the Whisper
local models). It also replaces `local/x-asr-960ms-zh-en`, the native tier from
the unmerged upstream PR, because the extension serves the same model and adds
live partials; use `/asr-zh off` or `autoSelectRoles: false` to keep the native
role. A role that names any other explicit model is left alone. Set
`autoSelectRoles: false` to keep the configured role and use `/asr-zh on` when
needed.

When the local server fails, OMP's normal role chain continues to the built-in
local model, so dictation keeps working with the stock fallback.

## Commands

| Command | Behavior |
| --- | --- |
| `/asr-zh` or `/asr-zh status` | Show the dictation role, server port, model state and path, live settings, and capture state |
| `/asr-zh on` | Select the Chinese model for the current session |
| `/asr-zh off` | Remove this extension's role selection for the current session |
| `/asr-zh selftest` | Wait for the model if needed, then transcribe its bundled test WAV through the registered provider |
| `/asr-zh live` | Toggle live dictation (interactive TUI) |
| `/asr-zh live on\|off` | Persist the live feature switch |
| `/asr-zh shortcut <key>` | Persist the live shortcut; restart OMP to bind it |
| `/asr-zh capture <command\|auto>` | Persist the raw PCM capture command |

## Live dictation

The default shortcut is `ctrl+alt+space`. It toggles one live session:

1. The extension saves the current editor text and opens a WebSocket to the
   local ASR server.
2. It starts `parec` with 16 kHz mono s16le output and forwards PCM chunks.
3. The server keeps one sherpa online stream, decodes each chunk, and sends
   `partial` or `final` text.
4. The extension writes `base text + partial` into the core editor.
5. On the second shortcut press, it sends `stop`; the server adds 1.5 s of tail
   silence, decodes the final text, and the extension replaces the preview with
   the final transcript.

Live dictation never submits the prompt; press Enter yourself. It does nothing
until `model: ready`; `/asr-zh status` reports the download progress. The
built-in `stt.enabled` dictation remains available, but it uses the buffered
provider path. If you only want live dictation, set `stt.enabled: false` and use
the shortcut.

The default `auto` capture command resolves in this order:

```text
parec --format=s16le --rate=16000 --channels=1 --latency-msec=50
pw-record --rate 16000 --channels 1 --format s16 --raw -
arecord -q -f S16_LE -r 16000 -c 1 -t raw
```

Set `live.capture` or `/asr-zh capture` to a command that writes raw 16 kHz
mono s16le PCM to stdout. The command is trusted local configuration and runs
through `sh -c`.

## Model download

The extension downloads the official sherpa-onnx X-ASR archive into the shared
OMP tiny-model cache on first use:

```text
Archive:  sherpa-onnx-x-asr-960ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05.tar.bz2
URL:      https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-x-asr-960ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05.tar.bz2
SHA-256:  0a92b798bd6801c333c7ce8aebf5ba769bfe7f3f3511699a67837b2288428603
Size:     about 128 MiB
Target:   <agent-dir>/cache/tiny-models/x-asr-960ms-streaming-zh-en-int8
```

The download goes to a private staging directory, the SHA-256 is verified, the
archive entries are checked for path traversal, and `tar -xjf` extracts it. The
model directory is replaced only after validation. A lock file serializes
concurrent installs from multiple OMP sessions.

For an offline or pre-existing model, place these files in the target
directory, or point `OMP_ASR_ZH_MODEL_DIR` at another directory:

```text
encoder.int8.onnx
decoder.onnx
joiner.int8.onnx
tokens.txt
```

The archive also contains the test WAVs used by `/asr-zh selftest`.

## Model details

- Streaming Zipformer2 transducer, int8, 16 kHz input, Chinese/English, with
  punctuation.
- `modelType: "zipformer2"`, greedy search, endpointing enabled.
- The buffered path appends 1.5 s of silence before the final decode.
- The live path keeps the same tail padding on `stop`.
- Non-quantized encoder/decoder/joiner files are accepted when the archive
  provides them.

## Limitations

- Live dictation holds the editor text read when recording starts and replaces
  the editor with `base + transcript` on every update. Do not edit that prompt
  while recording; finish or stop the dictation first. The cursor ends at the
  end of the transcript.
- Live dictation updates the editor with the full in-progress transcript; it
  does not segment the draft into independently committed phrases, because the
  X-ASR archive does not ship endpoint rules.
- The live session is one at a time; a second connection is rejected.
- The extension does not play assistant replies. That is TTS and belongs to a
  separate extension.
- The `openai-transcriptions` buffered path has no partial text; use the live
  shortcut for that.

## Troubleshooting

- Server log: `<agent-dir>/cache/omp-asr-zh/server.log`.
- Check the model state and path with `/asr-zh status`.
- If the first download is slow, keep the OMP session open; the download runs
  in the extension process. `/asr-zh selftest` waits for it.
- If the archive fails verification, delete the partial cache and retry:
  `rm -rf "<agent-dir>/cache/tiny-models/x-asr-960ms-streaming-zh-en-int8"`.
- If live dictation reports a capture error, test the command directly, for
  example:
  `timeout 2 parec --format=s16le --rate=16000 --channels=1 | wc -c`.
- If the shortcut does not fire, run `/asr-zh status`, change the chord with
  `/asr-zh shortcut <key>`, and restart OMP.
- If the extension directory is not discovered, confirm the symlink exists at
  `<agent-dir>/extensions/omp-asr-zh` and that `package.json` contains
  `omp.extensions`.

## Uninstall

```bash
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"
rm "$agent_dir/extensions/omp-asr-zh"
rm -rf "$agent_dir/cache/omp-asr-zh"
rm -f "$agent_dir/omp-asr-zh.json"
# Optional: remove the downloaded model.
rm -rf "$agent_dir/cache/tiny-models/x-asr-960ms-streaming-zh-en-int8"
```

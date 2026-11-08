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

There is no TTS code, no Kokoro model, and no speech playback in this
extension. Use `omp-voice-zh` if you also need Chinese TTS.

The extension starts one background child process with OMP's bundled Bun
(`BUN_BE_BUN=1`). It exposes a token-protected loopback transcription endpoint
and a token-protected WebSocket on a random port. No OMP source, native
runtime, or bundled model is modified.

## Requirements

- OMP 18.x with extension and shortcut support.
- Bun to install this package's dependencies once.
- The X-ASR model directory:
  `~/.local/share/vinput/models/sherpa-onnx/x-asr-960ms-streaming-zipformer-transducer-zh-en-punct-int8`.
  Any `x-asr-*` directory under the same root is also accepted.
- A capture tool for live dictation: `parec` (PipeWire/PulseAudio),
  `pw-record`, or `arecord`.

## Install

```bash
git clone <this-repo> ~/projects/omp-voice/omp-asr-zh
cd ~/projects/omp-voice/omp-asr-zh
bun install
mkdir -p ~/.omp/agent/extensions
ln -sfn ~/projects/omp-voice/omp-asr-zh ~/.omp/agent/extensions/omp-asr-zh
```

Restart OMP. Check that the provider and the role were selected:

```bash
omp -p '/asr-zh status'
```

Run the ASR selftest against the model's bundled WAV:

```bash
omp -p '/asr-zh selftest'
```

## Configuration

The extension reads `~/.omp/agent/omp-asr-zh.json`. The file is optional; these
are the defaults:

```json
{
  "asr": {
    "enabled": true,
    "modelDir": "~/.local/share/vinput/models/sherpa-onnx/x-asr-960ms-streaming-zipformer-transducer-zh-en-punct-int8",
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
local models). A role that names another explicit model is left alone. Set
`autoSelectRoles: false` to keep the configured role and use `/asr-zh on` when
needed.

When the local server fails, OMP's normal role chain continues to the built-in
local model, so dictation keeps working with the stock fallback.

## Commands

| Command | Behavior |
| --- | --- |
| `/asr-zh` or `/asr-zh status` | Show the dictation role, server port, model path, live settings, and capture state |
| `/asr-zh on` | Select the Chinese model for the current session |
| `/asr-zh off` | Remove this extension's role selection for the current session |
| `/asr-zh selftest` | Transcribe the model's bundled test WAV through the registered provider |
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

Live dictation never submits the prompt; press Enter yourself. The built-in
`stt.enabled` dictation remains available, but it uses the buffered provider
path. If you only want live dictation, set `stt.enabled: false` and use the
shortcut.

The default `auto` capture command resolves in this order:

```text
parec --format=s16le --rate=16000 --channels=1 --latency-msec=50
pw-record --rate 16000 --channels 1 --format s16 --raw -
arecord -q -f S16_LE -r 16000 -c 1 -t raw
```

Set `live.capture` or `/asr-zh capture` to a command that writes raw 16 kHz
mono s16le PCM to stdout. The command is trusted local configuration and runs
through `sh -c`.

## Model details

- Streaming Zipformer2 transducer, int8, 16 kHz input, Chinese/English, with
  punctuation.
- `modelType: "zipformer2"`, greedy search, endpointing enabled.
- The buffered path appends 1.5 s of silence before the final decode.
- The live path keeps the same tail padding on `stop`.
- Model files are expected as `encoder.int8.onnx`, `decoder.onnx`,
  `joiner.int8.onnx`, and `tokens.txt`, with non-quantized fallbacks where the
  archive provides them.

## Limitations

- Live dictation updates the editor with the full in-progress transcript; it
  does not segment the draft into independently committed phrases, because the
  X-ASR archive does not ship endpoint rules.
- The live session is one at a time; a second connection is rejected.
- The extension does not play assistant replies. That is TTS and belongs to a
  separate extension.
- The `openai-transcriptions` buffered path has no partial text; use the live
  shortcut for that.

## Troubleshooting

- Server log: `~/.omp/agent/cache/omp-asr-zh/server.log`.
- Check the model path, role, and capture command with `/asr-zh status`.
- If the shortcut does not fire, run `/asr-zh status`, change the chord with
  `/asr-zh shortcut <key>`, and restart OMP.
- If live dictation reports a capture error, test the command directly, for
  example:
  `timeout 2 parec --format=s16le --rate=16000 --channels=1 | wc -c`.
- If the extension directory is not discovered, confirm the symlink exists at
  `~/.omp/agent/extensions/omp-asr-zh` and that `package.json` contains
  `omp.extensions`.

## Uninstall

```bash
rm ~/.omp/agent/extensions/omp-asr-zh
rm -rf ~/.omp/agent/cache/omp-asr-zh
```

Remove `~/.omp/agent/omp-asr-zh.json` if you created it.

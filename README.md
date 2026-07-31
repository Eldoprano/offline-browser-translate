<h1 align="center">
  <img src="assets/logo.png" width="48" valign="middle"> Local LLM Translator
</h1>

A privacy-focused browser extension that translates web pages using local LLMs (Ollama, LMStudio, or llama.cpp). **Your data never leaves your machine.**

[![Get the Add-on](https://extensionworkshop.com/assets/img/documentation/publish/get-the-addon-178x60px.dad84b42.png)](https://addons.mozilla.org/en-GB/firefox/addon/local-llm-translator/)

## Features

- 🔒 **100% Private** - All translations happen on your local machine via Ollama or LMStudio
- 🎯 **Smart Prioritization** - Visible content and headings are translated first
- 🌍 **Many Languages** - Supports many many languages :3
- ⚡ **Translation Cache** - Optional: translate identical text once and reuse it (great for forums). Off by default; stored locally with a session-only or persistent mode
- 🛠️ **Selection Repair** - Retranslate a bad selected segment or discard its cached translation and restore the original text
- 📖 **Glossary** - Force consistent translations for proper nouns and UI labels via a user-supplied TSV dictionary

## Requirements

You need one of these running locally:

- **[Ollama](https://ollama.ai/)** (default: `http://localhost:11434`)
- **[LMStudio](https://lmstudio.ai/)** (default: `http://localhost:1234`)
- **Any OpenAI-compatible server** — [llama.cpp](https://github.com/ggml-org/llama.cpp)'s `llama-server`, [vLLM](https://github.com/vllm-project/vllm), etc. Put the server's base URL (e.g. `http://localhost:8080`) in the **LMStudio / OpenAI-compatible URL** field; a trailing `/v1` is tolerated and stripped automatically

With a translation-capable model loaded (e.g. `TranslateGemma`, `tencent.hunyuan-mt`, `qwen3`, etc.)

### llama.cpp setup

`llama-server` exposes an OpenAI-compatible API, which this extension uses
directly — enter `http://localhost:8080` in the **LMStudio / OpenAI-compatible
URL** field:

```sh
llama-server \
  -m /path/to/model.gguf \
  --host 127.0.0.1 \
  --port 8080 \
  --n-gpu-layers 999
```

For GPU acceleration, use a CUDA/ROCm/Vulkan-enabled `llama.cpp` build.

If the Firefox background console shows a CORS error for
`http://127.0.0.1:8080/v1/models`, allow the extension origin explicitly:

```sh
llama-server \
  -m /path/to/model.gguf \
  --host 127.0.0.1 \
  --port 8080 \
  --n-gpu-layers 999 \
  --cors-origins "moz-extension://<extension-uuid>"
```

Find the origin in the background debugger. For a script URL such as
`moz-extension://ca462efa-9eb3-47a8-b32e-c8f6d7b859c9/languages.js`, use only
the origin part:

```sh
--cors-origins "moz-extension://ca462efa-9eb3-47a8-b32e-c8f6d7b859c9"
```

Avoid `--cors-origins "*"` unless the server is tightly isolated. Also avoid
mixing `localhost` and the extension origin if Firefox reports that
`Access-Control-Allow-Origin` does not match; some `llama-server` builds return
the comma-separated value literally, but browsers require a single matching
origin in that response header. The built-in `llama-server` Web UI does not
need CORS for direct browser access to `http://127.0.0.1:8080`.

If both TranslateGemma 4B and 12B are loaded, select the 4B model for normal
use. The extension keeps short segments on 4B first; when a segment still comes
back empty, malformed, or suspicious after retries, it can automatically retry
just that failed segment on the loaded 12B model. Long segments (120+ words or
700+ characters) are sent directly to 12B. It does not send every segment to
both models.

**TranslateGemma note:** the model's bundled chat template requires a special
structured input and makes `llama-server` reject plain OpenAI-style messages
(startup fails with a Jinja exception). Override it with a plain Gemma
template — the extension builds the full TranslateGemma prompt itself. Save
this as `gemma.jinja`:

```jinja
{{ bos_token }}{%- for message in messages -%}
    {%- if message['role'] == 'assistant' -%}
        {{ '<start_of_turn>model\n' + (message['content'] | trim) + '<end_of_turn>\n' }}
    {%- else -%}
        {{ '<start_of_turn>user\n' + (message['content'] | trim) + '<end_of_turn>\n' }}
    {%- endif -%}
{%- endfor -%}
{%- if add_generation_prompt -%}
    {{ '<start_of_turn>model\n' }}
{%- endif -%}
```

and start the server with it:

```sh
llama-server -hf mradermacher/translategemma-4b-it-GGUF:Q4_K_M \
  --host 127.0.0.1 --port 8080 -ngl 999 \
  --jinja --chat-template-file gemma.jinja
```

(`--no-jinja --chat-template gemma` also works for translation, but it
disables tool calls, which breaks llama-server's built-in web UI. Passing a
built-in template *name* while Jinja is enabled does not work — the name is
treated as a literal template string.)

### Remote servers and gateways

The LMStudio path speaks the plain OpenAI-compatible API
(`GET /v1/models`, `POST /v1/chat/completions`), so it also works with any
endpoint that exposes it: `llama-server` on another machine, vLLM, or an AI
gateway such as [Tailscale Aperture](https://tailscale.com/docs/aperture) —
useful for translating on a machine without a GPU by borrowing one over your
tailnet.

Point the **LMStudio / OpenAI-compatible URL** at the remote endpoint (e.g.
`http://myserver.my-tailnet.ts.net`). For non-localhost URLs the extension
asks for host permission for that origin when you hit Save — an explicit
opt-in, since the extension ships with localhost-only permissions.

## Installation

### Firefox / Mullvad Browser
1. Go to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select the `manifest.json` file

This is temporary and is removed on restart. For a persistent install, package it
as an `.xpi` and load it in a browser that allows unsigned add-ons (Firefox
Developer Edition / Nightly / ESR with `xpinstall.signatures.required = false`):

1. Run `./mkxpi.sh` to produce `local-llm-translator-<version>.xpi`
2. Go to `about:addons` → gear icon → **Install Add-on From File**
3. Select the generated `.xpi`

An xpi is just a zip with `manifest.json` at the root, so no signing or `web-ext`
is needed. Bump `version` in `manifest.json` and re-run `./mkxpi.sh` to update.

### Chrome / Chromium
1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the extension folder

**Coming Soon:** Extension in Chrome Web Store

## Preview

<p align="center">
  <img src="assets/translating.png" width="600" alt="Extension Screenshot">
</p>

## Usage

1. Click the extension icon
2. Select a model from the dropdown
3. Choose your target language
4. Click **Translate Page**

The extension will:
- Extract all visible text from the page
- Prioritize headings and visible content
- Translate in batches with progress percentage
- Auto-translate new content (infinite scroll)

### Fixing a Bad Translation

If a small part of the page is translated badly:

1. Select the bad translated text on the page
2. Open the extension popup
3. Click **Retranslate Selection** to force a fresh translation
4. Click **Discard Selection** to restore the original text and forget that cached translation

Selection actions work on the extension's internal sentence/text segments. Long text is usually handled sentence by sentence; short UI text may be restored or retranslated as one text-node segment.

## Benchmarking

Use `scripts/benchmark.rb` to measure local LLM translation speed with a fixed
8-segment input set. This measures provider/API translation throughput, not
browser DOM replacement time.

```sh
PROVIDER=ollama MODEL=translategemma:4b TARGET_LANGUAGE=Japanese ./scripts/benchmark.rb
PROVIDER=llamacpp TARGET_LANGUAGE=Japanese ./scripts/benchmark.rb
```

Recommended reporting:

- Use one warmup run and at least three measured runs (the script default)
- Record the model, provider, target language, wall time, source characters/sec,
  and output tokens/sec
- Keep the benchmark input unchanged when comparing models or machines

### Local Reference

Measured on 2026-07-08, English -> Japanese, 8 segments / 584 source
characters, Q4_K_M quantization on both providers. These are reference numbers
for this machine, not a guarantee for other pages; real page translation also
depends on DOM size, cache hits, and parallel request settings.

Machine:

- OS: `Linux 7.1.2-zen1-1.1-zen x86_64 GNU/Linux`
- CPU: AMD Ryzen 7 3700X 8-Core Processor / 16 threads
- RAM: 31.3 GiB
- GPU: NVIDIA GeForce RTX 3060, 12 GiB VRAM, driver 610.43.02
- Ollama with its library `translategemma` models; llama.cpp b9902 (CUDA) with
  `mradermacher/translategemma-{4b,12b}-it-GGUF:Q4_K_M`, all layers on GPU

| Model | Provider | Avg wall time | Source chars/s | Avg output tokens/s |
|-------|----------|---------------|----------------|---------------------|
| TranslateGemma 4B | `llamacpp` | 3.18 s | 190.4 | 94.8 |
| TranslateGemma 4B | `ollama` | 5.04 s | 116.0 | 76.1 |
| TranslateGemma 12B | `llamacpp` | 6.68 s | 87.4 | 36.4 |
| TranslateGemma 12B | `ollama` | 7.27 s | 80.3 | 35.1 |

### Long-text Routing Reference

Measured on 2026-07-16, English -> Japanese, using text adapted from the
Wikipedia "Secure Shell" article: 3 segments / 1,916 source characters. The
segments were 28 words, 72 words, and 180 words; only the 180-word segment
crossed the long-text threshold and was routed to 12B.

llama.cpp was run with both TranslateGemma Q4_K_M models fully offloaded to the
GPU by reducing context and server parallelism:

```ini
[translategemma-4b-translate]
model = /home/onoue/.local/lib/models/translategemma-4b-it.Q4_K_M.gguf
chat-template-file = /home/onoue/.local/lib/models/gemma.jinja
c = 4096
parallel = 1
n-gpu-layers = 99

[translategemma-12b-translate]
model = /home/onoue/.local/lib/models/translategemma-12b-it.Q4_K_M.gguf
chat-template-file = /home/onoue/.local/lib/models/gemma.jinja
c = 4096
parallel = 1
n-gpu-layers = 99
```

| Pattern | Avg wall time | Source chars/s | Routing |
|---------|---------------|----------------|---------|
| TranslateGemma 4B only | 5.00 s | 382.9 | 4B: 3 / 12B: 0 |
| 4B + 12B long-text routing | 9.28 s | 206.4 | 4B: 2 / 12B: 1 |
| TranslateGemma 12B only | 12.30 s | 155.8 | 4B: 0 / 12B: 3 |

With the heavier default server settings (`c = 16384`, `parallel = 4`), keeping
both 4B and 12B fully on a 12 GiB RTX 3060 was not reliable. For this extension,
`c = 4096` and `parallel = 1` are a better fit because page text is translated
in small segments rather than as one large document.

### Gemma 4 E4B Reference

Measured on 2026-07-27 with the same Secure Shell input above, using
`gemma-4-E4B-it` (`unsloth/gemma-4-E4B-it-GGUF:Q4_K_M`) through llama.cpp.
The server preset fits on the same 12 GiB RTX 3060 with full GPU offload and
MTP draft decoding enabled:

```ini
[gemma-4-E4B-it]
hf = unsloth/gemma-4-E4B-it-GGUF:Q4_K_M
chat-template-file = /home/onoue/.local/lib/models/gemma-4-E4B-it-GGUF.jinja
n-gpu-layers = all
ctx-size = 393216
parallel = 4
spec-type = draft-mtp
spec-draft-n-max = 2
temp = 1.0
top-p = 0.95
top-k = 64
```

| Model / Pattern | Avg wall time | Source chars/s | Avg output tokens/s | Notes |
|-----------------|---------------|----------------|---------------------|-------|
| TranslateGemma 4B only | 5.00 s | 382.9 | 92.8 | Specialized TranslateGemma prompt |
| TranslateGemma 4B + 12B routing | 9.28 s | 206.4 | - | Long segment routed to 12B |
| TranslateGemma 12B only | 12.30 s | 155.8 | 37.4 | Specialized TranslateGemma prompt |
| Gemma 4 E4B IT | 5.62 s | 341.0 | 108.5 | Generic instruction translation prompt, MTP enabled |

Gemma 4 E4B produced longer Japanese output in this test, so wall time was a
little slower than TranslateGemma 4B despite higher output token throughput.
Because it still fits fully in 12 GiB with `parallel = 4` and MTP enabled, it is
a promising single-model option when its translation quality is good enough.

### Gemma 4 E4B QAT Comparison

Measured on 2026-07-31 through the same llama.cpp router on an RTX 3060 12 GiB.
This benchmark uses the bundled `scripts/benchmark.rb` input (8 English
segments, 584 source characters), with one warmup run and three measured runs.
It is intentionally separate from the Secure Shell reference above, which uses
a longer input.

| Model | Quantization | Avg wall time | Source chars/s | Avg output tokens/s |
|-------|--------------|---------------|----------------|---------------------|
| Gemma 4 E4B IT | `Q4_K_M` | 11.37 s | 52.0 | 127.8 |
| Gemma 4 E4B IT QAT | `UD-Q4_K_XL` | 6.38 s | 94.0 | 203.0 |

The QAT model reduced wall-clock time by 43.9% and increased generation
throughput by 58.9% in this test. It is a strong speed option, but evaluate
translation quality on the target content before making it the default.

## Privacy

This extension is designed to be privacy-focused:

- ✅ Only connects to `localhost` - no external network requests
- ✅ No analytics or tracking
- ✅ No data collection
- ✅ Minimal permissions (only `localhost` host permissions)
- ✅ The translation cache is **off by default**. When enabled it is stored **locally** (in memory, or IndexedDB for the persistent mode) and never leaves your machine; it can be set to clear on browser close, turned off, or cleared at any time

## Settings

Click **Advanced Settings** to configure:

| Setting | Description |
|---------|-------------|
| Provider | Auto-detect, Ollama only, or LMStudio/OpenAI-compatible only |
| URLs | Custom endpoints for Ollama and LMStudio/OpenAI-compatible servers |
| Max tokens/items per batch | Control batch sizes |
| Temperature | Model creativity (lower = more consistent) |
| Request Format (*work in progress*) | Default JSON, Hunyuan-MT, Simple, or Custom |
| Show Glow | Toggle visual indicator on translated text |
| Cache translations | Reuse stored translations for identical text — *off* (default), *until browser close*, or *across sessions*; includes a "Clear cache" button |
| Retranslate/Discard Selection | Repair selected bad translations from the popup. Retranslate clears the matching cache entry first; discard restores original text and removes the cached result |

## Translation Cache

To avoid re-translating the same text over and over (forum boilerplate, menus, usernames, repeated phrases), translations can be cached locally and reused — both later on the same page and across other pages. It is **off by default**; enable it in Options or the popup's Advanced Settings.

- **Modes (Options → Translation Cache):**
  - **Don't cache** (default) — every segment is translated fresh.
  - **Until I close the browser** — cache speeds things up while you browse, then is wiped on the next browser start. Kept in memory, so nothing translation-related lingers on disk between sessions. Works in every browser.
  - **Keep across sessions** — cache persists on disk (IndexedDB) until you clear it. Best for repeatedly visiting the same sites. Hardened browsers that block IndexedDB (e.g. Mullvad/Tor-based Firefox) disable this option automatically and fall back to the in-memory session cache.
- **What's cached:** the translated output for each source text segment, stored locally (in memory, or IndexedDB for the persistent mode) — nothing is uploaded.
- **How it's keyed:** by the source text plus everything that determines the model's output — model, source & target language, request format, prompt template, structured-output mode, and temperature. Changing any of these yields fresh translations instead of stale cached ones, so the cache never serves output that wouldn't match your current settings.
- **De-duplication:** within a single page, identical strings are translated only once and the result is reused for every occurrence (this happens regardless of cache mode).
- **Clearing:** use **Clear cache** to wipe it at any time (the button shows the current entry count). The cache is capped (oldest entries are evicted first).

## Glossary

Load a TSV dictionary (Options → Glossary) to pin translations for specific terms. Each line is `source<TAB>translation`; leave the second column empty to keep the term untranslated. Matching is case-sensitive. A `#target: ja` line declares the language the glossary translates into — the glossary is then only applied when that target language is selected (recommended, since a glossary maps terms into one specific language).

It works at two levels:

- **Inside sentences** — glossary terms found in the text being translated are injected into the prompt as hard hints, so the model keeps proper nouns consistent (e.g. *The Companions* → *同胞団* everywhere). Only matching terms are sent, so a large dictionary is fine.
- **Whole segments** — when a segment consists *entirely* of a glossary term, the mapping is applied directly and the model is skipped. This is the reliable way to fix short context-free labels that small models mangle — e.g. add `About<TAB>概要` and the nav heading "About" always becomes "概要" instead of the broken "について".

Whole-segment matches take priority over the translation cache, and loading or clearing a glossary wipes the cache (the same source text now translates differently). Note: models with a fixed prompt format (TranslateGemma, Hunyuan-MT) only get the whole-segment treatment — injecting instruction blocks into their prompts corrupts their output. See `examples/` for a sample dictionary.

## File Structure

```
├── manifest.json      # Extension manifest (MV3)
├── background.js      # Background script (LLM API, settings)
├── content.js         # Content script (DOM manipulation)
├── scripts/
│   └── benchmark.rb   # Local provider translation benchmark
├── popup/
│   ├── popup.html     # Popup UI
│   ├── popup.css      # Styles (Everforest Dark theme)
│   └── popup.js       # Popup logic
├── icons/             # Extension icons
└── mkxpi.sh           # Build an installable .xpi (no signing needed)
```

## Development

The codebase is intentionally simple with no build step or dependencies:

- Pure vanilla JavaScript
- No external libraries
- No bundler required
- Works directly in the browser

### Debug Logging

Enable **"Enable debug logging"** in Options → Output Settings, then Save.

To view logs, go to `about:debugging#/runtime/this-firefox`, find **Local LLM Translator**, and click **Inspect** — messages with `[Background]` prefix appear in the Console tab.

## License

MIT

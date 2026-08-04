# Agent Notes

## Work Plan

- Merge upstream (Eldoprano/offline-browser-translate) `main` into the fork.
- Adopt upstream's IndexedDB translation cache (`cache.js`, three-mode `cacheMode`) and remove the fork's storage.local cache.
- Keep fork-only features working on top of it: glossary, selection repair, per-model cache deletion, benchmark.
- Add TranslateGemma 4B-first translation routing: use 12B only for long segments or failed/suspicious 4B output, then document the local llama.cpp settings and benchmarks.
- Document the local Gemma 4 E4B IT benchmark against the same Secure Shell long-text input, including the 12 GiB VRAM/MTP preset.

## Work Record

- Merged `upstream/main` (69176649, v1.6.0) on branch `merge-upstream`; merge base was df65723.
- Resolved conflicts in `README.md`, `manifest.json`, `background.js`, `options/options.js`, `popup/popup.css`, `popup/popup.js`.
- Removed the fork's translation cache (Map + storage.local in `background.js`) in favor of upstream's `cache.js` (memory + IndexedDB, `cacheMode`: off/session/persistent).
- Ported fork cache features onto `cache.js`:
  - `cacheDeleteModel(model, keep)` — per-model deletion, used by `CLEAR_OTHER_MODELS_CACHE` ("Delete all except current model" in Options).
  - `cacheDeleteKeys(keys)` — exact-entry deletion, used by `CLEAR_TRANSLATION_CACHE_ENTRIES` (selection repair/discard).
- Extracted `promptSigFor(settings, modelId)` in `background.js` so `translate()` and the entry-deletion handler build identical cache keys (keys include the prompt-shape hash).
- Dropped fork-only settings/UI: `useTranslationCache` checkbox, per-model cache stats list (`refreshCacheStats`), `CLEAR_TRANSLATION_CACHE` / `GET_CACHE_STATS` / `CLEAR_MODEL_CACHE` messages.
- Glossary save/clear now invalidates via upstream's `cacheClear()`.
- `popup.js`: fork's `runSelectionCommand` now reads the model from upstream's `modelPicker.getValue()` (old `elements.modelSelect` is gone from the popup).
- Version is upstream's `1.6.0`.

### Glossary whole-segment matching (post-merge, v1.6.1)

- Added `getGlossaryExactIndex()` in `background.js`: when a segment's trimmed text exactly equals a glossary source, the glossary target is applied directly and the model is skipped. Fixes short context-free labels being mistranslated (e.g. heading "About" → "について").
- Runs before the cache lookup, so a user mapping beats stale cached LLM output; exact hits are not written to the cache.
- Empty glossary target still means "keep as-is". Index is invalidated together with the automaton (`invalidateGlossary` / `loadGlossary`).
- Added `examples/ui-labels-ja.tsv` (common English nav/UI labels → Japanese) and a README "Glossary" section.
- Validated in Node with stubbed `chrome.storage` + `fetch`: `About` (x2) resolved to `概要` without reaching the model, other text went through the normal batch path.

### Removed "Delete all except current model" (post-merge, v1.6.1)

- Dropped the per-model cache deletion carried over from the fork: `cacheDeleteModel` in `cache.js`, the `CLEAR_OTHER_MODELS_CACHE` message, and the Options button/handler.
- Rationale: its purpose was freeing disk space in the persistent cache; the user's browser blocks IndexedDB (memory-only cache), and the 100k-entry LRU cap handles size anyway. Removing it also shrinks the diff against upstream.
- `cacheDeleteKeys` stays — selection repair (`CLEAR_TRANSLATION_CACHE_ENTRIES`) depends on it. Upstream's "Clear cache" button is untouched.

### Fix: XPI was missing cache.js (v1.6.1)

- "Failed to save glossary" after installing the 1.6.0 XPI was NOT a glossary bug: `mkxpi.sh` has an explicit file list that predates upstream's `cache.js`, so the packaged extension had no cache module. `SAVE_GLOSSARY` hit a ReferenceError on `cacheClear`.
- Same missing file also caused the bogus "doesn't support keeping the cache across sessions" warning (`cachePersistentAvailable` undefined → treated as unsupported) and the stuck "0 entries" count. A browser that blocks IndexedDB shows the same warning legitimately — check the background console to tell them apart.
- Fixed by adding `cache.js` to `mkxpi.sh` and guarding the two glossary handlers with `typeof cacheClear === 'function'` (same style as the onStartup guard). Rebuilt `local-llm-translator-1.6.1.xpi` and verified `cache.js` is inside.
- When adding a new runtime file, remember BOTH lists: `manifest.json` background scripts and `mkxpi.sh`.
- The earlier `local-llm-translator-1.6.0.xpi` is broken (no cache.js) — don't install it.

### Glossary load feedback (v1.6.1)

- Status line now shows count + file name + load time ("✅ 16 terms loaded from ui-labels-ja.tsv (…)"), highlighted via `.glossary-status-loaded`.
- Added a collapsible "Show loaded terms" preview under the status: first `GLOSSARY_PREVIEW_MAX` (200) rows as `source → target`, `(kept as-is)` for empty targets, "… and N more" for the rest. Rows are built with `textContent` (TSV content never hits innerHTML).
- `SAVE_GLOSSARY` now stores `{ name, loadedAt }` under storage.local `glossaryMeta`; `GET_GLOSSARY_INFO` returns count/name/loadedAt/preview; `CLEAR_GLOSSARY` removes both keys.
- Repurposed the orphaned `.cache-stat*` CSS (left from the removed per-model stats UI) into `.glossary-*` styles.

### Upstream PR #15: content-script bugfixes (2026-07-02)

- Opened https://github.com/Eldoprano/offline-browser-translate/pull/15 — first probe PR to see how the maintainer receives contributions.
- Branch `fix/skip-tags-and-decimal-split` (pushed to our GitHub fork), cut from `upstream/main`, two commits extracted from fork history: SKIP_TAGS ancestor check (e6ef018) and decimal sentence splitting (45381b8), `content.js` changes only.
- Evidence in the PR: upstream's regex silently DROPS text around decimals (`String.match` fragments don't cover the input), verified by extracting `splitIntoSentences` from both versions and diffing outputs.
- Remaining PR queue if #15 lands well: glossary (open an issue first), cancel-on-navigation, selection repair. Keep Ruby tooling / BUGS.md / agent-notes fork-only.
- Result: merged upstream as-is via merge commit be61e98 (2026-07-03 confirmed). Maintainer is receptive; skipped the "issue first" step for the glossary and went straight to a PR.

### Upstream PR: glossary (2026-07-03)

- Branch `feat/glossary` off `upstream/main` (2fffa0c), worktree-built, hand-ported (fork's background.js has extra features, so no cherry-pick):
  - `options/options.{js,html,css}`: fork diff vs upstream was glossary-only → applied wholesale via `git diff upstream/main -- <files> | git apply`.
  - `background.js`: glossary section (constants/loader/automaton/exact index) after `getSettings()`, prompt injection in `requestBatch`, whole-segment bypass before the cache lookup (`unresolvedGroups`), 3 message handlers after `CACHE_BACKEND`. No `promptSigFor`/cancel/selection-repair bits — those stay fork-only.
  - `README.md`: feature bullet + Glossary section only (no mkxpi/benchmark/selection-repair text).
  - `examples/ui-labels-ja.tsv`: sample dictionary, header comments rewritten in English for upstream.
- Verified with `scratchpad/test-glossary.js` (stubbed chrome + Ollama fetch, drives the real onMessage handler): 14/14 PASS — save/info/clear, whole-segment bypass, keep-as-is, prompt hints, and cache-on behavior (exact hits not written to cache; `CACHE_COUNT` = model results only).
- Reminder for fork: upstream cache messages are `CLEAR_CACHE`/`CACHE_COUNT`/`CACHE_BACKEND` — same names used by our merged tree.

### llama.cpp / llama-server provider (2026-07-08, fork issue #3)

- Added a `llamacpp` provider (OpenAI-compatible, default `http://localhost:8080`) alongside ollama/lmstudio; the extension stays a thin HTTP client (no WebGPU).
- `background.js`: LMStudio client generalized into `OPENAI_COMPAT` table + `listOpenAICompatModels()` / `callOpenAICompat()` (`callLMStudio`/`listLMStudioModels` are gone — llamacpp and lmstudio share the `/v1` path, only base-URL setting and error label differ). `detectProviders()` rewritten around a shared `probeEndpoint()` helper and now probes all three in parallel; response gains `llamacpp`/`llamacpp_blocked`. `llamacppUrl` added to `DEFAULT_SETTINGS`.
- UI: provider option + URL field in popup and options; `llamacppUrl` wired through DEFAULT_SETTINGS / applySettingsToUI / save / `ensureHostPermissions` in `popup.js`, `options.js`; provider-status + CORS-banner handling in `popup.js` and `translator.js` (blocked-case text says "update llama.cpp / check proxy" — llama-server allows CORS by default, unlike Ollama/LMStudio). New `.model-provider-badge--llamacpp` (blue) in `popup.css`.
- `scripts/benchmark.rb`: `PROVIDER=llamacpp` + `LLAMACPP_URL`; `run_lmstudio` renamed `run_openai_chat`, detect tries ollama → lmstudio → llamacpp.
- `manifest.json` unchanged: `http://localhost/*` host permission ignores ports, so :8080 is already covered. No new files, so `mkxpi.sh` untouched.
- Validated with `scratchpad/test-llamacpp.js` (mock llama-server on :8080 + real local Ollama, drives the real onMessage handler): DETECT_PROVIDERS, auto-mode model merge, provider=llamacpp-only listing, and TRANSLATE via `/v1/chat/completions` with `response_format: json_schema` — 5/5 PASS. `benchmark.rb` llamacpp path also run against the mock.
- Not yet done: end-to-end against a real `llama-server` (binary is installed but no .gguf on this machine) — llama-server ≥ b4600ish supports OpenAI `json_schema` response_format; older builds fall back via the existing retry/plain-text path.
- UPDATE (same day): real E2E and benchmarks done — see the next section.

### llama.cpp benchmarks + real E2E (2026-07-08)

- Ollama's translategemma blobs are NOT loadable by upstream llama.cpp (`gemma3.attention.layer_norm_rms_epsilon` missing from Ollama's conversion) — downloaded `mradermacher/translategemma-{4b,12b}-it-GGUF:Q4_K_M` via `llama-server -hf` instead (lands in `~/.cache/huggingface/hub`, ~11 GB total incl. mmproj).
- **Gotcha:** TranslateGemma's bundled jinja chat template demands a structured content mapping (`source_lang_code`/`target_lang_code`/...), so `llama-server` dies at startup with a Jinja exception on plain OpenAI messages. Fix: `--no-jinja --chat-template gemma` (builtin C++ Gemma template). Plain `--chat-template gemma` WITHOUT `--no-jinja` silently treats "gemma" as a literal jinja string — every prompt renders as the word "gemma" and the model hallucinates garbage. Documented in README's llama.cpp setup section.
- **Aperture E2E (2026-07-08, later):** the llamacpp provider works unmodified against Tailscale Aperture (AI gateway on the tailnet's `ai` node). Auth is tailnet-identity — `/v1/models` and `/v1/chat/completions` answer without an API key, so no Authorization support is needed in the extension. Verified with `scratchpad/test-aperture.js`: provider detection, model listing (Claude/GPT/Ollama models all appear in the picker), `translategemma:12b` format auto-detection, and a real translation — PASS. Remote-machine setup = set llama.cpp URL to the gateway + grant the host permission on Save. Caveat: metered cloud models also appear in the picker — don't page-translate on Opus. Future idea: rename the `llamacpp` provider label to "OpenAI-compatible".
- **Gotcha 2 (2026-07-08, later):** `--no-jinja` disables tool calls entirely, so llama-server's built-in web UI errors with "tools require --jinja". The both-worlds fix: keep Jinja on and pass a plain Gemma template as a FILE — `--jinja --chat-template-file gemma.jinja` (file lives at `~/.local/lib/models/gemma.jinja`; same turn mapping as the LM Studio template in options.html). Verified on :8081 (CPU): startup OK, template renders `<start_of_turn>` turns, translation works, and a tools-bearing chat/completions request is accepted (no rejection; generic tool handling). README updated to recommend the template-file form.
- `scripts/benchmark.rb`: OpenAI path now fills output tokens (`usage.completion_tokens`) and tokens/s (llama-server's `timings.predicted_per_second`).
- Re-measured README "Local Reference" (2026-07-08, kernel 7.1.2, llama.cpp b9902 CUDA, Q4_K_M both providers, EN→JA):
  - 4B: llamacpp 3.18 s / 94.8 tok/s vs ollama 5.04 s / 76.1 tok/s
  - 12B: llamacpp 6.68 s / 36.4 tok/s vs ollama 7.27 s / 35.1 tok/s
- Real E2E (`scratchpad/test-llamacpp-real.js`, real llama-server + real onMessage handler): DETECT_PROVIDERS, model listing, `requestFormat: auto` → `translategemma` detected from the model id, TRANSLATE returned correct Japanese for 2 segments — PASS.
- Follow-up fix: switching Provider in the options page kept showing the old provider's models. Two causes: (1) background's 60s model cache wasn't keyed by provider — now `cachedModelsProvider` invalidates it on switch; (2) options page never reloaded the list on provider change and its refresh button didn't pass `forceRefresh` — provider change now saves immediately + reloads (`loadModels(true)`), refresh/Save force-refresh too, popup got the same provider-change listener. Regression test: `scratchpad/test-provider-switch.js` (3/3 PASS against the real llama-server).

### TranslateGemma 4B/12B quality routing (2026-07-16)

- Added 4B-first quality routing in `background.js`:
  - `qualityFallbackModel: 'auto'` detects a loaded TranslateGemma 12B candidate when the selected model is TranslateGemma 4B.
  - Short segments go to 4B first; empty/malformed/suspicious results are retried on 12B.
  - Long segments go directly to 12B when they are 120+ words or 700+ characters.
  - 12B-produced results are not written under the 4B cache key, so future requests still follow the routing rules.
- README now documents the routing behavior, the long-text threshold, and a Secure Shell long-routing benchmark.
- Benchmark input: 3 segments adapted from Wikipedia "Secure Shell" (28 words, 72 words, 180 words; 1,916 source chars total). With both TranslateGemma Q4_K_M models fully GPU-offloaded on RTX 3060 12 GiB using `c = 4096`, `parallel = 1`, `n-gpu-layers = 99`:
  - 4B only: 5.00 s / 382.9 chars/s.
  - 4B + 12B long-text routing: 9.28 s / 206.4 chars/s, routed 2 segments to 4B and 1 long segment to 12B.
  - 12B only: 12.30 s / 155.8 chars/s.
- Heavier llama.cpp defaults (`c = 16384`, `parallel = 4`) made simultaneous full-GPU 4B+12B residency unreliable on 12 GiB VRAM; `c = 4096`, `parallel = 1` worked and kept GPU utilization high.
- Validation: `node --check background.js`, `node --check languages.js`, and live local llama-server smoke/benchmark requests against temporary 4B/12B servers.

### Gemma 4 E4B translation benchmark (2026-07-27)

- User added and started `gemma-4-E4B-it` in llama.cpp with the optimized preset from `/etc/llama.cpp/models.ini`: `unsloth/gemma-4-E4B-it-GGUF:Q4_K_M`, `n-gpu-layers = all`, `ctx-size = 393216`, `parallel = 4`, `spec-type = draft-mtp`, `spec-draft-n-max = 2`.
- Benchmarked with the same Wikipedia "Secure Shell" 3-segment input used for the long-text routing reference: 1,916 source chars total.
- Result over 3 measured runs after 1 warmup: 5.62 s avg wall time, 341.0 source chars/s, 964 avg output chars, 603 avg output tokens, 108.5 output tokens/s.
- Comparison point: TranslateGemma 4B only was faster by wall time on this input (5.00 s / 382.9 chars/s) but lower in output token throughput (92.8 tok/s); Gemma 4 E4B emitted longer Japanese with a generic instruction translation prompt.
- Practical note: the model fits just inside the 12 GiB RTX 3060 while keeping full GPU offload plus MTP draft decoding, which likely explains the strong throughput. No extension code change was made for this benchmark.

### Gemma 4 E4B QAT benchmark (2026-07-31)

- Added the `gemma-4-E4B-it-qat` llama.cpp router preset: `unsloth/gemma-4-E4B-it-qat-GGUF:UD-Q4_K_XL`, full GPU offload, `ctx-size = 393216`, `parallel = 4`, MTP with `spec-draft-n-max = 4`.
- Same `scripts/benchmark.rb` input (8 English segments / 584 source characters) on the RTX 3060 12 GiB: QAT averaged 6.38 s, 94.0 source chars/s, and 203.0 output tokens/s over three measured runs after one warmup.
- The regular `gemma-4-E4B-it` Q4_K_M preset measured 11.37 s, 52.0 source chars/s, and 127.8 output tokens/s on the same input. QAT reduced wall-clock time by 43.9% and increased generation throughput by 58.9%.
- README records the comparison separately from the older 1,916-character Secure Shell reference. QAT is the faster option, but translation quality needs evaluation on the intended content before it becomes a default.

## Handoff

- Cache is now **off by default** (upstream policy). Enable it in Options → Translation Cache; selection repair works with or without it.
- Old fork cache data under storage.local `translationCache` is orphaned (never read); harmless, cleared on uninstall.
- Selection repair cache keys include `promptSigFor` output — if key derivation in `translate()` changes, change the `CLEAR_TRANSLATION_CACHE_ENTRIES` handler the same way (both call the shared helper).
- `background.js` briefly contained a literal NUL again during the merge; keep the `\u0000` escape in source (see upstream 5b5f1d5 and the fork's `.gitattributes`).
- Validation run: `node --check` on all six JS files, duplicate-id scan on both HTML files, and a Node smoke test of `cacheDeleteKeys` / `cacheDeleteModel` (memory layer).
- Real-browser status: llamacpp provider confirmed working in Firefox (options provider switch + model listing + page translation against a local `llama-server`); llama-server now runs as a systemd service (`/etc/conf.d/llama.cpp`, translategemma-12b). XPI rebuild for the llamacpp feature still pending (bump version + `./mkxpi.sh`).
- For TranslateGemma 4B/12B routing, prefer dedicated llama.cpp model aliases such as `translategemma-4b-translate` and `translategemma-12b-translate` with `c = 4096`, `parallel = 1`, `n-gpu-layers = 99`. The extension auto-routing only looks for 4B/12B TranslateGemma model IDs; keep both tokens in the aliases.
- Gemma 4 E4B benchmark is documentation-only. If integrating it into the extension as a first-class option, decide its request format/prompt separately; it is not a TranslateGemma model, so the current 4B/12B TranslateGemma fallback logic does not apply automatically.
- QAT comparison is documented in README: `gemma-4-E4B-it-qat` is substantially faster than Q4_K_M on the short benchmark, but quality has not been accepted as a replacement default. QAT was reloaded after the measurement.
- `filterLlamaCppUiModels` is opt-in and only filters llama.cpp router entries that explicitly serialize `webui = false`; preserve that fallback behavior for generic OpenAI-compatible servers.
- Existing unrelated local change remains in `examples/ui-labels-ja.tsv`; do not include it unless the user explicitly wants that file committed.
- Existing untracked `memo.txt` is unrelated; leave it uncommitted unless the user explicitly asks for it.

### Upstream v1.6.4 merge — llamacpp provider retired (2026-07-29)

- Merged `upstream/main` (d2b0907, v1.6.4). Upstream had squash-re-authored fork PR #16 (glossary) and then hardened it, so histories diverged textually; conflicts in 8 files.
- Adopted upstream's glossary plumbing wholesale: `#target:` TSV directive with `glossaryAppliesTo()`, `getGlossarySignature()` folded into the cache key (as a new third arg to the fork's `promptSigFor`), `SAVE_GLOSSARY`/`GET_GLOSSARY_INFO` with `target` meta, glossary block skipped for plain-text formats.
- Adopted upstream's provider plumbing: `normalizeServerUrl()` (trailing `/v1` strip + `localhost`→`127.0.0.1`), `probeProvider()` with the Ollama origin-block POST probe, parallel `detectProviders`/`listModels`, and the `response_format` 400 retry in `callLMStudio` (cancelSignal threaded through).
- **Removed the fork's dedicated `llamacpp` provider** (added 2026-07-08). Upstream covers the same servers via the LMStudio / OpenAI-compatible URL field, and the network path is identical; keeping a third provider only bought simultaneous LMStudio+llama-server use at a permanent merge-conflict cost. llama-server users now put `http://localhost:8080` in the LMStudio field. `scripts/benchmark.rb` keeps its own independent `PROVIDER=llamacpp` (it talks to servers directly, not through the extension).
- Kept fork features on top: ctx-based `translate()` with per-tab cancellation (`CANCEL_TRANSLATION`), TranslateGemma 4B→12B quality routing, selection repair, benchmark docs.
- Settings migration: a stored `provider: 'llamacpp'` is no longer recognized — re-select the provider and move the URL into `lmstudioUrl` manually.

### Upstream PR #22: cancel in-flight requests on navigation (2026-07-29)

- Decided against PRing the TranslateGemma 4B/12B quality routing: benchmarks show 4B+12B routing (9.28 s) loses to single-model Gemma 4 E4B (5.62 s) on the same input, the dual-model-in-12GiB setup is too niche, and the model-name-regex routing logic is upstream-maintenance-heavy.
- Instead extracted the fork's per-tab cancellation as https://github.com/Eldoprano/offline-browser-translate/pull/22 (branch `feat/cancel-inflight-on-navigation`, based on upstream/main): `pagehide` → `CANCEL_TRANSLATION` → refcounted per-tab AbortController linked into each fetch's timeout controller.
- Remaining PR candidate: Selection Repair (retranslate/discard a selected segment).

### Host permission for 127.0.0.1 (2026-07-29)

- After the v1.6.4 merge, model listing failed: upstream's `normalizeServerUrl` rewrites `localhost` → `127.0.0.1`, but `host_permissions` only covered `http://localhost/*`, so rewritten requests lost the extension's CORS exemption (llama-server sends no `Access-Control-Allow-Origin` at all — verified with curl). Fixed by adding `http://127.0.0.1/*` to `host_permissions`.
- Also verified end-to-end after the merge: model listing via the LMStudio/OpenAI-compatible path against llama-server on :8080, and full page translation (E4B). Note: the URL must be saved in settings first — refresh uses the stored `lmstudioUrl`, not the field value.
- Upstream has the same bug; submitted as a separate PR.

### llama-server CORS gotcha (2026-07-31)

- Firefox background scripts use a `moz-extension://<uuid>` origin. If `llama-server` does not emit a matching `Access-Control-Allow-Origin`, model detection fails with `NetworkError when attempting to fetch resource`.
- Safe local fix: keep `--host 127.0.0.1` and pass the extension origin only, e.g. `--cors-origins "moz-extension://ca462efa-9eb3-47a8-b32e-c8f6d7b859c9"`. When copying from a script URL like `/languages.js`, strip the path; CORS origin is scheme + host only.
- `--cors-origins "*"` works but is broader than needed. `--cors-origins "localhost,moz-extension://..."` can fail on this llama.cpp build because the server returns the comma-separated string literally, while Firefox expects a single matching `Access-Control-Allow-Origin` value.
- Direct use of the built-in `llama-server` Web UI at `http://127.0.0.1:8080` does not require adding `localhost` to CORS.

### llama.cpp model-list visibility filter (2026-08-04)

- The extension's LM Studio / OpenAI-compatible model picker now has an opt-in `filterLlamaCppUiModels` setting, exposed in both Options and the popup's Advanced Settings as “For llama.cpp, show only models with `ui = true`”. It defaults to off so LM Studio and existing OpenAI-compatible servers keep their full lists.
- llama.cpp router returns each rendered model preset in `/v1/models`; its `ui` option is serialized as `webui`. When the setting is enabled, the background filters only entries whose preset says `webui = false`. Models from LM Studio/vLLM and servers without this router-specific metadata remain visible.
- Model-list caching is keyed by both provider selection and this filter setting, so toggling it cannot return the prior unfiltered list. User verified the behavior in Firefox after reloading the extension.

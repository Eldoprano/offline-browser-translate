/**
 * Background Script for Local LLM Translator
 * Handles LLM API calls, settings storage, and message routing
 */

// Use browser API with chrome fallback
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Import languages (for Service Worker context)
if (typeof importScripts === 'function') {
    importScripts('languages.js', 'cache.js');
}

// ============================================================================
// Settings & Constants
// ============================================================================

const DEFAULT_SETTINGS = {
    provider: 'auto', // 'auto', 'ollama', 'lmstudio'
    ollamaUrl: 'http://localhost:11434',
    lmstudioUrl: 'http://localhost:1234',
    selectedModel: '',
    targetLanguage: 'en',
    sourceLanguage: 'auto', // 'auto' = detect from page, or specific code
    maxTokensPerBatch: 2000,
    maxItemsPerBatch: 8,
    maxConcurrentRequests: 4, // 1-4 parallel requests (LMStudio 0.4.0+ supports up to 4)
    useAdvanced: false,
    customSystemPrompt: '',
    customUserPromptTemplate: '',
    requestFormat: 'auto', // 'auto' (detect from model), 'default', 'translategemma', 'hunyuan', 'simple', 'custom'
    temperature: 0.3,
    useStructuredOutput: true,
    maxOutputRetries: 2,    // Extra attempts when the model returns malformed/missing translations
    plainTextFallback: true, // After JSON retries fail, translate the failed items one-by-one as plain text
    showGlow: false,
    numCtx: 0,          // Ollama context window size (0 = model default)
    // Translation cache: 'persistent' (kept across browser sessions), 'session'
    // (kept until the browser is closed, then wiped), or 'off'. Off by default.
    cacheMode: 'off',
    debug: false,       // Enable verbose logging
    floatingButton: false, // Show floating translate button on text selection (requires <all_urls> permission)
    useGlossary: true   // Inject matching glossary terms into the prompt for consistent proper-noun translation
};

let debugEnabled = false;
function debugLog(...args) { if (debugEnabled) console.log(...args); }
function debugWarn(...args) { if (debugEnabled) console.warn(...args); }

const PROMPT_TEMPLATES = {
    default: {
        system: `You are a professional translator. Translate the given texts to {{targetLanguage}}. 
Respond ONLY with a JSON object in this exact format:
{"translations": [{"id": 0, "text": "translated text"}, {"id": 1, "text": "another translation"}]}
Maintain the original meaning, tone, and formatting. Do not add explanations.`,
        user: `Translate the following texts to {{targetLanguage}}:\n{{texts}}`
    },
    translategemma: {
        // TranslateGemma EXACT format - do not modify
        system: '',
        user: `You are a professional {{sourceLang}} ({{sourceCode}}) to {{targetLang}} ({{targetCode}}) translator. Your goal is to accurately convey the meaning and nuances of the original {{sourceLang}} text while adhering to {{targetLang}} grammar, vocabulary, and cultural sensitivities.
Produce only the {{targetLang}} translation, without any additional explanations or commentary. Please translate the following {{sourceLang}} text into {{targetLang}}:


{{texts}}`
    },
    simple: {
        system: `You are a translator. Translate to {{targetLanguage}}. Output JSON only:
{"translations": [{"id": N, "text": "translation"}]}`,
        user: `Translate to {{targetLanguage}}:\n{{texts}}`
    },
    hunyuan: {
        system: '',
        user: `Translate the following segment into {{targetLanguage}}, without additional explanation.\n{{texts}}`
    }
};

// Cache for models to avoid repeated API calls during translation
let cachedModels = null;
let modelsCacheTime = 0;
const MODEL_CACHE_TTL = 60000; // 60 seconds

let cachedSettings = null;

// ============================================================================
// Settings Management
// ============================================================================

async function loadSettings() {
    try {
        const result = await browserAPI.storage.local.get('settings');
        cachedSettings = { ...DEFAULT_SETTINGS, ...result.settings };
        debugEnabled = !!cachedSettings.debug;
        return cachedSettings;
    } catch (e) {
        console.error('Failed to load settings:', e);
        cachedSettings = { ...DEFAULT_SETTINGS };
        return cachedSettings;
    }
}

async function saveSettings(settings) {
    // Merge defaults < cached < new so fields unknown to the caller are preserved
    cachedSettings = { ...DEFAULT_SETTINGS, ...cachedSettings, ...settings };
    debugEnabled = !!cachedSettings.debug;
    await browserAPI.storage.local.set({ settings: cachedSettings });
    return cachedSettings;
}

async function getSettings() {
    if (!cachedSettings) {
        return loadSettings();
    }
    return cachedSettings;
}

// ============================================================================
// Glossary
// User-supplied proper-noun dictionary. Only terms that actually appear in the
// batch being translated are injected into the prompt, so the dictionary itself
// can be large (tens of thousands of entries) without bloating requests.
//
// Stored in storage.local under 'glossary' as an array of [source, target]
// pairs. An empty/identical target means "keep as-is" (do not translate).
// Matching is case-sensitive and Latin word-boundary aware (proper nouns); an
// Aho-Corasick automaton is built lazily so a batch is scanned in one pass.
// ============================================================================

const GLOSSARY_KEY = 'glossary';
const GLOSSARY_META_KEY = 'glossaryMeta';  // { name, loadedAt } of the loaded TSV, for the options UI
const GLOSSARY_MAX_HITS = 40;   // cap terms injected per batch to keep prompts small
const GLOSSARY_PREVIEW_MAX = 200; // rows sent to the options page for the preview list

let glossaryEntries = null;     // Array<[source, target]>, lazily loaded
let glossaryAutomaton = null;   // built Aho-Corasick root, or null
let glossaryExactIndex = null;  // Map<source, target> for whole-segment lookups

async function loadGlossary() {
    if (glossaryEntries) return glossaryEntries;
    try {
        const result = await browserAPI.storage.local.get(GLOSSARY_KEY);
        const entries = result[GLOSSARY_KEY];
        glossaryEntries = Array.isArray(entries) ? entries : [];
    } catch (e) {
        console.error('Failed to load glossary:', e);
        glossaryEntries = [];
    }
    glossaryAutomaton = null;
    glossaryExactIndex = null;
    return glossaryEntries;
}

// Reset in-memory glossary so the next translate reloads it. Called after the
// user replaces or clears the dictionary.
function invalidateGlossary() {
    glossaryEntries = null;
    glossaryAutomaton = null;
    glossaryExactIndex = null;
}

// Map of source => target for whole-segment lookups. A segment that consists
// entirely of a glossary term (e.g. the nav heading "About") is translated
// deterministically from this map instead of being sent to the model — prompt
// hints only nudge the model, and short context-free labels are exactly where
// small models produce broken output. An empty target means "keep as-is", same
// as the prompt-hint path. Returns null when the glossary is off or empty.
async function getGlossaryExactIndex(settings) {
    if (settings.useGlossary === false) return null;
    const entries = await loadGlossary();
    if (!entries.length) return null;
    if (!glossaryExactIndex) {
        glossaryExactIndex = new Map();
        for (const entry of entries) {
            const src = entry && entry[0];
            if (!src) continue;
            const tgt = entry[1];
            glossaryExactIndex.set(src, (tgt === undefined || tgt === '') ? src : tgt);
        }
    }
    return glossaryExactIndex;
}

function isWordChar(c) {
    return c !== '' && c !== undefined && /[\p{L}\p{N}_]/u.test(c);
}

// Build an Aho-Corasick automaton over the source strings (case-sensitive,
// UTF-16 unit granularity — fine for Latin proper nouns).
function buildGlossaryAutomaton(entries) {
    const root = { next: new Map(), fail: null, out: [] };
    for (let i = 0; i < entries.length; i++) {
        const pat = entries[i] && entries[i][0];
        if (!pat) continue;
        let node = root;
        for (let j = 0; j < pat.length; j++) {
            const ch = pat[j];
            let child = node.next.get(ch);
            if (!child) { child = { next: new Map(), fail: null, out: [] }; node.next.set(ch, child); }
            node = child;
        }
        node.out.push(i);
    }
    const queue = [];
    for (const child of root.next.values()) { child.fail = root; queue.push(child); }
    while (queue.length) {
        const node = queue.shift();
        for (const [ch, child] of node.next) {
            let f = node.fail;
            while (f && !f.next.has(ch)) f = f.fail;
            child.fail = (f && f.next.get(ch)) || root;
            if (child.fail.out.length) child.out = child.out.concat(child.fail.out);
            queue.push(child);
        }
    }
    return root;
}

// Find glossary entries that occur in `text`. Returns an array of entry indices,
// deduped, in first-seen order, capped at GLOSSARY_MAX_HITS. A Latin match is
// rejected when it sits inside a larger word (e.g. "Container" in "Containers").
function scanGlossary(root, entries, text) {
    const seen = new Set();
    const order = [];
    let node = root;
    for (let i = 0; i < text.length && order.length < GLOSSARY_MAX_HITS; i++) {
        const ch = text[i];
        while (node !== root && !node.next.has(ch)) node = node.fail;
        node = node.next.get(ch) || root;
        if (!node.out.length) continue;
        for (const idx of node.out) {
            if (seen.has(idx)) continue;
            const pat = entries[idx][0];
            const end = i + 1;
            const start = end - pat.length;
            const before = start > 0 ? text[start - 1] : '';
            const after = end < text.length ? text[end] : '';
            const cutStart = isWordChar(before) && isWordChar(pat[0]);
            const cutEnd = isWordChar(after) && isWordChar(pat[pat.length - 1]);
            if (cutStart || cutEnd) continue;
            seen.add(idx);
            order.push(idx);
            if (order.length >= GLOSSARY_MAX_HITS) break;
        }
    }
    return order;
}

// Build the glossary instruction block for the terms found in `text`. Returns ''
// when the glossary is empty or nothing matches, so prompts are unchanged.
async function buildGlossaryBlock(settings, text) {
    if (settings.useGlossary === false) return '';
    const entries = await loadGlossary();
    if (!entries.length) return '';
    if (!glossaryAutomaton) glossaryAutomaton = buildGlossaryAutomaton(entries);
    const hits = scanGlossary(glossaryAutomaton, entries, text);
    if (!hits.length) return '';
    const lines = hits.map(idx => {
        const [src, tgt] = entries[idx];
        const target = (tgt === undefined || tgt === '') ? src : tgt;
        return `- "${src}" => "${target}"`;
    });
    return `[Glossary] Use these exact translations for the listed terms. Keep them consistent and do not alter them:\n${lines.join('\n')}`;
}

// ============================================================================
// Provider Detection & Model Listing
// ============================================================================

async function detectProviders(ollamaUrl, lmstudioUrl) {
    const results = { ollama: false, ollama_blocked: false, lmstudio: false, lmstudio_blocked: false };

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const response = await fetch(`${ollamaUrl}/api/tags`, {
            method: 'GET',
            signal: controller.signal
        });
        clearTimeout(timeout);
        results.ollama = response.ok;
    } catch (e) {
        // Normal fetch failed — could be server not running, or CORS blocking the response.
        // Try a no-cors fetch: it gives an opaque response (can't read status/body) but
        // will not throw if the server is reachable, only if it is truly unreachable.
        try {
            const controller2 = new AbortController();
            const timeout2 = setTimeout(() => controller2.abort(), 2000);
            await fetch(`${ollamaUrl}/api/tags`, {
                method: 'GET',
                mode: 'no-cors',
                signal: controller2.signal
            });
            clearTimeout(timeout2);
            results.ollama_blocked = true;
        } catch (_) {
            results.ollama = false;
        }
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const response = await fetch(`${lmstudioUrl}/v1/models`, {
            method: 'GET',
            signal: controller.signal
        });
        clearTimeout(timeout);
        results.lmstudio = response.ok;
    } catch (e) {
        // Try a no-cors fetch to see if server is running but CORS is blocking the response
        try {
            const controller2 = new AbortController();
            const timeout2 = setTimeout(() => controller2.abort(), 2000);
            await fetch(`${lmstudioUrl}/v1/models`, {
                method: 'GET',
                mode: 'no-cors',
                signal: controller2.signal
            });
            clearTimeout(timeout2);
            results.lmstudio_blocked = true;
        } catch (_) {
            results.lmstudio = false;
        }
    }

    return results;
}

async function listOllamaModels(url) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
        const response = await fetch(`${url}/api/tags`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!response.ok) throw new Error('Failed to fetch Ollama models');
        const data = await response.json();
        return (data.models || []).map(m => ({ id: m.name, name: m.name, provider: 'ollama' }));
    } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') throw new Error('Ollama model listing timed out');
        throw e;
    }
}

async function listLMStudioModels(url) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
        const response = await fetch(`${url}/v1/models`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!response.ok) throw new Error('Failed to fetch LMStudio models');
        const data = await response.json();
        return (data.data || []).map(m => ({ id: m.id, name: m.id, provider: 'lmstudio' }));
    } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') throw new Error('LMStudio model listing timed out');
        throw e;
    }
}

async function listModels(settings, useCache = true) {
    // Return cached models if available and not expired
    if (useCache && cachedModels && (Date.now() - modelsCacheTime < MODEL_CACHE_TTL)) {
        return cachedModels;
    }

    const models = [];
    const provider = settings.provider;

    if (provider === 'lmstudio' || provider === 'auto') {
        try {
            const lmstudioModels = await listLMStudioModels(settings.lmstudioUrl);
            models.push(...lmstudioModels);
        } catch (e) {
            if (provider === 'lmstudio') throw e;
        }
    }

    if (provider === 'ollama' || provider === 'auto') {
        try {
            const ollamaModels = await listOllamaModels(settings.ollamaUrl);
            models.push(...ollamaModels);
        } catch (e) {
            if (provider === 'ollama') throw e;
        }
    }

    // Update cache
    cachedModels = models;
    modelsCacheTime = Date.now();

    return models;
}

// ============================================================================
// Translation Logic
// ============================================================================

function formatTextsForPrompt(textItems) {
    return textItems.map(item => `[${item.id}]: ${item.text}`).join('\n');
}

function buildPrompt(template, vars) {
    let result = template;
    for (const [key, value] of Object.entries(vars)) {
        result = result.replace(new RegExp(`{{${key}}}`, 'g'), value);
    }
    return result;
}

// A small allowlist of inline HTML tags that occasionally leak from models.
// We only strip these — arbitrary "<...>" is left alone so legitimate text like
// "a < b" or "<3" is never mangled.
const LEAKED_HTML_TAG = /<\/?(?:div|span|p|br|b|i|em|strong|ul|ol|li|a|h[1-6])\b[^>]*>/gi;

// Clean translation text - remove ID prefixes and HTML garbage that LLM might include
function cleanTranslationText(text) {
    if (!text) return text;
    // Remove patterns like "[99]: ", "[99]:", "99: ", "99:" at start of text
    let cleaned = text.replace(/^\[?\d+\]?:\s*/g, '');
    // Remove only known HTML tags that occasionally leak through
    cleaned = cleaned.replace(LEAKED_HTML_TAG, '');
    // Normalize multiple spaces to single space (but preserve leading/trailing)
    cleaned = cleaned.replace(/  +/g, ' ');
    // Don't trim - let content.js handle whitespace preservation from original
    return cleaned;
}

// Heuristic: does this string look like leaked structure (JSON/markup) rather
// than an actual translation? Used to reject garbage so the page keeps its
// original text instead of being broken. Be conservative to avoid false positives.
function isSuspiciousTranslation(text) {
    if (text === null || text === undefined) return true;
    const t = String(text).trim();
    if (!t) return true;
    // Must contain at least one letter — pure punctuation/braces is garbage.
    if (!/\p{L}/u.test(t)) return true;
    // Leaked JSON keys from our own schema.
    if (/["']?(?:translations|id|text)["']?\s*:/.test(t)) return true;
    // Wrapped in a JSON object/array container with a quote or colon inside.
    if (/^[\[{][\s\S]*[\]}]$/.test(t) && /["':]/.test(t)) return true;
    // Markdown code fence.
    if (t.includes('```')) return true;
    return false;
}

// Extract the first balanced {...} object from a string, respecting strings and
// escapes. More reliable than a greedy regex when the model adds prose around it.
function extractJsonObject(text) {
    const start = text.indexOf('{');
    if (start === -1) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
        } else if (ch === '"') {
            inString = true;
        } else if (ch === '{') {
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0) return text.slice(start, i + 1);
        }
    }
    return null; // Unbalanced (e.g. truncated) — let the caller fall back.
}

function parseTranslationResponse(response, originalItems) {
    const expectedCount = originalItems.length;
    let translations = [];

    try {
        // Clean up markdown code blocks if present
        let cleanResponse = response
            .replace(/^```json\s*/m, '')
            .replace(/^```\s*/m, '')
            .replace(/\s*```$/m, '')
            .trim();

        // Try to parse as JSON first
        const parsed = JSON.parse(cleanResponse);
        if (parsed.translations && Array.isArray(parsed.translations)) {
            translations = parsed.translations;
        } else if (Array.isArray(parsed)) {
            translations = parsed;
        }
    } catch (e) {
        // Try to extract a balanced JSON object embedded in surrounding prose
        const jsonStr = extractJsonObject(response);
        if (jsonStr) {
            try {
                const parsed = JSON.parse(jsonStr);
                if (parsed.translations && Array.isArray(parsed.translations)) {
                    translations = parsed.translations;
                } else if (Array.isArray(parsed)) {
                    translations = parsed;
                }
            } catch (e2) {
                // Fall through to line-by-line parsing
            }
        }
    }

    // If JSON parsing worked, check if we need to remap IDs
    if (translations.length > 0) {
        // Clean up translations - remove any ID prefixes from the text
        translations = translations.map(t => ({
            ...t,
            text: cleanTranslationText(t.text)
        }));

        // Check if LLM returned sequential IDs (0, 1, 2...) instead of our IDs
        const llmIds = translations.map(t => t.id);
        const ourIds = originalItems.map(t => t.id);
        const llmUsedSequential = llmIds.every((id, i) => id === i);
        const idsMismatch = !llmIds.some(id => ourIds.includes(id));

        if (llmUsedSequential || idsMismatch) {
            // console.log('[Background] LLM used sequential IDs, remapping to original IDs');
            // Map sequential LLM IDs to our original IDs
            translations = translations.map((t, index) => ({
                id: originalItems[index]?.id ?? t.id,
                text: t.text,
                error: t.error
            }));
        }

        return translations;
    }

    // Single item: the entire response is one translation (preserve newlines)
    if (expectedCount === 1) {
        let text = response.trim().replace(/^\[?\d+\]?:\s*/, '');
        return [{ id: originalItems[0].id, text: cleanTranslationText(text) }];
    }

    // Fallback: parse by [id]: markers, grouping continuation lines per segment
    const idMarkerRegex = /^\[?(\d+)\]?:\s*(.*)$/;
    const segments = [];
    let current = null;

    for (const line of response.split('\n')) {
        const match = line.match(idMarkerRegex);
        if (match) {
            if (current) segments.push(current);
            current = { id: parseInt(match[1]), text: match[2] };
        } else if (current) {
            current.text += '\n' + line;
        }
    }
    if (current) segments.push(current);

    if (segments.length > 0) {
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            const text = seg.text.trim();
            if (!text) continue;
            const isOurId = originalItems.some(item => item.id === seg.id);
            translations.push({
                id: isOurId ? seg.id : (originalItems[i]?.id ?? seg.id),
                text: cleanTranslationText(text)
            });
        }
        return translations;
    }

    // Last resort: no markers found, one line = one translation
    for (let i = 0; i < Math.min(response.split('\n').filter(l => l.trim()).length, expectedCount); i++) {
        const line = response.split('\n').filter(l => l.trim())[i];
        const originalId = originalItems[i]?.id;
        if (originalId !== undefined) translations.push({ id: originalId, text: cleanTranslationText(line.trim()) });
    }
    return translations;
}

async function autoDetectAndSelectModel() {
    try {
        const settings = await getSettings();
        if (settings.selectedModel) return null; // already configured

        const models = await listModels(settings, false); // force fresh fetch
        if (models.length === 0) return null;

        // Prefer a translation-specialized model if one is loaded, else first available.
        // The request format is derived from the model automatically (requestFormat: 'auto'),
        // so we only need to pick the model and provider here.
        const preferred = models.find(m => detectRequestFormat(m.id) !== 'default') || models[0];

        await saveSettings({
            selectedModel: preferred.id,
            provider: preferred.provider
        });
        console.log(`[Background] Auto-selected model: ${preferred.id} (${preferred.provider})`);
        return preferred;
    } catch (e) {
        console.warn('[Background] Auto model detection failed:', e.message);
        return null;
    }
}

async function detectModelProvider(modelId, settings) {
    // Use cached models to avoid extra API calls
    const models = await listModels(settings, true);
    const model = models.find(m => m.id === modelId);
    return model ? model.provider : null;
}

// PLAIN_TEXT_FORMATS comes from languages.js (shared with the UIs).

async function callOllama(settings, modelId, systemPrompt, userPrompt, jsonOutput) {
    const body = {
        model: modelId,
        stream: false
    };

    // Request a schema-constrained JSON object when the caller wants structure.
    // Passing the full schema (not just 'json') makes Ollama enforce the shape,
    // not just valid-JSON-ness.
    if (jsonOutput) {
        body.format = TRANSLATION_JSON_SCHEMA;
    }

    body.prompt = systemPrompt ? `${systemPrompt}\n\n${userPrompt}` : userPrompt;
    body.keep_alive = '30m';
    body.options = {};
    if (settings.temperature !== undefined) body.options.temperature = settings.temperature;
    if (settings.numCtx) body.options.num_ctx = settings.numCtx;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300000);
    let response;
    try {
        response = await fetch(`${settings.ollamaUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });
    } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') throw new Error('Ollama request timed out after 5 minutes');
        throw e;
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
        if (response.status === 403) {
            throw new Error('Ollama returned 403 Forbidden. The extension is being blocked by Ollama\'s CORS policy. You need to enable CORS in Ollama.');
        }
        const error = await response.text();
        throw new Error(`Ollama error (${response.status}): ${error || '(empty response)'}`);
    }

    const data = await response.json();
    debugLog(`[Background] callOllama: response length=${data.response?.length || 0}`);
    return data.response;
}



// JSON schema for the batched translation response. The inner shape is shared:
// Ollama wants the bare schema in `format`, LMStudio/OpenAI want it wrapped.
const TRANSLATION_JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "translations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer" },
                    "text": { "type": "string" }
                },
                "required": ["id", "text"],
                "additionalProperties": false
            }
        }
    },
    "required": ["translations"],
    "additionalProperties": false
};
async function callLMStudio(settings, modelId, systemPrompt, userPrompt, jsonOutput) {
    const messages = [];

    if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: userPrompt });

    const body = {
        model: modelId,
        messages,
        temperature: settings.temperature || 0.3,
        stream: false
    };

    if (jsonOutput) {
        body.response_format = {
            "type": "json_schema",
            "json_schema": {
                "name": "translation_response",
                "strict": true,
                "schema": TRANSLATION_JSON_SCHEMA
            }
        };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300000);
    let response;
    try {
        response = await fetch(`${settings.lmstudioUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });
    } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') throw new Error('LMStudio request timed out after 5 minutes');
        if (e instanceof TypeError) {
            throw new Error('Failed to connect to LMStudio. The extension is being blocked by LMStudio\'s CORS policy or the server is offline. You need to enable CORS in LMStudio.');
        }
        throw e;
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`LMStudio error: ${error}`);
    }

    const data = await response.json();
    let content = data.choices[0]?.message?.content || '';

    // Clean up markdown code blocks if present
    content = content.replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/\s*```$/, '');

    return content;
}

// Low-level call to whichever provider, returning the raw text response.
async function callProvider(provider, settings, modelId, systemPrompt, userPrompt, jsonOutput) {
    if (provider === 'ollama') {
        return callOllama(settings, modelId, systemPrompt, userPrompt, jsonOutput);
    }
    return callLMStudio(settings, modelId, systemPrompt, userPrompt, jsonOutput);
}

// Translate a single text as plain text (no JSON), used as the last-resort
// fallback when structured output keeps failing. The whole response IS the
// translation — nothing to parse, nothing to break the page.
async function translatePlainItem(provider, settings, modelId, text, vars) {
    const systemPrompt = `You are a professional translator. Translate the user's text into ${vars.targetLang}. Output ONLY the translation, with no quotes, labels, JSON, or commentary.`;
    const userPrompt = text;
    const raw = await callProvider(provider, settings, modelId, systemPrompt, userPrompt, false);
    return cleanTranslationText((raw || '').trim());
}

// Small fast non-cryptographic string hash (cyrb53). Folds the prompt shape
// (templates + sampling params) into a compact token for the cache key without
// bloating it with the full template text.
function hashString(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

async function translate(textItems, targetLanguage, settings) {
    const modelId = settings.selectedModel;
    if (!modelId) throw new Error('No model selected');

    // Detect provider if auto
    let provider = settings.provider;
    if (provider === 'auto') {
        provider = await detectModelProvider(modelId, settings);
        if (!provider) throw new Error('Could not detect model provider');
    }

    // Resolve the effective request format ('auto' -> derived from the model).
    const format = resolveRequestFormat(settings, modelId);
    const isPlainText = PLAIN_TEXT_FORMATS.has(format);
    const template = PROMPT_TEMPLATES[format] || PROMPT_TEMPLATES.default;

    // Use custom prompts if advanced mode is enabled
    let systemTemplate = template.system;
    let userTemplate = template.user;
    if (settings.useAdvanced) {
        if (settings.customSystemPrompt) systemTemplate = settings.customSystemPrompt;
        if (settings.customUserPromptTemplate) userTemplate = settings.customUserPromptTemplate;
    }

    // Template variables shared across attempts
    const targetLangName = getLanguageName(targetLanguage);
    const sourceLangCode = (settings.sourceLanguage && settings.sourceLanguage !== 'auto')
        ? settings.sourceLanguage
        : 'en';
    const baseVars = {
        targetLanguage: targetLangName,
        sourceLang: getLanguageName(sourceLangCode),
        sourceCode: sourceLangCode.toUpperCase(),
        targetLang: targetLangName,
        targetCode: targetLanguage.toUpperCase()
    };

    // Whether to request schema-constrained JSON for this (structured) format.
    const wantJson = !!settings.useStructuredOutput && !isPlainText;

    // Run one batched request for the given subset of items, returning a Map of
    // id -> good translation text (suspicious/empty results are dropped).
    const requestBatch = async (items) => {
        // Map items to 0-indexed sequential IDs for the prompt to avoid confusing the LLM
        const mappedItems = items.map((item, index) => ({ id: index, text: item.text, originalId: item.id }));
        
        const vars = { ...baseVars, texts: formatTextsForPrompt(mappedItems) };
        let userPrompt = buildPrompt(userTemplate, vars);
        const systemPrompt = buildPrompt(systemTemplate, vars);

        // Prepend matching glossary terms so the model keeps proper nouns
        // consistent. Empty when the glossary is off/unmatched (prompt unchanged).
        const glossaryBlock = await buildGlossaryBlock(settings, mappedItems.map(m => m.text).join('\n'));
        if (glossaryBlock) userPrompt = `${glossaryBlock}\n\n${userPrompt}`;
        const raw = await callProvider(provider, settings, modelId, systemPrompt, userPrompt, wantJson);
        debugLog(`[Background] Raw LLM response (first 300 chars):`, (raw || '').substring(0, 300));
        
        // Parse using the mapped items so it expects 0, 1, 2...
        const parsed = parseTranslationResponse(raw, mappedItems);
        const good = new Map();
        for (const t of parsed) {
            if (t && t.text && !t.error && !isSuspiciousTranslation(t.text)) {
                // Find the original item to get its real ID
                const originalItem = mappedItems.find(m => m.id === t.id);
                if (originalItem) {
                    good.set(originalItem.originalId, t.text);
                }
            }
        }
        return good;
    };

    const results = new Map();          // originalId -> final translated text

    // ---- Cache + de-duplication --------------------------------------------
    // Group items by a key capturing everything that determines the model output
    // (model, languages, prompt shape/params) plus the source text, so each unique
    // string is translated once and identical strings reuse the result across
    // batches, pages, and sessions. promptSig folds in the resolved prompt
    // templates + structured-output mode + temperature so changing any of them
    // doesn't serve stale output. When the cache is off/unavailable we key by raw
    // text, which still de-dups within the request. cacheKey/cache* come from cache.js.
    const cacheEnabled = settings.cacheMode !== 'off'
        && typeof cacheGetMany === 'function' && typeof cacheKey === 'function';
    const promptSig = hashString([
        format, wantJson ? 'json' : 'plain', String(settings.temperature),
        systemTemplate, userTemplate
    ].join('\u0000'));
    const keyFor = cacheEnabled
        ? (text) => cacheKey(modelId, sourceLangCode, targetLanguage, promptSig, text)
        : (text) => text;

    // key -> { key, item: representative, ids: [every originalId sharing this text] }
    const groups = new Map();
    for (const item of textItems) {
        const k = keyFor(item.text);
        const g = groups.get(k);
        if (g) g.ids.push(item.id);
        else groups.set(k, { key: k, item, ids: [item.id] });
    }

    // Whole-segment glossary matches resolve deterministically, before the cache
    // and the model — the user's explicit mapping beats both a cached LLM answer
    // and a fresh one. Not written to the cache (the lookup is cheaper than it).
    let glossaryExactCount = 0;
    const exactIndex = await getGlossaryExactIndex(settings);
    if (exactIndex) {
        for (const g of groups.values()) {
            const direct = exactIndex.get(g.item.text.trim());
            if (direct !== undefined) {
                results.set(g.item.id, direct);
                glossaryExactCount++;
            }
        }
        if (glossaryExactCount) {
            debugLog(`[Background] glossary: ${glossaryExactCount} whole-segment match(es) resolved without the model`);
        }
    }
    const unresolvedGroups = glossaryExactCount
        ? [...groups.values()].filter(g => !results.has(g.item.id))
        : [...groups.values()];

    // Serve cache hits up front; only unresolved groups go to the model.
    let cacheHitCount = 0;      // unique source strings served from cache
    let fromCacheItems = 0;     // text elements served from cache (incl. duplicates)
    let missGroups;
    if (cacheEnabled) {
        try {
            const found = await cacheGetMany(unresolvedGroups.map(g => g.key));
            missGroups = [];
            for (const g of unresolvedGroups) {
                const cached = found.get(g.key);
                if (cached !== undefined) {
                    results.set(g.item.id, cached);
                    cacheHitCount++;
                    fromCacheItems += g.ids.length;
                } else {
                    missGroups.push(g);
                }
            }
        } catch (e) {
            debugWarn('[Background] cache read failed, translating all:', e && e.message);
            missGroups = unresolvedGroups;
        }
    } else {
        missGroups = unresolvedGroups;
    }
    debugLog(`[Background] cache: ${cacheHitCount} hit / ${missGroups.length} miss (${groups.size} unique of ${textItems.length} total)`);

    let pending = missGroups.map(g => g.item);   // representative item per unresolved group

    // Attempt the batched request, retrying only the items that came back
    // missing or malformed. maxOutputRetries extra attempts after the first.
    const maxRetries = Number.isInteger(settings.maxOutputRetries) ? settings.maxOutputRetries : 2;
    debugLog(`[Background] translate: provider=${provider} model=${modelId} format=${format} items=${textItems.length} json=${wantJson}`);
    for (let attempt = 0; attempt <= maxRetries && pending.length > 0; attempt++) {
        let good;
        try {
            good = await requestBatch(pending);
        } catch (e) {
            if (attempt === maxRetries) throw e; // bubble transport errors on last try
            debugWarn(`[Background] batch attempt ${attempt + 1} threw:`, e.message);
            continue;
        }
        for (const item of pending) {
            const text = good.get(item.id);
            if (text !== undefined) results.set(item.id, text);
        }
        pending = pending.filter(item => !results.has(item.id));
        if (pending.length) {
            debugWarn(`[Background] ${pending.length} item(s) malformed/missing after attempt ${attempt + 1}`);
        }
    }

    // Plain-text fallback: translate the still-failing items one-by-one with no
    // structure to parse. Only for JSON-style formats (plain formats already are).
    if (pending.length > 0 && !isPlainText && settings.plainTextFallback !== false) {
        debugWarn(`[Background] Falling back to plain-text translation for ${pending.length} item(s)`);
        for (const item of pending) {
            try {
                const text = await translatePlainItem(provider, settings, modelId, item.text, baseVars);
                if (text && !isSuspiciousTranslation(text)) results.set(item.id, text);
            } catch (e) {
                debugWarn(`[Background] plain-text fallback failed for id ${item.id}:`, e.message);
            }
        }
    }

    // Persist freshly produced translations. Awaited so an MV3 service worker
    // isn't torn down before the IndexedDB write commits.
    if (cacheEnabled) {
        const entries = [];
        for (const g of missGroups) {
            if (results.has(g.item.id)) entries.push([g.key, results.get(g.item.id)]);
        }
        if (entries.length) {
            try { await cacheSetMany(entries); }
            catch (e) { debugWarn('[Background] cache write failed:', e && e.message); }
        }
    }

    // Fan each group's translation out to every member sharing its source text.
    for (const g of groups.values()) {
        if (!results.has(g.item.id)) continue;
        const text = results.get(g.item.id);
        for (const id of g.ids) results.set(id, text);
    }

    // Build the final array in original order. Items that never succeeded are
    // returned with an error so the content script keeps their original text.
    const translations = textItems.map(item => results.has(item.id)
        ? { id: item.id, text: results.get(item.id) }
        : { id: item.id, error: 'translation failed' });
    return { translations, fromCache: fromCacheItems, total: textItems.length, cacheActive: cacheEnabled };
}

// ============================================================================
// Message Handler
// ============================================================================

browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // console.log('[Background] Received message:', message.type);

    (async () => {
        try {
            const settings = await getSettings();

            switch (message.type) {
                case 'GET_SETTINGS':
                    sendResponse({ settings });
                    break;

                case 'SAVE_SETTINGS':
                    const saved = await saveSettings(message.settings);
                    sendResponse({ settings: saved });
                    break;

                case 'DETECT_PROVIDERS':
                    const providers = await detectProviders(
                        settings.ollamaUrl,
                        settings.lmstudioUrl
                    );
                    sendResponse(providers);
                    break;

                case 'LIST_MODELS':
                    // Pass forceRefresh to bypass cache when user clicks refresh
                    const models = await listModels(settings, !message.forceRefresh);
                    sendResponse({ models });
                    break;

                case 'REGISTER_CONTENT_SCRIPT':
                    try {
                        await browserAPI.scripting.registerContentScripts([{
                            id: 'llm-translator-content',
                            matches: ['http://*/*', 'https://*/*'],
                            js: ['content.js'],
                            runAt: 'document_idle'
                        }]);
                    } catch (e) {
                        // Already registered — not an error
                    }
                    sendResponse({ ok: true });
                    break;

                case 'UNREGISTER_CONTENT_SCRIPT':
                    try {
                        await browserAPI.scripting.unregisterContentScripts({ ids: ['llm-translator-content'] });
                    } catch (e) {
                        // Not registered — not an error
                    }
                    sendResponse({ ok: true });
                    break;

                case 'TRANSLATE':
                    // Pass sourceLanguage for TranslateGemma support
                    let settingsWithSource = {
                        ...settings,
                        sourceLanguage: message.sourceLanguage || settings.sourceLanguage || 'en'
                    };

                    // WARNING LOG: Check if source language is missing or 'auto'
                    if (!settingsWithSource.sourceLanguage || settingsWithSource.sourceLanguage === 'auto') {
                        console.warn('[Background] WARNING: Source language is "auto" or missing. Some models (like TranslateGemma) require a specific source language code to function correctly.');
                    }

                    // Auto-detect model if none selected (e.g. fresh install, providers not ready at install time)
                    if (!settingsWithSource.selectedModel) {
                        await autoDetectAndSelectModel();
                        const refreshed = await getSettings();
                        settingsWithSource = {
                            ...settingsWithSource,
                            selectedModel: refreshed.selectedModel,
                            provider: refreshed.provider,
                            requestFormat: refreshed.requestFormat
                        };
                    }

                    const result = await translate(
                        message.texts,
                        message.targetLanguage,
                        settingsWithSource
                    );
                    sendResponse({
                        translations: result.translations,
                        fromCache: result.fromCache,
                        total: result.total,
                        cacheActive: result.cacheActive
                    });
                    break;

                case 'CLEAR_CACHE':
                    try {
                        await cacheClear();
                        sendResponse({ ok: true });
                    } catch (e) {
                        sendResponse({ ok: false, error: e && e.message });
                    }
                    break;

                case 'CACHE_COUNT':
                    try {
                        sendResponse({ count: await cacheCount() });
                    } catch (e) {
                        sendResponse({ count: 0, error: e && e.message });
                    }
                    break;

                case 'CACHE_BACKEND':
                    try {
                        sendResponse({ persistent: await cachePersistentAvailable() });
                    } catch (e) {
                        sendResponse({ persistent: false, error: e && e.message });
                    }
                    break;

                case 'SAVE_GLOSSARY': {
                    // entries: Array<[source, target]> already parsed by the options page.
                    const entries = Array.isArray(message.entries) ? message.entries : [];
                    const meta = {
                        name: typeof message.name === 'string' ? message.name : '',
                        loadedAt: Date.now()
                    };
                    await browserAPI.storage.local.set({ [GLOSSARY_KEY]: entries, [GLOSSARY_META_KEY]: meta });
                    invalidateGlossary();
                    // Glossary changes the output for the same source text — drop stale cache.
                    if (typeof cacheClear === 'function') await cacheClear();
                    sendResponse({ ok: true, count: entries.length });
                    break;
                }

                case 'GET_GLOSSARY_INFO': {
                    const entries = await loadGlossary();
                    let meta = null;
                    try {
                        const result = await browserAPI.storage.local.get(GLOSSARY_META_KEY);
                        meta = result[GLOSSARY_META_KEY] || null;
                    } catch (e) { /* meta is cosmetic — count/preview still work */ }
                    sendResponse({
                        count: entries.length,
                        name: meta && meta.name || '',
                        loadedAt: meta && meta.loadedAt || null,
                        // First rows only: enough to eyeball the dictionary without
                        // shipping tens of thousands of pairs to the options page.
                        preview: entries.slice(0, GLOSSARY_PREVIEW_MAX)
                    });
                    break;
                }

                case 'CLEAR_GLOSSARY':
                    await browserAPI.storage.local.remove([GLOSSARY_KEY, GLOSSARY_META_KEY]);
                    invalidateGlossary();
                    if (typeof cacheClear === 'function') await cacheClear();
                    sendResponse({ ok: true });
                    break;

                default:
                    sendResponse({ error: 'Unknown message type' });
            }
        } catch (e) {
            console.error('[Background] Error:', e);
            sendResponse({ error: e.message });
        }
    })();

    return true; // Keep the message channel open for async response
});

// On browser startup, wipe the translation cache if the user chose the
// 'session' mode (keep until the browser closes). onStartup fires when the
// profile launches but not on extension reload/update, so within-session
// worker restarts don't lose the cache — only a real browser restart does.
browserAPI.runtime.onStartup.addListener(async () => {
    try {
        const settings = await getSettings();
        if (settings.cacheMode === 'session' && typeof cacheClear === 'function') {
            await cacheClear();
        }
    } catch (e) {
        // Best-effort; a failed clear just leaves the previous session's cache.
    }
});

// ============================================================================
// Context Menu
// ============================================================================

browserAPI.runtime.onInstalled.addListener(async () => {
    browserAPI.contextMenus.create({
        id: "translate-page",
        title: "Translate Page",
        contexts: ["page"]
    }, () => { if (browserAPI.runtime.lastError) {} });

    browserAPI.contextMenus.create({
        id: "translate-selection",
        title: "Translate Selection",
        contexts: ["selection"]
    }, () => { if (browserAPI.runtime.lastError) {} });

    // Auto-detect and select a model on fresh install (when none is configured yet)
    await autoDetectAndSelectModel();

    // Re-register content script auto-injection if the user had the floating button enabled.
    // registerContentScripts() registrations are cleared on extension update/reinstall.
    const settings = await getSettings();
    if (settings.floatingButton) {
        try {
            await browserAPI.scripting.registerContentScripts([{
                id: 'llm-translator-content',
                matches: ['http://*/*', 'https://*/*'],
                js: ['content.js'],
                runAt: 'document_idle'
            }]);
        } catch (e) {
            // Already registered (e.g. fresh install where registration survived)
        }
    }
});

browserAPI.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "translate-page") {
        if (!tab || !tab.id) return;

        try {
            const settings = await getSettings();

            // Resolve source language - if 'auto', try to detect it programmatically
            let sourceLang = settings.sourceLanguage;
            if (!sourceLang || sourceLang === 'auto') {
                try {
                    const result = await browserAPI.scripting.executeScript({
                        target: { tabId: tab.id },
                        func: () => {
                            const htmlLang = document.documentElement.lang || document.querySelector('html')?.getAttribute('lang');
                            if (htmlLang) return htmlLang.split('-')[0].toLowerCase();
                            const metaLang = document.querySelector('meta[http-equiv="content-language"]')?.getAttribute('content');
                            if (metaLang) return metaLang.split('-')[0].toLowerCase();
                            return null;
                        }
                    });
                    if (result && result[0] && result[0].result) {
                        sourceLang = result[0].result;
                        console.log(`[Background] Detected page language for context menu: ${sourceLang}`);
                    }
                } catch (detectErr) {
                    console.log('[Background] Could not detect language from background:', detectErr);
                }
            }

            // Helper to send message
            const sendTranslationMessage = async () => {
                await browserAPI.tabs.sendMessage(tab.id, {
                    type: 'START_TRANSLATION',
                    targetLanguage: settings.targetLanguage,
                    sourceLanguage: sourceLang || 'auto', // Use detected or fall back to auto
                    showGlow: settings.showGlow,
                    maxConcurrentRequests: settings.maxConcurrentRequests || 4
                });
            };

            try {
                await sendTranslationMessage();
            } catch (e) {
                console.log('[Background] Initial translation connection failed, attempting injection:', e);

                // If message failed, content script might not be loaded. Inject it.
                await browserAPI.scripting.executeScript({
                    target: { tabId: tab.id },
                    files: ['content.js']
                });

                // Wait briefly for script to initialize
                await new Promise(resolve => setTimeout(resolve, 200));

                // Retry message
                await sendTranslationMessage();
            }

        } catch (e) {
            console.error('[Background] Context menu translation failed:', e);
        }
    } else if (info.menuItemId === "translate-selection") {
        if (!tab || !tab.id) return;

        try {
            const settings = await getSettings();

            let sourceLang = settings.sourceLanguage;
            if (!sourceLang || sourceLang === 'auto') {
                try {
                    const result = await browserAPI.scripting.executeScript({
                        target: { tabId: tab.id },
                        func: () => {
                            const htmlLang = document.documentElement.lang || document.querySelector('html')?.getAttribute('lang');
                            if (htmlLang) return htmlLang.split('-')[0].toLowerCase();
                            const metaLang = document.querySelector('meta[http-equiv="content-language"]')?.getAttribute('content');
                            if (metaLang) return metaLang.split('-')[0].toLowerCase();
                            return null;
                        }
                    });
                    if (result?.[0]?.result) sourceLang = result[0].result;
                } catch (detectErr) { /* ignore */ }
            }

            const sendSelectionMessage = async () => {
                await browserAPI.tabs.sendMessage(tab.id, {
                    type: 'TRANSLATE_SELECTION',
                    targetLanguage: settings.targetLanguage,
                    sourceLanguage: sourceLang || 'auto',
                    showGlow: settings.showGlow,
                    maxConcurrentRequests: settings.maxConcurrentRequests || 4
                });
            };

            try {
                await sendSelectionMessage();
            } catch (e) {
                await browserAPI.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
                await new Promise(resolve => setTimeout(resolve, 200));
                await sendSelectionMessage();
            }

        } catch (e) {
            console.error('[Background] Context menu selection translation failed:', e);
        }
    }
});

// Initialize settings on startup
loadSettings().then(() => {
    console.log('[Background] Local LLM Translator background script loaded');
});

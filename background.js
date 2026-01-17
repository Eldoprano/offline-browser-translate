/**
 * Background Script for Local LLM Translator
 * Handles LLM API calls, settings storage, and message routing
 */

// Use browser API with chrome fallback
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Import languages
// Import languages (for Service Worker context)
if (typeof importScripts === 'function') {
    importScripts('languages.js');
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
    useAdvanced: false,
    customSystemPrompt: '',
    customUserPromptTemplate: '',
    requestFormat: 'default', // 'default', 'translategemma', 'hunyuan', 'simple', 'custom'
    temperature: 0.3,
    useStructuredOutput: true,
    showGlow: false  // Disabled by default
};



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
        return cachedSettings;
    } catch (e) {
        console.error('Failed to load settings:', e);
        cachedSettings = { ...DEFAULT_SETTINGS };
        return cachedSettings;
    }
}

async function saveSettings(settings) {
    cachedSettings = { ...DEFAULT_SETTINGS, ...settings };
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
// Provider Detection & Model Listing
// ============================================================================

async function detectProviders(ollamaUrl, lmstudioUrl) {
    const results = { ollama: false, lmstudio: false };

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
        results.ollama = false;
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
        results.lmstudio = false;
    }

    return results;
}

async function listOllamaModels(url) {
    const response = await fetch(`${url}/api/tags`);
    if (!response.ok) throw new Error('Failed to fetch Ollama models');
    const data = await response.json();
    return (data.models || []).map(m => ({
        id: m.name,
        name: m.name,
        provider: 'ollama'
    }));
}

async function listLMStudioModels(url) {
    const response = await fetch(`${url}/v1/models`);
    if (!response.ok) throw new Error('Failed to fetch LMStudio models');
    const data = await response.json();
    return (data.data || []).map(m => ({
        id: m.id,
        name: m.id,
        provider: 'lmstudio'
    }));
}

async function listModels(settings, useCache = true) {
    // Return cached models if available and not expired
    if (useCache && cachedModels && (Date.now() - modelsCacheTime < MODEL_CACHE_TTL)) {
        return cachedModels;
    }

    const models = [];
    const provider = settings.provider;

    if (provider === 'ollama' || provider === 'auto') {
        try {
            const ollamaModels = await listOllamaModels(settings.ollamaUrl);
            models.push(...ollamaModels);
        } catch (e) {
            if (provider === 'ollama') throw e;
        }
    }

    if (provider === 'lmstudio' || provider === 'auto') {
        try {
            const lmstudioModels = await listLMStudioModels(settings.lmstudioUrl);
            models.push(...lmstudioModels);
        } catch (e) {
            if (provider === 'lmstudio') throw e;
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

// Clean translation text - remove ID prefixes and HTML garbage that LLM might include
function cleanTranslationText(text) {
    if (!text) return text;
    // Remove patterns like "[99]: ", "[99]:", "99: ", "99:" at start of text
    let cleaned = text.replace(/^\[?\d+\]?:\s*/g, '');
    // Remove HTML tags that might leak through (like </div>, <span>, etc.)
    cleaned = cleaned.replace(/<\/?[a-z][a-z0-9]*[^>]*>/gi, '');
    // Remove multiple spaces
    cleaned = cleaned.replace(/\s+/g, ' ');
    return cleaned.trim();
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
        // Try to extract JSON from response
        const jsonMatch = response.match(/\{[\s\S]*"translations"[\s\S]*\}/);
        if (jsonMatch) {
            try {
                const parsed = JSON.parse(jsonMatch[0]);
                if (parsed.translations) {
                    translations = parsed.translations;
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
            console.log('[Background] LLM used sequential IDs, remapping to original IDs');
            // Map sequential LLM IDs to our original IDs
            translations = translations.map((t, index) => ({
                id: originalItems[index]?.id ?? t.id,
                text: t.text,
                error: t.error
            }));
        }

        return translations;
    }

    // Fallback: parse line-by-line format using ORIGINAL item IDs
    console.log('[Background] Using fallback line-by-line parsing');
    const lines = response.split('\n').filter(l => l.trim());

    for (let i = 0; i < Math.min(lines.length, expectedCount); i++) {
        const line = lines[i];
        // Try to extract ID from line like "[4]: translated text" or "4: translated text"
        const match = line.match(/^\[?(\d+)\]?:\s*(.+)$/);
        if (match) {
            const parsedId = parseInt(match[1]);
            // Check if this ID is in our original items
            const isOurId = originalItems.some(item => item.id === parsedId);
            if (isOurId) {
                translations.push({ id: parsedId, text: match[2].trim() });
            } else {
                // LLM used sequential ID, map to our ID
                translations.push({ id: originalItems[i]?.id, text: match[2].trim() });
            }
        } else {
            // Use the ORIGINAL item's ID
            const originalId = originalItems[i]?.id;
            if (originalId !== undefined) {
                translations.push({ id: originalId, text: line.trim() });
            }
        }
    }

    console.log(`[Background] Fallback parsed ${translations.length} translations`);
    return translations;
}

async function detectModelProvider(modelId, settings) {
    // Use cached models to avoid extra API calls
    const models = await listModels(settings, true);
    const model = models.find(m => m.id === modelId);
    return model ? model.provider : null;
}

async function callOllama(settings, modelId, systemPrompt, userPrompt) {
    const body = {
        model: modelId,
        stream: false
    };

    if (settings.useStructuredOutput) {
        body.format = 'json';
    }

    body.prompt = systemPrompt ? `${systemPrompt}\n\n${userPrompt}` : userPrompt;

    if (settings.temperature !== undefined) {
        body.options = { temperature: settings.temperature };
    }

    const response = await fetch(`${settings.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Ollama error: ${error}`);
    }

    const data = await response.json();
    return data.response;
}



const TRANSLATION_SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "translation_response",
        "strict": true,
        "schema": {
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
        }
    }
};

async function callLMStudio(settings, modelId, systemPrompt, userPrompt) {
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

    if (settings.useStructuredOutput) {
        body.response_format = TRANSLATION_SCHEMA;
    }

    const response = await fetch(`${settings.lmstudioUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

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

async function translate(textItems, targetLanguage, settings) {
    const modelId = settings.selectedModel;
    if (!modelId) throw new Error('No model selected');

    // Detect provider if auto
    let provider = settings.provider;
    if (provider === 'auto') {
        provider = await detectModelProvider(modelId, settings);
        if (!provider) throw new Error('Could not detect model provider');
    }

    // Get prompt template
    const templateKey = settings.requestFormat || 'default';
    const template = PROMPT_TEMPLATES[templateKey] || PROMPT_TEMPLATES.default;

    // Use custom prompts if advanced mode is enabled
    let systemPrompt = template.system;
    let userPromptTemplate = template.user;

    if (settings.useAdvanced) {
        if (settings.customSystemPrompt) {
            systemPrompt = settings.customSystemPrompt;
        }
        if (settings.customUserPromptTemplate) {
            userPromptTemplate = settings.customUserPromptTemplate;
        }
    }

    // Build prompts
    const textsFormatted = formatTextsForPrompt(textItems);

    // Prepare variables for template substitution
    const targetLangName = getLanguageName(targetLanguage);
    const targetLangCode = targetLanguage.toUpperCase();

    // Source language handling (for TranslateGemma)
    // Settings.sourceLanguage is already populated from the message handler
    let sourceLangCode = (settings.sourceLanguage && settings.sourceLanguage !== 'auto')
        ? settings.sourceLanguage
        : 'en';
    let sourceLangName = getLanguageName(sourceLangCode);

    // Build template variables
    const templateVars = {
        targetLanguage: targetLangName,
        texts: textsFormatted,
        // TranslateGemma-specific variables
        sourceLang: sourceLangName,
        sourceCode: sourceLangCode.toUpperCase(),
        targetLang: targetLangName,
        targetCode: targetLangCode
    };

    const userPrompt = buildPrompt(userPromptTemplate, templateVars);
    const finalSystemPrompt = buildPrompt(systemPrompt, templateVars);

    // Call the appropriate provider
    let response;
    if (provider === 'ollama') {
        response = await callOllama(settings, modelId, finalSystemPrompt, userPrompt);
    } else {
        response = await callLMStudio(settings, modelId, finalSystemPrompt, userPrompt);
    }

    console.log(`[Background] Raw LLM response (first 500 chars):`, response.substring(0, 500));
    console.log(`[Background] Sent ${textItems.length} items, IDs:`, textItems.map(t => t.id));

    // Parse response - pass original items so we can use their IDs in fallback
    return parseTranslationResponse(response, textItems);
}

// ============================================================================
// Message Handler
// ============================================================================

browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[Background] Received message:', message.type);

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
                    const models = await listModels(settings);
                    sendResponse({ models });
                    break;

                case 'TRANSLATE':
                    // Pass sourceLanguage for TranslateGemma support
                    const settingsWithSource = {
                        ...settings,
                        sourceLanguage: message.sourceLanguage || settings.sourceLanguage || 'en'
                    };

                    // WARNING LOG: Check if source language is missing or 'auto'
                    if (!settingsWithSource.sourceLanguage || settingsWithSource.sourceLanguage === 'auto') {
                        console.warn('[Background] WARNING: Source language is "auto" or missing. Some models (like TranslateGemma) require a specific source language code to function correctly.');
                    }

                    const translations = await translate(
                        message.texts,
                        message.targetLanguage,
                        settingsWithSource
                    );
                    sendResponse({ translations });
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

// ============================================================================
// Context Menu
// ============================================================================

browserAPI.runtime.onInstalled.addListener(() => {
    browserAPI.contextMenus.create({
        id: "translate-page",
        title: "Translate Page",
        contexts: ["page"]
    }, () => {
        // Ignore error if item already exists
        if (browserAPI.runtime.lastError) {
            // Suppress duplicate id error
        }
    });
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
                    showGlow: settings.showGlow
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
    }
});

// Initialize settings on startup
loadSettings().then(() => {
    console.log('[Background] Local LLM Translator background script loaded');
});

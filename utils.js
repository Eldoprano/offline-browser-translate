/**
 * Utility functions for the Local LLM Translator extension
 */

// Language codes and names
export const LANGUAGES = {
    en: 'English',
    es: 'Spanish',
    fr: 'French',
    de: 'German',
    it: 'Italian',
    pt: 'Portuguese',
    ru: 'Russian',
    zh: 'Chinese',
    ja: 'Japanese',
    ko: 'Korean',
    ar: 'Arabic',
    hi: 'Hindi',
    nl: 'Dutch',
    pl: 'Polish',
    tr: 'Turkish',
    vi: 'Vietnamese',
    th: 'Thai',
    sv: 'Swedish',
    da: 'Danish',
    fi: 'Finnish',
    no: 'Norwegian',
    cs: 'Czech',
    el: 'Greek',
    he: 'Hebrew',
    hu: 'Hungarian',
    id: 'Indonesian',
    ms: 'Malay',
    ro: 'Romanian',
    uk: 'Ukrainian'
};

// Default settings
export const DEFAULT_SETTINGS = {
    provider: 'auto', // 'auto', 'ollama', 'lmstudio'
    ollamaUrl: 'http://localhost:11434',
    lmstudioUrl: 'http://localhost:1234',
    selectedModel: '',
    targetLanguage: 'en',
    maxTokensPerBatch: 2000,
    // Advanced settings
    useAdvanced: false,
    customSystemPrompt: '',
    customUserPromptTemplate: '',
    requestFormat: 'default', // 'default', 'translategemma', 'hunyuan', 'custom'
    temperature: 0.3,
    useStructuredOutput: true
};

// Prompt templates for different model types
export const PROMPT_TEMPLATES = {
    default: {
        system: `You are a professional translator. Translate the given texts to {{targetLanguage}}. 
Respond ONLY with a JSON object in this exact format:
{"translations": [{"id": 0, "text": "translated text"}, {"id": 1, "text": "another translation"}]}
Maintain the original meaning, tone, and formatting. Do not add explanations.`,
        user: `Translate the following texts to {{targetLanguage}}:
{{texts}}`
    },
    hunyuan: {
        system: '',
        user: `Translate the following segment into {{targetLanguage}}, without additional explanation.
{{texts}}`
    },
    translategemma: {
        // TranslateGemma uses a special format: <translate source_lang>target_lang>: text
        system: '',
        user: `<translate>{{targetLanguage}}>: {{texts}}`
    }
};

/**
 * Estimate token count from text (rough approximation: ~4 chars per token)
 * @param {string} text 
 * @returns {number}
 */
export function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
}

/**
 * Batch texts into groups that fit within token limits
 * @param {Array<{id: number, text: string}>} textItems 
 * @param {number} maxTokens 
 * @returns {Array<Array<{id: number, text: string}>>}
 */
export function batchTexts(textItems, maxTokens = 2000) {
    const batches = [];
    let currentBatch = [];
    let currentTokens = 0;

    // Reserve tokens for prompt overhead
    const promptOverhead = 200;
    const effectiveMax = maxTokens - promptOverhead;

    for (const item of textItems) {
        const itemTokens = estimateTokens(item.text);

        // If single item exceeds limit, put it in its own batch
        if (itemTokens > effectiveMax) {
            if (currentBatch.length > 0) {
                batches.push(currentBatch);
                currentBatch = [];
                currentTokens = 0;
            }
            batches.push([item]);
            continue;
        }

        // Check if adding this item would exceed limit
        if (currentTokens + itemTokens > effectiveMax) {
            batches.push(currentBatch);
            currentBatch = [item];
            currentTokens = itemTokens;
        } else {
            currentBatch.push(item);
            currentTokens += itemTokens;
        }
    }

    // Don't forget the last batch
    if (currentBatch.length > 0) {
        batches.push(currentBatch);
    }

    return batches;
}

/**
 * Format texts for inclusion in prompt
 * @param {Array<{id: number, text: string}>} textItems 
 * @returns {string}
 */
export function formatTextsForPrompt(textItems) {
    return textItems.map(item => `[${item.id}]: ${item.text}`).join('\n');
}

/**
 * Build prompt from template
 * @param {string} template 
 * @param {object} vars 
 * @returns {string}
 */
export function buildPrompt(template, vars) {
    let result = template;
    for (const [key, value] of Object.entries(vars)) {
        result = result.replace(new RegExp(`{{${key}}}`, 'g'), value);
    }
    return result;
}

/**
 * Parse translation response
 * @param {string} response 
 * @param {number} expectedCount 
 * @returns {Array<{id: number, text: string}>}
 */
export function parseTranslationResponse(response, expectedCount) {
    try {
        // Try to parse as JSON first
        const parsed = JSON.parse(response);
        if (parsed.translations && Array.isArray(parsed.translations)) {
            return parsed.translations;
        }
        // Handle array format
        if (Array.isArray(parsed)) {
            return parsed;
        }
    } catch (e) {
        // Try to extract JSON from response
        const jsonMatch = response.match(/\{[\s\S]*"translations"[\s\S]*\}/);
        if (jsonMatch) {
            try {
                const parsed = JSON.parse(jsonMatch[0]);
                if (parsed.translations) {
                    return parsed.translations;
                }
            } catch (e2) {
                // Fall through to simple parsing
            }
        }
    }

    // Fallback: try to parse line-by-line format for non-JSON responses
    const lines = response.split('\n').filter(l => l.trim());
    const translations = [];

    for (let i = 0; i < Math.min(lines.length, expectedCount); i++) {
        const line = lines[i];
        // Try to match [id]: text format
        const match = line.match(/^\[?(\d+)\]?:\s*(.+)$/);
        if (match) {
            translations.push({ id: parseInt(match[1]), text: match[2].trim() });
        } else if (i < expectedCount) {
            // Just use the line as-is
            translations.push({ id: i, text: line.trim() });
        }
    }

    return translations;
}

/**
 * Detect available providers by checking their endpoints
 * @returns {Promise<{ollama: boolean, lmstudio: boolean}>}
 */
export async function detectProviders(ollamaUrl = 'http://localhost:11434', lmstudioUrl = 'http://localhost:1234') {
    const results = { ollama: false, lmstudio: false };

    try {
        const ollamaCheck = await fetch(`${ollamaUrl}/api/tags`, {
            method: 'GET',
            signal: AbortSignal.timeout(2000)
        });
        results.ollama = ollamaCheck.ok;
    } catch (e) {
        results.ollama = false;
    }

    try {
        const lmstudioCheck = await fetch(`${lmstudioUrl}/v1/models`, {
            method: 'GET',
            signal: AbortSignal.timeout(2000)
        });
        results.lmstudio = lmstudioCheck.ok;
    } catch (e) {
        results.lmstudio = false;
    }

    return results;
}

/**
 * Get language name from code
 * @param {string} code 
 * @returns {string}
 */
export function getLanguageName(code) {
    return LANGUAGES[code] || code;
}

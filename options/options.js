/**
 * Options Page Script for Local LLM Translator
 */

// Use browser API with chrome fallback for Firefox compatibility
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

const DEFAULT_SETTINGS = {
    provider: 'auto',
    ollamaUrl: 'http://localhost:11434',
    lmstudioUrl: 'http://localhost:1234',
    selectedModel: '',
    targetLanguage: 'en',
    sourceLanguage: 'auto',
    maxTokensPerBatch: 2000,
    maxItemsPerBatch: 8,
    maxConcurrentRequests: 4, // 1-4 parallel requests for LMStudio 0.4.0+
    useAdvanced: false,
    customSystemPrompt: '',
    customUserPromptTemplate: '',
    requestFormat: 'default',
    temperature: 0.3,
    useStructuredOutput: true,
    showGlow: false  // Disabled by default
};

// Format descriptions
const FORMAT_DESCRIPTIONS = {
    default: 'Standard JSON output format. Best for most models.',
    translategemma: 'Specialized format for TranslateGemma models.',
    hunyuan: 'Format optimized for Hunyuan-MT models. No system message.',
    simple: 'Simple line-by-line output for smaller models.',
    custom: 'Your custom prompts. Edit below.'
};

// Prompt templates for each format
const PROMPT_TEMPLATES = {
    default: {
        system: `You are a professional translator. Translate the given texts to {{targetLanguage}}. 
Respond ONLY with a JSON object in this exact format:
{"translations": [{"id": 0, "text": "translated text"}, {"id": 1, "text": "another translation"}]}
Maintain the original meaning, tone, and formatting. Do not add explanations.`,
        user: `Translate the following texts to {{targetLanguage}}:\n{{texts}}`
    },
    simple: {
        system: `You are a translator. Translate to {{targetLanguage}}. Output JSON only:
{"translations": [{"id": N, "text": "translation"}]}`,
        user: `Translate to {{targetLanguage}}:\n{{texts}}`
    },
    hunyuan: {
        system: '',
        user: `Translate the following segment into {{targetLanguage}}, without additional explanation.\n{{texts}}`
    },
    translategemma: {
        system: '',
        user: `You are a professional {{sourceLang}} ({{sourceCode}}) to {{targetLang}} ({{targetCode}}) translator. Your goal is to accurately convey the meaning and nuances of the original {{sourceLang}} text while adhering to {{targetLang}} grammar, vocabulary, and cultural sensitivities.
Produce only the {{targetLang}} translation, without any additional explanations or commentary. Please translate the following {{sourceLang}} text into {{targetLang}}:


{{texts}}`
    },
    custom: {
        system: '',
        user: ''
    }
};

// DOM Elements
const elements = {
    providerSelect: document.getElementById('providerSelect'),
    ollamaUrl: document.getElementById('ollamaUrl'),
    lmstudioUrl: document.getElementById('lmstudioUrl'),
    modelSelect: document.getElementById('modelSelect'),
    refreshModels: document.getElementById('refreshModels'),
    sourceLanguage: document.getElementById('sourceLanguage'),
    sourceLanguageGroup: document.getElementById('sourceLanguageGroup'),
    targetLanguage: document.getElementById('targetLanguage'),
    requestFormat: document.getElementById('requestFormat'),
    formatDescription: document.getElementById('formatDescription'),
    systemPrompt: document.getElementById('systemPrompt'),
    userPrompt: document.getElementById('userPrompt'),
    maxTokens: document.getElementById('maxTokens'),
    maxItems: document.getElementById('maxItems'),
    maxConcurrent: document.getElementById('maxConcurrent'),
    maxConcurrentValue: document.getElementById('maxConcurrentValue'),
    temperature: document.getElementById('temperature'),
    temperatureValue: document.getElementById('temperatureValue'),
    useStructuredOutput: document.getElementById('useStructuredOutput'),
    showGlow: document.getElementById('showGlow'),
    customPromptsSection: document.getElementById('customPromptsSection'),
    customSystem: document.getElementById('customSystem'),
    customUser: document.getElementById('customUser'),
    translateGemmaHelp: document.getElementById('translateGemmaHelp'),
    copyTemplate: document.getElementById('copyTemplate'),
    saveSettings: document.getElementById('saveSettings'),
    resetSettings: document.getElementById('resetSettings'),
    toast: document.getElementById('toast')
};

let currentSettings = { ...DEFAULT_SETTINGS };

// Highlight variables in text
function highlightVariables(text) {
    if (!text) return text;
    // Escape HTML first
    let escaped = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    // Wrap {{variable}} in span
    return escaped.replace(/(\{\{[a-zA-Z0-9_]+\}\})/g, '<span class="highlight-var">$1</span>');
}

// Sync textarea with backdrop for highlighting
function syncEditor(textareaId, backdropId) {
    const textarea = document.getElementById(textareaId);
    const backdrop = document.getElementById(backdropId);

    if (!textarea || !backdrop) return;

    const handleInput = () => {
        // Handle scroll first
        backdrop.scrollTop = textarea.scrollTop;

        let text = textarea.value;
        if (text[text.length - 1] === '\n') {
            text += ' ';
        }
        // Use DOMParser instead of innerHTML to avoid Firefox AMO warnings
        const parser = new DOMParser();
        const doc = parser.parseFromString('<div>' + highlightVariables(text) + '</div>', 'text/html');
        // Clear backdrop using DOM methods
        while (backdrop.firstChild) {
            backdrop.removeChild(backdrop.firstChild);
        }
        // Append parsed content
        const content = doc.body.firstChild;
        while (content.firstChild) {
            backdrop.appendChild(content.firstChild);
        }
    };

    textarea.addEventListener('input', handleInput);
    textarea.addEventListener('scroll', () => {
        backdrop.scrollTop = textarea.scrollTop;
    });

    handleInput();
}

// Initialize prompt editors
function initPromptEditors() {
    syncEditor('systemPrompt', 'systemPromptBackdrop');
    syncEditor('userPrompt', 'userPromptBackdrop');
}

// Initialize
async function init() {
    populateLanguageDropdowns();
    await loadSettings();
    applySettingsToUI();
    initPromptEditors(); // Initialize editors
    await loadModels();
    setupEventListeners();
}

// Load available models from providers
async function loadModels() {
    if (!elements.modelSelect) return;

    elements.modelSelect.innerHTML = '<option value="">Loading models...</option>';
    elements.modelSelect.disabled = true;
    try {
        const response = await browserAPI.runtime.sendMessage({ type: 'LIST_MODELS' });
        const models = response.models || [];

        elements.modelSelect.innerHTML = '';

        if (models.length === 0) {
            elements.modelSelect.innerHTML = '<option value="">No models found</option>';
        } else {
            for (const model of models) {
                const option = document.createElement('option');
                option.value = model.id;
                option.textContent = `${model.name} (${model.provider})`;
                option.dataset.provider = model.provider;
                elements.modelSelect.appendChild(option);
            }

            // Select current model if set
            if (currentSettings.selectedModel) {
                elements.modelSelect.value = currentSettings.selectedModel;
            }

            // Auto-configure format for the selected model
            autoSetFormatForModel(elements.modelSelect.value);
        }
    } catch (e) {
        console.error('Failed to load models:', e);
        elements.modelSelect.innerHTML = '<option value="">Error loading models</option>';
    } finally {
        elements.modelSelect.disabled = false;
    }
}

// Populate language dropdowns from LANGUAGES object
function populateLanguageDropdowns() {
    const sortedLangs = Object.entries(LANGUAGES).sort((a, b) => a[1].localeCompare(b[1]));

    // Source language dropdown - add "auto" option first
    elements.sourceLanguage.innerHTML = '<option value="auto">Auto-detect from page</option>';
    for (const [code, name] of sortedLangs) {
        const option = document.createElement('option');
        option.value = code;
        option.textContent = name;
        elements.sourceLanguage.appendChild(option);
    }

    // Target language dropdown
    elements.targetLanguage.innerHTML = '';
    for (const [code, name] of sortedLangs) {
        const option = document.createElement('option');
        option.value = code;
        option.textContent = name;
        elements.targetLanguage.appendChild(option);
    }
}

// Load settings from storage
async function loadSettings() {
    try {
        const response = await browserAPI.runtime.sendMessage({ type: 'GET_SETTINGS' });
        if (response.settings) {
            currentSettings = { ...DEFAULT_SETTINGS, ...response.settings };
        }
    } catch (e) {
        console.error('Failed to load settings:', e);
    }
}

// Apply settings to UI
function applySettingsToUI() {
    elements.providerSelect.value = currentSettings.provider;
    elements.ollamaUrl.value = currentSettings.ollamaUrl;
    elements.lmstudioUrl.value = currentSettings.lmstudioUrl;
    elements.sourceLanguage.value = currentSettings.sourceLanguage || 'auto';
    elements.targetLanguage.value = currentSettings.targetLanguage;
    elements.requestFormat.value = currentSettings.requestFormat;
    elements.maxTokens.value = currentSettings.maxTokensPerBatch;
    elements.maxItems.value = currentSettings.maxItemsPerBatch || 8;
    elements.temperature.value = currentSettings.temperature;
    elements.temperatureValue.textContent = currentSettings.temperature;
    // Parallel requests slider
    if (elements.maxConcurrent) {
        elements.maxConcurrent.value = currentSettings.maxConcurrentRequests || 4;
        if (elements.maxConcurrentValue) {
            elements.maxConcurrentValue.textContent = currentSettings.maxConcurrentRequests || 4;
        }
    }
    elements.useStructuredOutput.checked = currentSettings.useStructuredOutput;
    elements.showGlow.checked = currentSettings.showGlow !== false;
    elements.customSystem.value = currentSettings.customSystemPrompt || '';
    elements.customUser.value = currentSettings.customUserPromptTemplate || '';

    // Update format description
    updateFormatDescription(currentSettings.requestFormat);

    // Show/hide sections based on format
    updateVisibility();
}

// Update format description and prompt editor
function updateFormatDescription(format) {
    elements.formatDescription.textContent = FORMAT_DESCRIPTIONS[format] || '';

    // Populate prompt editor with format's template
    const template = PROMPT_TEMPLATES[format];
    if (template && elements.systemPrompt && elements.userPrompt) {
        // For custom format, use saved custom prompts
        if (format === 'custom') {
            elements.systemPrompt.value = currentSettings.customSystemPrompt || '';
            elements.userPrompt.value = currentSettings.customUserPromptTemplate || '';
        } else {
            elements.systemPrompt.value = template.system || '';
            elements.userPrompt.value = template.user || '';
        }

        // Trigger input event to update highlights
        elements.systemPrompt.dispatchEvent(new Event('input'));
        elements.userPrompt.dispatchEvent(new Event('input'));
    }
}

// Check if a model is a TranslateGemma model
function isTranslateGemmaModel(modelId) {
    if (!modelId) return false;
    const lowerName = modelId.toLowerCase();
    return lowerName.includes('translategemma') ||
        lowerName.includes('translate-gemma') ||
        lowerName.includes('translate_gemma');
}

// Automatically set format based on model type
function autoSetFormatForModel(modelId) {
    if (!modelId) return;

    const isTranslateGemma = isTranslateGemmaModel(modelId);

    if (isTranslateGemma) {
        if (elements.requestFormat.value !== 'translategemma') {
            elements.requestFormat.value = 'translategemma';
            updateFormatDescription('translategemma');
            updateVisibility();
            showToast('Automatically switched to TranslateGemma format');
        }
    } else {
        // If switching away from TranslateGemma model and format is still TranslateGemma,
        // switch back to default
        if (elements.requestFormat.value === 'translategemma') {
            elements.requestFormat.value = 'default';
            updateFormatDescription('default');
            updateVisibility();
        }
    }
}

// Update visibility of sections based on current settings
function updateVisibility() {
    const format = elements.requestFormat.value;
    const isTranslateGemmaFormat = format === 'translategemma';
    const modelId = elements.modelSelect?.value || currentSettings.selectedModel;
    const isTranslateGemmaModelSelected = isTranslateGemmaModel(modelId);

    // Custom prompts section
    elements.customPromptsSection.hidden = format !== 'custom';

    // TranslateGemma help - only show when BOTH format is translategemma AND model is translategemma
    elements.translateGemmaHelp.hidden = !(isTranslateGemmaFormat && isTranslateGemmaModelSelected);

    // Source language only needed for TranslateGemma format
    if (elements.sourceLanguageGroup) {
        elements.sourceLanguageGroup.hidden = !isTranslateGemmaFormat;
    }
}

// Save current settings
async function saveCurrentSettings() {
    currentSettings = {
        ...currentSettings,
        provider: elements.providerSelect.value,
        ollamaUrl: elements.ollamaUrl.value,
        lmstudioUrl: elements.lmstudioUrl.value,
        selectedModel: elements.modelSelect?.value || currentSettings.selectedModel,
        sourceLanguage: elements.sourceLanguage.value,
        targetLanguage: elements.targetLanguage.value,
        requestFormat: elements.requestFormat.value,
        maxTokensPerBatch: parseInt(elements.maxTokens.value) || 2000,
        maxItemsPerBatch: parseInt(elements.maxItems.value) || 8,
        maxConcurrentRequests: parseInt(elements.maxConcurrent?.value) || 4,
        temperature: parseFloat(elements.temperature.value) || 0.3,
        useStructuredOutput: elements.useStructuredOutput.checked,
        showGlow: elements.showGlow.checked,
        // Save custom prompts from the new prompt editor
        customSystemPrompt: elements.systemPrompt?.value || elements.customSystem?.value || '',
        customUserPromptTemplate: elements.userPrompt?.value || elements.customUser?.value || '',
        useAdvanced: elements.requestFormat.value === 'custom'
    };

    await browserAPI.runtime.sendMessage({
        type: 'SAVE_SETTINGS',
        settings: currentSettings
    });
}

// Show toast notification
function showToast(message, type = 'success') {
    const toast = elements.toast;
    const icon = toast.querySelector('.toast-icon');
    const msg = toast.querySelector('.toast-message');

    icon.textContent = type === 'success' ? '✅' : type === 'error' ? '❌' : '⚠️';
    msg.textContent = message;

    toast.classList.add('show');
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

// Setup event listeners
function setupEventListeners() {
    // Temperature slider
    elements.temperature.addEventListener('input', (e) => {
        elements.temperatureValue.textContent = e.target.value;
    });

    // Parallel requests slider
    if (elements.maxConcurrent) {
        elements.maxConcurrent.addEventListener('input', (e) => {
            if (elements.maxConcurrentValue) {
                elements.maxConcurrentValue.textContent = e.target.value;
            }
        });
    }

    // Request format change
    elements.requestFormat.addEventListener('change', (e) => {
        updateFormatDescription(e.target.value);
        updateVisibility();
    });

    // Model selection
    if (elements.modelSelect) {
        elements.modelSelect.addEventListener('change', () => {
            currentSettings.selectedModel = elements.modelSelect.value;
            autoSetFormatForModel(currentSettings.selectedModel);
            updateVisibility(); // Update TranslateGemma help visibility
        });
    }

    // Refresh models
    if (elements.refreshModels) {
        elements.refreshModels.addEventListener('click', async () => {
            await loadModels();
            showToast('Models refreshed');
        });
    }

    // Save settings
    elements.saveSettings.addEventListener('click', async () => {
        await saveCurrentSettings();
        showToast('Settings saved!');
    });

    // Reset settings
    elements.resetSettings.addEventListener('click', async () => {
        currentSettings = { ...DEFAULT_SETTINGS };
        await browserAPI.runtime.sendMessage({
            type: 'SAVE_SETTINGS',
            settings: currentSettings
        });
        applySettingsToUI();
        await loadModels();
        showToast('Settings reset to defaults');
    });

    // Copy LM Studio template
    elements.copyTemplate.addEventListener('click', () => {
        const template = `{{ bos_token }}
{%- for message in messages -%}
    {%- if message['role'] == 'user' or message['role'] == 'system' -%}
        {{ '<start_of_turn>user\\n' + message['content'] | trim + '<end_of_turn>\\n' }}
    {%- elif message['role'] == 'assistant' -%}
        {{ '<start_of_turn>model\\n' + message['content'] | trim + '<end_of_turn>\\n' }}
    {%- endif -%}
{%- endfor -%}
{%- if add_generation_prompt -%}
    {{ '<start_of_turn>model\\n' }}
{%- endif -%}`;

        navigator.clipboard.writeText(template).then(() => {
            showToast('Template copied to clipboard!');
        }).catch(() => {
            showToast('Failed to copy template', 'error');
        });
    });
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', init);

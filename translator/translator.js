/**
 * Translator Page Script for Local LLM Translator
 * Google Translate-like interface using local LLM backend
 */

// Use browser API with chrome fallback for Firefox compatibility
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// ============================================================================
// Configuration
// ============================================================================

const PINNED_LANGUAGES = ['en', 'es', 'fr', 'de', 'zh', 'ja'];

const DEFAULT_SETTINGS = {
    provider: 'auto',
    ollamaUrl: 'http://localhost:11434',
    lmstudioUrl: 'http://localhost:1234',
    selectedModel: '',
    targetLanguage: 'en',
    sourceLanguage: 'auto',
    maxTokensPerBatch: 2000,
    maxItemsPerBatch: 8,
    maxConcurrentRequests: 4,
    useAdvanced: false,
    customSystemPrompt: '',
    customUserPromptTemplate: '',
    requestFormat: 'default',
    temperature: 0.3,
    useStructuredOutput: true,
    showGlow: false,
    showRomaji: false
};

// ============================================================================
// State
// ============================================================================

let currentSettings = { ...DEFAULT_SETTINGS };
let sourceLanguage = 'en';
let targetLanguage = 'es';
let isTranslating = false;
let selectedModel = null;
let selectedModelProvider = null;

// ============================================================================
// DOM Elements
// ============================================================================

const els = {
    // Theme
    themeToggle: document.getElementById('themeToggle'),
    themeIcon: document.getElementById('themeIcon'),

    // Status & Model
    statusIndicator: document.getElementById('statusIndicator'),
    statusText: document.getElementById('statusText'),
    modelName: document.getElementById('modelName'),
    modelBadge: document.getElementById('modelBadge'),

    // Source
    sourceLangBtn: document.getElementById('sourceLangBtn'),
    sourceLangName: document.getElementById('sourceLangName'),
    sourceLangDropdown: document.getElementById('sourceLangDropdown'),
    sourceLangSearch: document.getElementById('sourceLangSearch'),
    sourceLangPinned: document.getElementById('sourceLangPinned'),
    sourceLangList: document.getElementById('sourceLangList'),
    sourceLangSelector: document.getElementById('sourceLangSelector'),
    sourceText: document.getElementById('sourceText'),
    charCount: document.getElementById('charCount'),
    clearBtn: document.getElementById('clearBtn'),

    // Target
    targetLangBtn: document.getElementById('targetLangBtn'),
    targetLangName: document.getElementById('targetLangName'),
    targetLangDropdown: document.getElementById('targetLangDropdown'),
    targetLangSearch: document.getElementById('targetLangSearch'),
    targetLangPinned: document.getElementById('targetLangPinned'),
    targetLangList: document.getElementById('targetLangList'),
    targetLangSelector: document.getElementById('targetLangSelector'),
    targetOutput: document.getElementById('targetOutput'),
    translationInfo: document.getElementById('translationInfo'),
    copyBtn: document.getElementById('copyBtn'),

    // Actions
    swapBtn: document.getElementById('swapBtn'),
    translateBtn: document.getElementById('translateBtn'),

    // Romaji
    romajiSettings: document.getElementById('romajiSettings'),
    romajiToggle: document.getElementById('romajiToggle'),
    romajiOutput: document.getElementById('romajiOutput'),

    // Toast
    toast: document.getElementById('toast')
};

// ============================================================================
// Theme Management
// ============================================================================

function getSystemTheme() {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function getCurrentTheme() {
    const stored = localStorage.getItem('translator-theme');
    if (stored) return stored;
    return getSystemTheme();
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    els.themeIcon.textContent = theme === 'dark' ? '🌙' : '☀️';
    els.themeToggle.title = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
}

function toggleTheme() {
    const current = getCurrentTheme();
    const next = current === 'dark' ? 'light' : 'dark';
    localStorage.setItem('translator-theme', next);
    applyTheme(next);
}

// ============================================================================
// Language Selector
// ============================================================================

function buildLanguageSelector(type) {
    const pinnedContainer = type === 'source' ? els.sourceLangPinned : els.targetLangPinned;
    const listContainer = type === 'source' ? els.sourceLangList : els.targetLangList;
    const currentLang = type === 'source' ? sourceLanguage : targetLanguage;

    // Clear existing
    pinnedContainer.textContent = '';
    listContainer.textContent = '';

    // Pinned chips
    for (const code of PINNED_LANGUAGES) {
        const name = LANGUAGES[code];
        if (!name) continue;

        const chip = document.createElement('button');
        chip.className = 'lang-chip' + (code === currentLang ? ' active' : '');
        chip.textContent = name;
        chip.dataset.code = code;
        chip.type = 'button';
        chip.addEventListener('click', () => selectLanguage(type, code));
        pinnedContainer.appendChild(chip);
    }

    // Full list (sorted alphabetically)
    const sorted = Object.entries(LANGUAGES).sort((a, b) => a[1].localeCompare(b[1]));

    for (const [code, name] of sorted) {
        const item = document.createElement('div');
        item.className = 'lang-item' + (code === currentLang ? ' active' : '');
        item.dataset.code = code;
        item.dataset.name = name.toLowerCase();

        const codeSpan = document.createElement('span');
        codeSpan.className = 'lang-code';
        codeSpan.textContent = code;

        const nameSpan = document.createElement('span');
        nameSpan.textContent = name;

        item.appendChild(codeSpan);
        item.appendChild(nameSpan);
        item.addEventListener('click', () => selectLanguage(type, code));
        listContainer.appendChild(item);
    }
}

function selectLanguage(type, code) {
    const name = LANGUAGES[code] || code;

    if (type === 'source') {
        sourceLanguage = code;
        els.sourceLangName.textContent = name;
        closeDropdown('source');
        buildLanguageSelector('source'); // Rebuild to update active states
    } else {
        targetLanguage = code;
        els.targetLangName.textContent = name;
        closeDropdown('target');
        buildLanguageSelector('target');
    }

    updateRomajiVisibility();
}

function updateRomajiVisibility() {
    const isJapaneseInvolved = sourceLanguage === 'ja' || targetLanguage === 'ja';
    els.romajiSettings.hidden = !isJapaneseInvolved;
}

function openDropdown(type) {
    const selector = type === 'source' ? els.sourceLangSelector : els.targetLangSelector;
    const search = type === 'source' ? els.sourceLangSearch : els.targetLangSearch;

    // Close the other dropdown
    closeDropdown(type === 'source' ? 'target' : 'source');

    selector.classList.add('open');
    search.value = '';
    filterLanguages(type, '');

    // Focus search after a tick (for animation)
    requestAnimationFrame(() => search.focus());
}

function closeDropdown(type) {
    const selector = type === 'source' ? els.sourceLangSelector : els.targetLangSelector;
    selector.classList.remove('open');
}

function toggleDropdown(type) {
    const selector = type === 'source' ? els.sourceLangSelector : els.targetLangSelector;
    if (selector.classList.contains('open')) {
        closeDropdown(type);
    } else {
        openDropdown(type);
    }
}

function filterLanguages(type, query) {
    const listContainer = type === 'source' ? els.sourceLangList : els.targetLangList;
    const items = listContainer.querySelectorAll('.lang-item');
    const q = query.toLowerCase().trim();

    for (const item of items) {
        const name = item.dataset.name;
        const code = item.dataset.code;
        const matches = !q || name.includes(q) || code.includes(q);
        item.classList.toggle('hidden', !matches);
    }
}

// ============================================================================
// Swap Languages
// ============================================================================

function swapLanguages() {
    const tmpLang = sourceLanguage;
    sourceLanguage = targetLanguage;
    targetLanguage = tmpLang;

    els.sourceLangName.textContent = LANGUAGES[sourceLanguage] || sourceLanguage;
    els.targetLangName.textContent = LANGUAGES[targetLanguage] || targetLanguage;

    // Move translation output to source input
    const outputEl = els.targetOutput.querySelector('.translated-text');
    if (outputEl) {
        els.sourceText.value = outputEl.textContent;
        els.targetOutput.textContent = '';
        const placeholder = document.createElement('span');
        placeholder.className = 'placeholder-text';
        placeholder.textContent = 'Translation will appear here...';
        els.targetOutput.appendChild(placeholder);
        els.romajiOutput.textContent = '';
        els.copyBtn.hidden = true;
        els.translationInfo.textContent = '';
        updateCharCount();
    }

    buildLanguageSelector('source');
    buildLanguageSelector('target');
}

// ============================================================================
// Translation
// ============================================================================

async function translateText() {
    const text = els.sourceText.value.trim();
    if (!text || isTranslating) return;

    if (!selectedModel) {
        showTranslationError('No model available. Start Ollama or LMStudio and reload.');
        return;
    }

    isTranslating = true;
    setTranslatingUI(true);

    try {
        // Build a single text item for the background script
        const textItems = [{ id: 0, text: text }];

        const response = await browserAPI.runtime.sendMessage({
            type: 'TRANSLATE',
            texts: textItems,
            targetLanguage: targetLanguage,
            sourceLanguage: sourceLanguage
        });

        if (response.error) {
            throw new Error(response.error);
        }

        const translations = response.translations || [];
        if (translations.length > 0 && translations[0].text) {
            showTranslation(translations[0].text);
        } else {
            showTranslationError('No translation returned');
        }
    } catch (e) {
        console.error('Translation error:', e);
        showTranslationError(e.message);
    } finally {
        isTranslating = false;
        setTranslatingUI(false);
    }
}

function setTranslatingUI(translating) {
    els.translateBtn.disabled = translating;
    els.translateBtn.querySelector('.btn-text').hidden = translating;
    els.translateBtn.querySelector('.btn-loading').hidden = !translating;
}

function showTranslation(text) {
    els.targetOutput.textContent = '';
    const span = document.createElement('span');
    span.className = 'translated-text';
    span.textContent = text;
    els.targetOutput.appendChild(span);

    // Handle Romaji separately
    els.romajiOutput.textContent = '';
    if (currentSettings.showRomaji && typeof wanakana !== 'undefined' && wanakana.isJapanese(text)) {
        const romaji = wanakana.toRomaji(text);
        if (romaji && romaji.toLowerCase() !== text.toLowerCase()) {
            els.romajiOutput.textContent = `(${romaji})`;
        }
    }

    els.copyBtn.hidden = false;
    els.translationInfo.textContent = `${LANGUAGES[sourceLanguage] || sourceLanguage} → ${LANGUAGES[targetLanguage] || targetLanguage}`;
}

function showTranslationError(message) {
    els.targetOutput.textContent = '';
    const span = document.createElement('span');
    span.className = 'placeholder-text';
    span.style.color = 'var(--red)';
    span.textContent = `Error: ${message}`;
    els.targetOutput.appendChild(span);
    els.copyBtn.hidden = true;
    els.translationInfo.textContent = '';
}

// ============================================================================
// Copy to Clipboard
// ============================================================================

function copyTranslation() {
    const outputEl = els.targetOutput.querySelector('.translated-text');
    if (!outputEl) return;

    navigator.clipboard.writeText(outputEl.textContent).then(() => {
        showToast('Copied to clipboard!');
    }).catch(() => {
        showToast('Failed to copy', 'error');
    });
}

// ============================================================================
// Character Count
// ============================================================================

function updateCharCount() {
    const len = els.sourceText.value.length;
    els.charCount.textContent = `${len} character${len !== 1 ? 's' : ''}`;
    els.clearBtn.hidden = len === 0;
}

function clearSource() {
    els.sourceText.value = '';
    updateCharCount();
    els.sourceText.focus();
}

// ============================================================================
// Provider Status
// ============================================================================

async function checkStatus() {
    const dot = els.statusIndicator.querySelector('.status-dot');

    try {
        await loadSettings();
        const response = await browserAPI.runtime.sendMessage({ type: 'DETECT_PROVIDERS' });

        const providers = [];
        if (response.ollama) providers.push('Ollama');
        if (response.lmstudio) providers.push('LMStudio');

        if (providers.length > 0) {
            dot.className = 'status-dot connected';
            els.statusText.textContent = providers.join(' + ');
            els.statusIndicator.title = `Connected: ${providers.join(', ')}`;
        } else {
            dot.className = 'status-dot error';
            els.statusText.textContent = 'No provider';
            els.statusIndicator.title = 'No LLM providers found. Start Ollama or LMStudio.';
        }
    } catch (e) {
        dot.className = 'status-dot error';
        els.statusText.textContent = 'Error';
        els.statusIndicator.title = 'Error connecting to extension background';
    }
}

// ============================================================================
// Model Loading & Auto-Selection
// ============================================================================

/**
 * Smart model auto-selection priority:
 * 1. "translategemma-4b-it" (LMStudio name)
 * 2. "translategemma" (Ollama name)
 * 3. Any model containing "translategemma"
 * 4. Any model with "translat" in the name
 * 5. First available model
 */
function autoSelectModel(models) {
    if (!models || models.length === 0) return null;

    const exact4b = models.find(m => m.id.toLowerCase() === 'translategemma-4b-it');
    if (exact4b) return exact4b;

    const exactTG = models.find(m => m.id.toLowerCase() === 'translategemma');
    if (exactTG) return exactTG;

    const containsTG = models.find(m => m.id.toLowerCase().includes('translategemma'));
    if (containsTG) return containsTG;

    const containsTranslat = models.find(m => m.id.toLowerCase().includes('translat'));
    if (containsTranslat) return containsTranslat;

    return models[0];
}

function isTranslateGemmaModel(modelId) {
    if (!modelId) return false;
    const lower = modelId.toLowerCase();
    return lower.includes('translategemma') ||
        lower.includes('translate-gemma') ||
        lower.includes('translate_gemma');
}

async function loadModels() {
    els.modelName.textContent = 'Loading...';

    try {
        const response = await browserAPI.runtime.sendMessage({ type: 'LIST_MODELS' });
        const models = response.models || [];

        if (models.length === 0) {
            els.modelName.textContent = 'No models';
            els.modelBadge.title = 'No models found. Make sure Ollama or LMStudio has models loaded.';
            selectedModel = null;
            return;
        }

        // Use settings model if it exists in the list, otherwise auto-select
        let chosen = null;
        if (currentSettings.selectedModel) {
            chosen = models.find(m => m.id === currentSettings.selectedModel);
        }
        if (!chosen) {
            chosen = autoSelectModel(models);
        }

        if (chosen) {
            selectedModel = chosen.id;
            selectedModelProvider = chosen.provider;
            els.modelName.textContent = chosen.name || chosen.id;
            els.modelBadge.title = `Model: ${chosen.id} (${chosen.provider})`;

            // Auto-set request format for TranslateGemma models
            if (isTranslateGemmaModel(chosen.id)) {
                currentSettings.requestFormat = 'translategemma';
            }

            // Save the selected model to settings so background.js uses it
            currentSettings.selectedModel = chosen.id;
            await browserAPI.runtime.sendMessage({
                type: 'SAVE_SETTINGS',
                settings: currentSettings
            });
        }
    } catch (e) {
        console.error('Failed to load models:', e);
        els.modelName.textContent = 'Error';
        els.modelBadge.title = 'Failed to load models';
    }
}

// ============================================================================
// Settings
// ============================================================================

async function loadSettings() {
    try {
        const response = await browserAPI.runtime.sendMessage({ type: 'GET_SETTINGS' });
        if (response.settings) {
            currentSettings = { ...DEFAULT_SETTINGS, ...response.settings };
        }
    } catch (e) {
        console.error('Failed to load settings:', e);
    }
    return currentSettings;
}

// ============================================================================
// Toast
// ============================================================================

function showToast(message, type = 'success') {
    const toast = els.toast;
    const icon = toast.querySelector('.toast-icon');
    const msg = toast.querySelector('.toast-message');

    icon.textContent = type === 'success' ? '✅' : '❌';
    msg.textContent = message;

    if (type === 'error') {
        toast.style.borderColor = 'var(--red)';
        toast.style.color = 'var(--red)';
    } else {
        toast.style.borderColor = 'var(--accent)';
        toast.style.color = 'var(--accent)';
    }

    toast.classList.add('show');
    setTimeout(() => {
        toast.classList.remove('show');
    }, 2500);
}

// ============================================================================
// Event Listeners
// ============================================================================

function setupEventListeners() {
    // Theme toggle
    els.themeToggle.addEventListener('click', toggleTheme);

    // Language selector buttons
    els.sourceLangBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleDropdown('source');
    });
    els.targetLangBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleDropdown('target');
    });

    // Language search
    els.sourceLangSearch.addEventListener('input', (e) => {
        filterLanguages('source', e.target.value);
    });
    els.targetLangSearch.addEventListener('input', (e) => {
        filterLanguages('target', e.target.value);
    });

    // Prevent dropdown close when clicking inside
    els.sourceLangDropdown.addEventListener('click', (e) => e.stopPropagation());
    els.targetLangDropdown.addEventListener('click', (e) => e.stopPropagation());

    // Close dropdowns on outside click
    document.addEventListener('click', () => {
        closeDropdown('source');
        closeDropdown('target');
    });

    // Swap
    els.swapBtn.addEventListener('click', swapLanguages);

    // Translate
    els.translateBtn.addEventListener('click', translateText);

    // Ctrl+Enter to translate
    els.sourceText.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            translateText();
        }
    });

    // Character count
    els.sourceText.addEventListener('input', updateCharCount);

    // Clear
    els.clearBtn.addEventListener('click', clearSource);

    // Copy
    els.copyBtn.addEventListener('click', copyTranslation);

    // Romaji toggle
    els.romajiToggle.addEventListener('change', (e) => {
        currentSettings.showRomaji = e.target.checked;
        // If there's already a translation, refresh it to show/hide Romaji
        const outputEl = els.targetOutput.querySelector('.translated-text');
        if (outputEl) {
            // Re-apply the translation display logic
            showTranslation(outputEl.textContent);
        }
    });
}

// ============================================================================
// Initialization
// ============================================================================

async function init() {
    // Apply theme
    const theme = getCurrentTheme();
    applyTheme(theme);

    // Load settings to get user preferences
    await loadSettings();

    // Set initial languages from settings, fallback to defaults
    if (currentSettings.sourceLanguage && currentSettings.sourceLanguage !== 'auto' && LANGUAGES[currentSettings.sourceLanguage]) {
        sourceLanguage = currentSettings.sourceLanguage;
    }
    if (currentSettings.targetLanguage && LANGUAGES[currentSettings.targetLanguage]) {
        targetLanguage = currentSettings.targetLanguage;
    }

    // Make sure source and target are different
    if (sourceLanguage === targetLanguage) {
        targetLanguage = sourceLanguage === 'en' ? 'es' : 'en';
    }

    // Update UI
    els.sourceLangName.textContent = LANGUAGES[sourceLanguage] || sourceLanguage;
    els.targetLangName.textContent = LANGUAGES[targetLanguage] || targetLanguage;

    // Build language selectors
    buildLanguageSelector('source');
    buildLanguageSelector('target');

    // Setup events
    setupEventListeners();

    // Update Romaji visibility based on initial languages
    updateRomajiVisibility();

    // Check provider status & load models
    await checkStatus();
    await loadModels();

    // Update char count
    updateCharCount();
}

document.addEventListener('DOMContentLoaded', init);

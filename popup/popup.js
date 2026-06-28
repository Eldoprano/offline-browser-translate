/**
 * Popup Script for Local LLM Translator
 */

// Use browser API with chrome fallback for Firefox compatibility
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Import default settings (kept in sync with background.js DEFAULT_SETTINGS)
const DEFAULT_SETTINGS = {
    provider: 'auto',
    ollamaUrl: 'http://localhost:11434',
    lmstudioUrl: 'http://localhost:1234',
    selectedModel: '',
    targetLanguage: 'en',
    sourceLanguage: 'auto',
    pinnedLanguages: [],
    pinnedModels: [],
    maxTokensPerBatch: 2000,
    maxItemsPerBatch: 8,
    maxConcurrentRequests: 4, // 1-4 parallel requests (LMStudio 0.4.0+ supports parallelism)
    useAdvanced: false,
    customSystemPrompt: '',
    customUserPromptTemplate: '',
    requestFormat: 'auto',
    temperature: 0.3,
    useStructuredOutput: true,
    maxOutputRetries: 2,
    plainTextFallback: true,
    showGlow: true,
    numCtx: 0,
    debug: false,
    floatingButton: false
};

// DOM Elements
const elements = {
    providerStatus: document.getElementById('providerStatus'),
    modelPickerEl: document.getElementById('modelPickerEl'),
    modelTrigger: document.getElementById('modelTrigger'),
    modelTriggerLabel: document.getElementById('modelTriggerLabel'),
    modelMenu: document.getElementById('modelMenu'),
    modelSearch: document.getElementById('modelSearch'),
    modelList: document.getElementById('modelList'),
    refreshModels: document.getElementById('refreshModels'),
    languagePicker: document.getElementById('languagePicker'),
    langTrigger: document.getElementById('langTrigger'),
    langTriggerLabel: document.getElementById('langTriggerLabel'),
    langMenu: document.getElementById('langMenu'),
    langSearch: document.getElementById('langSearch'),
    langList: document.getElementById('langList'),
    sourceLangGroup: document.getElementById('sourceLangGroup'),
    detectedLang: document.getElementById('detectedLang'),
    sourceLangOverride: document.getElementById('sourceLangOverride'),
    translateBtn: document.getElementById('translateBtn'),
    cancelBtn: document.getElementById('cancelBtn'),
    restoreBtn: document.getElementById('restoreBtn'),
    toggleAdvanced: document.getElementById('toggleAdvanced'),
    advancedSection: document.getElementById('advancedSection'),
    providerSelect: document.getElementById('providerSelect'),
    ollamaUrl: document.getElementById('ollamaUrl'),
    lmstudioUrl: document.getElementById('lmstudioUrl'),
    maxTokens: document.getElementById('maxTokens'),
    maxItems: document.getElementById('maxItems'),
    temperature: document.getElementById('temperature'),
    temperatureValue: document.getElementById('temperatureValue'),
    requestFormat: document.getElementById('requestFormat'),
    formatDescription: document.getElementById('formatDescription'),
    useStructuredOutput: document.getElementById('useStructuredOutput'),
    showGlow: document.getElementById('showGlow'),
    floatingButton: document.getElementById('floatingButton'),
    customPrompts: document.getElementById('customPrompts'),
    customSystem: document.getElementById('customSystem'),
    customUser: document.getElementById('customUser'),
    saveSettings: document.getElementById('saveSettings'),
    openOptions: document.getElementById('openOptions'),
    resetSettings: document.getElementById('resetSettings'),
    toast: document.getElementById('toast')
};

// Format descriptions for each request format type
const FORMAT_DESCRIPTIONS = {
    auto: 'Picks the right format automatically based on the selected model.',
    default: 'Standard JSON output format. Best for most models. Returns translations as a structured JSON array.',
    translategemma: 'Specialized format for TranslateGemma models. Uses the exact prompt structure required by TranslateGemma. Auto-detects source language from the page.',
    hunyuan: 'Format optimized for Hunyuan-MT models. Minimal prompt with no system message.',
    simple: 'Simple line-by-line output. Good for smaller models that struggle with JSON formatting.',
    custom: 'Use your own custom system and user prompts. Full control over the translation request.'
};

let currentSettings = { ...DEFAULT_SETTINGS };
function debugLog(...args) { if (currentSettings.debug) console.log(...args); }
let isTranslating = false;
let detectedPageLanguage = 'en';

// Detect page language from active tab (using programmatic injection)
async function detectPageLanguage() {
    if (elements.detectedLang) {
        elements.detectedLang.textContent = 'Detecting...';
    }

    try {
        const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.id) {
            // DIRECT INJECTION: Read language without requiring content script
            const result = await browserAPI.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                    // Try HTML lang attribute
                    const htmlLang = document.documentElement.lang || document.querySelector('html')?.getAttribute('lang');
                    if (htmlLang) return htmlLang.split('-')[0].toLowerCase();

                    // Try meta tag
                    const metaLang = document.querySelector('meta[http-equiv="content-language"]')?.getAttribute('content');
                    if (metaLang) return metaLang.split('-')[0].toLowerCase();

                    return 'en'; // Default
                }
            });

            if (result && result[0] && result[0].result) {
                detectedPageLanguage = result[0].result;
                if (elements.detectedLang) {
                    const langName = LANGUAGES[detectedPageLanguage] || detectedPageLanguage.toUpperCase();
                    elements.detectedLang.textContent = langName;
                }
            } else {
                throw new Error('No result from script');
            }
        }
    } catch (e) {
        console.error('Language detection failed:', e);
        if (elements.detectedLang) {
            elements.detectedLang.textContent = 'unknown';
        }
    }
}

// Populate source language override dropdown
function populateSourceLangOverride() {
    if (!elements.sourceLangOverride) return;

    elements.sourceLangOverride.innerHTML = '<option value="auto">Use detected</option>';
    const sortedLangs = Object.entries(LANGUAGES).sort((a, b) => a[1].localeCompare(b[1]));

    for (const [code, name] of sortedLangs) {
        const option = document.createElement('option');
        option.value = code;
        option.textContent = name;
        elements.sourceLangOverride.appendChild(option);
    }
}

// Show toast notification
function showToast(message, type = 'success', duration = 3000) {
    const toast = elements.toast;
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
    }, duration);
}

// Initialize popup
async function init() {
    populateLanguageDropdown();
    initModelPicker();
    populateSourceLangOverride();
    await loadSettings();
    applySettingsToUI();
    setupEventListeners();
    await checkProviders();
    await loadModels();
    await checkTranslationStatus();
    await detectPageLanguage();
}

// ============================================================================
// Shared dropdown picker: a searchable list with pinnable items. Pinned items
// float to the top under a "Pinned" header (separated by a line) for quick
// access; a pin toggle lives on each row. Used for both the target-language and
// the model selectors — callers supply the element refs and item accessors via
// createPicker(config), so list/search/keyboard/pin logic lives here once.
// ============================================================================
const PIN_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';

/**
 * Build a searchable, pinnable dropdown picker.
 * @param {object} config
 *  - els: { picker, trigger, label, menu, search, list } — DOM refs
 *  - getItems(): item[]                — current full list of selectable items
 *  - getId(item) / getName(item)       — identity + display name for an item
 *  - restGroupLabel: string            — header shown above the non-pinned group
 *  - emptyText(filter): string         — text shown when nothing matches
 *  - labelFor(id): string              — trigger label for the current value
 *  - decorateOption?(li, item): void   — optional hook to append extra markup
 *  - isValidId?(id): boolean           — optional filter applied in setPinned
 *  - initialValue?: string             — starting value (default '')
 */
function createPicker(config) {
    const { els, getItems, getId, getName } = config;

    return {
        value: config.initialValue ?? '',
        pinned: [],
        open: false,
        activeIndex: -1,
        visibleIds: [],
        onChange: null,       // (id) => void
        onPinnedChange: null, // (pinnedArray) => void

        init() {
            els.trigger.addEventListener('click', () => this.toggle());
            els.search.addEventListener('input', () => {
                this.activeIndex = -1;
                this.render();
            });
            els.search.addEventListener('keydown', (e) => this.handleKeydown(e));
            // Close when clicking outside the picker
            document.addEventListener('click', (e) => {
                if (this.open && !els.picker.contains(e.target)) this.close();
            });
        },

        getValue() { return this.value; },

        setValue(id) {
            this.value = id;
            els.label.textContent = config.labelFor(id);
        },

        setPinned(arr) {
            const list = Array.isArray(arr) ? arr : [];
            this.pinned = config.isValidId ? list.filter(config.isValidId) : [...list];
        },

        isPinned(id) { return this.pinned.includes(id); },

        togglePin(id) {
            this.pinned = this.isPinned(id)
                ? this.pinned.filter(p => p !== id)
                : [...this.pinned, id];
            if (this.onPinnedChange) this.onPinnedChange([...this.pinned]);
            this.render();
        },

        select(id) {
            this.setValue(id);
            this.close();
            if (this.onChange) this.onChange(id);
        },

        toggle() { this.open ? this.close() : this.openMenu(); },

        openMenu() {
            this.open = true;
            els.picker.classList.add('open');
            els.menu.hidden = false;
            els.trigger.setAttribute('aria-expanded', 'true');
            els.search.value = '';
            this.activeIndex = -1;
            this.render();
            els.search.focus();
            // Scroll the selected row into view
            const sel = els.list.querySelector('.lang-option.selected');
            if (sel) sel.scrollIntoView({ block: 'nearest' });
        },

        close() {
            this.open = false;
            els.picker.classList.remove('open');
            els.menu.hidden = true;
            els.trigger.setAttribute('aria-expanded', 'false');
        },

        // Build the option list, applying the current search filter and pin grouping
        render() {
            const filter = els.search.value.trim().toLowerCase();
            const match = (item) => !filter
                || getName(item).toLowerCase().includes(filter)
                || String(getId(item)).toLowerCase().includes(filter);

            const pinnedSet = new Set(this.pinned);
            const sorted = [...getItems()].sort((a, b) => getName(a).localeCompare(getName(b)));
            const pinnedItems = sorted.filter(i => pinnedSet.has(getId(i)) && match(i));
            const restItems = sorted.filter(i => !pinnedSet.has(getId(i)) && match(i));

            const list = els.list;
            list.innerHTML = '';
            this.visibleIds = [];

            if (!pinnedItems.length && !restItems.length) {
                const empty = document.createElement('li');
                empty.className = 'lang-empty';
                empty.textContent = config.emptyText(filter);
                list.appendChild(empty);
                return;
            }

            if (pinnedItems.length) {
                list.appendChild(this.makeGroupLabel('Pinned'));
                pinnedItems.forEach(i => list.appendChild(this.makeOption(i, true)));
                if (restItems.length) {
                    const sep = document.createElement('li');
                    sep.className = 'lang-separator';
                    sep.setAttribute('aria-hidden', 'true');
                    list.appendChild(sep);
                    list.appendChild(this.makeGroupLabel(config.restGroupLabel));
                }
            }
            restItems.forEach(i => list.appendChild(this.makeOption(i, false)));

            this.updateActive();
        },

        makeGroupLabel(text) {
            const li = document.createElement('li');
            li.className = 'lang-group-label';
            li.textContent = text;
            li.setAttribute('aria-hidden', 'true');
            return li;
        },

        makeOption(item, pinned) {
            const id = getId(item);
            const name = getName(item);
            const li = document.createElement('li');
            li.className = 'lang-option' + (pinned ? ' pinned' : '') + (id === this.value ? ' selected' : '');
            li.setAttribute('role', 'option');
            li.dataset.id = id;
            if (id === this.value) li.setAttribute('aria-selected', 'true');

            const nameEl = document.createElement('span');
            nameEl.className = 'lang-option-name';
            nameEl.textContent = name;
            li.appendChild(nameEl);

            if (config.decorateOption) config.decorateOption(li, item);

            const pinBtn = document.createElement('button');
            pinBtn.type = 'button';
            pinBtn.className = 'lang-pin-btn';
            pinBtn.innerHTML = PIN_ICON_SVG;
            pinBtn.title = pinned ? `Unpin ${name}` : `Pin ${name}`;
            pinBtn.setAttribute('aria-label', pinBtn.title);
            pinBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.togglePin(id);
            });
            li.appendChild(pinBtn);

            li.addEventListener('click', () => this.select(id));

            const idx = this.visibleIds.length;
            li.addEventListener('mousemove', () => {
                if (this.activeIndex !== idx) { this.activeIndex = idx; this.updateActive(); }
            });
            this.visibleIds.push(id);
            return li;
        },

        // Reflect activeIndex onto the rows for keyboard navigation highlight
        updateActive() {
            const rows = els.list.querySelectorAll('.lang-option');
            rows.forEach((row, i) => {
                const active = i === this.activeIndex;
                row.classList.toggle('active', active);
                if (active) row.scrollIntoView({ block: 'nearest' });
            });
        },

        handleKeydown(e) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (this.visibleIds.length) {
                    this.activeIndex = Math.min(this.activeIndex + 1, this.visibleIds.length - 1);
                    this.updateActive();
                }
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (this.visibleIds.length) {
                    this.activeIndex = Math.max(this.activeIndex - 1, 0);
                    this.updateActive();
                }
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const idx = this.activeIndex >= 0 ? this.activeIndex : 0;
                const id = this.visibleIds[idx];
                if (id) this.select(id);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.close();
                els.trigger.focus();
            }
        }
    };
}

// Target-language picker: items are [code, name] entries from LANGUAGES.
const langPicker = createPicker({
    els: {
        picker: elements.languagePicker,
        trigger: elements.langTrigger,
        label: elements.langTriggerLabel,
        menu: elements.langMenu,
        search: elements.langSearch,
        list: elements.langList,
    },
    getItems: () => Object.entries(LANGUAGES),
    getId: (entry) => entry[0],
    getName: (entry) => entry[1],
    restGroupLabel: 'All languages',
    emptyText: () => 'No languages match your search',
    labelFor: (code) => LANGUAGES[code] || code,
    isValidId: (code) => !!LANGUAGES[code],
    initialValue: 'en',
});

// Model picker: items are { id, name, provider } objects loaded from providers.
// allModels lives on the instance and feeds getItems(); model-specific helpers
// (setModels / getSelectedProvider) are attached after creation.
const modelPicker = createPicker({
    els: {
        picker: elements.modelPickerEl,
        trigger: elements.modelTrigger,
        label: elements.modelTriggerLabel,
        menu: elements.modelMenu,
        search: elements.modelSearch,
        list: elements.modelList,
    },
    getItems: () => modelPicker.allModels,
    getId: (m) => m.id,
    getName: (m) => m.name,
    restGroupLabel: 'All models',
    emptyText: () => modelPicker.allModels.length === 0 ? 'No models available' : 'No models match your search',
    labelFor: (id) => {
        const m = modelPicker.allModels.find(x => x.id === id);
        return m ? m.name : (id || 'Select a model');
    },
    decorateOption: (li, m) => {
        const badge = document.createElement('span');
        badge.className = `model-provider-badge model-provider-badge--${m.provider}`;
        badge.textContent = m.provider;
        li.appendChild(badge);
    },
});

modelPicker.allModels = [];

modelPicker.getSelectedProvider = function () {
    const m = this.allModels.find(x => x.id === this.value);
    return m ? m.provider : null;
};

modelPicker.setModels = function (models) {
    this.allModels = models;
    // Drop pinned ids that no longer exist in the model list
    const ids = new Set(models.map(m => m.id));
    this.pinned = this.pinned.filter(id => ids.has(id));
};

// Initialize the model picker and wire it to settings persistence.
function initModelPicker() {
    modelPicker.onChange = (id) => {
        currentSettings.selectedModel = id;
        updateFormatUI();
        saveCurrentSettings();
    };
    modelPicker.onPinnedChange = (pinned) => {
        currentSettings.pinnedModels = pinned;
        saveCurrentSettings();
    };
    modelPicker.init();
}

// Initialize the language picker and wire it to settings persistence.
function populateLanguageDropdown() {
    langPicker.onChange = (code) => {
        currentSettings.targetLanguage = code;
        saveCurrentSettings();
    };
    langPicker.onPinnedChange = (pinned) => {
        currentSettings.pinnedLanguages = pinned;
        saveCurrentSettings();
    };
    langPicker.init();
}

// Check if translation is already running in active tab
async function checkTranslationStatus() {
    try {
        const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.id) {
            const response = await browserAPI.tabs.sendMessage(tab.id, { type: 'GET_TRANSLATION_STATUS' });
            if (response && response.isTranslating) {
                isTranslating = true;
                elements.translateBtn.disabled = true;
                elements.translateBtn.querySelector('.btn-text').hidden = true;
                elements.translateBtn.querySelector('.btn-loading').hidden = false;
                elements.cancelBtn.hidden = false;
            }
        }
    } catch (e) {
        // Content script might not be injected yet, which is fine
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
    langPicker.setPinned(currentSettings.pinnedLanguages || []);
    langPicker.setValue(currentSettings.targetLanguage);
    modelPicker.setPinned(currentSettings.pinnedModels || []);
    elements.providerSelect.value = currentSettings.provider;
    elements.ollamaUrl.value = currentSettings.ollamaUrl;
    elements.lmstudioUrl.value = currentSettings.lmstudioUrl;
    elements.maxTokens.value = currentSettings.maxTokensPerBatch;
    elements.maxItems.value = currentSettings.maxItemsPerBatch || 8;
    elements.temperature.value = currentSettings.temperature;
    elements.temperatureValue.textContent = currentSettings.temperature;
    elements.requestFormat.value = currentSettings.requestFormat;
    elements.useStructuredOutput.checked = currentSettings.useStructuredOutput;
    elements.showGlow.checked = currentSettings.showGlow !== false;
    if (elements.floatingButton) elements.floatingButton.checked = !!currentSettings.floatingButton;
    elements.customSystem.value = currentSettings.customSystemPrompt || '';
    elements.customUser.value = currentSettings.customUserPromptTemplate || '';

    // Restore source language override
    if (elements.sourceLangOverride && currentSettings.sourceLanguage) {
        elements.sourceLangOverride.value = currentSettings.sourceLanguage;
    }

    // Refresh format-dependent UI
    updateFormatUI();
}

// The effective format = the explicit choice, or (for 'auto') the one detected
// from the selected model. detectRequestFormat/PLAIN_TEXT_FORMATS come from languages.js.
function getEffectiveFormat() {
    return resolveRequestFormat(
        { requestFormat: elements.requestFormat.value },
        modelPicker.getValue()
    );
}

// Refresh format-dependent UI. Non-mutating: it never silently rewrites the
// user's format choice — 'auto' resolves at translation time in the background.
function updateFormatUI() {
    const fmt = elements.requestFormat.value;
    const effective = getEffectiveFormat();

    let desc = FORMAT_DESCRIPTIONS[fmt] || '';
    if (fmt === 'auto' && modelPicker.getValue()) {
        desc += ` Detected for this model: ${effective}.`;
    }
    if (elements.formatDescription) elements.formatDescription.textContent = desc;

    // Structured JSON output is meaningless for plain-text formats; grey it out.
    // (The background already ignores it for those, so we don't touch its value.)
    elements.useStructuredOutput.disabled = PLAIN_TEXT_FORMATS.has(effective);

    elements.customPrompts.hidden = fmt !== 'custom';
}

// Check which providers are available
let providersAvailable = false;

async function checkProviders() {
    const statusWrapper = elements.providerStatus;
    const statusDot = statusWrapper.querySelector('.status-dot');

    try {
        const response = await browserAPI.runtime.sendMessage({ type: 'DETECT_PROVIDERS' });
        
        // Resolve active provider using setting or currently selected model's provider
        const providerSetting = currentSettings.provider; // 'auto', 'ollama', 'lmstudio'
        const selectedModelProvider = modelPicker.getSelectedProvider();
        
        let activeProvider = providerSetting;
        if (activeProvider === 'auto' && selectedModelProvider) {
            activeProvider = selectedModelProvider;
        }

        let connected = false;
        let blocked = false;
        let blockedType = ''; // 'ollama' or 'lmstudio'
        const connectedProviders = [];

        if (response.ollama) connectedProviders.push('Ollama');
        if (response.lmstudio) connectedProviders.push('LMStudio');

        if (activeProvider === 'ollama') {
            connected = response.ollama;
            blocked = response.ollama_blocked;
            blockedType = 'ollama';
        } else if (activeProvider === 'lmstudio') {
            connected = response.lmstudio;
            blocked = response.lmstudio_blocked;
            blockedType = 'lmstudio';
        } else {
            // 'auto' mode with no specific model selected yet
            connected = connectedProviders.length > 0;
            if (!connected) {
                blocked = response.ollama_blocked || response.lmstudio_blocked;
                blockedType = response.ollama_blocked ? 'ollama' : 'lmstudio';
            }
        }

        if (connected) {
            statusDot.className = 'status-dot connected';
            statusWrapper.title = `Connected: ${connectedProviders.join(', ')}`;
            providersAvailable = true;
            hideSetupBanner();
        } else if (blocked) {
            statusDot.className = 'status-dot error';
            statusWrapper.title = blockedType === 'ollama'
                ? 'Ollama is running but blocking the extension (CORS)'
                : 'LMStudio is running but blocking the extension (CORS)';
            providersAvailable = false;
            showSetupBanner(blockedType === 'ollama' ? 'cors-blocked-ollama' : 'cors-blocked-lmstudio');
        } else {
            statusDot.className = 'status-dot error';
            statusWrapper.title = 'No providers found';
            providersAvailable = false;
            showSetupBanner();
        }
    } catch (e) {
        statusDot.className = 'status-dot error';
        statusWrapper.title = 'Error checking providers';
        providersAvailable = false;
        showSetupBanner();
    }
}

function bannerHTML(type) {
    if (type === 'no-models') {
        return `
            <div style="font-weight: bold; margin-bottom: 4px; color: var(--yellow, #dbbc7f);">No translation models found</div>
            <div>Your LLM provider is connected, but you have not downloaded a translation model yet.</div>
            <div style="margin-top: 6px;">Recommended model:</div>
            <div style="background: var(--bg1, #2b2b2b); padding: 4px 8px; border-radius: 4px; font-family: monospace; display: flex; align-items: center; justify-content: space-between; margin-top: 4px;">
                <code>ollama pull translategemma</code>
            </div>
            <div style="margin-top: 6px; font-size: 11px; opacity: 0.8;">Or download a model in LMStudio (search for "translate"). Click the refresh button above when done.</div>
        `;
    }
    if (type === 'cors-blocked-ollama') {
        return `
            <div style="font-weight: bold; margin-bottom: 4px; color: var(--yellow, #dbbc7f);">Ollama is blocking the extension</div>
            <div>Ollama is running, but it is not allowing requests from browser extensions (CORS policy).</div>
            <div style="margin-top: 6px; font-size: 11px; opacity: 0.8;"><a href="https://api.onlyoffice.com/docs/plugin-and-macros/ai/configuring-ollama-with-cors/" target="_blank" style="color: var(--accent, #a7c080);">See CORS instructions for Ollama here</a>. Click the refresh button above when done.</div>
        `;
    }
    if (type === 'cors-blocked-lmstudio') {
        return `
            <div style="font-weight: bold; margin-bottom: 4px; color: var(--yellow, #dbbc7f);">LM Studio is blocking the extension</div>
            <div>LM Studio server is running, but Cross-Origin Resource Sharing (CORS) is disabled.</div>
            <div style="margin-top: 6px; line-height: 1.4;">
                To enable CORS:
                <ol style="margin: 4px 0; padding-left: 18px;">
                    <li>Open <b>LM Studio</b></li>
                    <li>Go to the <b>Developer</b> tab (server icon on the left sidebar)</li>
                    <li>Under <b>Server Settings</b>, activate <b>"Enable CORS"</b></li>
                    <li>Restart the server</li>
                </ol>
            </div>
            <div style="margin-top: 6px; font-size: 11px; opacity: 0.8;">Click the refresh button above when done.</div>
        `;
    }
    return `
        <div style="font-weight: bold; margin-bottom: 4px; color: var(--yellow, #dbbc7f);">No LLM provider detected</div>
        <div>To use this extension, you need a local LLM server running:</div>
        <ol style="margin: 6px 0 2px 18px; padding: 0;">
            <li>Install <a href="https://ollama.com" target="_blank" style="color: var(--accent, #a7c080);">Ollama</a> or <a href="https://lmstudio.ai" target="_blank" style="color: var(--accent, #a7c080);">LMStudio</a></li>
            <li>Load a translation model (e.g. <code style="background: var(--bg1, #2b2b2b); padding: 1px 4px; border-radius: 3px;">ollama pull translategemma</code>)</li>
            <li>Click the refresh button above</li>
        </ol>
    `;
}

// Show/hide first-run setup guidance banner
function showSetupBanner(type = 'no-provider') {
    let banner = document.getElementById('setup-banner');
    if (banner) {
        banner.hidden = false;
        // Update content if it already exists
        banner.innerHTML = bannerHTML(type);
        return;
    }

    banner = document.createElement('div');
    banner.id = 'setup-banner';
    banner.style.cssText = `
        background: var(--bg3, #3a3a3a);
        border: 1px solid var(--yellow, #dbbc7f);
        border-radius: 8px;
        padding: 10px 14px;
        margin: 8px 0;
        font-size: 12px;
        line-height: 1.5;
        color: var(--fg, #d3c6aa);
    `;
    banner.innerHTML = bannerHTML(type);

    // Insert after the model selector row
    const modelRow = elements.modelPickerEl?.closest('.row') || elements.modelPickerEl?.parentElement;
    if (modelRow) {
        modelRow.parentNode.insertBefore(banner, modelRow.nextSibling);
    } else {
        document.querySelector('.popup-body, .container, body')?.prepend(banner);
    }
}

function hideSetupBanner() {
    const banner = document.getElementById('setup-banner');
    if (banner && providersAvailable) banner.hidden = true;
}

// Load available models
async function loadModels(forceRefresh = false) {
    elements.modelTrigger.disabled = true;
    elements.modelTriggerLabel.textContent = 'Loading models...';

    try {
        const response = await browserAPI.runtime.sendMessage({ type: 'LIST_MODELS', forceRefresh });
        const models = response.models || [];

        if (models.length === 0) {
            modelPicker.setModels([]);
            elements.modelTriggerLabel.textContent = 'No models found';
            elements.modelTrigger.disabled = false;
            if (providersAvailable) {
                // If any provider is blocked by CORS, prioritize showing the CORS banner
                const detectResponse = await browserAPI.runtime.sendMessage({ type: 'DETECT_PROVIDERS' }).catch(() => ({}));
                if (detectResponse.ollama_blocked || detectResponse.lmstudio_blocked) {
                    showSetupBanner(detectResponse.ollama_blocked ? 'cors-blocked-ollama' : 'cors-blocked-lmstudio');
                } else {
                    showSetupBanner('no-models');
                }
            }
            return;
        }

        // We have models — hide any setup banner
        hideSetupBanner();
        modelPicker.setModels(models);

        // Apply pinned now that we know the real model ids
        modelPicker.setPinned(currentSettings.pinnedModels || []);

        // Select previously saved model if still available, else first model
        const targetId = currentSettings.selectedModel && models.some(m => m.id === currentSettings.selectedModel)
            ? currentSettings.selectedModel
            : models[0].id;
        modelPicker.setValue(targetId);

        elements.modelTrigger.disabled = false;
        elements.translateBtn.disabled = false;

        // Refresh the "Auto → detected format" hint for the selected model
        updateFormatUI();

    } catch (e) {
        console.error('Failed to load models:', e);
        elements.modelTriggerLabel.textContent = 'Error loading models';
        elements.modelTrigger.disabled = false;
    }
}

// Save current settings
async function saveCurrentSettings() {
    currentSettings = {
        ...currentSettings,
        provider: elements.providerSelect.value,
        ollamaUrl: elements.ollamaUrl.value,
        lmstudioUrl: elements.lmstudioUrl.value,
        selectedModel: modelPicker.getValue(),
        pinnedModels: [...modelPicker.pinned],
        targetLanguage: langPicker.getValue(),
        pinnedLanguages: langPicker.pinned,
        maxTokensPerBatch: parseInt(elements.maxTokens.value) || 2000,
        maxItemsPerBatch: parseInt(elements.maxItems.value) || 8,
        temperature: parseFloat(elements.temperature.value) || 0.3,
        requestFormat: elements.requestFormat.value,
        useStructuredOutput: elements.useStructuredOutput.checked,
        showGlow: elements.showGlow.checked,
        // Save the source language override preference
        sourceLanguage: elements.sourceLangOverride ? elements.sourceLangOverride.value : 'auto',
        customSystemPrompt: elements.customSystem.value,
        customUserPromptTemplate: elements.customUser.value
    };

    await browserAPI.runtime.sendMessage({
        type: 'SAVE_SETTINGS',
        settings: currentSettings
    });
}

// Start translation
async function startTranslation() {
    if (isTranslating) return;

    // --- Pre-flight checks with clear error messages ---
    const model = modelPicker.getValue();
    if (!model) {
        showToast('Please select a model first', 'error');
        return;
    }

    if (!providersAvailable) {
        showToast('No LLM provider running. Start Ollama or LMStudio first.', 'error');
        return;
    }

    isTranslating = true;
    elements.translateBtn.disabled = true;
    elements.translateBtn.querySelector('.btn-text').hidden = true;
    elements.translateBtn.querySelector('.btn-loading').hidden = false;
    elements.cancelBtn.hidden = false;

    try {
        // Save settings first
        await saveCurrentSettings();

        // Get current tab
        const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });

        if (!tab || !tab.id) {
            throw new Error('No active tab found');
        }

        // Check if page is a restricted URL
        if (tab.url && (tab.url.startsWith('about:') || tab.url.startsWith('chrome:') ||
            tab.url.startsWith('moz-extension:') || tab.url.startsWith('chrome-extension:'))) {
            throw new Error('Cannot translate browser internal pages.');
        }

        // Try to inject content script
        try {
            await browserAPI.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['/content.js']
            });
        } catch (injectErr) {
            debugLog('[Popup] Script injection note:', injectErr.message);
            // May already be injected or page doesn't allow scripts
        }

        // Wait for content script readiness (replaces fragile 100ms delay)
        let scriptReady = false;
        for (let i = 0; i < 15; i++) {
            try {
                const resp = await browserAPI.tabs.sendMessage(tab.id, { type: 'PING' });
                if (resp && resp.pong) {
                    scriptReady = true;
                    break;
                }
            } catch { }
            await new Promise(r => setTimeout(r, 100));
        }

        if (!scriptReady) {
            throw new Error('Could not connect to page. Try refreshing the page first.');
        }

        // Resolve source language: if auto, use the detected language we found earlier
        let finalSourceLang = currentSettings.sourceLanguage;
        if (finalSourceLang === 'auto' && detectedPageLanguage) {
            finalSourceLang = detectedPageLanguage;
        }

        // Send translation message (script is confirmed ready)
        try {
            const response = await browserAPI.tabs.sendMessage(tab.id, {
                type: 'START_TRANSLATION',
                targetLanguage: currentSettings.targetLanguage,
                sourceLanguage: finalSourceLang,
                showGlow: currentSettings.showGlow,
                maxConcurrentRequests: currentSettings.maxConcurrentRequests || 4
            });
            if (response && response.started) {
                return; // Success! UI stays in translating state
            }
        } catch (msgErr) {
            throw new Error('Lost connection to page. Please refresh and try again.');
        }

    } catch (e) {
        console.error('Translation error:', e);
        showToast(`Error: ${e.message}`, 'error');

        // Only reset UI on error
        isTranslating = false;
        elements.translateBtn.disabled = false;
        elements.translateBtn.querySelector('.btn-text').hidden = false;
        elements.translateBtn.querySelector('.btn-loading').hidden = true;
        elements.cancelBtn.hidden = true;
    }
}

// Cancel translation
async function cancelTranslation() {
    try {
        const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.id) {
            await browserAPI.tabs.sendMessage(tab.id, { type: 'CANCEL_TRANSLATION' });
        }
    } catch (e) {
        console.error('Cancel error:', e);
    }

    isTranslating = false;
    elements.translateBtn.disabled = false;
    elements.translateBtn.querySelector('.btn-text').hidden = false;
    elements.translateBtn.querySelector('.btn-loading').hidden = true;
    elements.cancelBtn.hidden = true;
}

// Toggle translation on/off (uses cached translations if available)
async function toggleTranslation() {
    try {
        const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
        const response = await browserAPI.tabs.sendMessage(tab.id, { type: 'TOGGLE_TRANSLATION' });

        // Update button text based on state
        if (response && response.showing === 'translated') {
            elements.restoreBtn.textContent = 'Original';
        } else {
            elements.restoreBtn.textContent = response?.hasCache ? 'Translated' : 'Restore';
        }
    } catch (e) {
        console.error('Toggle error:', e);
    }
}

// Setup event listeners
function setupEventListeners() {
    // Translate button
    elements.translateBtn.addEventListener('click', startTranslation);

    // Cancel button
    elements.cancelBtn.addEventListener('click', cancelTranslation);

    // Restore/Toggle button
    elements.restoreBtn.addEventListener('click', toggleTranslation);

    // Refresh models
    elements.refreshModels.addEventListener('click', async () => {
        await checkProviders();
        await loadModels(true); // Force refresh, bypass cache
    });

    // Toggle advanced settings
    elements.toggleAdvanced.addEventListener('click', () => {
        const isHidden = elements.advancedSection.hidden;
        elements.advancedSection.hidden = !isHidden;
        elements.toggleAdvanced.classList.toggle('active', !isHidden);
    });

    // Floating button toggle — permission required to enable
    if (elements.floatingButton) {
        elements.floatingButton.addEventListener('change', async (e) => {
            if (e.target.checked) {
                const granted = await browserAPI.permissions.request({ origins: ['<all_urls>'] });
                if (!granted) {
                    e.target.checked = false;
                    showToast('Permission denied', 'error');
                    return;
                }
                await browserAPI.runtime.sendMessage({ type: 'REGISTER_CONTENT_SCRIPT' });
                showToast('Floating button enabled — reload pages to activate');
            } else {
                await browserAPI.runtime.sendMessage({ type: 'UNREGISTER_CONTENT_SCRIPT' });
                try { await browserAPI.permissions.remove({ origins: ['<all_urls>'] }); } catch (e) {}
                showToast('Floating button disabled — permission removed');
            }
            currentSettings.floatingButton = e.target.checked;
            await browserAPI.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: currentSettings });
        });
    }

    // Temperature slider
    elements.temperature.addEventListener('input', (e) => {
        elements.temperatureValue.textContent = e.target.value;
    });

    // Request format change
    elements.requestFormat.addEventListener('change', (e) => {
        currentSettings.requestFormat = e.target.value;
        updateFormatUI();
    });

    // Save settings button
    elements.saveSettings.addEventListener('click', async () => {
        // Request host permission for any non-localhost server URL (opt-in).
        // Must run inside this click gesture, before any other awaits.
        const granted = await ensureHostPermissions([
            elements.ollamaUrl.value,
            elements.lmstudioUrl.value
        ]);
        await saveCurrentSettings();
        if (!granted) {
            showToast('Saved, but permission for the custom server was denied — remote models won\'t load until you allow it.', 'error', 5000);
        } else {
            showToast('Settings saved!');
        }
        await checkProviders();
        await loadModels();
    });

    // (Target-language changes are handled by langPicker.onChange.)
    // (Model changes are handled by modelPicker.onChange.)

    // Glow toggle - update in real-time
    elements.showGlow.addEventListener('change', async () => {
        currentSettings.showGlow = elements.showGlow.checked;
        await saveCurrentSettings();
        // Send to content script to update existing translations
        try {
            const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
            if (tab && tab.id) {
                await browserAPI.tabs.sendMessage(tab.id, {
                    type: 'SET_GLOW',
                    enabled: currentSettings.showGlow
                });
            }
        } catch (e) {
            // Content script may not be loaded
        }
    });

    // Variable helpers
    document.querySelectorAll('.var-tag').forEach(tag => {
        tag.addEventListener('click', () => {
            const targetId = tag.dataset.target;
            const textToInsert = tag.dataset.insert;
            const textarea = document.getElementById(targetId);

            if (textarea) {
                const start = textarea.selectionStart;
                const end = textarea.selectionEnd;
                const text = textarea.value;
                const before = text.substring(0, start);
                const after = text.substring(end, text.length);

                textarea.value = before + textToInsert + after;
                textarea.selectionStart = textarea.selectionEnd = start + textToInsert.length;
                textarea.focus();

                // Trigger change to update settings
                textarea.dispatchEvent(new Event('change'));
            }
        });
    });

    // Open options page
    if (elements.openOptions) {
        elements.openOptions.addEventListener('click', () => {
            browserAPI.runtime.openOptionsPage();
        });
    }

    // Open translator page
    const openTranslatorBtn = document.getElementById('openTranslator');
    if (openTranslatorBtn) {
        openTranslatorBtn.addEventListener('click', () => {
            browserAPI.tabs.create({ url: browserAPI.runtime.getURL('translator/translator.html') });
        });
    }

    // Reset settings to defaults
    if (elements.resetSettings) {
        elements.resetSettings.addEventListener('click', async () => {
            currentSettings = { ...DEFAULT_SETTINGS };
            await browserAPI.runtime.sendMessage({
                type: 'SAVE_SETTINGS',
                settings: currentSettings
            });
            applySettingsToUI();
            showToast('Settings reset to defaults');
        });
    }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', init);

// ============================================================================
// Resizable popup — drag the corner grip to adjust width and height.
// Uses Pointer Capture so the drag keeps working even when the cursor moves
// outside the popup window quickly. Size is persisted to localStorage.
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
    const handle = document.querySelector('.resize-handle');
    if (!handle) return;

    const MIN_W = 260, MAX_W = 720, MIN_H = 280;
    const STORAGE_KEY_W = 'popupWidth';
    const STORAGE_KEY_H = 'popupHeight';

    // Restore previously saved size
    const savedW = localStorage.getItem(STORAGE_KEY_W);
    const savedH = localStorage.getItem(STORAGE_KEY_H);
    if (savedW) document.body.style.width = Math.max(MIN_W, Math.min(MAX_W, +savedW)) + 'px';
    if (savedH) document.body.style.height = Math.max(MIN_H, +savedH) + 'px';

    let dragging = false;
    let startX, startY, startW, startH;
    let rafId = null;       // pending animation frame
    let pendingW, pendingH; // latest values to commit on next frame

    handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        startW = document.body.offsetWidth;
        startH = document.body.offsetHeight;
        handle.setPointerCapture(e.pointerId); // keeps events firing even outside window
        handle.classList.add('dragging');
    });

    handle.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        // Compute the desired size but don't write to the DOM yet
        pendingW = Math.max(MIN_W, Math.min(MAX_W, startW + (startX - e.clientX)));
        pendingH = Math.max(MIN_H, startH + (e.clientY - startY));
        // Schedule a single DOM write per animation frame (drops redundant intermediate events)
        if (!rafId) {
            rafId = requestAnimationFrame(() => {
                document.body.style.width  = pendingW + 'px';
                document.body.style.height = pendingH + 'px';
                rafId = null;
            });
        }
    });

    const stopDrag = () => {
        if (!dragging) return;
        dragging = false;
        handle.classList.remove('dragging');
        localStorage.setItem(STORAGE_KEY_W, document.body.offsetWidth);
        localStorage.setItem(STORAGE_KEY_H, document.body.offsetHeight);
    };

    handle.addEventListener('pointerup', stopDrag);
    handle.addEventListener('pointercancel', stopDrag);
});

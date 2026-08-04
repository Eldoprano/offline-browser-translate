/**
 * Options Page Script for Local LLM Translator
 */

// Use browser API with chrome fallback for Firefox compatibility
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

const DEFAULT_SETTINGS = {
    provider: 'auto',
    ollamaUrl: 'http://localhost:11434',
    lmstudioUrl: 'http://localhost:1234',
    filterLlamaCppUiModels: false,
    selectedModel: '',
    targetLanguage: 'en',
    sourceLanguage: 'auto',
    pinnedLanguages: [],
    pinnedModels: [],
    maxTokensPerBatch: 2000,
    maxItemsPerBatch: 8,
    maxConcurrentRequests: 4, // 1-32 parallel requests (LMStudio 0.4.0+ supports parallelism)
    // Per-format prompt overrides: { [format]: { system, user } }. No 'auto' entry —
    // auto always resolves to a concrete format first, and that format's (possibly
    // overridden) prompt is what actually gets used.
    customPrompts: {},
    requestFormat: 'auto',
    temperature: 0.3,
    useStructuredOutput: true,
    maxOutputRetries: 2,
    plainTextFallback: true,
    showGlow: false,  // Disabled by default
    useGlossary: false,  // Off by default; enable once you've set up terms
    cacheMode: 'off',
    autoTranslatePages: false,
    autoTranslateNeverLanguages: [],
    autoTranslateNeverSites: []
};

// Format descriptions
const FORMAT_DESCRIPTIONS = {
    auto: 'Picks the format automatically based on the selected model.',
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
    providerPickerEl: document.getElementById('providerPickerEl'),
    providerTrigger: document.getElementById('providerTrigger'),
    providerTriggerLabel: document.getElementById('providerTriggerLabel'),
    providerMenu: document.getElementById('providerMenu'),
    providerList: document.getElementById('providerList'),
    ollamaUrl: document.getElementById('ollamaUrl'),
    lmstudioUrl: document.getElementById('lmstudioUrl'),
    modelPickerEl: document.getElementById('modelPickerEl'),
    modelTrigger: document.getElementById('modelTrigger'),
    modelTriggerLabel: document.getElementById('modelTriggerLabel'),
    modelMenu: document.getElementById('modelMenu'),
    modelSearch: document.getElementById('modelSearch'),
    modelList: document.getElementById('modelList'),
    filterLlamaCppUiModels: document.getElementById('filterLlamaCppUiModels'),
    refreshModels: document.getElementById('refreshModels'),
    sourceLanguagePickerEl: document.getElementById('sourceLanguagePickerEl'),
    sourceLanguageTrigger: document.getElementById('sourceLanguageTrigger'),
    sourceLanguageTriggerLabel: document.getElementById('sourceLanguageTriggerLabel'),
    sourceLanguageMenu: document.getElementById('sourceLanguageMenu'),
    sourceLanguageList: document.getElementById('sourceLanguageList'),
    sourceLanguageGroup: document.getElementById('sourceLanguageGroup'),
    targetLangPickerEl: document.getElementById('targetLangPickerEl'),
    targetLangTrigger: document.getElementById('targetLangTrigger'),
    targetLangTriggerLabel: document.getElementById('targetLangTriggerLabel'),
    targetLangMenu: document.getElementById('targetLangMenu'),
    targetLangSearch: document.getElementById('targetLangSearch'),
    targetLangList: document.getElementById('targetLangList'),
    requestFormatPickerEl: document.getElementById('requestFormatPickerEl'),
    requestFormatTrigger: document.getElementById('requestFormatTrigger'),
    requestFormatTriggerLabel: document.getElementById('requestFormatTriggerLabel'),
    requestFormatMenu: document.getElementById('requestFormatMenu'),
    requestFormatList: document.getElementById('requestFormatList'),
    formatDescription: document.getElementById('formatDescription'),
    promptEditor: document.getElementById('promptEditor'),
    promptEditorHint: document.getElementById('promptEditorHint'),
    systemPrompt: document.getElementById('systemPrompt'),
    userPrompt: document.getElementById('userPrompt'),
    maxTokens: document.getElementById('maxTokens'),
    maxItems: document.getElementById('maxItems'),
    maxConcurrent: document.getElementById('maxConcurrent'),
    maxConcurrentValue: document.getElementById('maxConcurrentValue'),
    temperature: document.getElementById('temperature'),
    temperatureValue: document.getElementById('temperatureValue'),
    useStructuredOutput: document.getElementById('useStructuredOutput'),
    plainTextFallback: document.getElementById('plainTextFallback'),
    showGlow: document.getElementById('showGlow'),
    cacheModePickerEl: document.getElementById('cacheModePickerEl'),
    cacheModeTrigger: document.getElementById('cacheModeTrigger'),
    cacheModeTriggerLabel: document.getElementById('cacheModeTriggerLabel'),
    cacheModeMenu: document.getElementById('cacheModeMenu'),
    cacheModeList: document.getElementById('cacheModeList'),
    cacheBackendWarning: document.getElementById('cacheBackendWarning'),
    clearCache: document.getElementById('clearCache'),
    cacheCount: document.getElementById('cacheCount'),
    debugLogging: document.getElementById('debugLogging'),
    useGlossary: document.getElementById('useGlossary'),
    glossarySettings: document.getElementById('glossarySettings'),
    // new glossary UI elements
    glossaryTargetLangPickerEl: document.getElementById('glossaryTargetLangPickerEl'),
    glossaryTargetLangTrigger: document.getElementById('glossaryTargetLangTrigger'),
    glossaryTargetLangTriggerLabel: document.getElementById('glossaryTargetLangTriggerLabel'),
    glossaryTargetLangMenu: document.getElementById('glossaryTargetLangMenu'),
    glossaryTargetLangList: document.getElementById('glossaryTargetLangList'),
    glossaryRows: document.getElementById('glossaryRows'),
    glossaryFilter: document.getElementById('glossaryFilter'),
    glossaryRowsNote: document.getElementById('glossaryRowsNote'),
    glossaryStatusBadge: document.getElementById('glossaryStatusBadge'),
    glossaryTargetInfo: document.getElementById('glossaryTargetInfo'),
    glossaryUnsavedHint: document.getElementById('glossaryUnsavedHint'),
    newTermSource: document.getElementById('newTermSource'),
    newTermTarget: document.getElementById('newTermTarget'),
    addGlossaryTerm: document.getElementById('addGlossaryTerm'),
    saveGlossary: document.getElementById('saveGlossary'),
    clearGlossary: document.getElementById('clearGlossary'),
    glossaryImportFile: document.getElementById('glossaryImportFile'),
    glossaryExportBtn: document.getElementById('glossaryExportBtn'),
    floatingButton: document.getElementById('floatingButton'),
    autoTranslatePages: document.getElementById('autoTranslatePages'),
    autoTranslateOptions: document.getElementById('autoTranslateOptions'),
    neverLanguagePickerEl: document.getElementById('neverLanguagePickerEl'),
    neverLanguageTrigger: document.getElementById('neverLanguageTrigger'),
    neverLanguageTriggerLabel: document.getElementById('neverLanguageTriggerLabel'),
    neverLanguageMenu: document.getElementById('neverLanguageMenu'),
    neverLanguagePickerList: document.getElementById('neverLanguagePickerList'),
    addNeverLanguage: document.getElementById('addNeverLanguage'),
    neverLanguageList: document.getElementById('neverLanguageList'),
    neverSiteInput: document.getElementById('neverSiteInput'),
    addNeverSite: document.getElementById('addNeverSite'),
    neverSiteList: document.getElementById('neverSiteList'),
    translateGemmaHelp: document.getElementById('translateGemmaHelp'),
    copyTemplate: document.getElementById('copyTemplate'),
    saveSettings: document.getElementById('saveSettings'),
    resetSettings: document.getElementById('resetSettings'),
    toast: document.getElementById('toast')
};

let currentSettings = { ...DEFAULT_SETTINGS };

// ============================================================================
// Shared dropdown picker: a searchable list with pinnable items. Mirrors the
// popup's picker (popup.js) so the Model and Target Language controls here
// look and behave the same as their popup counterparts.
// ============================================================================
const PIN_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';

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
            const sel = els.list.querySelector('.lang-option.selected');
            if (sel) sel.scrollIntoView({ block: 'nearest' });
        },

        close() {
            this.open = false;
            els.picker.classList.remove('open');
            els.menu.hidden = true;
            els.trigger.setAttribute('aria-expanded', 'false');
        },

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

// ============================================================================
// Lightweight dropdown for plain value/label selects (no search box, no pinning)
// — a styled stand-in for <select> so every dropdown on this page looks and
// behaves the same way. Options are computed live via getOptions() each time
// the menu opens, so callers can change what's offered (e.g. a disabled entry)
// without having to rebuild the picker.
// ============================================================================
function createSimpleSelect(config) {
    const { els, getOptions } = config;

    return {
        value: config.initialValue ?? '',
        open: false,
        activeIndex: -1,
        visibleValues: [],
        onChange: null, // (value) => void

        init() {
            els.trigger.addEventListener('click', () => this.toggle());
            els.trigger.addEventListener('keydown', (e) => this.handleKeydown(e));
            document.addEventListener('click', (e) => {
                if (this.open && !els.picker.contains(e.target)) this.close();
            });
        },

        getValue() { return this.value; },

        setValue(value) {
            this.value = value;
            const opt = (getOptions() || []).find(o => o.value === value);
            els.label.textContent = opt ? opt.label : (config.placeholder || '');
        },

        select(value) {
            this.setValue(value);
            this.close();
            els.trigger.focus();
            if (this.onChange) this.onChange(value);
        },

        toggle() { this.open ? this.close() : this.openMenu(); },

        openMenu() {
            this.open = true;
            els.picker.classList.add('open');
            els.menu.hidden = false;
            els.trigger.setAttribute('aria-expanded', 'true');
            this.activeIndex = -1;
            this.render();
            const sel = els.list.querySelector('.lang-option.selected');
            if (sel) sel.scrollIntoView({ block: 'nearest' });
        },

        close() {
            this.open = false;
            els.picker.classList.remove('open');
            els.menu.hidden = true;
            els.trigger.setAttribute('aria-expanded', 'false');
        },

        render() {
            const options = (getOptions() || []);
            const list = els.list;
            list.innerHTML = '';
            this.visibleValues = [];
            options.forEach(opt => {
                const disabled = !!opt.disabled;
                const li = document.createElement('li');
                li.className = 'lang-option' + (opt.value === this.value ? ' selected' : '') + (disabled ? ' disabled' : '');
                li.setAttribute('role', 'option');
                li.dataset.id = opt.value;
                if (opt.value === this.value) li.setAttribute('aria-selected', 'true');
                if (disabled) li.setAttribute('aria-disabled', 'true');

                const nameEl = document.createElement('span');
                nameEl.className = 'lang-option-name';
                nameEl.textContent = opt.label;
                li.appendChild(nameEl);

                if (!disabled) {
                    li.addEventListener('click', () => this.select(opt.value));
                    const idx = this.visibleValues.length;
                    li.addEventListener('mousemove', () => {
                        if (this.activeIndex !== idx) { this.activeIndex = idx; this.updateActive(); }
                    });
                    this.visibleValues.push(opt.value);
                }
                list.appendChild(li);
            });
            this.updateActive();
        },

        updateActive() {
            const rows = els.list.querySelectorAll('.lang-option:not(.disabled)');
            rows.forEach((row, i) => {
                const active = i === this.activeIndex;
                row.classList.toggle('active', active);
                if (active) row.scrollIntoView({ block: 'nearest' });
            });
        },

        handleKeydown(e) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (!this.open) { this.openMenu(); return; }
                if (this.visibleValues.length) {
                    this.activeIndex = Math.min(this.activeIndex + 1, this.visibleValues.length - 1);
                    this.updateActive();
                }
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (this.open && this.visibleValues.length) {
                    this.activeIndex = Math.max(this.activeIndex - 1, 0);
                    this.updateActive();
                }
            } else if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (!this.open) { this.openMenu(); return; }
                const idx = this.activeIndex >= 0 ? this.activeIndex : 0;
                const value = this.visibleValues[idx];
                if (value !== undefined) this.select(value);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.close();
            }
        }
    };
}

// Full language list as { value, label } options, sorted by display name —
// shared by every simple-select that offers a language choice.
function sortedLanguageOptions() {
    return Object.entries(LANGUAGES)
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([code, name]) => ({ value: code, label: name }));
}

// Target-language picker: items are [code, name] entries from LANGUAGES.
const langPicker = createPicker({
    els: {
        picker: elements.targetLangPickerEl,
        trigger: elements.targetLangTrigger,
        label: elements.targetLangTriggerLabel,
        menu: elements.targetLangMenu,
        search: elements.targetLangSearch,
        list: elements.targetLangList,
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
modelPicker.setModels = function (models) {
    this.allModels = models;
    const ids = new Set(models.map(m => m.id));
    this.pinned = this.pinned.filter(id => ids.has(id));
};

function initTargetLangPicker() {
    langPicker.onChange = (code) => {
        currentSettings.targetLanguage = code;
    };
    langPicker.onPinnedChange = (pinned) => {
        currentSettings.pinnedLanguages = pinned;
        saveCurrentSettings();
    };
    langPicker.init();
}

function initModelPicker() {
    modelPicker.onChange = (id) => {
        currentSettings.selectedModel = id;
        updateFormatDescription(requestFormatPicker.getValue());
        updateVisibility();
    };
    modelPicker.onPinnedChange = (pinned) => {
        currentSettings.pinnedModels = pinned;
        saveCurrentSettings();
    };
    modelPicker.init();
}

// ============================================================================
// Simple-select pickers: provider, source language, request format, cache
// mode, glossary target language, and the "never auto-translate" language
// combo. None of these need search or pinning, just a styled stand-in for
// the plain <select> they used to be.
// ============================================================================

const PROVIDER_OPTIONS = [
    { value: 'auto', label: 'Auto-detect' },
    { value: 'ollama', label: 'Ollama' },
    { value: 'lmstudio', label: 'LM Studio / OpenAI-compatible' },
];

const providerPicker = createSimpleSelect({
    els: {
        picker: elements.providerPickerEl,
        trigger: elements.providerTrigger,
        label: elements.providerTriggerLabel,
        menu: elements.providerMenu,
        list: elements.providerList,
    },
    getOptions: () => PROVIDER_OPTIONS,
    initialValue: 'auto',
});

const sourceLanguagePicker = createSimpleSelect({
    els: {
        picker: elements.sourceLanguagePickerEl,
        trigger: elements.sourceLanguageTrigger,
        label: elements.sourceLanguageTriggerLabel,
        menu: elements.sourceLanguageMenu,
        list: elements.sourceLanguageList,
    },
    getOptions: () => [{ value: 'auto', label: 'Auto-detect from page' }, ...sortedLanguageOptions()],
    initialValue: 'auto',
});

const REQUEST_FORMAT_OPTIONS = [
    { value: 'auto', label: 'Auto (detect from model)' },
    { value: 'default', label: 'Default (JSON output)' },
    { value: 'translategemma', label: 'TranslateGemma' },
    { value: 'hunyuan', label: 'Hunyuan-MT' },
    { value: 'simple', label: 'Simple (Line-by-line)' },
    { value: 'custom', label: 'Custom' },
];

const requestFormatPicker = createSimpleSelect({
    els: {
        picker: elements.requestFormatPickerEl,
        trigger: elements.requestFormatTrigger,
        label: elements.requestFormatTriggerLabel,
        menu: elements.requestFormatMenu,
        list: elements.requestFormatList,
    },
    getOptions: () => REQUEST_FORMAT_OPTIONS,
    initialValue: 'auto',
});

// Greyed out (not removed) when the browser can't persist IndexedDB — see refreshCacheBackend().
let cachePersistentAvailable = true;

const cacheModePicker = createSimpleSelect({
    els: {
        picker: elements.cacheModePickerEl,
        trigger: elements.cacheModeTrigger,
        label: elements.cacheModeTriggerLabel,
        menu: elements.cacheModeMenu,
        list: elements.cacheModeList,
    },
    getOptions: () => [
        { value: 'off', label: "Don't cache" },
        { value: 'session', label: 'Until I close the browser' },
        { value: 'persistent', label: 'Keep across sessions', disabled: !cachePersistentAvailable },
    ],
    initialValue: 'off',
});

const glossaryTargetLangPicker = createSimpleSelect({
    els: {
        picker: elements.glossaryTargetLangPickerEl,
        trigger: elements.glossaryTargetLangTrigger,
        label: elements.glossaryTargetLangTriggerLabel,
        menu: elements.glossaryTargetLangMenu,
        list: elements.glossaryTargetLangList,
    },
    getOptions: () => [{ value: '', label: 'Any language (always apply)' }, ...sortedLanguageOptions()],
    initialValue: '',
});

const neverLanguagePicker = createSimpleSelect({
    els: {
        picker: elements.neverLanguagePickerEl,
        trigger: elements.neverLanguageTrigger,
        label: elements.neverLanguageTriggerLabel,
        menu: elements.neverLanguageMenu,
        list: elements.neverLanguagePickerList,
    },
    getOptions: () => sortedLanguageOptions(),
    initialValue: (sortedLanguageOptions()[0] || {}).value || '',
});

function initSimpleSelects() {
    providerPicker.init();
    sourceLanguagePicker.init();
    requestFormatPicker.onChange = (value) => {
        updateFormatDescription(value);
        updateVisibility();
    };
    requestFormatPicker.init();
    cacheModePicker.init();
    glossaryTargetLangPicker.init();
    neverLanguagePicker.init();
    // Paint the trigger label for the default selection picked at construction time.
    neverLanguagePicker.setValue(neverLanguagePicker.getValue());
}

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
    initTargetLangPicker();
    initModelPicker();
    initSimpleSelects();
    await loadSettings();
    applySettingsToUI();
    initPromptEditors(); // Initialize editors
    await loadModels();
    setupEventListeners();
    await refreshGlossaryStatus();
    initSidebarScrollspy();
    refreshCacheCount();
    refreshCacheBackend();

    // The options page opens in a persistent tab, so init() only runs once. Refresh
    // the cached-entry count whenever the tab is re-focused (e.g. after translating
    // a page in another tab) so it doesn't show a stale value.
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) refreshCacheCount();
    });
}

// Grey out "Keep across sessions" when the browser blocks IndexedDB (e.g. hardened
// Firefox forks like Mullvad/Tor), since persistence can't work there.
async function refreshCacheBackend() {
    let persistent = true;
    try {
        const res = await browserAPI.runtime.sendMessage({ type: 'CACHE_BACKEND' });
        persistent = !(res && res.persistent === false);
    } catch (e) { /* assume available on error */ }

    cachePersistentAvailable = persistent;
    if (elements.cacheBackendWarning) elements.cacheBackendWarning.hidden = persistent;
    // If persistence isn't available but it was the saved choice, fall back to session.
    if (!persistent && cacheModePicker.getValue() === 'persistent') {
        cacheModePicker.setValue('session');
        currentSettings.cacheMode = 'session';
    }
}

// Show how many translations are currently cached.
async function refreshCacheCount() {
    if (!elements.cacheCount) return;
    try {
        const res = await browserAPI.runtime.sendMessage({ type: 'CACHE_COUNT' });
        elements.cacheCount.textContent = (res && typeof res.count === 'number') ? res.count.toLocaleString() : '0';
    } catch (e) {
        elements.cacheCount.textContent = '0';
    }
}

// Load available models from providers
async function loadModels() {
    if (!elements.modelTrigger) return;

    elements.modelTrigger.disabled = true;
    elements.modelTriggerLabel.textContent = 'Loading models...';
    try {
        const response = await browserAPI.runtime.sendMessage({ type: 'LIST_MODELS' });
        const models = response.models || [];

        modelPicker.setModels(models);
        modelPicker.setPinned(currentSettings.pinnedModels || []);

        if (models.length === 0) {
            elements.modelTriggerLabel.textContent = 'No models found';
        } else {
            // Select current model if still available, else the first one
            const targetId = currentSettings.selectedModel && models.some(m => m.id === currentSettings.selectedModel)
                ? currentSettings.selectedModel
                : models[0].id;
            modelPicker.setValue(targetId);
            currentSettings.selectedModel = targetId;

            // Refresh the "Auto → detected format" hint for the selected model
            updateFormatDescription(requestFormatPicker.getValue());
            updateVisibility();
        }
    } catch (e) {
        console.error('Failed to load models:', e);
        elements.modelTriggerLabel.textContent = 'Error loading models';
    } finally {
        elements.modelTrigger.disabled = false;
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
    providerPicker.setValue(currentSettings.provider);
    elements.ollamaUrl.value = currentSettings.ollamaUrl;
    elements.lmstudioUrl.value = currentSettings.lmstudioUrl;
    elements.filterLlamaCppUiModels.checked = !!currentSettings.filterLlamaCppUiModels;
    sourceLanguagePicker.setValue(currentSettings.sourceLanguage || 'auto');
    langPicker.setPinned(currentSettings.pinnedLanguages || []);
    langPicker.setValue(currentSettings.targetLanguage);
    requestFormatPicker.setValue(currentSettings.requestFormat);
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
    if (elements.plainTextFallback) elements.plainTextFallback.checked = currentSettings.plainTextFallback !== false;
    elements.showGlow.checked = currentSettings.showGlow !== false;
    cacheModePicker.setValue(currentSettings.cacheMode || 'off');
    elements.debugLogging.checked = !!currentSettings.debug;
    if (elements.useGlossary) elements.useGlossary.checked = currentSettings.useGlossary !== false;
    updateGlossaryVisibility();
    elements.floatingButton.checked = !!currentSettings.floatingButton;
    if (elements.autoTranslatePages) {
        elements.autoTranslatePages.checked = !!currentSettings.autoTranslatePages;
    }
    renderAutoTranslateLists();

    // Update format description
    updateFormatDescription(currentSettings.requestFormat);

    // Show/hide sections based on format
    updateVisibility();
}

// The effective format = the explicit choice, or (for 'auto') the one detected
// from the selected model. resolveRequestFormat/detectRequestFormat come from languages.js.
function getEffectiveFormat() {
    const modelId = modelPicker.getValue() || currentSettings.selectedModel;
    return resolveRequestFormat({ requestFormat: requestFormatPicker.getValue() }, modelId);
}

// In-memory drafts of per-format prompt edits, keyed by format, plus which
// format the editor is currently showing. Edits aren't written into
// currentSettings.customPrompts until Save — but switching formats before
// saving would otherwise blow away whatever was just typed, since the same
// pair of textareas is reused for every format. Capturing into promptDrafts
// on every switch (and reading it back if the user returns) avoids that.
let promptDrafts = {};
let activePromptFormat = null;

// Update format description and prompt editor. 'auto' has no single template —
// it resolves to a concrete format per model — so the editor is hidden while
// it's selected. For any concrete format, shows (in priority order) an
// in-progress draft, then a saved override, then the built-in template.
function updateFormatDescription(format) {
    let desc = FORMAT_DESCRIPTIONS[format] || '';
    if (format === 'auto' && (modelPicker.getValue() || currentSettings.selectedModel)) {
        desc += ` Detected for this model: ${getEffectiveFormat()}.`;
    }
    elements.formatDescription.textContent = desc;

    if (elements.promptEditor) elements.promptEditor.hidden = (format === 'auto');
    if (format === 'auto') {
        activePromptFormat = 'auto';
        return;
    }

    // Already showing this format — nothing to (re)populate, and doing so
    // anyway would stomp an in-progress edit on every unrelated refresh
    // (e.g. picking a different model while the editor is open).
    if (activePromptFormat === format) return;

    if (activePromptFormat && activePromptFormat !== 'auto' && elements.systemPrompt && elements.userPrompt) {
        promptDrafts[activePromptFormat] = {
            system: elements.systemPrompt.value,
            user: elements.userPrompt.value,
        };
    }

    if (elements.systemPrompt && elements.userPrompt) {
        const draft = promptDrafts[format];
        const override = currentSettings.customPrompts && currentSettings.customPrompts[format];
        const builtin = PROMPT_TEMPLATES[format] || PROMPT_TEMPLATES.default;
        const source = draft || override || builtin;
        elements.systemPrompt.value = source.system || '';
        elements.userPrompt.value = source.user || '';
        elements.systemPrompt.dispatchEvent(new Event('input'));
        elements.userPrompt.dispatchEvent(new Event('input'));
    }
    if (elements.promptEditorHint) {
        elements.promptEditorHint.textContent =
            `Saved edits are used whenever "${format}" is active, including when Auto detects it.`;
    }
    activePromptFormat = format;
}

// Update visibility of sections based on the effective format.
function updateVisibility() {
    const effective = getEffectiveFormat();

    // TranslateGemma help — when the effective format is translategemma
    elements.translateGemmaHelp.hidden = effective !== 'translategemma';

    // Source language only matters for TranslateGemma's prompt
    if (elements.sourceLanguageGroup) {
        elements.sourceLanguageGroup.hidden = effective !== 'translategemma';
    }

    // Structured JSON output is meaningless for plain-text formats; grey it out.
    elements.useStructuredOutput.disabled = PLAIN_TEXT_FORMATS.has(effective);
}

// Save current settings
async function saveCurrentSettings() {
    // Whatever's currently in the editor belongs to activePromptFormat and hasn't
    // been captured into promptDrafts yet unless the user already switched away
    // from it (updateFormatDescription does that capture on every switch).
    if (activePromptFormat && activePromptFormat !== 'auto' && elements.systemPrompt && elements.userPrompt) {
        promptDrafts[activePromptFormat] = {
            system: elements.systemPrompt.value,
            user: elements.userPrompt.value,
        };
    }

    currentSettings = {
        ...currentSettings,
        provider: providerPicker.getValue(),
        ollamaUrl: elements.ollamaUrl.value,
        lmstudioUrl: elements.lmstudioUrl.value,
        filterLlamaCppUiModels: elements.filterLlamaCppUiModels.checked,
        selectedModel: modelPicker.getValue() || currentSettings.selectedModel,
        pinnedModels: [...modelPicker.pinned],
        sourceLanguage: sourceLanguagePicker.getValue(),
        targetLanguage: langPicker.getValue(),
        pinnedLanguages: [...langPicker.pinned],
        requestFormat: requestFormatPicker.getValue(),
        maxTokensPerBatch: parseInt(elements.maxTokens.value) || 2000,
        maxItemsPerBatch: parseInt(elements.maxItems.value) || 8,
        maxConcurrentRequests: parseInt(elements.maxConcurrent?.value) || 4,
        temperature: parseFloat(elements.temperature.value) || 0.3,
        useStructuredOutput: elements.useStructuredOutput.checked,
        plainTextFallback: elements.plainTextFallback ? elements.plainTextFallback.checked : true,
        showGlow: elements.showGlow.checked,
        cacheMode: cacheModePicker.getValue() || 'off',
        debug: elements.debugLogging.checked,
        useGlossary: elements.useGlossary ? elements.useGlossary.checked : false,
        floatingButton: elements.floatingButton.checked,
        // Merge in this session's prompt edits, keyed by the format each one belongs to.
        customPrompts: { ...currentSettings.customPrompts, ...promptDrafts }
    };

    await browserAPI.runtime.sendMessage({
        type: 'SAVE_SETTINGS',
        settings: currentSettings
    });
}

// Parse a TSV glossary into { entries: Array<[source, target]>, target: string }.
// One entry per line: `source<TAB>translation`. A missing/empty second column
// means "keep as-is". Lines starting with '#' and blank lines are skipped,
// except a `#target: xx` directive, which declares the language the glossary
// translates INTO — it is then only applied when translating to that language.
// Duplicate sources keep the last occurrence.
function parseGlossaryTSV(text) {
    const bySource = new Map();
    let target = '';
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
        if (!line) continue;
        if (line[0] === '#') {
            const directive = line.match(/^#\s*target\s*:\s*([A-Za-z-]+)/i);
            if (directive) target = directive[1].split('-')[0].toLowerCase();
            continue;
        }
        const tab = line.indexOf('\t');
        const source = (tab === -1 ? line : line.slice(0, tab)).trim();
        if (!source) continue;
        bySource.set(source, tab === -1 ? '' : line.slice(tab + 1).trim());
    }
    return { entries: [...bySource.entries()], target };
}

// ============================================================================
// Inline glossary editor state
// ============================================================================

// Working copy of the *entire* glossary. Saving writes this array back verbatim,
// so it must always hold every stored term — never a truncated preview.
// Each item: { source: string, target: string }
let glossaryEditorRows = [];
let glossaryEditorDirty = false;
let glossaryEditorTargetLang = ''; // from loaded TSV / storage meta
// False until the full dictionary has been read back from the background. Saving
// while false would overwrite the stored glossary with an incomplete list.
let glossaryEditorLoaded = false;

// Rows are edited in memory but only this many are put in the DOM at once —
// a 20k-term dictionary would otherwise mean 60k input elements. The filter box
// is how users reach terms past the cap.
const GLOSSARY_RENDER_MAX = 300;

function markGlossaryDirty() {
    glossaryEditorDirty = true;
    if (elements.glossaryUnsavedHint) elements.glossaryUnsavedHint.hidden = false;
}

function markGlossaryClean() {
    glossaryEditorDirty = false;
    if (elements.glossaryUnsavedHint) elements.glossaryUnsavedHint.hidden = true;
}

// Render glossaryEditorRows into the DOM table, honouring the filter box and
// the render cap. Handlers close over the row's index in the *full* array, so
// editing a filtered view still writes to the right entry.
function renderGlossaryRows() {
    const container = elements.glossaryRows;
    if (!container) return;

    const query = (elements.glossaryFilter ? elements.glossaryFilter.value : '').trim().toLowerCase();
    const matches = [];
    for (let idx = 0; idx < glossaryEditorRows.length; idx++) {
        const entry = glossaryEditorRows[idx];
        if (!query
            || entry.source.toLowerCase().includes(query)
            || entry.target.toLowerCase().includes(query)) {
            matches.push(idx);
        }
    }

    const shown = matches.slice(0, GLOSSARY_RENDER_MAX);
    container.replaceChildren();
    for (const idx of shown) {
        const entry = glossaryEditorRows[idx];
        const row = document.createElement('div');
        row.className = 'glossary-row';

        const srcInput = document.createElement('input');
        srcInput.type = 'text';
        srcInput.value = entry.source;
        srcInput.placeholder = 'Source term';
        srcInput.addEventListener('input', () => {
            glossaryEditorRows[idx].source = srcInput.value;
            markGlossaryDirty();
        });

        const tgtInput = document.createElement('input');
        tgtInput.type = 'text';
        tgtInput.value = entry.target;
        tgtInput.placeholder = '(keep as-is)';
        tgtInput.addEventListener('input', () => {
            glossaryEditorRows[idx].target = tgtInput.value;
            markGlossaryDirty();
        });

        const delBtn = document.createElement('button');
        delBtn.className = 'glossary-row-delete';
        delBtn.textContent = '×';
        delBtn.title = 'Remove term';
        delBtn.addEventListener('click', () => {
            glossaryEditorRows.splice(idx, 1);
            markGlossaryDirty();
            renderGlossaryRows();
        });

        row.append(srcInput, tgtInput, delBtn);
        container.appendChild(row);
    }

    updateGlossaryRowsNote(matches.length, shown.length, !!query);
}

// Line under the table explaining what the visible rows represent, so a capped
// or filtered view is never mistaken for the whole dictionary.
function updateGlossaryRowsNote(matchCount, shownCount, filtered) {
    const note = elements.glossaryRowsNote;
    if (!note) return;
    const total = glossaryEditorRows.length;

    if (!total) {
        note.textContent = 'No terms yet. Add one below or import a TSV.';
    } else if (filtered && shownCount < matchCount) {
        note.textContent = `Showing ${shownCount} of ${matchCount.toLocaleString()} matches (${total.toLocaleString()} terms total). Narrow the filter to see the rest.`;
    } else if (filtered) {
        note.textContent = `${matchCount.toLocaleString()} of ${total.toLocaleString()} terms match.`;
    } else if (shownCount < total) {
        note.textContent = `Showing the first ${shownCount} of ${total.toLocaleString()} terms. Use the filter to reach the others; all ${total.toLocaleString()} are kept when you save.`;
    } else {
        note.textContent = `${total.toLocaleString()} term${total === 1 ? '' : 's'}.`;
    }
    note.hidden = false;
}

// Show/hide the glossary editor and its controls — kept collapsed to just the
// toggle when the feature is off so it doesn't clutter the page for users who
// don't use it.
function updateGlossaryVisibility() {
    if (elements.glossarySettings) {
        elements.glossarySettings.hidden = !(elements.useGlossary && elements.useGlossary.checked);
    }
}

// Update the badge showing term count above the table.
function updateGlossaryBadge(count) {
    if (!elements.glossaryStatusBadge) return;
    if (!count) {
        elements.glossaryStatusBadge.textContent = '0 terms';
        elements.glossaryStatusBadge.className = 'glossary-badge';
    } else {
        elements.glossaryStatusBadge.textContent = `${count.toLocaleString()} term${count === 1 ? '' : 's'}`;
        elements.glossaryStatusBadge.className = 'glossary-badge loaded';
    }
}

// Load the full glossary from the background service and populate the editor.
async function refreshGlossaryStatus() {
    let res = null;
    try {
        res = await browserAPI.runtime.sendMessage({ type: 'GET_GLOSSARY_ENTRIES' });
    } catch (e) { /* background not ready */ }

    if (!res || !Array.isArray(res.entries)) {
        // Couldn't read the dictionary. Leave the editor empty but locked, so a
        // stray Save can't wipe terms we simply failed to load.
        glossaryEditorLoaded = false;
        glossaryEditorRows = [];
        renderGlossaryRows();
        updateGlossaryBadge(0);
        if (elements.glossaryRowsNote) {
            elements.glossaryRowsNote.textContent = 'Could not load the glossary. Reload this page to try again.';
        }
        markGlossaryClean();
        return;
    }

    glossaryEditorLoaded = true;
    glossaryEditorTargetLang = res.target || '';
    glossaryEditorRows = res.entries.map(([source, target]) => ({ source, target: target || '' }));
    renderGlossaryRows();
    updateGlossaryBadge(glossaryEditorRows.length);
    // Sync the target language dropdown
    glossaryTargetLangPicker.setValue(glossaryEditorTargetLang || '');
    markGlossaryClean();
}

// Show toast notification
function showToast(message, type = 'success', duration = 3000) {
    const toast = elements.toast;
    const icon = toast.querySelector('.toast-icon');
    const msg = toast.querySelector('.toast-message');

    icon.textContent = type === 'success' ? '✅' : type === 'error' ? '❌' : '⚠️';
    msg.textContent = message;

    toast.classList.add('show');
    setTimeout(() => {
        toast.classList.remove('show');
    }, duration);
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

    // (Request format selection is handled by requestFormatPicker.onChange.)
    // (Model selection is handled by modelPicker.onChange.)

    // Refresh models
    if (elements.refreshModels) {
        elements.refreshModels.addEventListener('click', async () => {
            await loadModels();
            showToast('Models refreshed');
        });
    }

    elements.filterLlamaCppUiModels.addEventListener('change', async () => {
        currentSettings.filterLlamaCppUiModels = elements.filterLlamaCppUiModels.checked;
        await browserAPI.runtime.sendMessage({
            type: 'SAVE_SETTINGS',
            settings: { filterLlamaCppUiModels: currentSettings.filterLlamaCppUiModels }
        });
        await loadModels();
    });

    // Save settings
    elements.saveSettings.addEventListener('click', async () => {
        // Request host permission for any non-localhost server URL (opt-in).
        // Must run inside this click gesture, before any other awaits.
        const granted = await ensureHostPermissions([
            elements.ollamaUrl.value,
            elements.lmstudioUrl.value
        ]);
        await saveCurrentSettings();
        if (!granted) {
            showToast('Saved, but permission for the custom server was denied. Remote models won\'t load until you allow it.', 'error', 5000);
        } else {
            showToast('Settings saved!');
        }
    });

    // Reset settings
    elements.resetSettings.addEventListener('click', async () => {
        currentSettings = { ...DEFAULT_SETTINGS };
        promptDrafts = {};
        activePromptFormat = null;
        await browserAPI.runtime.sendMessage({
            type: 'SAVE_SETTINGS',
            settings: currentSettings
        });
        applySettingsToUI();
        await loadModels();
        showToast('Settings reset to defaults');
    });

    // Clear translation cache
    if (elements.clearCache) {
        elements.clearCache.addEventListener('click', async () => {
            try {
                await browserAPI.runtime.sendMessage({ type: 'CLEAR_CACHE' });
                await refreshCacheCount();
                showToast('Translation cache cleared');
            } catch (e) {
                showToast('Failed to clear cache', 'error');
            }
        });
    }

    // Glossary: collapse/expand the editor immediately when toggled
    if (elements.useGlossary) {
        elements.useGlossary.addEventListener('change', updateGlossaryVisibility);
    }

    // Glossary: filter the visible rows
    if (elements.glossaryFilter) {
        elements.glossaryFilter.addEventListener('input', renderGlossaryRows);
    }

    // Glossary: add a new row via the bottom input bar
    if (elements.addGlossaryTerm) {
        const doAdd = () => {
            const src = elements.newTermSource.value.trim();
            if (!src) return;
            const tgt = elements.newTermTarget.value.trim();
            // Prevent duplicate sources
            const existing = glossaryEditorRows.findIndex(r => r.source === src);
            if (existing !== -1) {
                glossaryEditorRows[existing].target = tgt;
            } else {
                glossaryEditorRows.push({ source: src, target: tgt });
            }
            elements.newTermSource.value = '';
            elements.newTermTarget.value = '';
            elements.newTermSource.focus();
            markGlossaryDirty();

            // A filtered or capped view may not include the row we just added.
            // Filter down to it so the user can see what happened.
            const filterActive = elements.glossaryFilter && elements.glossaryFilter.value.trim();
            if (filterActive || glossaryEditorRows.length > GLOSSARY_RENDER_MAX) {
                if (elements.glossaryFilter) elements.glossaryFilter.value = src;
            }
            renderGlossaryRows();
            // Scroll to bottom of the rows container
            if (elements.glossaryRows) elements.glossaryRows.scrollTop = elements.glossaryRows.scrollHeight;
        };
        elements.addGlossaryTerm.addEventListener('click', doAdd);
        // Allow pressing Enter in either input to add
        [elements.newTermSource, elements.newTermTarget].forEach(input => {
            if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });
        });
    }

    // Glossary: save the inline editor contents to storage
    if (elements.saveGlossary) {
        elements.saveGlossary.addEventListener('click', async () => {
            if (!glossaryEditorLoaded) {
                showToast('Glossary not loaded. Reload the page before saving', 'error');
                return;
            }
            const entries = glossaryEditorRows
                .filter(r => r.source.trim())
                .map(r => [r.source.trim(), r.target.trim()]);
            // Dedupe: last occurrence of a source wins
            const bySource = new Map(entries);
            const deduped = [...bySource.entries()];
            // Read target language from the dropdown
            const targetLang = glossaryTargetLangPicker.getValue();
            const res = await browserAPI.runtime.sendMessage({
                type: 'SAVE_GLOSSARY',
                entries: deduped,
                target: targetLang,
                name: 'inline editor'
            });
            if (res && res.ok) {
                glossaryEditorTargetLang = targetLang;
                await refreshGlossaryStatus();
                showToast(`Glossary saved: ${res.count} terms`);
            } else {
                showToast('Failed to save glossary', 'error');
            }
        });
    }

    // Glossary: clear all
    if (elements.clearGlossary) {
        elements.clearGlossary.addEventListener('click', async () => {
            if (!confirm('Clear all glossary terms?')) return;
            const res = await browserAPI.runtime.sendMessage({ type: 'CLEAR_GLOSSARY' });
            if (res && res.ok) {
                glossaryEditorTargetLang = '';
                await refreshGlossaryStatus();
                showToast('Glossary cleared');
            } else {
                showToast('Failed to clear glossary', 'error');
            }
        });
    }

    // Glossary: import from TSV file
    if (elements.glossaryImportFile) {
        elements.glossaryImportFile.addEventListener('change', async (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            if (!glossaryEditorLoaded) {
                showToast('Glossary not loaded. Reload the page before importing', 'error');
                e.target.value = '';
                return;
            }
            try {
                const text = await file.text();
                const { entries, target } = parseGlossaryTSV(text);
                if (!entries.length) {
                    showToast('No valid entries found in file', 'error');
                    return;
                }
                // Merge into editor: imported entries override existing ones with same source
                const merged = new Map(glossaryEditorRows.map(r => [r.source, r.target]));
                for (const [src, tgt] of entries) merged.set(src, tgt);
                glossaryEditorRows = [...merged.entries()].map(([source, target]) => ({ source, target }));
                if (target) glossaryEditorTargetLang = target;
                renderGlossaryRows();
                updateGlossaryBadge(glossaryEditorRows.length);
                markGlossaryDirty();
                showToast(`Imported ${entries.length} terms. Click Save to apply`);
            } catch (err) {
                showToast('Failed to read file', 'error');
            } finally {
                e.target.value = '';
            }
        });
    }

    // Glossary: export as TSV
    if (elements.glossaryExportBtn) {
        elements.glossaryExportBtn.addEventListener('click', () => {
            const lines = [];
            if (glossaryEditorTargetLang) lines.push(`#target: ${glossaryEditorTargetLang}`);
            for (const { source, target } of glossaryEditorRows) {
                if (source.trim()) lines.push(`${source}\t${target}`);
            }
            const blob = new Blob([lines.join('\n')], { type: 'text/tab-separated-values' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'glossary.tsv';
            a.click();
            URL.revokeObjectURL(url);
        });
    }

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

// ============================================================================
// Sidebar scrollspy — highlight the nav link matching the visible section
// ============================================================================
function initSidebarScrollspy() {
    const navLinks = document.querySelectorAll('.nav-link[data-section]');
    if (!navLinks.length) return;

    // Only sections that have a nav link. Observing the others (e.g. the
    // conditionally shown custom-prompts section) would clear the highlight
    // entirely whenever one of them scrolled into view.
    const sections = [...navLinks]
        .map(link => document.getElementById(link.dataset.section))
        .filter(Boolean);
    if (!sections.length) return;

    // Highlight the visible section nearest the top of the viewport rather than
    // whichever entry the observer happened to report last.
    const visible = new Set();
    const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (entry.isIntersecting) visible.add(entry.target);
            else visible.delete(entry.target);
        }
        if (!visible.size) return;
        const topmost = [...visible].reduce((best, el) =>
            el.getBoundingClientRect().top < best.getBoundingClientRect().top ? el : best);
        navLinks.forEach(link => {
            link.classList.toggle('active', link.dataset.section === topmost.id);
        });
    }, { threshold: 0.3 });

    sections.forEach(s => observer.observe(s));

    // Smooth-scroll on nav click
    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const target = document.getElementById(link.dataset.section);
            if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    });
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', init);

// ============================================================================
// All-sites permission management
//
// The floating button and auto-translate both need content.js present on every
// page. They share one <all_urls> grant and one script registration, so each
// toggle only persists its own setting and then asks the background to work out
// whether the script should still be registered.
// ============================================================================

// True once the setting is saved and (if needed) the permission is granted.
async function applyAllSitesFeature(settingKey, enabled) {
    if (enabled) {
        const granted = await browserAPI.permissions.request({ origins: ['<all_urls>'] });
        if (!granted) return false;
    }

    currentSettings[settingKey] = enabled;
    await browserAPI.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: currentSettings });
    await browserAPI.runtime.sendMessage({ type: 'SYNC_CONTENT_SCRIPT' });

    // Only hand the permission back when nothing else is still using it.
    if (!enabled && !currentSettings.floatingButton && !currentSettings.autoTranslatePages) {
        try {
            await browserAPI.permissions.remove({ origins: ['<all_urls>'] });
        } catch (e) {
            // Permission may already be absent
        }
    }
    return true;
}

// ============================================================================
// Auto-translate never-lists
// ============================================================================

// Render one removable chip per entry. Values come from user input, so they are
// written with textContent and never parsed as HTML.
function renderChipList(container, values, onRemove, labelFor) {
    if (!container) return;
    container.replaceChildren();
    if (!values.length) {
        const empty = document.createElement('span');
        empty.className = 'chip-empty';
        empty.textContent = 'None yet.';
        container.appendChild(empty);
        return;
    }
    values.forEach((value, idx) => {
        const chip = document.createElement('span');
        chip.className = 'chip';

        const text = document.createElement('span');
        text.textContent = labelFor ? labelFor(value) : value;

        const remove = document.createElement('button');
        remove.className = 'chip-remove';
        remove.type = 'button';
        remove.textContent = '×';
        remove.title = 'Remove';
        remove.addEventListener('click', () => onRemove(idx));

        chip.append(text, remove);
        container.appendChild(chip);
    });
}

function renderAutoTranslateLists() {
    const langs = Array.isArray(currentSettings.autoTranslateNeverLanguages)
        ? currentSettings.autoTranslateNeverLanguages
        : [];
    const sites = Array.isArray(currentSettings.autoTranslateNeverSites)
        ? currentSettings.autoTranslateNeverSites
        : [];

    renderChipList(elements.neverLanguageList, langs,
        (idx) => {
            langs.splice(idx, 1);
            currentSettings.autoTranslateNeverLanguages = langs;
            persistAutoTranslateLists();
        },
        (code) => (typeof LANGUAGES !== 'undefined' && LANGUAGES[code]) || code);

    renderChipList(elements.neverSiteList, sites, (idx) => {
        sites.splice(idx, 1);
        currentSettings.autoTranslateNeverSites = sites;
        persistAutoTranslateLists();
    });

    if (elements.autoTranslateOptions) {
        elements.autoTranslateOptions.hidden = !currentSettings.autoTranslatePages;
    }
}

async function persistAutoTranslateLists() {
    await browserAPI.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: currentSettings });
    renderAutoTranslateLists();
}

// The on-page banner can add sites while this tab is open. Pick those up so the
// next save from here doesn't write a stale list back over them.
browserAPI.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const updated = changes.settings.newValue;
    if (!updated) return;
    const sites = updated.autoTranslateNeverSites;
    if (!Array.isArray(sites)) return;
    const current = currentSettings.autoTranslateNeverSites || [];
    if (sites.length === current.length && sites.every((s, i) => s === current[i])) return;
    currentSettings.autoTranslateNeverSites = [...sites];
    renderAutoTranslateLists();
});

// Accepts a bare hostname or a pasted URL, and stores just the host.
function normalizeSiteEntry(raw) {
    let value = String(raw || '').trim().toLowerCase();
    if (!value) return '';
    if (value.includes('/') || value.includes(':')) {
        try {
            value = new URL(value.includes('://') ? value : 'http://' + value).hostname;
        } catch (e) {
            return '';
        }
    }
    return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(value) || value === 'localhost' ? value : '';
}

document.addEventListener('DOMContentLoaded', () => {
    elements.floatingButton.addEventListener('change', async (e) => {
        const enabled = e.target.checked;
        const ok = await applyAllSitesFeature('floatingButton', enabled);
        if (!ok) {
            elements.floatingButton.checked = false;
            showToast('Permission denied. Floating button not enabled', 'error');
            return;
        }
        showToast(enabled
            ? 'Floating button enabled. Reload pages to activate'
            : 'Floating button disabled');
    });

    if (elements.autoTranslatePages) {
        elements.autoTranslatePages.addEventListener('change', async (e) => {
            const enabled = e.target.checked;
            const ok = await applyAllSitesFeature('autoTranslatePages', enabled);
            if (!ok) {
                elements.autoTranslatePages.checked = false;
                showToast('Permission denied. Auto-translate not enabled', 'error');
                return;
            }
            renderAutoTranslateLists();
            showToast(enabled
                ? 'Auto-translate enabled. Reload pages to activate'
                : 'Auto-translate disabled');
        });
    }

    if (elements.addNeverLanguage) {
        elements.addNeverLanguage.addEventListener('click', () => {
            const code = neverLanguagePicker.getValue();
            if (!code) return;
            const langs = Array.isArray(currentSettings.autoTranslateNeverLanguages)
                ? currentSettings.autoTranslateNeverLanguages
                : [];
            if (langs.includes(code)) {
                showToast('Already in the list', 'warning');
                return;
            }
            langs.push(code);
            currentSettings.autoTranslateNeverLanguages = langs;
            persistAutoTranslateLists();
        });
    }

    if (elements.addNeverSite) {
        const addSite = () => {
            const host = normalizeSiteEntry(elements.neverSiteInput.value);
            if (!host) {
                showToast('Enter a hostname like example.com', 'error');
                return;
            }
            const sites = Array.isArray(currentSettings.autoTranslateNeverSites)
                ? currentSettings.autoTranslateNeverSites
                : [];
            if (sites.includes(host)) {
                showToast('Already in the list', 'warning');
                return;
            }
            sites.push(host);
            currentSettings.autoTranslateNeverSites = sites;
            elements.neverSiteInput.value = '';
            persistAutoTranslateLists();
        };
        elements.addNeverSite.addEventListener('click', addSite);
        elements.neverSiteInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); addSite(); }
        });
    }
});

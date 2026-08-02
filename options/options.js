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
    requestFormat: 'auto',
    temperature: 0.3,
    useStructuredOutput: true,
    maxOutputRetries: 2,
    plainTextFallback: true,
    showGlow: false,  // Disabled by default
    useGlossary: true,
    cacheMode: 'off'
};

// Format descriptions
const FORMAT_DESCRIPTIONS = {
    auto: 'Picks the right format automatically based on the selected model.',
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
    plainTextFallback: document.getElementById('plainTextFallback'),
    showGlow: document.getElementById('showGlow'),
    cacheMode: document.getElementById('cacheMode'),
    cacheBackendWarning: document.getElementById('cacheBackendWarning'),
    clearCache: document.getElementById('clearCache'),
    cacheCount: document.getElementById('cacheCount'),
    debugLogging: document.getElementById('debugLogging'),
    useGlossary: document.getElementById('useGlossary'),
    // new glossary UI elements
    glossaryTargetLang: document.getElementById('glossaryTargetLang'),
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
    if (!elements.cacheMode) return;
    let persistent = true;
    try {
        const res = await browserAPI.runtime.sendMessage({ type: 'CACHE_BACKEND' });
        persistent = !(res && res.persistent === false);
    } catch (e) { /* assume available on error */ }

    const opt = elements.cacheMode.querySelector('option[value="persistent"]');
    if (opt) opt.disabled = !persistent;
    if (elements.cacheBackendWarning) elements.cacheBackendWarning.hidden = persistent;
    // If persistence isn't available but it was the saved choice, fall back to session.
    if (!persistent && elements.cacheMode.value === 'persistent') {
        elements.cacheMode.value = 'session';
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

            // Refresh the "Auto → detected format" hint for the selected model
            updateFormatDescription(elements.requestFormat.value);
            updateVisibility();
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

    // Glossary target language dropdown
    if (elements.glossaryTargetLang) {
        // Keep the first "Any language" option already in the HTML
        for (const [code, name] of sortedLangs) {
            const option = document.createElement('option');
            option.value = code;
            option.textContent = name;
            elements.glossaryTargetLang.appendChild(option);
        }
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
    if (elements.plainTextFallback) elements.plainTextFallback.checked = currentSettings.plainTextFallback !== false;
    elements.showGlow.checked = currentSettings.showGlow !== false;
    if (elements.cacheMode) elements.cacheMode.value = currentSettings.cacheMode || 'off';
    elements.debugLogging.checked = !!currentSettings.debug;
    if (elements.useGlossary) elements.useGlossary.checked = currentSettings.useGlossary !== false;
    elements.floatingButton.checked = !!currentSettings.floatingButton;
    elements.customSystem.value = currentSettings.customSystemPrompt || '';
    elements.customUser.value = currentSettings.customUserPromptTemplate || '';

    // Update format description
    updateFormatDescription(currentSettings.requestFormat);

    // Show/hide sections based on format
    updateVisibility();
}

// The effective format = the explicit choice, or (for 'auto') the one detected
// from the selected model. resolveRequestFormat/detectRequestFormat come from languages.js.
function getEffectiveFormat() {
    const modelId = elements.modelSelect?.value || currentSettings.selectedModel;
    return resolveRequestFormat({ requestFormat: elements.requestFormat.value }, modelId);
}

// Update format description and prompt editor. Shows the *effective* template so
// the user can see what 'auto' resolved to for the current model.
function updateFormatDescription(format) {
    const effective = format === 'auto' ? getEffectiveFormat() : format;

    let desc = FORMAT_DESCRIPTIONS[format] || '';
    if (format === 'auto' && (elements.modelSelect?.value || currentSettings.selectedModel)) {
        desc += ` Detected for this model: ${effective}.`;
    }
    elements.formatDescription.textContent = desc;

    // Populate prompt editor with the effective format's template
    const template = PROMPT_TEMPLATES[effective] || PROMPT_TEMPLATES.default;
    if (template && elements.systemPrompt && elements.userPrompt) {
        if (effective === 'custom') {
            elements.systemPrompt.value = currentSettings.customSystemPrompt || '';
            elements.userPrompt.value = currentSettings.customUserPromptTemplate || '';
        } else {
            elements.systemPrompt.value = template.system || '';
            elements.userPrompt.value = template.user || '';
        }
        elements.systemPrompt.dispatchEvent(new Event('input'));
        elements.userPrompt.dispatchEvent(new Event('input'));
    }
}

// Update visibility of sections based on the effective format.
function updateVisibility() {
    const selected = elements.requestFormat.value;
    const effective = getEffectiveFormat();

    // Custom prompts section — only when the user explicitly chose 'custom'
    elements.customPromptsSection.hidden = selected !== 'custom';

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
        plainTextFallback: elements.plainTextFallback ? elements.plainTextFallback.checked : true,
        showGlow: elements.showGlow.checked,
        cacheMode: elements.cacheMode ? elements.cacheMode.value : 'off',
        debug: elements.debugLogging.checked,
        useGlossary: elements.useGlossary ? elements.useGlossary.checked : true,
        floatingButton: elements.floatingButton.checked,
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
        note.textContent = 'No terms yet — add one below or import a TSV.';
    } else if (filtered && shownCount < matchCount) {
        note.textContent = `Showing ${shownCount} of ${matchCount.toLocaleString()} matches (${total.toLocaleString()} terms total). Narrow the filter to see the rest.`;
    } else if (filtered) {
        note.textContent = `${matchCount.toLocaleString()} of ${total.toLocaleString()} terms match.`;
    } else if (shownCount < total) {
        note.textContent = `Showing the first ${shownCount} of ${total.toLocaleString()} terms. Use the filter to reach the others — all ${total.toLocaleString()} are kept when you save.`;
    } else {
        note.textContent = `${total.toLocaleString()} term${total === 1 ? '' : 's'}.`;
    }
    note.hidden = false;
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
            elements.glossaryRowsNote.textContent = 'Could not load the glossary — reload this page to try again.';
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
    if (elements.glossaryTargetLang) {
        elements.glossaryTargetLang.value = glossaryEditorTargetLang || '';
    }
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

    // Request format change
    elements.requestFormat.addEventListener('change', (e) => {
        updateFormatDescription(e.target.value);
        updateVisibility();
    });

    // Model selection
    if (elements.modelSelect) {
        elements.modelSelect.addEventListener('change', () => {
            currentSettings.selectedModel = elements.modelSelect.value;
            updateFormatDescription(elements.requestFormat.value);
            updateVisibility(); // Refresh detected-format hint + TranslateGemma help
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
                showToast('Glossary not loaded — reload the page before saving', 'error');
                return;
            }
            const entries = glossaryEditorRows
                .filter(r => r.source.trim())
                .map(r => [r.source.trim(), r.target.trim()]);
            // Dedupe: last occurrence of a source wins
            const bySource = new Map(entries);
            const deduped = [...bySource.entries()];
            // Read target language from the dropdown
            const targetLang = elements.glossaryTargetLang ? elements.glossaryTargetLang.value : glossaryEditorTargetLang;
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
                showToast('Glossary not loaded — reload the page before importing', 'error');
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
                showToast(`Imported ${entries.length} terms — click Save to apply`);
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
// Floating button permission management
// ============================================================================

async function enableFloatingButton() {
    const granted = await browserAPI.permissions.request({ origins: ['<all_urls>'] });
    if (!granted) {
        elements.floatingButton.checked = false;
        showToast('Permission denied — floating button not enabled', 'error');
        return false;
    }
    // Delegate registration to background so the path resolves from the extension root
    await browserAPI.runtime.sendMessage({ type: 'REGISTER_CONTENT_SCRIPT' });
    return true;
}

async function disableFloatingButton() {
    await browserAPI.runtime.sendMessage({ type: 'UNREGISTER_CONTENT_SCRIPT' });
    try {
        await browserAPI.permissions.remove({ origins: ['<all_urls>'] });
    } catch (e) {
        // Permission may already be absent
    }
}

document.addEventListener('DOMContentLoaded', () => {
    elements.floatingButton.addEventListener('change', async (e) => {
        if (e.target.checked) {
            const ok = await enableFloatingButton();
            if (ok) showToast('Floating button enabled — reload pages to activate');
        } else {
            await disableFloatingButton();
            showToast('Floating button disabled — permission removed');
        }
        // Persist the setting immediately without waiting for Save
        currentSettings.floatingButton = elements.floatingButton.checked;
        await browserAPI.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: currentSettings });
    });
});

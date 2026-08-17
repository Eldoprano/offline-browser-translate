/**
 * Content Script for Local LLM Translator
 * Handles DOM text extraction, replacement, and auto-translation of new content
 */

// Use browser API with chrome fallback
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Prevent duplicate injection
if (window.hasLLMTranslatorContentScript) {
    console.log('[Translator] Content script already injected, skipping initialization');
    // If we're re-injecting, we might want to ensure the listener returns true to keep the channel open if needed,
    // but usually we just want to stop re-execution.
    throw new Error('Content script already injected'); // Determines this execution stop
}
window.hasLLMTranslatorContentScript = true;

let debugEnabled = false;
function debugLog(...args) { if (debugEnabled) console.log(...args); }
function debugWarn(...args) { if (debugEnabled) console.warn(...args); }

let floatingButtonEnabled = false;

browserAPI.runtime.sendMessage({ type: 'GET_SETTINGS' }).then(r => {
    if (r?.settings) {
        debugEnabled = !!r.settings.debug;
        if (r.settings.targetLanguage) currentTargetLanguage = r.settings.targetLanguage;
        floatingButtonEnabled = !!r.settings.floatingButton;
        maybeAutoTranslatePage(r.settings);
    }
}).catch(() => {});

// Keep currentTargetLanguage in sync when user changes settings in popup/options
browserAPI.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const newSettings = changes.settings.newValue;
    const newLang = newSettings?.targetLanguage;
    if (newLang && newLang !== currentTargetLanguage) {
        currentTargetLanguage = newLang;
        updateFloatingBtnTitle();
    }
    if (typeof newSettings?.floatingButton === 'boolean') {
        floatingButtonEnabled = newSettings.floatingButton;
        if (!floatingButtonEnabled) hideFloatingBtn();
    }
});

// Track text nodes and their segments
const textNodeMap = new Map(); // Maps nodeId -> { node, originalText, segments: [...] }
const segmentToNodeIdMap = new Map(); // Maps segmentId -> nodeId
const translatedNodeSet = new Set(); // Track which nodes have been translated
let translationInProgress = false;
let translationCancelled = false;  // Flag to cancel ongoing translation
let nextNodeId = 0;
let nextSegmentId = 0;
let currentTargetLanguage = 'en';
let maxConcurrentRequests = 4; // Default parallel requests (1-32, tunable in Settings > Performance)
let autoTranslateEnabled = false;
let showGlow = false; // Setting for glow effect (disabled by default)
let mutationObserver = null;
let pendingNewNodes = [];
let autoTranslateDebounceTimer = null;

// Translation state for toggle functionality
let hasTranslationCache = false; // True if we have cached translations
let isShowingTranslations = false; // True if currently showing translations

// Queue of pending text items to translate (with dynamic priority)
let pendingTranslationQueue = [];
let scrollDebounceTimer = null;

// Elements to skip
const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED',
    'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'CODE', 'PRE', 'KBD',
    'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'
]);

// Minimum text length to consider for translation
const MIN_TEXT_LENGTH = 2;

/**
 * Check if an element should be skipped
 */
function shouldSkipElement(element) {
    if (!element || !element.tagName) return true;
    if (element.isContentEditable) return true;

    // Check element and ancestors for SKIP_TAGS, translate="no", or our extension elements
    let curr = element;
    while (curr) {
        if (curr.tagName && SKIP_TAGS.has(curr.tagName)) {
            return true;
        }
        if (curr.getAttribute && curr.getAttribute('translate') === 'no') {
            return true;
        }
        if (curr.id === 'llm-translator-status' || curr.id === 'llm-translator-float-btn') {
            return true;
        }
        curr = curr.parentElement;
    }
    
    return false;
}

/**
 * Check if text is worth translating
 */
function isTranslatableText(text) {
    if (!text) return false;
    // Trim and check minimum length
    const trimmed = text.trim();
    if (trimmed.length < MIN_TEXT_LENGTH) return false;
    // Skip if it's only whitespace, numbers, or punctuation
    // Use Unicode-aware check - look for any letter character
    const hasLetters = /\p{L}/u.test(trimmed);
    return hasLetters;
}

/**
 * Split text into sentence-level segments while preserving all whitespace and punctuation
 */
function splitIntoSentences(text) {
    if (!text) return [];
    const segments = [];
    let current = '';

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        current += ch;

        if ('。？！'.includes(ch)) {
            segments.push(current);
            current = '';
            continue;
        }

        if (!'.!?'.includes(ch)) continue;

        const prev = text[i - 1] || '';
        const next = text[i + 1] || '';
        if (ch === '.' && /\d/.test(prev) && /\d/.test(next)) {
            continue;
        }

        while (i + 1 < text.length && '.!?'.includes(text[i + 1])) {
            current += text[++i];
        }

        if (i + 1 >= text.length || /\s/.test(text[i + 1])) {
            while (i + 1 < text.length && /\s/.test(text[i + 1])) {
                current += text[++i];
            }
            segments.push(current);
            current = '';
        }
    }

    if (current) segments.push(current);
    return segments.length > 0 ? segments : [text];
}

/**
 * Check if a text node has already been processed
 */
function isNodeProcessed(node) {
    return translatedNodeSet.has(node);
}

/**
 * Calculate priority score for a text node (higher = more important, translate first)
 * Factors: viewport visibility, semantic context (main vs sidebar), parent tag type.
 */
const TAG_PRIORITY = {
    P: 80, H1: 70, H2: 60, H3: 50, H4: 40, H5: 40, H6: 40,
    LI: 30, BLOCKQUOTE: 25, FIGCAPTION: 25, TD: 20, TH: 20,
    SPAN: 5, DIV: 5, A: -10, LABEL: -30, BUTTON: -50
};

function calculatePriority(node) {
    const parent = node.parentElement;
    if (!parent) return 0;

    let priority = 0;
    const rect = parent.getBoundingClientRect();

    // Viewport visibility (dominant factor)
    if (rect.top < window.innerHeight && rect.bottom > 0 &&
        rect.left < window.innerWidth && rect.right > 0) {
        priority += 1000;
    }

    // Semantic context via closest() — main content vs sidebar/nav
    if (parent.closest('main, article, [role="main"], [role="article"]')) {
        priority += 500;
    } else if (parent.closest('nav, aside, footer, header, [role="navigation"], [role="complementary"]')) {
        priority -= 300;
    }

    // Tag type
    priority += TAG_PRIORITY[parent.tagName] || 0;

    return Math.max(0, priority);
}

/**
 * Register a text node: split into segments, add to maps, return text items for translation.
 */
function registerTextNode(node) {
    const nodeId = nextNodeId++;
    const priority = calculatePriority(node);
    const originalText = node.textContent;
    const segments = [];
    const textItems = [];

    const rawSegments = originalText.length > 200
        ? splitIntoSentences(originalText) : [originalText];

    for (const rawSeg of rawSegments) {
        if (isTranslatableText(rawSeg)) {
            const segmentId = nextSegmentId++;
            segmentToNodeIdMap.set(segmentId, nodeId);
            segments.push({
                id: segmentId, originalText: rawSeg,
                translatedText: null, processedTranslatedText: null, translated: false
            });
            textItems.push({ id: segmentId, text: rawSeg.trim(), priority });
        } else {
            segments.push({
                id: null, originalText: rawSeg,
                translatedText: null, processedTranslatedText: null, translated: false
            });
        }
    }

    textNodeMap.set(nodeId, { node, originalText, segments });
    translatedNodeSet.add(node);
    return textItems;
}

/**
 * Extract visible text nodes from the page (or from a specific root)
 */
function extractTextNodes(root = document.body, onlyNew = false) {
    if (!onlyNew) {
        textNodeMap.clear();
        segmentToNodeIdMap.clear();
        translatedNodeSet.clear();
        nextNodeId = 0;
        nextSegmentId = 0;
    }

    const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT,
        {
            acceptNode: (node) => {
                // Skip if already processed
                if (onlyNew && isNodeProcessed(node)) {
                    return NodeFilter.FILTER_REJECT;
                }
                const parent = node.parentElement;
                if (!parent || shouldSkipElement(parent)) {
                    return NodeFilter.FILTER_REJECT;
                }
                if (!isTranslatableText(node.textContent)) {
                    return NodeFilter.FILTER_REJECT;
                }
                const style = window.getComputedStyle(parent);
                if (style.display === 'none' || style.visibility === 'hidden') {
                    return NodeFilter.FILTER_REJECT;
                }
                return NodeFilter.FILTER_ACCEPT;
            }
        }
    );

    const textItems = [];
    let node;
    while (node = walker.nextNode()) {
        textItems.push(...registerTextNode(node));
    }

    // Sort by priority (highest first) - visible headings get translated first
    textItems.sort((a, b) => b.priority - a.priority);

    return textItems;
}

/**
 * Extract text nodes from newly added elements
 */
function extractNewTextNodes(addedNodes) {
    const textItems = [];

    for (const node of addedNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            if (!isNodeProcessed(node) && isTranslatableText(node.textContent)) {
                const parent = node.parentElement;
                if (parent && !shouldSkipElement(parent)) {
                    textItems.push(...registerTextNode(node));
                }
            }
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            // Extract text nodes from the added element (already sorted)
            const items = extractTextNodes(node, true);
            textItems.push(...items);
        }
    }

    // Sort by priority (highest first)
    textItems.sort((a, b) => b.priority - a.priority);

    return textItems;
}

function extractSelectionTextNodes(selection) {
    const textItems = [];
    const seenNodes = new Set();

    for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        const ancestor = range.commonAncestorContainer;
        const root = ancestor.nodeType === Node.TEXT_NODE ? ancestor.parentElement : ancestor;
        if (!root) continue;

        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) => {
                if (seenNodes.has(node)) return NodeFilter.FILTER_REJECT;
                if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
                const parent = node.parentElement;
                if (!parent || shouldSkipElement(parent)) return NodeFilter.FILTER_REJECT;
                if (!isTranslatableText(node.textContent)) return NodeFilter.FILTER_REJECT;
                const style = window.getComputedStyle(parent);
                if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });

        let node;
        while (node = walker.nextNode()) {
            seenNodes.add(node);
            
            // Reuse existing entry if this node was already registered
            let existingNodeId = null;
            let existingEntry = null;
            for (const [nodeId, entry] of textNodeMap) {
                if (entry.node === node) {
                    existingNodeId = nodeId;
                    existingEntry = entry;
                    break;
                }
            }

            const priority = calculatePriority(node);
            if (existingEntry !== null) {
                // Node already registered, extract its translatable segments
                for (const seg of existingEntry.segments) {
                    if (seg.id !== null) {
                        textItems.push({
                            id: seg.id,
                            text: seg.originalText.trim(),
                            priority
                        });
                    }
                }
            } else {
                // New node, register it
                textItems.push(...registerTextNode(node));
            }
        }
    }

    textItems.sort((a, b) => b.priority - a.priority);
    return textItems;
}

// Opens a runtime.connect port that keeps the background service worker alive
// during long translation requests (Firefox MV3 terminates idle service workers).
function startKeepAlive() {
    let port = null;
    let interval = null;
    try {
        port = browserAPI.runtime.connect({ name: 'keepalive' });
        port.onDisconnect.addListener(() => {
            port = null;
            if (interval) { clearInterval(interval); interval = null; }
        });
        interval = setInterval(() => {
            if (port) {
                try { port.postMessage({ type: 'ping' }); }
                catch (e) { clearInterval(interval); interval = null; }
            }
        }, 20000);
    } catch (e) {
        console.warn('[Translator] Could not open keep-alive port:', e.message);
    }
    return function stopKeepAlive() {
        if (interval) clearInterval(interval);
        if (port) { try { port.disconnect(); } catch (e) {} }
    };
}

/**
 * Replace text node content with translation
 */
function replaceTextNode(segmentId, translatedText) {
    const nodeId = segmentToNodeIdMap.get(segmentId);
    if (nodeId === undefined) {
        console.warn(`[Translator] Segment ID ${segmentId} not found in lookup map`);
        return false;
    }

    const entry = textNodeMap.get(nodeId);
    if (!entry) {
        console.warn(`[Translator] Node ID ${nodeId} not found in map`);
        return false;
    }

    const { node, originalText, segments } = entry;
    const segment = segments.find(s => s.id === segmentId);
    if (!segment) {
        console.warn(`[Translator] Segment ${segmentId} not found in node ${nodeId}`);
        return false;
    }

    try {
        const segOriginalText = segment.originalText;
        const leadingSpace = segOriginalText.match(/^\s*/)[0];
        const trailingSpace = segOriginalText.match(/\s*$/)[0];

        // Trim LLM's response to get pure text content first, so we don't end up with doubled spaces
        const trimmedTranslation = (translatedText || '').trim();

        // For spaceless languages (Japanese, Chinese, etc.), add spacing when translating
        // to spaced languages if there was no original spacing
        let effectiveTrailingSpace = trailingSpace;
        if (!effectiveTrailingSpace && trimmedTranslation) {
            // Check if original text looks like a spaceless language (contains CJK characters)
            const hasCJK = /[\u3000-\u9fff\uff00-\uffef]/.test(segOriginalText);
            if (hasCJK) {
                // Always add trailing space for CJK source
                effectiveTrailingSpace = ' ';
            }
        }

        const processedText = leadingSpace + trimmedTranslation + effectiveTrailingSpace;
        segment.translatedText = translatedText;
        segment.processedTranslatedText = processedText;
        segment.translated = true;

        // Reconstruct full node text
        const joinedText = segments.map(s => s.translated && s.processedTranslatedText !== null ? s.processedTranslatedText : s.originalText).join('');
        node.textContent = joinedText;

        // Add blue glow effect to parent element (if enabled)
        const parent = node.parentElement;
        if (parent) {
            if (showGlow) {
                parent.style.textShadow = '0 0 8px #7FBBB3, 0 0 2px #7FBBB3';
            }
            parent.dataset.translated = 'true';
        }

        translatedNodeSet.add(node);
        debugLog(`[Translator] Replaced segment ${segmentId} in node ${nodeId}: "${segOriginalText}" -> "${processedText}"`);
        return true;
    } catch (e) {
        console.error(`[Translator] Failed to replace segment ${segmentId} in node ${nodeId}:`, e);
        return false;
    }
}

/**
 * Restore original text for all translated nodes
 */
function restoreOriginalText() {
    for (const [nodeId, entry] of textNodeMap) {
        let hasAnyTranslated = entry.segments.some(s => s.translated);
        if (hasAnyTranslated) {
            try {
                entry.node.textContent = entry.originalText;
                translatedNodeSet.delete(entry.node);
            } catch (e) {
                // Node may have been removed
            }
        }
    }
    isShowingTranslations = false;
    // Stop auto-translate when restoring
    stopAutoTranslate();
}

/**
 * Restore cached translations (toggle back to translated view)
 */
function restoreCachedTranslations() {
    if (!hasTranslationCache) return false;

    let restoredCount = 0;
    for (const [nodeId, entry] of textNodeMap) {
        let hasAnyTranslated = entry.segments.some(s => s.translated && s.processedTranslatedText !== null);
        if (hasAnyTranslated) {
            try {
                const joinedText = entry.segments.map(s => s.translated && s.processedTranslatedText !== null ? s.processedTranslatedText : s.originalText).join('');
                entry.node.textContent = joinedText;
                translatedNodeSet.add(entry.node);
                restoredCount++;
            } catch (e) {
                // Node may have been removed
            }
        }
    }
    isShowingTranslations = true;
    return restoredCount > 0;
}

// ============================================================================
// Translation progress widget (bottom-right)
//
// One small green pill serves both the "in-progress" state (message, stop
// button) and short one-off toasts (e.g. "Restored original text"). While a
// translation is running, it morphs down into a small percent circle after a
// few idle seconds and morphs back open on hover.
// ============================================================================

let widgetEl = null;
let widgetMinimizeTimer = null;
let widgetHideTimer = null;
let widgetHovered = false;
let widgetState = 'idle'; // 'idle' | 'progress' | 'complete'
// Set when a cancellation is a step inside a more specific action (e.g.
// "Ignore site") that's about to show its own message - keeps the generic
// "Translation cancelled" from flashing on screen for a moment first.
let suppressCancelMessage = false;

function ensureWidgetStyles() {
    if (document.getElementById('llm-translator-widget-style')) return;
    const style = document.createElement('style');
    style.id = 'llm-translator-widget-style';
    style.textContent = `
        #llm-translator-status.ltw, #llm-translator-status.ltw *, #llm-translator-status.ltw *::before, #llm-translator-status.ltw *::after {
            box-sizing: border-box;
        }
        #llm-translator-status.ltw {
            position: fixed; bottom: 20px; right: 20px; z-index: 999999;
            overflow: hidden; background: #A7C080; color: #1E2326;
            font-family: system-ui, -apple-system, sans-serif; font-size: 13px; line-height: 1.4;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2); user-select: none;
            width: 40px; max-height: 40px; border-radius: 20px;
            opacity: 0; transform: translateY(10px) scale(0.92); pointer-events: none;
            /* --ltw-width-duration lets JS use a near-instant width change when the
               box is already open and just resizing for new text (nothing to morph,
               so no reason to let text sit ellipsis-truncated for 0.35s while it
               catches up) vs the full 0.35s "stretch" when actually morphing open
               from the minimized circle. */
            transition: opacity 0.25s ease, transform 0.25s ease,
                width var(--ltw-width-duration, 0.35s) cubic-bezier(.4,0,.2,1),
                max-height 0.35s cubic-bezier(.4,0,.2,1), border-radius 0.35s cubic-bezier(.4,0,.2,1),
                background-color 0.2s ease;
        }
        #llm-translator-status.ltw.ltw-visible { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; }
        #llm-translator-status.ltw-error { background: #E67E80; }
        #llm-translator-status.ltw-expanded { width: var(--ltw-expanded-width, 160px); max-height: 42px; border-radius: 12px; }
        #llm-translator-status.ltw-minimized { width: 40px; max-height: 40px; border-radius: 20px; cursor: pointer; }
        #llm-translator-status .ltw-content {
            position: relative; z-index: 1; padding: 8px 8px 8px 12px;
            /* Delayed so text only fades in once the width transition (0.35s) has
               mostly finished - otherwise it's visible (and ellipsis-truncated)
               while the box is still mid-widen, flashing half the message. */
            opacity: 1; transition: opacity 0.15s ease 0.2s;
        }
        #llm-translator-status.ltw-minimized .ltw-content { opacity: 0; pointer-events: none; }
        #llm-translator-status .ltw-row { display: flex; align-items: center; gap: 8px; flex-wrap: nowrap; }
        #llm-translator-status .ltw-message {
            flex: 1 1 auto; min-width: 0; font-size: 13px; font-weight: 600;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        #llm-translator-status .ltw-actions { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; margin-left: auto; }
        /* The [hidden] attribute alone loses to the rule above (author CSS always
           beats the UA stylesheet's [hidden]{display:none}, regardless of
           specificity) - without this, "hiding" the actions row did nothing:
           the stop/ignore-site buttons kept rendering and eating into the row's
           width, squeezing the message far narrower than measureContentWidth()
           had budgeted for (which correctly assumes the hidden actions take 0px). */
        #llm-translator-status .ltw-actions[hidden] { display: none; }
        #llm-translator-status .ltw-btn {
            background: rgba(30,35,38,0.14); border: 1px solid rgba(30,35,38,0.4); color: #1E2326;
            padding: 3px 8px; border-radius: 5px; cursor: pointer; font-family: inherit; font-size: 11px; font-weight: 600;
            width: auto; flex-shrink: 0; white-space: nowrap; transition: background 0.15s ease;
        }
        #llm-translator-status .ltw-btn:hover { background: rgba(30,35,38,0.26); }
        #llm-translator-status .ltw-icon-btn {
            display: flex; align-items: center; justify-content: center;
            width: 22px; height: 22px; padding: 0; flex-shrink: 0;
            border-radius: 50%; border: 1px solid rgba(30,35,38,0.3); cursor: pointer;
            transition: background 0.15s ease, filter 0.15s ease;
        }
        /* Same [hidden]-vs-author-display fix as .ltw-actions above. */
        #llm-translator-status .ltw-icon-btn[hidden] { display: none; }
        #llm-translator-status .ltw-icon-btn.ltw-stop { background: #E67E80; color: #1E2326; }
        #llm-translator-status .ltw-icon-btn.ltw-stop:hover { filter: brightness(0.93); }
        #llm-translator-status .ltw-icon-btn svg { width: 9px; height: 9px; }
        #llm-translator-status .ltw-ring {
            position: absolute; inset: 0; border-radius: 50%; pointer-events: none;
            background: conic-gradient(#1E2326 calc(var(--ltw-pct, 0) * 1%), rgba(30,35,38,0.22) 0);
            -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 3px));
            mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 3px));
            opacity: 0; transition: opacity 0.15s ease;
        }
        #llm-translator-status.ltw-minimized .ltw-ring { opacity: 1; }
        #llm-translator-status .ltw-mini-pct {
            position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
            font-size: 11px; font-weight: 700; opacity: 0; pointer-events: none; transition: opacity 0.15s ease;
        }
        #llm-translator-status.ltw-minimized .ltw-mini-pct { opacity: 1; }
    `;
    document.head.appendChild(style);
}

function getWidget() {
    if (widgetEl) return widgetEl;
    ensureWidgetStyles();

    const el = document.createElement('div');
    el.id = 'llm-translator-status';
    el.setAttribute('translate', 'no');
    el.className = 'ltw';
    el.innerHTML = `
        <div class="ltw-content">
            <div class="ltw-row">
                <span class="ltw-message"></span>
                <div class="ltw-actions" hidden>
                    <button type="button" class="ltw-btn ltw-never" hidden>Ignore site</button>
                    <button type="button" class="ltw-icon-btn ltw-stop" title="Stop translation" aria-label="Stop translation">
                        <svg viewBox="0 0 10 10" fill="currentColor"><rect x="0" y="0" width="10" height="10" rx="1.5"></rect></svg>
                    </button>
                </div>
            </div>
        </div>
        <div class="ltw-ring"></div>
        <span class="ltw-mini-pct"></span>
    `;
    document.body.appendChild(el);
    widgetEl = el;

    el.querySelector('.ltw-stop').addEventListener('click', () => stopCurrentTranslation());
    el.querySelector('.ltw-never').addEventListener('click', async () => {
        stopCurrentTranslation({ silent: true });
        try {
            await browserAPI.runtime.sendMessage({
                type: 'ADD_AUTO_TRANSLATE_NEVER_SITE',
                hostname: location.hostname
            });
            // Un-ignoring a site lives in the popup's Quick Settings instead
            // (plenty of room there, and no translation to resume anyway - the
            // page needs a reload regardless once the site's un-ignored).
            showToast(`${location.hostname} won't be auto-translated`);
        } catch (e) {
            showToast('Could not save the site preference', true);
        }
    });

    el.addEventListener('mouseenter', () => {
        widgetHovered = true;
        clearTimeout(widgetMinimizeTimer);
        clearTimeout(widgetHideTimer);
        if (widgetState === 'progress') expandWidgetBox();
    });
    el.addEventListener('mouseleave', () => {
        widgetHovered = false;
        // Any hover-then-leave counts as user interaction, so it always gets
        // the short delay - only a completely untouched widget waits the
        // full 3s (that timer was already set once, at start, and is left
        // alone here since it's still ticking).
        if (widgetState === 'progress') scheduleMinimize(1000);
        else if (widgetState === 'complete') scheduleHide(1500);
    });

    return el;
}

// delay is explicit so callers control the "no interaction yet" (3s, set
// once at start) vs "user just hovered away" (1s) cases. Deliberately NOT
// called from progress updates - only from start and from mouseleave -
// otherwise a fast stream of progress ticks would keep resetting the clock
// and the widget would never get a quiet window to minimize in.
function scheduleMinimize(delay) {
    clearTimeout(widgetMinimizeTimer);
    if (widgetState !== 'progress') return;
    widgetMinimizeTimer = setTimeout(() => {
        if (!widgetHovered && widgetState === 'progress' && widgetEl) {
            widgetEl.classList.remove('ltw-expanded');
            widgetEl.classList.add('ltw-minimized');
        }
    }, delay);
}

// Only fires the actual hide if the user isn't still hovering; mouseleave
// re-arms it once they move away.
function scheduleHide(delay) {
    clearTimeout(widgetHideTimer);
    widgetHideTimer = setTimeout(() => {
        if (widgetHovered) return;
        if (widgetState === 'complete') hideWidget();
    }, delay);
}

// Measures the pill's natural width from its actual text/button content.
// Uses a real offscreen DOM element (not canvas measureText, which turned
// out to under-measure - likely a system-ui font-string mismatch between
// canvas and DOM rendering) so it matches exactly what the browser renders.
let widgetMeasureRuler = null;
function getMeasureRuler() {
    if (widgetMeasureRuler) return widgetMeasureRuler;
    const ruler = document.createElement('span');
    // Without this, every text update here (many per second while translating)
    // looks like new page content to the auto-translate MutationObserver, which
    // queues it, translates it, writes the result back in - which is itself a
    // mutation, re-triggering the loop forever. Same marker the widget itself
    // uses to stay invisible to that pipeline.
    ruler.setAttribute('translate', 'no');
    ruler.style.cssText = 'position:fixed;left:-9999px;top:-9999px;visibility:hidden;' +
        'white-space:nowrap;font-family:system-ui,-apple-system,sans-serif;font-size:13px;font-weight:600;';
    document.body.appendChild(ruler);
    widgetMeasureRuler = ruler;
    return ruler;
}
const WIDGET_MAX_WIDTH = 300;

function measureTextWidth(text) {
    const ruler = getMeasureRuler();
    ruler.textContent = text;
    return ruler.getBoundingClientRect().width;
}

function measureContentWidth(el) {
    const messageWidth = measureTextWidth(el.querySelector('.ltw-message').textContent);

    const actionsEl = el.querySelector('.ltw-actions');
    let actionsWidth = 0;
    let gap = 0;
    if (!actionsEl.hidden) {
        actionsWidth = actionsEl.getBoundingClientRect().width;
        gap = 8;
    }

    const horizontalPadding = 12 + 8; // .ltw-content: 8px 8px 8px 12px
    const total = horizontalPadding + messageWidth + gap + actionsWidth + 4; // small safety buffer
    return Math.max(120, Math.min(WIDGET_MAX_WIDTH, Math.ceil(total)));
}

// Appends each clause only if the result still fits the pill's max width -
// a clause that doesn't fit is dropped whole rather than left for CSS to
// chop off mid-word. Clauses should be passed most-important first.
function appendFittingClauses(base, clauses) {
    let msg = base;
    for (const clause of clauses) {
        const candidate = msg + clause;
        const width = 20 + measureTextWidth(candidate) + 4; // .ltw-content horizontal padding + buffer
        if (width <= WIDGET_MAX_WIDTH) msg = candidate;
    }
    return msg;
}

// Does NOT touch widgetMinimizeTimer - resizing the box for new text
// shouldn't disturb an already-running minimize countdown. Only actual
// hover interaction (mouseenter) or a fresh start should reset that clock.
function expandWidgetBox() {
    if (!widgetEl) return;
    // Only a genuine morph-open (from the minimized circle) gets the slow
    // "stretch" animation; a resize of an already-open box (new/longer text)
    // snaps near-instantly so text is never sitting truncated mid-transition.
    const isMorphOpen = widgetEl.classList.contains('ltw-minimized');
    widgetEl.style.setProperty('--ltw-width-duration', isMorphOpen ? '0.35s' : '0.08s');
    widgetEl.style.setProperty('--ltw-expanded-width', measureContentWidth(widgetEl) + 'px');
    widgetEl.classList.remove('ltw-minimized');
    widgetEl.classList.add('ltw-expanded');
}

/**
 * Show the pill and start the minimize timer.
 * Pass auto:true for translations started without the user directly asking.
 */
function startProgressWidget({ auto = false, message = '' } = {}) {
    const el = getWidget();
    clearTimeout(widgetHideTimer);
    widgetState = 'progress';
    el.classList.remove('ltw-error');
    el.classList.add('ltw-visible');
    el.style.setProperty('--ltw-pct', '0');

    el.querySelector('.ltw-message').textContent = message;
    el.querySelector('.ltw-mini-pct').textContent = '0%';
    el.querySelector('.ltw-actions').hidden = false;
    el.querySelector('.ltw-never').hidden = !auto;
    expandWidgetBox();

    // Untouched-widget case: exactly one 3s timer, set here and never reset
    // by progress updates - see expandWidgetBox's comment.
    if (!widgetHovered) scheduleMinimize(3000);
}

function updateProgressWidget(percent, message) {
    if (!widgetEl || widgetState !== 'progress') return;
    const pct = Math.max(0, Math.min(100, Math.round(percent)));
    widgetEl.style.setProperty('--ltw-pct', String(pct));
    widgetEl.querySelector('.ltw-mini-pct').textContent = pct + '%';
    if (message !== undefined) {
        widgetEl.querySelector('.ltw-message').textContent = message;
        // Resizes for the new text without touching the minimize countdown -
        // see expandWidgetBox's comment.
        if (!widgetEl.classList.contains('ltw-minimized')) expandWidgetBox();
    }
}

/**
 * Show the final result, forcing the pill back open so the user sees it,
 * then fade the whole widget out after a delay (unless the user is hovering).
 */
function completeWidget(message, isError = false) {
    const el = getWidget();
    clearTimeout(widgetMinimizeTimer);
    widgetState = 'complete';
    el.classList.toggle('ltw-error', isError);
    el.classList.add('ltw-visible');
    el.querySelector('.ltw-message').textContent = message;
    el.querySelector('.ltw-actions').hidden = true;
    expandWidgetBox();
    scheduleHide(isError ? 5000 : 4000);
}

function hideWidget() {
    clearTimeout(widgetMinimizeTimer);
    clearTimeout(widgetHideTimer);
    widgetState = 'idle';
    // Without this, a mouse that's sitting still over the widget's screen
    // position when it hides never fires a fresh mouseleave/mouseenter pair,
    // so the stale "hovered" flag survives into the next run and blocks
    // both scheduleMinimize (start) and scheduleHide (complete) from firing.
    widgetHovered = false;
    if (widgetEl) widgetEl.classList.remove('ltw-visible', 'ltw-minimized', 'ltw-expanded');
}

/** A short one-off message with no stop button. */
function showToast(message, isError = false) {
    const el = getWidget();
    clearTimeout(widgetMinimizeTimer);
    widgetState = 'complete';
    el.classList.toggle('ltw-error', isError);
    el.classList.add('ltw-visible');
    el.querySelector('.ltw-actions').hidden = true;
    el.querySelector('.ltw-message').textContent = message;
    expandWidgetBox();
    scheduleHide(isError ? 4000 : 2500);
}

/** Stop button handler: just cancel remaining work. Already-translated text
 * (even from an auto-triggered run) is left as-is. Pass silent:true when the
 * caller is about to show its own, more specific completion message. */
function stopCurrentTranslation({ silent = false } = {}) {
    translationCancelled = true;
    suppressCancelMessage = silent;
    pendingTranslationQueue = [];
    stopAutoTranslate();
}

// LM Studio JIT-loads models on the first request, which can take a while
// and would otherwise leave the widget looking frozen at "0%" with no
// requests yet answered. This only *observes* the load state via polling and
// updates the widget accordingly - it never triggers a load itself, so it
// must be started alongside (not before) the actual translation requests,
// which are what cause LM Studio to load the model. No-ops for Ollama/older
// LM Studio, since GET_MODEL_STATE reports state: null there.
//
// onReady fires the instant "loaded" is observed, so the caller can switch
// the widget straight to its normal progress text instead of leaving
// "Loading model..." stuck on screen until the next unrelated widget update
// (which might not happen until the first translation batch finishes,
// seconds later). Returns a stop() function; call it once real responses
// start arriving, so this doesn't keep polling for the rest of the run.
function watchModelLoading(onReady) {
    let stopped = false;
    const maxWaitMs = 180000; // safety cap so a stuck/unknown state never polls forever
    const startedAt = Date.now();
    (async () => {
        try {
            while (!stopped && !translationCancelled && Date.now() - startedAt < maxWaitMs) {
                const res = await browserAPI.runtime.sendMessage({ type: 'GET_MODEL_STATE' });
                if (stopped) return;
                if (!res || !res.state || res.state === 'loaded') {
                    if (onReady) onReady();
                    return;
                }
                updateProgressWidget(0, 'Loading model...');
                await new Promise(r => setTimeout(r, 300));
            }
        } catch (e) {
            // Background worker unreachable or message type unsupported - just stop watching.
        }
    })();
    return () => { stopped = true; };
}

/**
 * Detect page source language from HTML lang attribute
 * Returns base language code (e.g., "en" from "en-US")
 */
// Returns the page's explicitly declared language code, or null when the page
// declares none. Kept separate from getPageLanguage() so callers that need to
// reason about "unknown" (e.g. the floating button) aren't fooled by a default.
function getDeclaredPageLanguage() {
    const htmlLang = document.documentElement.lang || document.querySelector('html')?.getAttribute('lang');
    if (htmlLang) {
        // Extract base language code (e.g., "en" from "en-US")
        return htmlLang.split('-')[0].toLowerCase();
    }
    // Fallback: try meta tag
    const metaLang = document.querySelector('meta[http-equiv="content-language"]')?.getAttribute('content');
    if (metaLang) {
        return metaLang.split('-')[0].toLowerCase();
    }
    return null; // No declared language
}

function getPageLanguage() {
    return getDeclaredPageLanguage() || 'en'; // Default fallback for translation source
}

// ============================================================================
// Auto-translate on page load
//
// Opt-in (settings.autoTranslatePages). Only runs when the page *declares* a
// language different from the target one — guessing would mean burning local
// inference on pages that are already readable, so an undeclared page is left
// alone. Two escape hatches are offered on the page itself while it runs.
// ============================================================================

let autoTranslateChecked = false;

// A never-list entry covers its own host and any subdomain, so "example.com"
// also matches "news.example.com".
function hostMatchesNeverSite(hostname, sites) {
    const host = (hostname || '').toLowerCase();
    if (!host || !Array.isArray(sites)) return false;
    return sites.some(entry => {
        const site = String(entry || '').trim().toLowerCase();
        if (!site) return false;
        return host === site || host.endsWith('.' + site);
    });
}

// Decide whether this page should be translated without the user asking, and
// do it. Safe to call more than once — only the first call is acted on.
async function maybeAutoTranslatePage(settings) {
    if (autoTranslateChecked) return;
    autoTranslateChecked = true;

    if (!settings || !settings.autoTranslatePages) return;
    // Top-level documents only. Translating every ad and widget iframe on a page
    // would multiply the request count for text the user mostly cannot see.
    if (window.top !== window.self) return;
    if (translationInProgress) return;

    const pageLang = getDeclaredPageLanguage();
    if (!pageLang) return;

    const target = String(settings.targetLanguage || currentTargetLanguage || 'en')
        .split('-')[0].toLowerCase();
    if (pageLang === target) return;

    const neverLangs = Array.isArray(settings.autoTranslateNeverLanguages)
        ? settings.autoTranslateNeverLanguages
        : [];
    if (neverLangs.includes(pageLang)) return;

    if (hostMatchesNeverSite(location.hostname, settings.autoTranslateNeverSites)) return;

    debugLog(`[Translator] Auto-translating page from ${pageLang} to ${target}`);
    await translatePage(target, pageLang, true, { auto: true });
}

/**
 * Translate a batch of text items with retry logic
 * Returns { applied: number, failed: Array } 
 */
async function translateBatch(textItems, targetLanguage, sourceLanguage = 'auto', retries = 3) {
    if (textItems.length === 0) return { applied: 0, failed: [] };

    debugLog(`[Translator] translateBatch called for ${textItems.length} items:`, textItems);

    // Use passed source language if valid, otherwise detect from page
    const pageLanguage = (sourceLanguage && sourceLanguage !== 'auto')
        ? sourceLanguage
        : getPageLanguage();

    let lastError = null;
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            if (attempt > 0) {
                debugLog(`[Translator] Retrying batch, attempt ${attempt + 1}/${retries}`);
            }
            const response = await browserAPI.runtime.sendMessage({
                type: 'TRANSLATE',
                texts: textItems,
                targetLanguage,
                sourceLanguage: pageLanguage // Pass detected page language for TranslateGemma
            });

            debugLog(`[Translator] translateBatch response:`, response);

            // sendMessage resolves undefined if the background worker was asleep
            // or a handler returned without responding — treat as retryable.
            if (!response) {
                throw new Error('No response from background (worker asleep?)');
            }
            if (response.error) {
                throw new Error(response.error);
            }

            const { translations } = response;
            debugLog(`[Translator] Got ${translations?.length} translations back for ${textItems.length} items`);

            let applied = 0;
            const failed = [];
            const receivedIds = new Set();

            // Process received translations
            for (const t of (translations || [])) {
                receivedIds.add(t.id);
                if (!t.error && t.text) {
                    if (replaceTextNode(t.id, t.text)) {
                        applied++;
                    } else {
                        // Node replacement failed
                        const original = textItems.find(item => item.id === t.id);
                        if (original) failed.push(original);
                    }
                } else if (t.error) {
                    console.warn(`[Translator] Translation error for id ${t.id}: ${t.error}`);
                    const original = textItems.find(item => item.id === t.id);
                    if (original) failed.push(original);
                }
            }

            // Check for items that weren't returned at all
            for (const item of textItems) {
                if (!receivedIds.has(item.id)) {
                    console.warn(`[Translator] Item ${item.id} was not returned by LLM`);
                    failed.push(item);
                }
            }

            if (failed.length > 0) {
                console.warn(`[Translator] ${failed.length} items failed in this batch`);
            }

            return {
                applied, failed,
                fromCache: response.fromCache || 0,
                total: (typeof response.total === 'number') ? response.total : textItems.length,
                cacheActive: !!response.cacheActive
            };

        } catch (e) {
            lastError = e;
            console.warn(`[Translator] Attempt ${attempt + 1}/${retries} failed:`, e.message);
            debugWarn(`[Translator] Batch translation failed with exception:`, e, 'on items:', textItems);

            // Wait before retry (exponential backoff)
            if (attempt < retries - 1) {
                await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
            }
        }
    }

    // All retries failed - return all items as failed
    console.error(`[Translator] All retries failed for batch of ${textItems.length} items. Last error: ${lastError?.message}`);
    return { applied: 0, failed: textItems, fromCache: 0, total: textItems.length, cacheActive: false };
}


/**
 * Handle scroll event - recalculate priorities after user stops scrolling
 */
function onScroll() {
    if (scrollDebounceTimer) {
        clearTimeout(scrollDebounceTimer);
    }
    scrollDebounceTimer = setTimeout(() => {
        if (pendingTranslationQueue.length > 0) {
            recalculatePendingPriorities();
        }
    }, 100); // 100ms debounce for snappier updates
}

/**
 * Main translation function with queue and cancellation support
 */
async function translatePage(targetLanguage, sourceLanguage = 'auto', enableAutoTranslate = true, { auto = false } = {}) {
    if (translationInProgress) {
        showToast('Translation already in progress...', true);
        return;
    }

    currentTargetLanguage = targetLanguage;
    translationInProgress = true;
    translationCancelled = false;
    suppressCancelMessage = false;
    const verb = auto ? 'Auto-translating' : 'Translating';
    startProgressWidget({ auto, message: 'Extracting text...' });

    // Add scroll listener for dynamic priority
    window.addEventListener('scroll', onScroll, { passive: true });
    const stopKeepAlive = startKeepAlive();
    let stopModelWatch = null;

    try {
        const textItems = extractTextNodes();

        if (textItems.length === 0) {
            completeWidget('No translatable text found', true);
            translationInProgress = false;
            return;
        }

        // Initialize queue with all items (already sorted by priority)
        pendingTranslationQueue = [...textItems];

        updateProgressWidget(0, `Found ${textItems.length} text elements. ${verb}...`);

        let totalApplied = 0;
        let totalProcessed = 0; // Track how many items we've attempted
        let totalFromCache = 0; // Elements served from the translation cache
        let cacheActive = false; // Whether the cache was on for this run
        const totalItems = textItems.length;
        const batchSize = 8; // Process in batches
        const failedItems = []; // Track items that failed for potential retry
        let inFlightBatches = []; // Track in-flight batch promises

        // Started alongside (not before) the real requests below - LM Studio
        // only starts loading once one of those requests actually lands.
        stopModelWatch = watchModelLoading(() => {
            const percent = Math.min(100, Math.round((totalProcessed / totalItems) * 100));
            updateProgressWidget(percent, `${verb} ${percent}%`);
        });

        // Main translation loop with parallel processing
        while ((pendingTranslationQueue.length > 0 || inFlightBatches.length > 0) && !translationCancelled) {
            // Fill up to maxConcurrentRequests parallel batches
            while (inFlightBatches.length < maxConcurrentRequests && pendingTranslationQueue.length > 0) {
                const batch = pendingTranslationQueue.splice(0, batchSize);
                totalProcessed += batch.length;

                // Create a trackable batch object with unique ID
                const batchId = Date.now() + Math.random();
                const batchPromise = translateBatch(batch, targetLanguage, sourceLanguage)
                    .then(result => ({ batchId, result, batch, success: true }))
                    .catch(error => ({ batchId, error, batch, success: false }));

                inFlightBatches.push({ batchId, promise: batchPromise });
            }

            // Cap percentage at 100%
            const percent = Math.min(100, Math.round((totalProcessed / totalItems) * 100));
            updateProgressWidget(percent, `${verb} ${percent}%`);

            // Wait for any one batch to complete
            if (inFlightBatches.length > 0) {
                const completed = await Promise.race(inFlightBatches.map(b => b.promise));
                stopModelWatch(); // a response landed, so the model is answering - stop polling its load state

                // Remove the completed batch from inFlightBatches by its ID
                inFlightBatches = inFlightBatches.filter(b => b.batchId !== completed.batchId);

                if (completed.success) {
                    totalApplied += completed.result.applied;
                    totalFromCache += completed.result.fromCache || 0;
                    if (completed.result.cacheActive) cacheActive = true;
                    if (completed.result.failed && completed.result.failed.length > 0) {
                        failedItems.push(...completed.result.failed);
                    }
                } else {
                    console.error('Batch error:', completed.error);
                    failedItems.push(...completed.batch);
                }
            }

            // Check cancellation between batches
            if (translationCancelled) {
                if (!suppressCancelMessage) completeWidget('Translation cancelled');
                break;
            }
        }

        // Whatever got applied before a cancel is real, translated text sitting
        // in the page - the popup's "Original" toggle needs to know about it
        // regardless of whether the run finished or was cut short.
        if (totalApplied > 0) {
            hasTranslationCache = true;
            isShowingTranslations = true;
        }

        if (!translationCancelled) {
            if (failedItems.length > 0) {
                console.warn(`[Translator] ${failedItems.length} items failed:`,
                    failedItems.slice(0, 5).map(f => f.text.substring(0, 30)));
            }

            if (enableAutoTranslate) startAutoTranslate(targetLanguage);

            // The core "did it work" stat always shows; everything after is a
            // nice-to-have that gets dropped whole (not truncated mid-word) if
            // it doesn't fit the pill - most important clause first.
            const cachePercent = (cacheActive && totalFromCache > 0 && totalItems > 0)
                ? Math.round((totalFromCache / totalItems) * 100) : 0;
            const statusMsg = appendFittingClauses(`Translated ${totalApplied}/${totalItems} elements`, [
                failedItems.length > 0 ? `, ${failedItems.length} failed` : '',
                cachePercent > 0 ? `, ${cachePercent}% cached` : '',
                enableAutoTranslate ? ' · auto-on' : ''
            ].filter(Boolean));

            completeWidget(statusMsg);
        }

    } catch (e) {
        console.error('Translation error:', e);
        completeWidget(`Error: ${e.message}`, true);
    } finally {
        stopKeepAlive();
        if (stopModelWatch) stopModelWatch();
        translationInProgress = false;
        translationCancelled = false;
        pendingTranslationQueue = [];
        window.removeEventListener('scroll', onScroll);
        // Let the popup know translation is done so it can reset its button
        // (e.g. when everything was served from cache and finished instantly).
        try {
            browserAPI.runtime.sendMessage({ type: 'TRANSLATION_COMPLETE' }).catch(() => {});
        } catch (e) { /* popup may be closed */ }
    }
}

/**
 * Recalculate priorities for pending items based on current viewport
 */
function recalculatePendingPriorities() {
    for (const item of pendingTranslationQueue) {
        const nodeId = segmentToNodeIdMap.get(item.id);
        if (nodeId !== undefined) {
            const entry = textNodeMap.get(nodeId);
            if (entry && entry.node && entry.node.parentElement) {
                item.priority = calculatePriority(entry.node);
            }
        }
    }
    // Re-sort by new priorities
    pendingTranslationQueue.sort((a, b) => b.priority - a.priority);
}

/**
 * Start watching for new content and auto-translate
 */
function startAutoTranslate(targetLanguage) {
    if (mutationObserver) {
        mutationObserver.disconnect();
    }

    autoTranslateEnabled = true;
    currentTargetLanguage = targetLanguage;
    pendingNewNodes = [];

    mutationObserver = new MutationObserver((mutations) => {
        if (!autoTranslateEnabled) return;

        for (const mutation of mutations) {
            if (mutation.type === 'childList') {
                for (const node of mutation.addedNodes) {
                    pendingNewNodes.push(node);
                }
            }
        }

        // Debounce: wait for DOM to settle before translating
        if (autoTranslateDebounceTimer) {
            clearTimeout(autoTranslateDebounceTimer);
        }
        autoTranslateDebounceTimer = setTimeout(() => {
            translatePendingNodes();
        }, 500);
    });

    mutationObserver.observe(document.body, {
        childList: true,
        subtree: true
    });

    console.log('Auto-translate enabled for new content');
}

/**
 * Stop auto-translate
 */
function stopAutoTranslate() {
    autoTranslateEnabled = false;
    if (mutationObserver) {
        mutationObserver.disconnect();
        mutationObserver = null;
    }
    if (autoTranslateDebounceTimer) {
        clearTimeout(autoTranslateDebounceTimer);
        autoTranslateDebounceTimer = null;
    }
    pendingNewNodes = [];
    console.log('Auto-translate disabled');
}

/**
 * Translate pending new nodes
 */
async function translatePendingNodes() {
    if (pendingNewNodes.length === 0 || translationInProgress) return;

    const nodesToProcess = [...pendingNewNodes];
    pendingNewNodes = [];

    const textItems = extractNewTextNodes(nodesToProcess);

    if (textItems.length === 0) return;

    translationInProgress = true;
    showToast(`Translating ${textItems.length} new elements...`);

    try {
        const result = await translateBatch(textItems, currentTargetLanguage);
        showToast(`Translated ${result.applied} new elements`);
    } catch (e) {
        console.error('Auto-translate error:', e);
        showToast(`Auto-translate error: ${e.message}`, true);
    } finally {
        translationInProgress = false;
    }
}

async function translateSelection(targetLanguage, sourceLanguage = 'auto') {
    if (translationInProgress) {
        showToast('Translation already in progress...', true);
        return;
    }

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        showToast('No text selected', true);
        return;
    }

    currentTargetLanguage = targetLanguage;
    translationInProgress = true;
    translationCancelled = false;
    const stopKeepAlive = startKeepAlive();
    let stopModelWatch = null;
    startProgressWidget({ message: 'Extracting selected text...' });

    try {
        const textItems = extractSelectionTextNodes(selection);

        if (textItems.length === 0) {
            completeWidget('No translatable text in selection', true);
            return;
        }

        updateProgressWidget(0, `Translating ${textItems.length} selected elements...`);

        let totalApplied = 0;
        const batchSize = 8;
        const failedItems = [];

        // Started alongside (not before) the real requests below - LM Studio
        // only starts loading once one of those requests actually lands.
        stopModelWatch = watchModelLoading(() => {
            updateProgressWidget(0, `Translating ${textItems.length} selected elements...`);
        });

        for (let i = 0; i < textItems.length && !translationCancelled; i += batchSize) {
            const batch = textItems.slice(i, i + batchSize);
            const result = await translateBatch(batch, targetLanguage, sourceLanguage);
            stopModelWatch(); // a response landed, so the model is answering - stop polling its load state
            totalApplied += result.applied;
            if (result.failed && result.failed.length > 0) failedItems.push(...result.failed);
            const percent = Math.min(100, Math.round(((i + batch.length) / textItems.length) * 100));
            updateProgressWidget(percent, `Translating selection ${percent}%`);
        }

        if (totalApplied > 0) {
            hasTranslationCache = true;
            isShowingTranslations = true;
        }

        let statusMsg = translationCancelled
            ? `Translation cancelled - ${totalApplied}/${textItems.length} selected elements translated`
            : `Translated ${totalApplied}/${textItems.length} selected elements`;
        if (failedItems.length > 0) statusMsg += ` - ${failedItems.length} failed`;
        completeWidget(statusMsg);

    } catch (e) {
        console.error('[Translator] Selection translation error:', e);
        completeWidget(`Error: ${e.message}`, true);
    } finally {
        stopKeepAlive();
        if (stopModelWatch) stopModelWatch();
        translationInProgress = false;
        translationCancelled = false;
        // Suppress the button briefly so it doesn't reappear on the now-translated selection
        suppressFloatingBtn = true;
        setTimeout(() => { suppressFloatingBtn = false; }, 1000);
    }
}

// Listen for messages from background/popup
browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // console.log(`[Translator] Received message: ${message.type}`, message);

    switch (message.type) {
        case 'START_TRANSLATION':
            if (message.showGlow !== undefined) showGlow = message.showGlow;
            if (message.maxConcurrentRequests !== undefined) {
                maxConcurrentRequests = Math.max(1, Math.min(32, message.maxConcurrentRequests));
            }
            translatePage(message.targetLanguage, message.sourceLanguage, true);
            sendResponse({ started: true });
            break;

        case 'TRANSLATE_SELECTION':
            if (message.showGlow !== undefined) showGlow = message.showGlow;
            if (message.maxConcurrentRequests !== undefined) {
                maxConcurrentRequests = Math.max(1, Math.min(32, message.maxConcurrentRequests));
            }
            translateSelection(message.targetLanguage, message.sourceLanguage);
            sendResponse({ started: true });
            break;

        case 'SET_GLOW':
            showGlow = message.enabled;
            // Update existing translated elements
            document.querySelectorAll('[data-translated="true"]').forEach(el => {
                el.style.textShadow = showGlow ? '0 0 8px #7FBBB3, 0 0 2px #7FBBB3' : '';
            });
            sendResponse({ showGlow });
            break;

        case 'RESTORE_ORIGINAL':
            restoreOriginalText();
            showToast('Restored original text');
            sendResponse({ restored: true, hasCache: hasTranslationCache });
            break;

        case 'TOGGLE_TRANSLATION':
            // Toggle between translated and original
            if (isShowingTranslations) {
                restoreOriginalText();
                showToast('Showing original text');
                sendResponse({ showing: 'original', hasCache: hasTranslationCache });
            } else if (hasTranslationCache) {
                restoreCachedTranslations();
                showToast('Restored translations');
                sendResponse({ showing: 'translated', hasCache: hasTranslationCache });
            } else {
                sendResponse({ showing: 'original', hasCache: false });
            }
            break;

        case 'TRANSLATION_PROGRESS':
            showToast(message.status);
            sendResponse({ received: true });
            break;

        case 'PARTIAL_TRANSLATION':
            console.log(`[Translator] PARTIAL_TRANSLATION with ${message.translations?.length} items`);
            let applied = 0;
            for (const t of message.translations) {
                if (!t.error && t.text) {
                    if (replaceTextNode(t.id, t.text)) {
                        applied++;
                    }
                }
            }
            console.log(`[Translator] Applied ${applied} partial translations`);
            sendResponse({ applied: true });
            break;

        case 'TOGGLE_AUTO_TRANSLATE':
            if (autoTranslateEnabled) {
                stopAutoTranslate();
                showToast('Auto-translate disabled');
            } else {
                startAutoTranslate(message.targetLanguage || currentTargetLanguage);
                showToast('Auto-translate enabled');
            }
            sendResponse({ autoTranslate: autoTranslateEnabled });
            break;

        case 'CANCEL_TRANSLATION':
            console.log('[Translator] Cancellation requested');
            stopCurrentTranslation();
            sendResponse({ cancelled: true });
            break;

        case 'GET_TRANSLATION_STATUS':
            sendResponse({
                isTranslating: translationInProgress,
                isAutoTranslating: autoTranslateEnabled
            });
            break;

        case 'GET_PAGE_LANGUAGE':
            sendResponse({
                language: getPageLanguage()
            });
            break;

        case 'PING':
            sendResponse({ pong: true });
            break;

        default:
            sendResponse({ unknown: true });
    }
    return true;
});

console.log('Local LLM Translator content script loaded');

// ============================================================================
// Floating translate button (only active when auto-injected via optional permission)
// ============================================================================

let floatingTranslateBtn = null;
let suppressFloatingBtn = false;

function getLanguageName(code) {
    try {
        return new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }).of(code);
    } catch (e) {
        return code.toUpperCase();
    }
}

function updateFloatingBtnTitle() {
    if (floatingTranslateBtn) {
        floatingTranslateBtn.title = `Translate to ${getLanguageName(currentTargetLanguage)}`;
    }
}

function getFloatingTranslateBtn() {
    if (floatingTranslateBtn) return floatingTranslateBtn;

    const btn = document.createElement('div');
    btn.id = 'llm-translator-float-btn';
    btn.setAttribute('translate', 'no');
    btn.title = `Translate to ${getLanguageName(currentTargetLanguage)}`;
    btn.style.cssText = [
        'position:absolute', 'width:2em', 'height:2em', 'cursor:pointer',
        'z-index:999999', 'display:none', 'align-items:center', 'justify-content:center',
        'transition:opacity 0.1s,transform 0.1s', 'opacity:0', 'transform:scale(0.8)'
    ].join(';');

    const img = document.createElement('img');
    img.src = browserAPI.runtime.getURL('icons/icon48.png');
    img.style.cssText = 'width:100%;height:100%;pointer-events:none;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.35))';
    btn.appendChild(img);

    btn.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
    btn.addEventListener('mouseleave', () => { btn.style.opacity = '0.65'; });
    btn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideFloatingBtn();
        translateSelection(currentTargetLanguage, getPageLanguage());
    });

    document.body.appendChild(btn);
    floatingTranslateBtn = btn;
    return btn;
}

function showFloatingBtn(selection) {
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(selection.rangeCount - 1);
    const rects = range.getClientRects();
    const rect = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;

    const btn = getFloatingTranslateBtn();
    btn.style.left = (rect.right + window.scrollX + 4) + 'px';
    btn.style.top = (rect.bottom + window.scrollY + 4) + 'px';
    btn.style.display = 'flex';
    requestAnimationFrame(() => { btn.style.opacity = '0.65'; btn.style.transform = 'scale(1)'; });
}

function hideFloatingBtn() {
    if (!floatingTranslateBtn) return;
    floatingTranslateBtn.style.opacity = '0';
    floatingTranslateBtn.style.transform = 'scale(0.8)';
    setTimeout(() => { if (floatingTranslateBtn) floatingTranslateBtn.style.display = 'none'; }, 80);
}

function tryShowFloatingBtn() {
    if (!floatingButtonEnabled) return;
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim() || '';
    // Only suppress when the page *explicitly* declares the target language; an
    // undeclared page (null) is treated as unknown so the button still appears.
    const declaredLang = getDeclaredPageLanguage();
    const sameLanguage = declaredLang !== null && declaredLang === currentTargetLanguage;
    if (selection && !selection.isCollapsed && selectedText.length >= MIN_TEXT_LENGTH
            && !sameLanguage && !translationInProgress && !suppressFloatingBtn) {
        showFloatingBtn(selection);
    }
}

// mouseup/keyup: selection is final, safe to show the button.
// selectionchange: only used to hide when selection is cleared, avoiding
// the double-click problem where it briefly collapses before expanding.
document.addEventListener('mouseup', tryShowFloatingBtn);
document.addEventListener('keyup', (e) => {
    if (e.shiftKey || e.key === 'End' || e.key === 'Home') tryShowFloatingBtn();
});

document.addEventListener('selectionchange', () => {
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim() || '';
    if (!selection || selection.isCollapsed || selectedText.length < MIN_TEXT_LENGTH) {
        hideFloatingBtn();
    }
});

window.addEventListener('scroll', () => {
    if (floatingTranslateBtn && floatingTranslateBtn.style.display !== 'none') hideFloatingBtn();
}, { passive: true });

// Page is navigating away / unloading — tell the background to abort this tab's
// in-flight LLM requests so they don't run to the 5min timeout. Fire-and-forget:
// the document is being torn down, so we can't await a response.
window.addEventListener('pagehide', () => {
    if (!translationInProgress) return;
    try { browserAPI.runtime.sendMessage({ type: 'CANCEL_TRANSLATION' }); } catch (e) {}
});

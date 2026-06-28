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
let maxConcurrentRequests = 4; // Default parallel requests (LMStudio 0.4.0+ supports up to 4)
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
    if (SKIP_TAGS.has(element.tagName)) return true;
    if (element.isContentEditable) return true;
    
    // Check ancestors recursively for translate="no" or our extension elements
    let curr = element;
    while (curr) {
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
    const regex = /[^.!?。？！]+(?:[.!?]+(?:\s+|$)|[。？！]+|$)|[.!?。？！\s]+/gu;
    return text.match(regex) || [text];
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

/**
 * Show translation status indicator
 */
function showStatus(message, isError = false) {
    let statusEl = document.getElementById('llm-translator-status');

    if (!statusEl) {
        statusEl = document.createElement('div');
        statusEl.id = 'llm-translator-status';
        statusEl.setAttribute('translate', 'no');
        statusEl.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      padding: 12px 20px;
      border-radius: 8px;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 14px;
      z-index: 999999;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      transition: opacity 0.3s, transform 0.3s;
    `;
        document.body.appendChild(statusEl);
    }

    statusEl.style.backgroundColor = isError ? '#E67E80' : '#A7C080';
    statusEl.style.color = '#1E2326';
    statusEl.textContent = message;
    statusEl.style.opacity = '1';
    statusEl.style.transform = 'translateY(0)';
}

/**
 * Hide status indicator
 */
function hideStatus() {
    const statusEl = document.getElementById('llm-translator-status');
    if (statusEl) {
        statusEl.style.opacity = '0';
        statusEl.style.transform = 'translateY(20px)';
        setTimeout(() => statusEl.remove(), 300);
    }
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

            return { applied, failed };

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
    return { applied: 0, failed: textItems };
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
async function translatePage(targetLanguage, sourceLanguage = 'auto', enableAutoTranslate = true) {
    if (translationInProgress) {
        showStatus('Translation already in progress...', true);
        return;
    }

    currentTargetLanguage = targetLanguage;
    translationInProgress = true;
    translationCancelled = false;
    showStatus('Extracting text...');

    // Add scroll listener for dynamic priority
    window.addEventListener('scroll', onScroll, { passive: true });
    const stopKeepAlive = startKeepAlive();

    try {
        const textItems = extractTextNodes();

        if (textItems.length === 0) {
            showStatus('No translatable text found', true);
            setTimeout(hideStatus, 3000);
            translationInProgress = false;
            return;
        }

        // Initialize queue with all items (already sorted by priority)
        pendingTranslationQueue = [...textItems];

        showStatus(`Found ${textItems.length} text elements. Translating...`);

        let totalApplied = 0;
        let totalProcessed = 0; // Track how many items we've attempted
        const totalItems = textItems.length;
        const batchSize = 8; // Process in batches
        const failedItems = []; // Track items that failed for potential retry
        let inFlightBatches = []; // Track in-flight batch promises

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
            showStatus(`Translating... ${percent}%`);

            // Wait for any one batch to complete
            if (inFlightBatches.length > 0) {
                const completed = await Promise.race(inFlightBatches.map(b => b.promise));

                // Remove the completed batch from inFlightBatches by its ID
                inFlightBatches = inFlightBatches.filter(b => b.batchId !== completed.batchId);

                if (completed.success) {
                    totalApplied += completed.result.applied;
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
                showStatus('Translation cancelled');
                setTimeout(hideStatus, 2000);
                break;
            }
        }

        if (!translationCancelled) {
            // Show completion message with stats
            const successRate = Math.round((totalApplied / totalItems) * 100);
            let statusMsg = `Translated ${totalApplied}/${totalItems} elements (${successRate}%)`;

            if (failedItems.length > 0) {
                console.warn(`[Translator] ${failedItems.length} items failed:`,
                    failedItems.slice(0, 5).map(f => f.text.substring(0, 30)));
                statusMsg += ` - ${failedItems.length} failed`;
            }

            // Mark that we have cached translations for toggle
            if (totalApplied > 0) {
                hasTranslationCache = true;
                isShowingTranslations = true;
            }

            showStatus(statusMsg);

            // Start auto-translate for new content if enabled
            if (enableAutoTranslate) {
                startAutoTranslate(targetLanguage);
                setTimeout(() => {
                    showStatus(`${statusMsg}. Auto-translate ON`);
                    setTimeout(hideStatus, 4000);
                }, 1000);
            } else {
                setTimeout(hideStatus, 4000);
            }
        }

    } catch (e) {
        console.error('Translation error:', e);
        showStatus(`Error: ${e.message}`, true);
        setTimeout(hideStatus, 5000);
    } finally {
        stopKeepAlive();
        translationInProgress = false;
        translationCancelled = false;
        pendingTranslationQueue = [];
        window.removeEventListener('scroll', onScroll);
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
    showStatus(`Translating ${textItems.length} new elements...`);

    try {
        const result = await translateBatch(textItems, currentTargetLanguage);
        showStatus(`Translated ${result.applied} new elements`);
        setTimeout(hideStatus, 2000);
    } catch (e) {
        console.error('Auto-translate error:', e);
        showStatus(`Auto-translate error: ${e.message}`, true);
        setTimeout(hideStatus, 3000);
    } finally {
        translationInProgress = false;
    }
}

async function translateSelection(targetLanguage, sourceLanguage = 'auto') {
    if (translationInProgress) {
        showStatus('Translation already in progress...', true);
        return;
    }

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        showStatus('No text selected', true);
        setTimeout(hideStatus, 2000);
        return;
    }

    currentTargetLanguage = targetLanguage;
    translationInProgress = true;
    translationCancelled = false;
    const stopKeepAlive = startKeepAlive();
    showStatus('Extracting selected text...');

    try {
        const textItems = extractSelectionTextNodes(selection);

        if (textItems.length === 0) {
            showStatus('No translatable text in selection', true);
            setTimeout(hideStatus, 3000);
            return;
        }

        showStatus(`Translating ${textItems.length} selected elements...`);

        let totalApplied = 0;
        const batchSize = 8;
        const failedItems = [];

        for (let i = 0; i < textItems.length && !translationCancelled; i += batchSize) {
            const batch = textItems.slice(i, i + batchSize);
            const result = await translateBatch(batch, targetLanguage, sourceLanguage);
            totalApplied += result.applied;
            if (result.failed && result.failed.length > 0) failedItems.push(...result.failed);
            const percent = Math.min(100, Math.round(((i + batch.length) / textItems.length) * 100));
            showStatus(`Translating selection... ${percent}%`);
        }

        if (totalApplied > 0) {
            hasTranslationCache = true;
            isShowingTranslations = true;
        }

        let statusMsg = `Translated ${totalApplied}/${textItems.length} selected elements`;
        if (failedItems.length > 0) statusMsg += ` - ${failedItems.length} failed`;
        showStatus(statusMsg);
        setTimeout(hideStatus, 4000);

    } catch (e) {
        console.error('[Translator] Selection translation error:', e);
        showStatus(`Error: ${e.message}`, true);
        setTimeout(hideStatus, 5000);
    } finally {
        stopKeepAlive();
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
                maxConcurrentRequests = Math.max(1, Math.min(4, message.maxConcurrentRequests));
            }
            translatePage(message.targetLanguage, message.sourceLanguage, true);
            sendResponse({ started: true });
            break;

        case 'TRANSLATE_SELECTION':
            if (message.showGlow !== undefined) showGlow = message.showGlow;
            if (message.maxConcurrentRequests !== undefined) {
                maxConcurrentRequests = Math.max(1, Math.min(4, message.maxConcurrentRequests));
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
            showStatus('Restored original text');
            setTimeout(hideStatus, 2000);
            sendResponse({ restored: true, hasCache: hasTranslationCache });
            break;

        case 'TOGGLE_TRANSLATION':
            // Toggle between translated and original
            if (isShowingTranslations) {
                restoreOriginalText();
                showStatus('Showing original text');
                setTimeout(hideStatus, 2000);
                sendResponse({ showing: 'original', hasCache: hasTranslationCache });
            } else if (hasTranslationCache) {
                restoreCachedTranslations();
                showStatus('Restored translations');
                setTimeout(hideStatus, 2000);
                sendResponse({ showing: 'translated', hasCache: hasTranslationCache });
            } else {
                sendResponse({ showing: 'original', hasCache: false });
            }
            break;

        case 'TRANSLATION_PROGRESS':
            showStatus(message.status);
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
                showStatus('Auto-translate disabled');
            } else {
                startAutoTranslate(message.targetLanguage || currentTargetLanguage);
                showStatus('Auto-translate enabled');
            }
            setTimeout(hideStatus, 2000);
            sendResponse({ autoTranslate: autoTranslateEnabled });
            break;

        case 'CANCEL_TRANSLATION':
            console.log('[Translator] Cancellation requested');
            translationCancelled = true;
            pendingTranslationQueue = [];
            stopAutoTranslate();
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

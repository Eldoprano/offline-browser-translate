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

// Track text nodes and their original content
const textNodeMap = new Map();
const translatedNodeSet = new Set(); // Track which nodes have been translated
let translationInProgress = false;
let translationCancelled = false;  // Flag to cancel ongoing translation
let nextId = 0;
let currentTargetLanguage = 'en';
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
    if (element.getAttribute('translate') === 'no') return true;
    // Skip our own status element
    if (element.id === 'llm-translator-status') return true;
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
 * Check if a text node has already been processed
 */
function isNodeProcessed(node) {
    return translatedNodeSet.has(node);
}

/**
 * Calculate priority score for a text node (higher = more important, translate first)
 * 
 * Priority factors:
 * 1. Viewport visibility (must be in view)
 * 2. Text length (longer = more valuable content)
 * 3. Semantic context (main/article vs nav/sidebar)
 * 4. Tag type (P, H1-H6 vs SPAN, A, LABEL)
 */
function calculatePriority(node) {
    const parent = node.parentElement;
    if (!parent) return 0;

    let priority = 0;
    const rect = parent.getBoundingClientRect();

    // 1. Viewport visibility (CRITICAL)
    const inViewport = (
        rect.top < window.innerHeight &&
        rect.bottom > 0 &&
        rect.left < window.innerWidth &&
        rect.right > 0
    );

    if (inViewport) {
        priority += 10000;
        // Top half of viewport gets slight bonus
        if (rect.top >= 0 && rect.top < window.innerHeight / 2) {
            priority += 200;
        }
    }

    // 2. TEXT LENGTH - longer text is more valuable (main content vs labels)
    const textLength = node.textContent.trim().length;
    if (textLength >= 200) priority += 150;      // Long paragraph
    else if (textLength >= 100) priority += 100; // Medium paragraph
    else if (textLength >= 50) priority += 60;   // Short paragraph
    else if (textLength >= 20) priority += 30;   // Sentence
    else priority -= 20;                          // Very short = likely UI label

    // 3. SEMANTIC CONTEXT - detect main content vs sidebars
    let ancestor = parent;
    let inMainContent = false;
    let inSidebar = false;
    let depth = 0;

    while (ancestor && depth < 15) {
        const tag = ancestor.tagName;
        const id = (ancestor.id || '').toLowerCase();
        const classes = (ancestor.className && typeof ancestor.className === 'string')
            ? ancestor.className.toLowerCase() : '';
        const role = (ancestor.getAttribute('role') || '').toLowerCase();

        // Main content indicators (+500)
        if (tag === 'MAIN' || tag === 'ARTICLE') {
            inMainContent = true;
        }
        if (role === 'main' || role === 'article') {
            inMainContent = true;
        }
        if (id.includes('content') || id.includes('article') || id.includes('main-text') ||
            id.includes('mw-content') || id.includes('post') || id.includes('entry')) {
            inMainContent = true;
        }
        if (classes.includes('content') || classes.includes('article') ||
            classes.includes('post') || classes.includes('entry') ||
            classes.includes('mw-parser-output') || classes.includes('mw-content')) {
            inMainContent = true;
        }

        // Sidebar/nav indicators (-300)
        if (tag === 'NAV' || tag === 'ASIDE' || tag === 'FOOTER' || tag === 'HEADER') {
            inSidebar = true;
        }
        if (role === 'navigation' || role === 'complementary' ||
            role === 'banner' || role === 'contentinfo' || role === 'menu') {
            inSidebar = true;
        }
        if (id.includes('sidebar') || id.includes('nav') || id.includes('menu') ||
            id.includes('footer') || id.includes('header') || id.includes('toc') ||
            id.includes('widget') || id.includes('prefs') || id.includes('toolbar')) {
            inSidebar = true;
        }
        if (classes.includes('sidebar') || classes.includes('nav') ||
            classes.includes('menu') || classes.includes('footer') ||
            classes.includes('header') || classes.includes('widget') ||
            classes.includes('toc') || classes.includes('infobox') ||
            classes.includes('mw-portlet') || classes.includes('vector-')) {
            inSidebar = true;
        }

        ancestor = ancestor.parentElement;
        depth++;
    }

    if (inMainContent && !inSidebar) priority += 500;
    else if (inMainContent && inSidebar) priority += 100; // Mixed signals
    else if (inSidebar) priority -= 300;

    // 4. TAG TYPE - paragraphs and headings are main content
    const tagName = parent.tagName;
    if (tagName === 'P') priority += 80;
    else if (tagName === 'H1') priority += 70;
    else if (tagName === 'H2') priority += 60;
    else if (tagName === 'H3') priority += 50;
    else if (tagName === 'H4' || tagName === 'H5' || tagName === 'H6') priority += 40;
    else if (tagName === 'LI') priority += 30;
    else if (tagName === 'TD' || tagName === 'TH') priority += 20;
    else if (tagName === 'BLOCKQUOTE' || tagName === 'FIGCAPTION') priority += 25;
    else if (tagName === 'SPAN') priority += 5;
    else if (tagName === 'DIV') priority += 5;
    else if (tagName === 'A') priority -= 10;      // Links are usually navigation
    else if (tagName === 'LABEL') priority -= 30;  // Form labels
    else if (tagName === 'BUTTON') priority -= 50; // UI buttons

    // 5. Position penalty for elements far from center (likely sidebars)
    const centerX = rect.left + rect.width / 2;
    const pageCenter = window.innerWidth / 2;
    const distanceFromCenter = Math.abs(centerX - pageCenter);
    if (distanceFromCenter > window.innerWidth * 0.35) {
        priority -= 100; // Far from center = likely sidebar
    }

    return Math.max(0, priority);
}

/**
 * Extract visible text nodes from the page (or from a specific root)
 */
function extractTextNodes(root = document.body, onlyNew = false) {
    if (!onlyNew) {
        textNodeMap.clear();
        translatedNodeSet.clear();
        nextId = 0;
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
        const id = nextId++;
        const text = node.textContent.trim();
        const priority = calculatePriority(node);

        textNodeMap.set(id, {
            node,
            originalText: node.textContent
        });

        textItems.push({ id, text, priority });
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
                    const id = nextId++;
                    const priority = calculatePriority(node);
                    textNodeMap.set(id, {
                        node,
                        originalText: node.textContent
                    });
                    textItems.push({ id, text: node.textContent.trim(), priority });
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

/**
 * Replace text node content with translation
 */
function replaceTextNode(id, translatedText) {
    const entry = textNodeMap.get(id);
    if (!entry) {
        console.warn(`[Translator] Node ${id} not found in map`);
        return false;
    }

    const { node, originalText } = entry;

    try {
        const leadingSpace = originalText.match(/^\s*/)[0];
        const trailingSpace = originalText.match(/\s*$/)[0];
        node.textContent = leadingSpace + translatedText + trailingSpace;

        // Add blue glow effect to parent element (if enabled)
        const parent = node.parentElement;
        if (parent) {
            if (showGlow) {
                parent.style.textShadow = '0 0 8px #7FBBB3, 0 0 2px #7FBBB3';
            }
            parent.dataset.translated = 'true';
        }

        entry.translated = true;
        entry.translatedText = translatedText;
        translatedNodeSet.add(node);
        console.log(`[Translator] Replaced node ${id}: "${originalText.substring(0, 30)}..." -> "${translatedText.substring(0, 30)}..."`);
        return true;
    } catch (e) {
        console.error(`[Translator] Failed to replace node ${id}:`, e);
        return false;
    }
}

/**
 * Restore original text for all translated nodes
 */
function restoreOriginalText() {
    for (const [id, entry] of textNodeMap) {
        if (entry.translated) {
            try {
                entry.node.textContent = entry.originalText;
                // Keep translated = true so we can toggle back
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
    for (const [id, entry] of textNodeMap) {
        if (entry.translatedText && entry.originalText !== entry.translatedText) {
            try {
                entry.node.textContent = entry.translatedText;
                entry.translated = true;
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
function getPageLanguage() {
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
    return 'en'; // Default fallback
}

/**
 * Translate a batch of text items with retry logic
 * Returns { applied: number, failed: Array } 
 */
async function translateBatch(textItems, targetLanguage, sourceLanguage = 'auto', retries = 3) {
    if (textItems.length === 0) return { applied: 0, failed: [] };

    console.log(`[Translator] translateBatch called with ${textItems.length} items`);

    // Use passed source language if valid, otherwise detect from page
    const pageLanguage = (sourceLanguage && sourceLanguage !== 'auto')
        ? sourceLanguage
        : getPageLanguage();

    let lastError = null;
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const response = await browserAPI.runtime.sendMessage({
                type: 'TRANSLATE',
                texts: textItems,
                targetLanguage,
                sourceLanguage: pageLanguage // Pass detected page language for TranslateGemma
            });

            console.log(`[Translator] translateBatch response:`, response);

            if (response.error) {
                throw new Error(response.error);
            }

            const { translations } = response;
            console.log(`[Translator] Got ${translations?.length} translations back for ${textItems.length} items`);

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

            // Wait before retry (exponential backoff)
            if (attempt < retries - 1) {
                await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
            }
        }
    }

    // All retries failed - return all items as failed
    console.error(`[Translator] All retries failed for batch of ${textItems.length} items`);
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
            console.log('[Translator] Recalculating priorities after scroll');
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

    // Log source language if provided
    if (sourceLanguage && sourceLanguage !== 'auto') {
        console.log(`[Translator] Using explicit source language: ${sourceLanguage}`);
    }

    // Add scroll listener for dynamic priority
    window.addEventListener('scroll', onScroll, { passive: true });

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

        while (pendingTranslationQueue.length > 0 && !translationCancelled) {
            // Take next batch from queue (highest priority items)
            const batch = pendingTranslationQueue.splice(0, batchSize);
            totalProcessed += batch.length;

            // Cap percentage at 100%
            const percent = Math.min(100, Math.round((totalProcessed / totalItems) * 100));
            showStatus(`Translating... ${percent}%`);

            try {
                const result = await translateBatch(batch, targetLanguage, sourceLanguage);
                totalApplied += result.applied;

                // Track failed items (don't add to totalProcessed again)
                if (result.failed && result.failed.length > 0) {
                    failedItems.push(...result.failed);
                }
            } catch (e) {
                console.error('Batch error:', e);
                // Add batch items to failed list
                failedItems.push(...batch);
            }

            // Check cancellation between batches
            if (translationCancelled) {
                showStatus('Translation cancelled');
                setTimeout(hideStatus, 2000);
                break;
            }
        }

        if (!translationCancelled) {
            // Retry failed items silently (up to 2 additional attempts)
            let retryAttempts = 0;
            const maxRetries = 2;

            while (failedItems.length > 0 && retryAttempts < maxRetries && !translationCancelled) {
                retryAttempts++;
                console.log(`[Translator] Retry attempt ${retryAttempts} for ${failedItems.length} failed items`);

                // Show progress as percentage (continuing from where we left off)
                const percent = Math.min(100, Math.round((totalApplied / totalItems) * 100));
                showStatus(`Translating... ${percent}%`);

                // Wait a bit before retry
                await new Promise(r => setTimeout(r, 500 * retryAttempts));

                const itemsToRetry = [...failedItems];
                failedItems.length = 0; // Clear for this round

                // Process in smaller batches for retries
                const retryBatchSize = 4;
                for (let i = 0; i < itemsToRetry.length && !translationCancelled; i += retryBatchSize) {
                    const batch = itemsToRetry.slice(i, i + retryBatchSize);
                    try {
                        const result = await translateBatch(batch, targetLanguage, sourceLanguage, 1); // Single retry per batch
                        totalApplied += result.applied;
                        if (result.failed && result.failed.length > 0) {
                            failedItems.push(...result.failed);
                        }
                    } catch (e) {
                        failedItems.push(...batch);
                    }
                }
            }

            // Show completion message with stats
            const successRate = Math.round((totalApplied / totalItems) * 100);
            let statusMsg = `Translated ${totalApplied}/${totalItems} elements (${successRate}%)`;

            if (failedItems.length > 0) {
                console.warn(`[Translator] ${failedItems.length} items still failed after retries:`,
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
        const entry = textNodeMap.get(item.id);
        if (entry && entry.node && entry.node.parentElement) {
            item.priority = calculatePriority(entry.node);
        }
    }
    // Re-sort by new priorities
    pendingTranslationQueue.sort((a, b) => b.priority - a.priority);

    // Debug log top 3 items
    if (pendingTranslationQueue.length > 0) {
        const top = pendingTranslationQueue.slice(0, 3);
        console.log('[Translator] Top priority items after scroll:', top.map(i => ({
            id: i.id,
            text: i.text.substring(0, 20),
            prio: i.priority
        })));
    }
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
        const applied = await translateBatch(textItems, currentTargetLanguage);
        showStatus(`Translated ${applied} new elements`);
        setTimeout(hideStatus, 2000);
    } catch (e) {
        console.error('Auto-translate error:', e);
        showStatus(`Auto-translate error: ${e.message}`, true);
        setTimeout(hideStatus, 3000);
    } finally {
        translationInProgress = false;
    }
}

// Listen for messages from background/popup
browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log(`[Translator] Received message: ${message.type}`, message);

    switch (message.type) {
        case 'START_TRANSLATION':
            if (message.showGlow !== undefined) {
                showGlow = message.showGlow;
            }
            // Pass sourceLanguage to translatePage
            translatePage(message.targetLanguage, message.sourceLanguage, true);
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

        default:
            sendResponse({ unknown: true });
    }
    return true;
});

console.log('Local LLM Translator content script loaded');

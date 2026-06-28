/**
 * TranslateGemma-compatible language definitions
 * These are the unique languages supported by the TranslateGemma model
 */

// Language codes and names for TranslateGemma
// Format: { code: "Language Name" }
const LANGUAGES = {
    aa: "Afar",
    ab: "Abkhazian",
    af: "Afrikaans",
    ak: "Akan",
    am: "Amharic",
    an: "Aragonese",
    ar: "Arabic",
    as: "Assamese",
    az: "Azerbaijani",
    ba: "Bashkir",
    be: "Belarusian",
    bg: "Bulgarian",
    bm: "Bambara",
    bn: "Bengali",
    bo: "Tibetan",
    br: "Breton",
    bs: "Bosnian",
    ca: "Catalan",
    ce: "Chechen",
    co: "Corsican",
    cs: "Czech",
    cv: "Chuvash",
    cy: "Welsh",
    da: "Danish",
    de: "German",
    dv: "Divehi",
    dz: "Dzongkha",
    ee: "Ewe",
    el: "Greek",
    en: "English",
    eo: "Esperanto",
    es: "Spanish",
    et: "Estonian",
    eu: "Basque",
    fa: "Persian",
    ff: "Fulah",
    fi: "Finnish",
    fil: "Filipino",
    fo: "Faroese",
    fr: "French",
    fy: "Western Frisian",
    ga: "Irish",
    gd: "Scottish Gaelic",
    gl: "Galician",
    gn: "Guarani",
    gu: "Gujarati",
    gv: "Manx",
    ha: "Hausa",
    he: "Hebrew",
    hi: "Hindi",
    hr: "Croatian",
    ht: "Haitian",
    hu: "Hungarian",
    hy: "Armenian",
    ia: "Interlingua",
    id: "Indonesian",
    ie: "Interlingue",
    ig: "Igbo",
    ii: "Sichuan Yi",
    ik: "Inupiaq",
    io: "Ido",
    is: "Icelandic",
    it: "Italian",
    iu: "Inuktitut",
    ja: "Japanese",
    jv: "Javanese",
    ka: "Georgian",
    ki: "Kikuyu",
    kk: "Kazakh",
    kl: "Kalaallisut",
    km: "Central Khmer",
    kn: "Kannada",
    ko: "Korean",
    ks: "Kashmiri",
    ku: "Kurdish",
    kw: "Cornish",
    ky: "Kyrgyz",
    la: "Latin",
    lb: "Luxembourgish",
    lg: "Ganda",
    ln: "Lingala",
    lo: "Lao",
    lt: "Lithuanian",
    lu: "Luba-Katanga",
    lv: "Latvian",
    mg: "Malagasy",
    mi: "Maori",
    mk: "Macedonian",
    ml: "Malayalam",
    mn: "Mongolian",
    mr: "Marathi",
    ms: "Malay",
    mt: "Maltese",
    my: "Burmese",
    nb: "Norwegian Bokmål",
    nd: "North Ndebele",
    ne: "Nepali",
    nl: "Dutch",
    nn: "Norwegian Nynorsk",
    no: "Norwegian",
    nr: "South Ndebele",
    nv: "Navajo",
    ny: "Chichewa",
    oc: "Occitan",
    om: "Oromo",
    or: "Oriya",
    os: "Ossetian",
    pa: "Punjabi",
    pl: "Polish",
    ps: "Pashto",
    pt: "Portuguese",
    qu: "Quechua",
    rm: "Romansh",
    rn: "Rundi",
    ro: "Romanian",
    ru: "Russian",
    rw: "Kinyarwanda",
    sa: "Sanskrit",
    sc: "Sardinian",
    sd: "Sindhi",
    se: "Northern Sami",
    sg: "Sango",
    si: "Sinhala",
    sk: "Slovak",
    sl: "Slovenian",
    sn: "Shona",
    so: "Somali",
    sq: "Albanian",
    sr: "Serbian",
    ss: "Swati",
    st: "Southern Sotho",
    su: "Sundanese",
    sv: "Swedish",
    sw: "Swahili",
    ta: "Tamil",
    te: "Telugu",
    tg: "Tajik",
    th: "Thai",
    ti: "Tigrinya",
    tk: "Turkmen",
    tl: "Tagalog",
    tn: "Tswana",
    to: "Tonga",
    tr: "Turkish",
    ts: "Tsonga",
    tt: "Tatar",
    ug: "Uyghur",
    uk: "Ukrainian",
    ur: "Urdu",
    uz: "Uzbek",
    ve: "Venda",
    vi: "Vietnamese",
    vo: "Volapük",
    wa: "Walloon",
    wo: "Wolof",
    xh: "Xhosa",
    yi: "Yiddish",
    yo: "Yoruba",
    za: "Zhuang",
    zh: "Chinese",
    zu: "Zulu"
};

/**
 * Get language name from code
 * @param {string} code - Language code (e.g., "en", "es")
 * @returns {string} Language name or the code itself if not found
 */
function getLanguageName(code) {
    // Handle codes with regional variants (e.g., "en-US" -> "en")
    const baseCode = code.split('-')[0].toLowerCase();
    return LANGUAGES[baseCode] || code;
}

/**
 * Get language code from name (case-insensitive)
 * @param {string} name - Language name (e.g., "English", "Spanish")
 * @returns {string|null} Language code or null if not found
 */
function getLanguageCode(name) {
    const lowerName = name.toLowerCase();
    for (const [code, langName] of Object.entries(LANGUAGES)) {
        if (langName.toLowerCase() === lowerName) {
            return code;
        }
    }
    return null;
}

// ============================================================================
// Model → request-format mapping (single source of truth)
// ============================================================================
// Each rule maps a model family to the request format it needs. `patterns` are
// matched as case-insensitive substrings against the model id. `plainText: true`
// means the model returns a bare translation (no JSON to parse).
// Add a new model family by adding one entry here — nothing else needs to change.
const MODEL_FORMAT_RULES = [
    { format: 'translategemma', plainText: true, patterns: ['translategemma', 'translate-gemma', 'translate_gemma'] },
    { format: 'hunyuan',        plainText: true, patterns: ['hunyuan-mt', 'hunyuanmt', 'hunyuan_mt'] }
];

// Formats that produce plain text instead of JSON (derived from the rules above).
const PLAIN_TEXT_FORMATS = new Set(MODEL_FORMAT_RULES.filter(r => r.plainText).map(r => r.format));

/**
 * Detect the request format a given model needs, based on its id.
 * Returns the matching format, or 'default' when nothing matches.
 * @param {string} modelId
 * @returns {string}
 */
function detectRequestFormat(modelId) {
    if (!modelId) return 'default';
    const id = modelId.toLowerCase();
    for (const rule of MODEL_FORMAT_RULES) {
        if (rule.patterns.some(p => id.includes(p))) return rule.format;
    }
    return 'default';
}

/**
 * Resolve the effective request format for a settings object.
 * When requestFormat is 'auto', it is derived from the selected model;
 * otherwise the explicit choice is respected.
 * @param {{requestFormat?: string, selectedModel?: string}} settings
 * @param {string} [modelId] - overrides settings.selectedModel if provided
 * @returns {string}
 */
function resolveRequestFormat(settings, modelId) {
    const fmt = settings && settings.requestFormat;
    if (!fmt || fmt === 'auto') {
        return detectRequestFormat(modelId || (settings && settings.selectedModel));
    }
    return fmt;
}

// ============================================================================
// Host permissions for custom (non-localhost) server URLs
// ============================================================================
// The extension ships with only `http://localhost/*` as a static host
// permission, to stay privacy-minimal. When the user points Ollama/LMStudio at
// a remote machine (e.g. another box on the LAN), the extension needs an
// explicit, opt-in host permission for that origin — otherwise the background
// fetch is blocked by the browser and "no models found" with no visible error.

// Hostnames already covered by the static `http://localhost/*` permission.
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Build a match-pattern (origin) for a server URL, or null when no extra
 * permission is needed. Note: match patterns ignore the port, so a single
 * `http://192.168.1.50/*` covers any port on that host.
 * @param {string} rawUrl
 * @returns {string|null}
 */
function hostPermissionPattern(rawUrl) {
    if (!rawUrl) return null;
    let u;
    try { u = new URL(rawUrl); } catch { return null; }
    if (LOCAL_HOSTNAMES.has(u.hostname)) return null; // covered by static permission
    return `${u.protocol}//${u.hostname}/*`;
}

/**
 * Request host permissions for any non-localhost server URLs. Must be called
 * from within a user gesture (e.g. a Save button click). Already-granted
 * origins resolve immediately without a prompt.
 * @param {string[]} urls - candidate server URLs (localhost ones are ignored)
 * @returns {Promise<boolean>} true if no permission was needed or all granted
 */
async function ensureHostPermissions(urls) {
    const api = (typeof browser !== 'undefined') ? browser : chrome;
    const patterns = [...new Set(
        (urls || []).map(hostPermissionPattern).filter(Boolean)
    )];
    if (!patterns.length) return true;
    try {
        return await api.permissions.request({ origins: patterns });
    } catch (e) {
        console.error('Host permission request failed:', e);
        return false;
    }
}

// Export for use in other scripts (will be included via script tag)
// These will be available as global variables
if (typeof window !== 'undefined') {
    window.LANGUAGES = LANGUAGES;
    window.getLanguageName = getLanguageName;
    window.getLanguageCode = getLanguageCode;
    window.MODEL_FORMAT_RULES = MODEL_FORMAT_RULES;
    window.PLAIN_TEXT_FORMATS = PLAIN_TEXT_FORMATS;
    window.detectRequestFormat = detectRequestFormat;
    window.resolveRequestFormat = resolveRequestFormat;
    window.hostPermissionPattern = hostPermissionPattern;
    window.ensureHostPermissions = ensureHostPermissions;
} else if (typeof self !== 'undefined') {
    self.LANGUAGES = LANGUAGES;
    self.getLanguageName = getLanguageName;
    self.getLanguageCode = getLanguageCode;
    self.MODEL_FORMAT_RULES = MODEL_FORMAT_RULES;
    self.PLAIN_TEXT_FORMATS = PLAIN_TEXT_FORMATS;
    self.detectRequestFormat = detectRequestFormat;
    self.resolveRequestFormat = resolveRequestFormat;
    self.hostPermissionPattern = hostPermissionPattern;
    self.ensureHostPermissions = ensureHostPermissions;
}

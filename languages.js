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

// Export for use in other scripts (will be included via script tag)
// These will be available as global variables
if (typeof window !== 'undefined') {
    window.LANGUAGES = LANGUAGES;
    window.getLanguageName = getLanguageName;
    window.getLanguageCode = getLanguageCode;
} else if (typeof self !== 'undefined') {
    self.LANGUAGES = LANGUAGES;
    self.getLanguageName = getLanguageName;
    self.getLanguageCode = getLanguageCode;
}

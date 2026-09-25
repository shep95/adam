/**
 * Interface language. Labels are swapped where they appear in the DOM —
 * rail chips, buttons, menu items, section titles — by matching the whole
 * text of a node against the dictionary, so every panel follows without
 * each one knowing about languages. Right-to-left scripts turn panel text
 * direction around; the globe and its layout stay put. Shepherd reads the
 * language from the console state and answers in it.
 */
import { LANGUAGE_NAMES, RTL, TERMS, TRANSLATIONS } from './dictionary.js';

export function lookupTable(lang) {
  const list = TRANSLATIONS[lang];
  if (!list) return null;
  const map = new Map();
  TERMS.forEach((term, i) => {
    if (list[i]) map.set(term, list[i]);
  });
  return map;
}

/** Translate one label; returns null when it is not a known label. */
export function translateLabel(text, table) {
  if (!table) return null;
  const key = String(text || '')
    .trim()
    .toLowerCase();
  return key && table.has(key) ? table.get(key) : null;
}

const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'CODE', 'PRE']);

export function createI18n({ doc = document } = {}) {
  let lang = 'en';
  let table = null;
  const originals = new WeakMap();
  let observer = null;

  function translateNode(node) {
    if (node.nodeType !== 3) return;
    const parent = node.parentElement;
    if (
      !parent ||
      SKIP.has(parent.tagName) ||
      parent.closest(
        '.material-symbols-outlined, [data-no-translate], .cesium-viewer-cesiumWidgetContainer',
      )
    )
      return;
    const current = node.nodeValue;
    const english =
      originals.has(node) && originals.get(node).shown === current
        ? originals.get(node).english
        : current;
    const next = translateLabel(english, table);
    if (next) {
      const lead = english.match(/^\s*/)[0];
      const trail = english.match(/\s*$/)[0];
      const shown = `${lead}${next}${trail}`;
      originals.set(node, { english, shown });
      if (current !== shown) node.nodeValue = shown;
    } else if (originals.has(node) && originals.get(node).shown === current) {
      node.nodeValue = originals.get(node).english;
      originals.delete(node);
    }
  }

  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) return translateNode(root);
    const it = doc.createTreeWalker(root, 4);
    let n;
    while ((n = it.nextNode())) translateNode(n);
  }

  function setLanguage(code) {
    const next = String(code || 'en')
      .slice(0, 2)
      .toLowerCase();
    lang = TRANSLATIONS[next] || next === 'en' ? next : 'en';
    table = lang === 'en' ? null : lookupTable(lang);
    const root = doc.documentElement;
    root.lang = lang;
    if (RTL.has(lang)) root.dataset.rtl = '1';
    else delete root.dataset.rtl;
    walk(doc.body);
    if (!observer && table) {
      observer = new MutationObserver((records) => {
        if (!table) return;
        for (const r of records) {
          if (r.type === 'characterData') translateNode(r.target);
          else for (const n of r.addedNodes) walk(n);
        }
      });
      observer.observe(doc.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
    if (!table && observer) {
      observer.disconnect();
      observer = null;
    }
    return lang;
  }

  return {
    setLanguage,
    current: () => lang,
    /** For Shepherd's console block. */
    describe: () =>
      lang === 'en' ? null : `${lang} (${LANGUAGE_NAMES[lang] || lang})`,
    destroy() {
      observer?.disconnect();
      observer = null;
    },
  };
}

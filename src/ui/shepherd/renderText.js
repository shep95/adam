/**
 * Safe rendering for Shepherd replies. The model's text is parsed into a
 * tiny block/inline structure and built with DOM nodes and textContent —
 * never innerHTML — so a reply cannot inject markup.
 */

const CONFIDENCE_LINE =
  /^confidence:\s*([01](?:\.\d+)?)\s*(?:·|\||-)\s*signal:\s*(weak|moderate|strong)(?:\s*(?:·|\||-)\s*evidence:\s*(.*?))?(?:\s*(?:·|\||-)\s*unknown:\s*(.*))?$/i;

/** Split inline markdown (**bold**, `code`) into runs. */
export function parseInline(text) {
  const runs = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  for (const m of String(text).matchAll(re)) {
    if (m.index > last)
      runs.push({ kind: 'text', text: text.slice(last, m.index) });
    const token = m[0];
    runs.push(
      token.startsWith('**')
        ? { kind: 'strong', text: token.slice(2, -2) }
        : { kind: 'code', text: token.slice(1, -1) },
    );
    last = m.index + token.length;
  }
  if (last < text.length) runs.push({ kind: 'text', text: text.slice(last) });
  return runs;
}

/** Parse a reply into blocks: p, list, heading, code, confidence. */
export function parseBlocks(source) {
  const blocks = [];
  const lines = String(source || '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  let para = [];
  let list = null;
  let code = null;
  const flushPara = () => {
    if (para.length) blocks.push({ kind: 'p', text: para.join(' ') });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (code) {
      if (/^```/.test(line.trim())) {
        blocks.push(code);
        code = null;
      } else code.text += (code.text ? '\n' : '') + raw;
      continue;
    }
    if (/^```/.test(line.trim())) {
      flushPara();
      flushList();
      code = { kind: 'code', text: '' };
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      flushPara();
      flushList();
      continue;
    }
    const conf = CONFIDENCE_LINE.exec(trimmed);
    if (conf) {
      flushPara();
      flushList();
      blocks.push({
        kind: 'confidence',
        value: Math.max(0, Math.min(1, Number(conf[1]))),
        signal: conf[2].toLowerCase(),
        evidence: (conf[3] || '').trim(),
        unknown: (conf[4] || '').trim(),
      });
      continue;
    }
    const heading = /^#{1,4}\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushPara();
      flushList();
      blocks.push({ kind: 'heading', text: heading[1] });
      continue;
    }
    const item = /^(?:[-*•]|\d+[.)])\s+(.*)$/.exec(trimmed);
    if (item) {
      flushPara();
      list ??= { kind: 'list', ordered: /^\d/.test(trimmed), items: [] };
      list.items.push(item[1]);
      continue;
    }
    flushList();
    para.push(trimmed);
  }
  if (code) blocks.push(code);
  flushPara();
  flushList();
  return blocks;
}

function appendInline(doc, parent, text) {
  for (const run of parseInline(text)) {
    if (run.kind === 'text') parent.append(doc.createTextNode(run.text));
    else {
      const node = doc.createElement(run.kind === 'strong' ? 'strong' : 'code');
      node.textContent = run.text;
      parent.append(node);
    }
  }
}

/** Build DOM for a reply into `container` (replacing its children). */
export function renderReply(doc, container, source) {
  container.replaceChildren();
  for (const block of parseBlocks(source)) {
    if (block.kind === 'p' || block.kind === 'heading') {
      const node = doc.createElement(block.kind === 'p' ? 'p' : 'h4');
      appendInline(doc, node, block.text);
      container.append(node);
    } else if (block.kind === 'list') {
      const node = doc.createElement(block.ordered ? 'ol' : 'ul');
      for (const text of block.items) {
        const li = doc.createElement('li');
        appendInline(doc, li, text);
        node.append(li);
      }
      container.append(node);
    } else if (block.kind === 'code') {
      const pre = doc.createElement('pre');
      pre.textContent = block.text;
      container.append(pre);
    } else if (block.kind === 'confidence') {
      const box = doc.createElement('div');
      box.className = `shp-conf shp-conf--${block.signal}`;
      const meter = doc.createElement('div');
      meter.className = 'shp-conf-meter';
      const fill = doc.createElement('span');
      fill.style.width = `${Math.round(block.value * 100)}%`;
      meter.append(fill);
      const label = doc.createElement('div');
      label.className = 'shp-conf-label';
      label.textContent = `confidence ${block.value.toFixed(2)} · ${block.signal}`;
      box.append(label, meter);
      for (const [key, text] of [
        ['evidence', block.evidence],
        ['unknown', block.unknown],
      ]) {
        if (!text) continue;
        const row = doc.createElement('div');
        row.className = 'shp-conf-row';
        row.textContent = `${key} — ${text}`;
        box.append(row);
      }
      container.append(box);
    }
  }
}

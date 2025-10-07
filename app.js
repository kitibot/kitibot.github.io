const DATA_URL = './kits.txt';

const state = {
  kits: [],        // [{ name, blocks, screenshot }]
  tokens: [],      // search tokens
  open: new Set(), // slugs of open kits for persistent expand state
};

const els = {
  search: document.getElementById('searchInput'),
  clearSearch: document.getElementById('clearSearch'),
  reload: document.getElementById('reloadBtn'),
  summary: document.getElementById('summary'),
  grid: document.getElementById('kitsGrid'),
  empty: document.getElementById('emptyState'),
};

init();

async function init() {
  await loadKits();
  bindUI();
  render();
}

function bindUI() {
  els.search.addEventListener('input', () => {
    state.tokens = tokenize(els.search.value);
    render();
  });
  els.clearSearch.addEventListener('click', () => {
    els.search.value = '';
    state.tokens = [];
    render();
    els.search.focus();
  });
  els.reload.addEventListener('click', async () => {
    await loadKits(true);
    render();
  });
}

async function loadKits(bustCache = false) {
  els.summary.textContent = 'Loading kits…';
  try {
    const url = bustCache ? `${DATA_URL}?t=${Date.now()}` : DATA_URL;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load kits.txt (${res.status})`);
    const text = await res.text();
    const kits = parseKitsText(text);
    kits.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    state.kits = kits;
    els.summary.textContent = `${state.kits.length} kits loaded.`;
  } catch (err) {
    console.error(err);
    els.summary.textContent = 'Failed to load kits.txt';
  }
}

/*
Supports lines like:
  Kit Name, block1, block2, block3 | images/kit.png
- Text before "|" is the kit name + blocks (comma-separated, first item is the name).
- Text after "|" is the screenshot path (optional). Quotes around the path are allowed.
*/
function parseKitsText(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const kits = [];
  for (const line of lines) {
    const partsPipe = line.split('|'); // allow one optional pipe
    const head = partsPipe[0].trim(); // "Kit Name, block1, block2"
    const screenshot = partsPipe[1] ? stripQuotes(partsPipe.slice(1).join('|').trim()) : null;

    const parts = head.split(',').map(s => s.trim()).filter(Boolean);
    if (!parts.length) continue;

    const name = parts[0];
    const blocks = parts.slice(1).map(normalize).filter(Boolean);
    kits.push({ name, blocks, screenshot });
  }
  return kits;
}

function stripQuotes(s) {
  if (!s) return s;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/* ------------- Fuzzy search helpers ------------- */

function normalize(str) {
  return str.toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();
}
function singularize(s) {
  if (s.endsWith('ies') && s.length > 3) return s.slice(0, -3) + 'y';
  if (s.endsWith('sses')) return s.slice(0, -2);
  if (s.endsWith('xes') || s.endsWith('ches') || s.endsWith('shes')) return s.slice(0, -2);
  if (s.endsWith('es') && s.length > 3) return s.slice(0, -2);
  if (s.endsWith('s') && s.length > 3) return s.slice(0, -1);
  return s;
}
function tokenize(q) {
  return (q || '').toLowerCase().split(/[, ]+/).map(s => singularize(normalize(s))).filter(Boolean);
}
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}
function bestWindowSimilarity(text, token) {
  const t = singularize(normalize(text));
  const q = singularize(normalize(token));
  if (!q) return { score: 0, start: -1, end: -1, exact: false };
  const idx = t.indexOf(q);
  if (idx !== -1) return { score: 1, start: idx, end: idx + q.length, exact: true };

  let prefixScore = 0;
  if (t.startsWith(q) || q.startsWith(t)) {
    const len = Math.min(t.length, q.length);
    prefixScore = len / Math.max(t.length, q.length);
  }

  const w = q.length;
  let best = { score: prefixScore, start: -1, end: -1, exact: false };
  if (t.length === 0) return best;

  for (let s = 0; s <= Math.max(0, t.length - w); s++) {
    const sub = t.slice(s, s + w);
    const dist = levenshtein(sub, q);
    const sim = 1 - dist / Math.max(sub.length, q.length);
    if (sim > best.score) best = { score: sim, start: s, end: s + w, exact: false };
    if (best.score === 1) break;
  }
  const wholeDist = levenshtein(t, q);
  const wholeSim = 1 - wholeDist / Math.max(t.length, q.length);
  if (wholeSim > best.score) best = { score: wholeSim, start: -1, end: -1, exact: false };
  return best;
}
function similarityThresholdFor(len) {
  if (len <= 2) return 1.0;
  if (len === 3) return 0.85;
  if (len <= 5) return 0.78;
  if (len <= 8) return 0.72;
  return 0.68;
}
function matchTokenToBlock(token, block) {
  const words = singularize(normalize(block)).split(' ');
  let best = { score: 0, start: -1, end: -1, exact: false, target: singularize(normalize(block)), inWordIndex: -1 };
  let bw = bestWindowSimilarity(block, token);
  if (bw.score > best.score) best = { ...bw, target: singularize(normalize(block)), inWordIndex: -1 };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const res = bestWindowSimilarity(w, token);
    if (res.score > best.score) best = { ...res, target: w, inWordIndex: i };
  }
  return best;
}

/* ------------- Rendering ------------- */

function render() {
  els.grid.innerHTML = '';
  const tokens = state.tokens;

  if (!state.kits.length) {
    els.empty.innerHTML = '<p>No kits found. Edit kits.txt to add kits.</p>';
    els.empty.hidden = false;
    return;
  }

  if (!tokens.length) {
    els.empty.innerHTML = '<p>Type a block (e.g., “grass”) to find which kits include it.</p>';
    els.empty.hidden = false;
    return;
  }

  const results = [];
  for (const kit of state.kits) {
    const matchedBlocks = [];
    let kitScore = 0;

    for (const block of kit.blocks) {
      let bestForBlock = { score: 0, token: '', match: null };
      for (const tokRaw of tokens) {
        const tok = singularize(normalize(tokRaw));
        const match = matchTokenToBlock(tok, block);
        const th = similarityThresholdFor(tok.length);
        if (match.score >= th && match.score > bestForBlock.score) {
          bestForBlock = { score: match.score, token: tok, match, originalBlock: block };
        }
      }
      if (bestForBlock.score > 0) {
        matchedBlocks.push(bestForBlock);
        kitScore += bestForBlock.score;
      }
    }

    if (matchedBlocks.length) {
      matchedBlocks.sort((a, b) => b.score - a.score);
      results.push({ kit, matchedBlocks, kitScore, hitsCount: matchedBlocks.length });
    }
  }

  if (!results.length) {
    els.empty.innerHTML = '<p>No kits match that (try fewer letters or another spelling).</p>';
    els.empty.hidden = false;
    return;
  }

  results.sort((a, b) =>
    b.kitScore - a.kitScore ||
    b.hitsCount - a.hitsCount ||
    a.kit.name.localeCompare(b.kit.name)
  );

  els.empty.hidden = true;

  const frag = document.createDocumentFragment();
  for (const { kit, matchedBlocks } of results) {
    const kitId = slugify(kit.name);
    const card = renderCard(kit, matchedBlocks, state.open.has(kitId));
    frag.appendChild(card);
  }
  els.grid.appendChild(frag);
}

function renderCard(kit, matchedBlocks, isOpen) {
  const kitId = slugify(kit.name);
  const card = div('card');
  if (isOpen) card.classList.add('open');

  const header = div('card-header');
  const title = el('h2', 'card-title', kit.name);
  const meta = el('div', 'card-meta', `${matchedBlocks.length} matching block${matchedBlocks.length > 1 ? 's' : ''}`);
  header.append(title, meta);

  const blocksWrap = div('blocks');
  for (const mb of matchedBlocks) {
    const chip = el('span', 'block-chip');
    const highlighted = highlightApprox(mb.originalBlock, mb.token, mb.match);
    chip.innerHTML = highlighted.html;
    if (!highlighted.hadExact) chip.classList.add('fuzzy');
    blocksWrap.appendChild(chip);
  }

  const toggleBtn = el('button', 'card-toggle');
  toggleBtn.setAttribute('type', 'button');
  toggleBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  toggleBtn.innerHTML = `<span class="chev">▾</span> View kit screenshot`;

  // Details area (collapsed/expanded)
  const details = div('card-details');
  const inner = div('details-inner');

  const shotWrap = div('screenshot-wrap');
  const status = el('div', 'sshot-status', 'Click to load screenshot…');
  const img = document.createElement('img');
  img.className = 'screenshot';
  img.alt = `${kit.name} screenshot`;
  img.decoding = 'async';
  img.loading = 'lazy';
  shotWrap.append(img, status);

  inner.appendChild(shotWrap);
  details.appendChild(inner);

  // Toggle behavior
  toggleBtn.addEventListener('click', () => {
    const nowOpen = card.classList.toggle('open');
    toggleBtn.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');

    if (nowOpen) {
      state.open.add(kitId);
      animateOpen(details);
      loadScreenshot(img, status, kit.screenshot, kit.name);
    } else {
      state.open.delete(kitId);
      animateClose(details);
    }
  });

  if (isOpen) {
    details.style.height = `${details.scrollHeight || 0}px`;
    loadScreenshot(img, status, kit.screenshot, kit.name);
  }

  const headerRow = div('card-header');
  headerRow.append(toggleBtn);

  card.append(header, blocksWrap, headerRow, details);
  return card;
}

/* ------------- Expand/collapse animation ------------- */

function animateOpen(el) {
  el.style.height = '0px';
  el.style.opacity = '0';
  const target = el.scrollHeight;
  requestAnimationFrame(() => {
    el.style.height = target + 'px';
    el.style.opacity = '1';
  });
}

function animateClose(el) {
  const start = el.scrollHeight;
  el.style.height = start + 'px';
  requestAnimationFrame(() => {
    el.style.height = '0px';
    el.style.opacity = '0';
  });
}

/* ------------- Screenshot loading ------------- */

function slugify(name) {
  return name
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s/g, '-')
    .toLowerCase();
}

function loadScreenshot(imgEl, statusEl, screenshotPath, kitName) {
  if (imgEl.dataset.loaded === 'true') return;

  if (!screenshotPath) {
    statusEl.textContent = 'No screenshot path set for this kit. Add “| path/to/image.png” in kits.txt.';
    imgEl.style.display = 'none';
    return;
  }

  statusEl.textContent = 'Loading screenshot…';
  imgEl.style.display = 'block';
  imgEl.src = screenshotPath;

  const onLoad = () => {
    imgEl.dataset.loaded = 'true';
    statusEl.textContent = '';
    cleanup();
  };
  const onError = () => {
    statusEl.textContent = `Failed to load: ${screenshotPath}`;
    imgEl.style.display = 'none';
    cleanup();
  };
  function cleanup() {
    imgEl.removeEventListener('load', onLoad);
    imgEl.removeEventListener('error', onError);
  }
  imgEl.addEventListener('load', onLoad);
  imgEl.addEventListener('error', onError);
}

/* ------------- Highlighting ------------- */

function highlightApprox(blockText, token, match) {
  const lower = singularize(normalize(blockText));
  const t = singularize(normalize(token));
  let hadExact = false;

  const idx = lower.indexOf(t);
  if (idx !== -1) {
    hadExact = true;
    return {
      html: escapeHtml(blockText.slice(0, idx)) +
            '<mark>' + escapeHtml(blockText.slice(idx, idx + t.length)) + '</mark>' +
            escapeHtml(blockText.slice(idx + t.length)),
      hadExact
    };
  }

  if (match && match.start >= 0 && match.end >= 0) {
    const words = blockText.split(/\s+/);
    const idxWord = match.inWordIndex;
    if (idxWord >= 0 && idxWord < words.length) {
      const word = words[idxWord];
      const wordLower = word.toLowerCase();
      const s = match.start;
      const e = match.end;

      const markedWord =
        escapeHtml(wordLower.slice(0, s).split('').map((c, i) => word[i]).join('')) +
        '<mark>' +
        escapeHtml(wordLower.slice(s, e).split('').map((c, i) => word[s + i]).join('')) +
        '</mark>' +
        escapeHtml(wordLower.slice(e).split('').map((c, i) => word[e + i]).join(''));

      words[idxWord] = markedWord;
      return { html: words.map((w, i) => (i === idxWord ? w : escapeHtml(w))).join(' '), hadExact: false };
    }
  }

  return { html: escapeHtml(blockText), hadExact: false };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/* ------------- tiny helpers ------------- */

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}
function div(className) { return el('div', className); }

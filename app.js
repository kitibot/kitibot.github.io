const DATA_URL = './kits.txt';

const state = {
  kits: [],       // [{ name, blocks }]
  tokens: [],     // search tokens
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

function parseKitsText(text) {
  // Each non-empty, non-comment line: Kit Name, block1, block2, ...
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const kits = [];
  for (const line of lines) {
    const parts = line.split(',').map(s => s.trim()).filter(Boolean);
    if (!parts.length) continue;
    const name = parts[0];
    const blocks = parts.slice(1).map(normalize).filter(Boolean);
    kits.push({ name, blocks });
  }
  return kits;
}

// Normalize and light singularization for better matching
function normalize(str) {
  return str.toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();
}
function singularize(s) {
  // very light English singularization
  if (s.endsWith('ies') && s.length > 3) return s.slice(0, -3) + 'y';            // berries -> berry
  if (s.endsWith('sses')) return s.slice(0, -2);                                  // classes -> class
  if (s.endsWith('xes') || s.endsWith('ches') || s.endsWith('shes')) return s.slice(0, -2); // boxes -> box, matches -> match
  if (s.endsWith('es') && s.length > 3) return s.slice(0, -2);                    // stones -> stone
  if (s.endsWith('s') && s.length > 3) return s.slice(0, -1);                     // planks -> plank
  return s;
}

function tokenize(q) {
  return (q || '')
    .toLowerCase()
    .split(/[, ]+/)
    .map(s => singularize(normalize(s)))
    .filter(Boolean);
}

// Levenshtein distance (iterative two-row), returns integer edits
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
      curr[j] = Math.min(
        curr[j - 1] + 1,     // insert
        prev[j] + 1,         // delete
        prev[j - 1] + cost   // substitute
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// Compute token vs text best window similarity with highlight location
function bestWindowSimilarity(text, token) {
  const t = singularize(normalize(text));
  const q = singularize(normalize(token));
  if (!q) return { score: 0, start: -1, end: -1, exact: false };

  // Exact substring fast path
  const idx = t.indexOf(q);
  if (idx !== -1) return { score: 1, start: idx, end: idx + q.length, exact: true };

  // Prefix boost
  let prefixScore = 0;
  if (t.startsWith(q) || q.startsWith(t)) {
    const len = Math.min(t.length, q.length);
    prefixScore = len / Math.max(t.length, q.length);
  }

  // Sliding window approximate match
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

  // Also compare whole word/string (helps for short tokens vs longer words)
  const wholeDist = levenshtein(t, q);
  const wholeSim = 1 - wholeDist / Math.max(t.length, q.length);
  if (wholeSim > best.score) best = { score: wholeSim, start: -1, end: -1, exact: false };

  return best;
}

// Adaptive threshold based on token length (more forgiving for longer tokens)
function similarityThresholdFor(len) {
  if (len <= 2) return 1.0;   // very short terms must be exact
  if (len === 3) return 0.85;
  if (len <= 5) return 0.78;
  if (len <= 8) return 0.72;
  return 0.68;
}

// For a block string, compute the best match info for a token
function matchTokenToBlock(token, block) {
  // Compare against entire block and each word inside the block
  const words = singularize(normalize(block)).split(' ');
  let best = { score: 0, start: -1, end: -1, exact: false, target: singularize(normalize(block)), inWordIndex: -1 };
  // Whole block
  let bw = bestWindowSimilarity(block, token);
  if (bw.score > best.score) best = { ...bw, target: singularize(normalize(block)), inWordIndex: -1 };
  // Per-word
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const res = bestWindowSimilarity(w, token);
    if (res.score > best.score) best = { ...res, target: w, inWordIndex: i };
  }
  return best;
}

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

  // Build results with fuzzy matching and scoring
  const results = [];
  for (const kit of state.kits) {
    const matchedBlocks = [];
    let kitScore = 0;

    for (const block of kit.blocks) {
      // For this block, find its best token match
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
      // Sort matched blocks by score desc
      matchedBlocks.sort((a, b) => b.score - a.score);
      results.push({ kit, matchedBlocks, kitScore, hitsCount: matchedBlocks.length });
    }
  }

  if (!results.length) {
    els.empty.innerHTML = '<p>No kits match that (try fewer letters or another spelling).</p>';
    els.empty.hidden = false;
    return;
  }

  // Rank: higher total score, then more hits, then kit name
  results.sort((a, b) =>
    b.kitScore - a.kitScore ||
    b.hitsCount - a.hitsCount ||
    a.kit.name.localeCompare(b.kit.name)
  );

  els.empty.hidden = true;

  const frag = document.createDocumentFragment();
  for (const { kit, matchedBlocks } of results) {
    frag.appendChild(renderCard(kit, matchedBlocks));
  }
  els.grid.appendChild(frag);
}

function renderCard(kit, matchedBlocks) {
  const card = div('card');
  const header = div('card-header');
  const title = el('h2', 'card-title', kit.name);
  const meta = el('div', 'card-meta', `${matchedBlocks.length} matching block${matchedBlocks.length > 1 ? 's' : ''}`);
  header.append(title, meta);

  const blocksWrap = div('blocks');

  // Matched blocks first with highlight; then (optional) other blocks could be listed faded if desired
  for (const mb of matchedBlocks) {
    const chip = el('span', 'block-chip');
    const blockText = mb.originalBlock;

    // Try to highlight the best window on either the whole block or the word that matched best.
    const highlighted = highlightApprox(blockText, mb.token, mb.match);
    chip.innerHTML = highlighted.html;
    if (!highlighted.hadExact) chip.classList.add('fuzzy'); // mark fuzzy matches
    blocksWrap.appendChild(chip);
  }

  card.append(header, blocksWrap);
  return card;
}

function highlightApprox(blockText, token, match) {
  const lower = singularize(normalize(blockText));
  const t = singularize(normalize(token));
  let hadExact = false;

  // If exact substring in entire block, highlight that
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

  // If we only matched a specific word window, highlight that portion inside the matching word
  if (match && match.start >= 0 && match.end >= 0) {
    // Reconstruct based on words to place mark at approximate segment
    const words = blockText.split(/\s+/);
    const idxWord = match.inWordIndex;
    if (idxWord >= 0 && idxWord < words.length) {
      const word = words[idxWord];
      const before = words.slice(0, idxWord).join(' ');
      const after = words.slice(idxWord + 1).join(' ');
      const wordLower = words[idxWord].toLowerCase();
      const s = match.start;
      const e = match.end;

      const markedWord =
        escapeHtml(wordLower.slice(0, s).split('').map((c, i) => word[i]).join('')) +
        '<mark>' +
        escapeHtml(wordLower.slice(s, e).split('').map((c, i) => word[s + i]).join('')) +
        '</mark>' +
        escapeHtml(wordLower.slice(e).split('').map((c, i) => word[e + i]).join(''));

      const joinLeft = before ? escapeHtml(before) + ' ' : '';
      const joinRight = after ? ' ' + escapeHtml(after) : '';
      return { html: joinLeft + markedWord + joinRight, hadExact: false };
    }
  }

  // Fallback: no exact window we can place reliably; return full chip text, marked as fuzzy via CSS
  return { html: escapeHtml(blockText), hadExact: false };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// tiny helpers
function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}
function div(className) { return el('div', className); }

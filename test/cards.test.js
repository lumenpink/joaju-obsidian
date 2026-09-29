const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal DOM paragraph from raw HTML */
function makeParagraph(innerHtml, wrapInList = false) {
  const wrapper = wrapInList
    ? `<ul><li><p>${innerHtml}</p></li></ul>`
    : `<div><p>${innerHtml}</p></div>`;
  const { document } = parseHTML(`<html><body>${wrapper}</body></html>`);
  if (wrapInList) {
    return document.querySelector('li > p');
  }
  return document.querySelector('div > p');
}

/** Build a linkedom document and inject it as global.document so that
 *  renderCardElement (which calls document.createElement) works in Node. */
function makeDocument(bodyHtml = '') {
  const { document } = parseHTML(`<html><body>${bodyHtml}</body></html>`);
  // eslint-disable-next-line no-global-assign
  global.document = document;
  return document;
}

// Require AFTER potential global.document setup (modules are cached anyway)
const { simpleHash, isIsolatedLinkParagraph, renderCardElement } = require('../main.js');

// ── simpleHash ────────────────────────────────────────────────────────────────

test('simpleHash - mesma URL sempre devolve o mesmo hash', () => {
  const url = 'https://example.com/article';
  assert.strictEqual(simpleHash(url), simpleHash(url));
});

test('simpleHash - hashes diferentes para URLs diferentes', () => {
  assert.notStrictEqual(simpleHash('https://a.com'), simpleHash('https://b.com'));
});

test('simpleHash - resultado é string alfanumérica não-vazia', () => {
  const h = simpleHash('https://example.com');
  assert.strictEqual(typeof h, 'string');
  assert.ok(h.length > 0);
  assert.match(h, /^[a-z0-9]+$/);
});

// ── isIsolatedLinkParagraph ───────────────────────────────────────────────────

test('isIsolatedLinkParagraph - link isolado → isIsolated=true', () => {
  const p = makeParagraph('<a href="https://example.com">Example</a>');
  const result = isIsolatedLinkParagraph(p);
  assert.strictEqual(result.isIsolated, true);
  assert.ok(result.linkEl);
  assert.strictEqual(result.linkEl.href, 'https://example.com');
});

test('isIsolatedLinkParagraph - link com texto ao redor → isIsolated=false', () => {
  const p = makeParagraph('Veja <a href="https://example.com">este link</a> aqui.');
  const result = isIsolatedLinkParagraph(p);
  assert.strictEqual(result.isIsolated, false);
});

test('isIsolatedLinkParagraph - dois links no parágrafo → isIsolated=false', () => {
  const p = makeParagraph('<a href="https://a.com">A</a> e <a href="https://b.com">B</a>');
  const result = isIsolatedLinkParagraph(p);
  assert.strictEqual(result.isIsolated, false);
});

test('isIsolatedLinkParagraph - link dentro de <li> → isIsolated=false', () => {
  const p = makeParagraph('<a href="https://example.com">Link</a>', true);
  const result = isIsolatedLinkParagraph(p);
  assert.strictEqual(result.isIsolated, false);
});

test('isIsolatedLinkParagraph - <!-- nocard --> na mesma linha → isIsolated=false', () => {
  const { document } = parseHTML(`
    <html><body><div>
      <p><a href="https://example.com">Link</a><!-- nocard --></p>
    </div></body></html>
  `);
  const p = document.querySelector('p');
  const result = isIsolatedLinkParagraph(p);
  assert.strictEqual(result.isIsolated, false);
});

test('isIsolatedLinkParagraph - parágrafo vazio → isIsolated=false', () => {
  const p = makeParagraph('');
  const result = isIsolatedLinkParagraph(p);
  assert.strictEqual(result.isIsolated, false);
});

// ── Atalho !url ───────────────────────────────────────────────────────────────

test('isIsolatedLinkParagraph - atalho !https://url → isIsolated=true com rawUrl', () => {
  const p = makeParagraph('!https://example.com/article');
  const result = isIsolatedLinkParagraph(p);
  assert.strictEqual(result.isIsolated, true);
  assert.strictEqual(result.linkEl, null);
  assert.strictEqual(result.rawUrl, 'https://example.com/article');
});

test('isIsolatedLinkParagraph - atalho !gemini://host/path → isIsolated=true com rawUrl', () => {
  const p = makeParagraph('!gemini://gemini.circumlunar.space/users/solderpunk/');
  const result = isIsolatedLinkParagraph(p);
  assert.strictEqual(result.isIsolated, true);
  assert.strictEqual(result.rawUrl, 'gemini://gemini.circumlunar.space/users/solderpunk/');
});

test('isIsolatedLinkParagraph - atalho !gopher://url → isIsolated=true com rawUrl', () => {
  const p = makeParagraph('!gopher://gopher.floodgap.com/1/');
  const result = isIsolatedLinkParagraph(p);
  assert.strictEqual(result.isIsolated, true);
  assert.strictEqual(result.rawUrl, 'gopher://gopher.floodgap.com/1/');
});

test('isIsolatedLinkParagraph - texto sem ! não vira card', () => {
  const p = makeParagraph('https://example.com');
  const result = isIsolatedLinkParagraph(p);
  assert.strictEqual(result.isIsolated, false);
});

test('isIsolatedLinkParagraph - !url com texto ao redor não vira card', () => {
  const p = makeParagraph('veja !https://example.com aqui');
  const result = isIsolatedLinkParagraph(p);
  assert.strictEqual(result.isIsolated, false);
});

// ── fetchUnfurl ───────────────────────────────────────────────────────────────
// fetchUnfurl uses globalThis.fetch when obsidian.requestUrl is absent.
// We temporarily replace globalThis.fetch with a stub.

test('fetchUnfurl - retorna dados quando fetch responde com sucesso', async () => {
  const { fetchUnfurl } = require('../main.js');
  const fakeData = { ok: true, title: 'Test Page', description: 'Desc', domain: 'test.com' };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => fakeData
  });
  try {
    const result = await fetchUnfurl('http://localhost:3000', 'https://example.com', false);
    assert.strictEqual(result.title, 'Test Page');
    assert.strictEqual(result.domain, 'test.com');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchUnfurl - lança erro quando resposta não é ok', async () => {
  const { fetchUnfurl } = require('../main.js');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 422,
    json: async () => ({ ok: false, error: 'URL inválida' })
  });
  try {
    await assert.rejects(
      () => fetchUnfurl('http://localhost:3000', 'https://bad.url', false),
      /URL inválida/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── renderCardElement ─────────────────────────────────────────────────────────

test('renderCardElement - renderiza título e domínio', () => {
  const doc = makeDocument('<div id="card"></div>');
  const cardEl = doc.getElementById('card');
  const data = {
    title: 'Meu Artigo',
    description: 'Uma descrição bacana.',
    domain: 'bacana.com.br',
    faviconUrl: null,
    imageUrl: null,
    localResourcePath: null,
    author: null,
    date: null,
    readingTimeMin: 3,
    hasArticle: true
  };
  renderCardElement(cardEl, data, { onRefresh: () => {}, onArchive: () => {} });

  assert.ok(cardEl.innerHTML.includes('Meu Artigo'));
  assert.ok(cardEl.innerHTML.includes('bacana.com.br'));
  assert.ok(cardEl.innerHTML.includes('3'));
});

test('renderCardElement - adiciona classe has-no-image quando sem imagem', () => {
  const doc = makeDocument('<div id="card"></div>');
  const cardEl = doc.getElementById('card');
  renderCardElement(
    cardEl,
    {
      title: 'Sem Imagem',
      description: '',
      domain: 'test.com',
      faviconUrl: null,
      imageUrl: null,
      localResourcePath: null,
      author: null,
      date: null,
      readingTimeMin: 1,
      hasArticle: false
    },
    { onRefresh: () => {}, onArchive: () => {} }
  );

  assert.ok(cardEl.className.includes('has-no-image'));
});

test('renderCardElement - remove classe has-no-image quando há imagem local', () => {
  const doc = makeDocument('<div id="card" class="joaju-link-card has-no-image"></div>');
  const cardEl = doc.getElementById('card');
  renderCardElement(
    cardEl,
    {
      title: 'Com Imagem',
      description: 'Desc',
      domain: 'img.io',
      faviconUrl: null,
      imageUrl: 'https://img.io/cover.jpg',
      localResourcePath: 'app://local/cover.jpg',
      author: 'Autor',
      date: '2025-01-01',
      readingTimeMin: 5,
      hasArticle: true
    },
    { onRefresh: () => {}, onArchive: () => {} }
  );

  assert.ok(!cardEl.className.includes('has-no-image'));
  assert.ok(cardEl.innerHTML.includes('app://local/cover.jpg'));
});

test('renderCardElement - adiciona botão de edição quando onEdit é fornecido', () => {
  const doc = makeDocument('<div id="card"></div>');
  const cardEl = doc.getElementById('card');
  let edited = false;
  renderCardElement(
    cardEl,
    {
      title: 'Teste Edit',
      domain: 'test.com',
      url: 'https://test.com'
    },
    {
      onEdit: () => {
        edited = true;
      }
    }
  );

  assert.ok(cardEl.innerHTML.includes('✏️'));
  const editBtn = cardEl.querySelector('.joaju-card-btn[title="Editar Markdown"]');
  assert.ok(editBtn);
  editBtn.click();
  assert.strictEqual(edited, true);
});

// ── CM6 Extensions & loadAndRenderCard ───────────────────────────────────────

test('createAutoTitleExtension e createLivePreviewCardsExtension retornam extensões válidas', () => {
  const { createAutoTitleExtension, createLivePreviewCardsExtension } = require('../main.js');
  const mockPlugin = { settings: { enableCards: true } };

  const autoTitle = createAutoTitleExtension(mockPlugin);
  const livePreview = createLivePreviewCardsExtension(mockPlugin);

  assert.ok(autoTitle);
  assert.ok(livePreview);
});

test('LinkCardWidget - instanciação, eq e ignoreEvent', () => {
  const { LinkCardWidget } = require('../main.js');
  const mockPlugin = { settings: { enableCards: true } };

  const w1 = new LinkCardWidget('https://a.com', 'A', mockPlugin, 1);
  const w2 = new LinkCardWidget('https://a.com', 'A', mockPlugin, 1);
  const w3 = new LinkCardWidget('https://b.com', 'B', mockPlugin, 2);

  assert.strictEqual(w1.eq(w2), true);
  assert.strictEqual(w1.eq(w3), false);
  assert.strictEqual(w1.ignoreEvent(), true);
});

test('loadAndRenderCard - renderiza card a partir de dados em cache', async () => {
  const { loadAndRenderCard } = require('../main.js');
  const doc = makeDocument('<div id="card"></div>');
  const cardEl = doc.getElementById('card');

  const cachedData = {
    [simpleHash('https://cached.org')]: {
      title: 'Artigo Cacheado',
      domain: 'cached.org',
      url: 'https://cached.org'
    }
  };

  const mockPlugin = {
    manifest: { dir: '.obsidian/plugins/joaju-obsidian' },
    settings: { enableCards: true, serverUrl: 'http://localhost:3000' },
    app: {
      vault: {
        adapter: {
          read: async () => JSON.stringify(cachedData),
          write: async () => {}
        }
      }
    }
  };

  await loadAndRenderCard(cardEl, 'https://cached.org', mockPlugin);
  assert.ok(cardEl.innerHTML.includes('Artigo Cacheado'));
  assert.ok(cardEl.innerHTML.includes('cached.org'));
});

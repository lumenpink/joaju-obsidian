const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_SETTINGS,
  createDiagramCache,
  buildRenderPayload,
  fetchDiagramSvg
} = require('../main.js');

test('Configurações Padrão (DEFAULT_SETTINGS)', () => {
  assert.ok(DEFAULT_SETTINGS.serverUrl.startsWith('http'));
  assert.strictEqual(typeof DEFAULT_SETTINGS.debounceMs, 'number');
  assert.ok(DEFAULT_SETTINGS.debounceMs >= 100);
});

test('Cache de Diagramas (createDiagramCache)', () => {
  const cache = createDiagramCache(2);

  assert.strictEqual(cache.size(), 0);
  assert.strictEqual(cache.get('d2:a'), null);
  assert.strictEqual(cache.has('d2:a'), false);

  cache.set('d2:a', '<svg id="a"></svg>');
  assert.strictEqual(cache.size(), 1);
  assert.strictEqual(cache.has('d2:a'), true);
  assert.strictEqual(cache.get('d2:a'), '<svg id="a"></svg>');

  cache.set('d2:b', '<svg id="b"></svg>');
  assert.strictEqual(cache.size(), 2);

  // Inserção do 3º elemento deve remover o mais antigo (d2:a)
  cache.set('d2:c', '<svg id="c"></svg>');
  assert.strictEqual(cache.size(), 2);
  assert.strictEqual(cache.has('d2:a'), false);
  assert.strictEqual(cache.has('d2:b'), true);
  assert.strictEqual(cache.has('d2:c'), true);

  // Atualização de chave existente não excede tamanho
  cache.set('d2:c', '<svg id="c-mod"></svg>');
  assert.strictEqual(cache.size(), 2);
  assert.strictEqual(cache.get('d2:c'), '<svg id="c-mod"></svg>');

  cache.clear();
  assert.strictEqual(cache.size(), 0);
});

test('Normalizador de Payload (buildRenderPayload)', () => {
  assert.throws(() => buildRenderPayload('', 'd2'), /vazio/);
  assert.throws(() => buildRenderPayload('   ', 'kinship'), /vazio/);

  // Código sem crases deve ser envelopado
  const bare = buildRenderPayload('x -> y: Conexao', 'd2');
  assert.strictEqual(bare.engine, 'd2');
  assert.strictEqual(bare.code, '```d2\nx -> y: Conexao\n```');

  // Código já envelopado deve ser preservado
  const wrapped = buildRenderPayload('```kinship\nid,pai,mae\n1,0,0\n```', 'kinship');
  assert.strictEqual(wrapped.engine, 'kinship');
  assert.strictEqual(wrapped.code, '```kinship\nid,pai,mae\n1,0,0\n```');
});

test('Cliente HTTP (fetchDiagramSvg) - Sucesso com fetch padrão', async () => {
  const mockFetch = async (url, opts) => {
    assert.strictEqual(url, 'https://joaju.lumen.pink/render');
    assert.strictEqual(opts.method, 'POST');
    assert.strictEqual(opts.headers['Content-Type'], 'application/json');

    const body = JSON.parse(opts.body);
    assert.strictEqual(body.engine, 'd2');

    return {
      ok: true,
      status: 200,
      text: async () => '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'
    };
  };

  const svg = await fetchDiagramSvg('https://joaju.lumen.pink/', 'a -> b', 'd2', mockFetch);
  assert.ok(svg.includes('<svg'));
});

test('Cliente HTTP (fetchDiagramSvg) - Sucesso com Obsidian requestUrl', async () => {
  const mockObsidianRequest = async (url, opts) => {
    return {
      status: 200,
      text: '<svg viewBox="0 0 100 100"><circle/></svg>'
    };
  };

  const svg = await fetchDiagramSvg(
    'http://localhost:3000',
    'id,pai,mae\n1,0,0',
    'kinship',
    mockObsidianRequest
  );
  assert.ok(svg.includes('<svg viewBox'));
});

test('Cliente HTTP (fetchDiagramSvg) - Erro de compilação da API (422/500)', async () => {
  const mockErrorFetch = async () => ({
    ok: false,
    status: 422,
    text: async () => JSON.stringify({ error: 'Erro de sintaxe no D2 linha 3' })
  });

  await assert.rejects(
    () => fetchDiagramSvg('http://localhost:3000', 'invalid', 'd2', mockErrorFetch),
    /Erro de sintaxe no D2/
  );
});

test('Cliente HTTP (fetchDiagramSvg) - Resposta sem SVG válido', async () => {
  const mockInvalidSvgFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => '<html><body>502 Bad Gateway</body></html>'
  });

  await assert.rejects(
    () => fetchDiagramSvg('http://localhost:3000', 'a -> b', 'd2', mockInvalidSvgFetch),
    /sem SVG válido/
  );
});

test('Cliente HTTP (fetchDiagramSvg) - Falha de conexão de rede', async () => {
  const mockNetworkFail = async () => {
    throw new Error('ECONNREFUSED');
  };

  await assert.rejects(
    () => fetchDiagramSvg('http://localhost:3000', 'a -> b', 'd2', mockNetworkFail),
    /Falha de conexão com o servidor Joaju/
  );
});

test('Configurações Fuxico (DEFAULT_SETTINGS)', () => {
  assert.ok(DEFAULT_SETTINGS.fuxicoUrl.startsWith('https://'));
  assert.ok(DEFAULT_SETTINGS.fuxicoToken.length > 0);
});

test('Atualizador de Frontmatter (updateFrontmatterString)', () => {
  // Nota sem frontmatter
  const rawWithoutFm = '# Meu Artigo\n\nConteúdo aqui.';
  const updated1 = require('../main.js').updateFrontmatterString(rawWithoutFm, {
    pdfUrl: 'https://2lp.in/12345.pdf'
  });
  assert.ok(updated1.startsWith('---\n'));
  assert.ok(updated1.includes('fuxico_pdf: https://2lp.in/12345.pdf'));
  assert.ok(updated1.includes('tags:\n  - fuxico'));

  // Nota com frontmatter existente
  const rawWithFm = `---
title: Teste
tags:
  - artigo
---

# Teste`;
  const updated2 = require('../main.js').updateFrontmatterString(rawWithFm, {
    pdfUrl: 'https://2lp.in/pdf1.pdf',
    mdUrl: 'https://2lp.in/md1.md'
  });
  assert.ok(updated2.includes('title: Teste'));
  assert.ok(updated2.includes('fuxico_pdf: https://2lp.in/pdf1.pdf'));
  assert.ok(updated2.includes('fuxico_md: https://2lp.in/md1.md'));
  assert.ok(updated2.includes('  - fuxico'));
});

test('Compilador de PDF (compileMarkdownToPdf) - Sucesso com fetch padrão', async () => {
  const { compileMarkdownToPdf } = require('../main.js');
  const mockFetch = async (url, opts) => {
    assert.strictEqual(url, 'http://baquara:3000/compile');
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([37, 80, 68, 70]).buffer
    };
  };

  const buffer = await compileMarkdownToPdf('http://baquara:3000', '# Artigo', mockFetch);
  assert.ok(buffer);
  assert.strictEqual(buffer.byteLength, 4);
});

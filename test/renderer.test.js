const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_SETTINGS,
  createDiagramCache,
  buildRenderPayload,
  fetchDiagramSvg,
  CANONICAL_ENGINES,
  resolveDiagramSource,
  resolveMarkdownExternalSources
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

test('Cliente HTTP (fetchDiagramSvg) - Sucesso com resposta HTML de tabela acadêmica', async () => {
  const mockTableFetch = async () => ({
    status: 200,
    text: JSON.stringify({
      format: 'table',
      type: 'html',
      html: '<div class="joaju-academic-table-wrapper"><table class="joaju-academic-table"></table></div>'
    })
  });

  const html = await fetchDiagramSvg(
    'http://localhost:3000',
    'Col1, Col2\n1, 2',
    'table',
    mockTableFetch
  );
  assert.ok(html.includes('class="joaju-academic-table"'));
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
    /sem SVG ou HTML válido/
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
  assert.ok(DEFAULT_SETTINGS.fuxicoUrl.startsWith('http'));
  assert.strictEqual(typeof DEFAULT_SETTINGS.fuxicoToken, 'string');
});

test('Atualizador de Frontmatter (updateFrontmatterString)', () => {
  // Nota sem frontmatter
  const rawWithoutFm = '# Meu Artigo\n\nConteúdo aqui.';
  const updated1 = require('../main.js').updateFrontmatterString(rawWithoutFm, {
    pdfUrl: 'http://localhost:8080/12345.pdf'
  });
  assert.ok(updated1.startsWith('---\n'));
  assert.ok(updated1.includes('fuxico_pdf: http://localhost:8080/12345.pdf'));
  assert.ok(updated1.includes('tags:\n  - fuxico'));

  // Nota com frontmatter existente
  const rawWithFm = `---
title: Teste
tags:
  - artigo
---

# Teste`;
  const updated2 = require('../main.js').updateFrontmatterString(rawWithFm, {
    pdfUrl: 'http://localhost:8080/pdf1.pdf',
    mdUrl: 'http://localhost:8080/md1.md'
  });
  assert.ok(updated2.includes('title: Teste'));
  assert.ok(updated2.includes('fuxico_pdf: http://localhost:8080/pdf1.pdf'));
  assert.ok(updated2.includes('fuxico_md: http://localhost:8080/md1.md'));
  assert.ok(updated2.includes('  - fuxico'));
});

test('Compilador de PDF (compileMarkdownToPdf) - Sucesso com fetch padrão', async () => {
  const { compileMarkdownToPdf } = require('../main.js');
  const mockFetch = async (url, opts) => {
    assert.strictEqual(url, 'http://localhost:3000/compile');
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([37, 80, 68, 70]).buffer
    };
  };

  const buffer = await compileMarkdownToPdf('http://localhost:3000', '# Artigo', mockFetch);
  assert.ok(buffer);
  assert.strictEqual(buffer.byteLength, 4);
});

test('Comparador de Versões SemVer (isNewerVersion)', () => {
  const { isNewerVersion } = require('../main.js');

  assert.strictEqual(isNewerVersion('0.2.0', '0.1.0'), true);
  assert.strictEqual(isNewerVersion('0.1.1', '0.1.0'), true);
  assert.strictEqual(isNewerVersion('1.0.0', '0.9.9'), true);
  assert.strictEqual(isNewerVersion('v0.2.0', '0.1.0'), true);
  assert.strictEqual(isNewerVersion('0.1.0', '0.1.0'), false);
  assert.strictEqual(isNewerVersion('0.0.9', '0.1.0'), false);
  assert.strictEqual(isNewerVersion('0.1.0', '0.2.0'), false);
  assert.strictEqual(isNewerVersion(null, '0.1.0'), false);
});

test('Verificador de Atualizações Codeberg (checkCodebergUpdate)', async () => {
  const { checkCodebergUpdate } = require('../main.js');

  const mockFetchNew = async (url) => {
    assert.ok(url.includes('codeberg.org/lumenpink/joaju-obsidian'));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ version: '0.2.0' })
    };
  };

  const resNew = await checkCodebergUpdate(
    'lumenpink/joaju-obsidian',
    'main',
    '0.1.0',
    mockFetchNew
  );
  assert.strictEqual(resNew.hasUpdate, true);
  assert.strictEqual(resNew.remoteVersion, '0.2.0');

  const mockFetchSame = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ version: '0.1.0' })
  });

  const resSame = await checkCodebergUpdate(
    'lumenpink/joaju-obsidian',
    'main',
    '0.1.0',
    mockFetchSame
  );
  assert.strictEqual(resSame.hasUpdate, false);
});

test('Download de Arquivos do Plugin (downloadCodebergPluginFiles)', async () => {
  const { downloadCodebergPluginFiles } = require('../main.js');

  const mockFetch = async (url) => {
    if (url.includes('manifest.json')) {
      return { ok: true, text: async () => '{"id":"joaju-obsidian"}' };
    }
    if (url.includes('main.js')) {
      return { ok: true, text: async () => 'console.log("hello");' };
    }
    if (url.includes('styles.css')) {
      return { ok: true, text: async () => '.body {}' };
    }
    return { ok: false, status: 404 };
  };

  const files = await downloadCodebergPluginFiles('lumenpink/joaju-obsidian', 'main', mockFetch);
  assert.strictEqual(files['manifest.json'], '{"id":"joaju-obsidian"}');
  assert.strictEqual(files['main.js'], 'console.log("hello");');
  assert.strictEqual(files['styles.css'], '.body {}');
});

test('Sincronizador Zotero Tatupeba (syncZoteroWithTatupeba) - Sucesso com token', async () => {
  const { syncZoteroWithTatupeba } = require('../main.js');

  const mockObsidianRequest = async (opts) => {
    assert.strictEqual(opts.url, 'http://localhost:3001/sync');
    assert.strictEqual(opts.headers.Authorization, 'Bearer chave_secreta');
    assert.strictEqual(opts.headers['X-Api-Key'], 'chave_secreta');
    return {
      status: 200,
      json: {
        ok: true,
        summary: { notesWritten: 5, bibEntries: 12 }
      }
    };
  };

  const res = await syncZoteroWithTatupeba(
    'http://localhost:3001',
    'chave_secreta',
    mockObsidianRequest
  );
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.summary.notesWritten, 5);
  assert.strictEqual(res.summary.bibEntries, 12);
});

test('Sincronizador Zotero Tatupeba (syncZoteroWithTatupeba) - Erro 401 Não autorizado', async () => {
  const { syncZoteroWithTatupeba } = require('../main.js');

  const mockObsidian401 = async () => {
    const err = new Error('Unauthorized');
    err.status = 401;
    throw err;
  };

  await assert.rejects(
    async () => syncZoteroWithTatupeba('http://localhost:3001', 'errado', mockObsidian401),
    /Não autorizado/
  );
});

test('Upload para Fuxico (uploadToFuxico) - Sucesso com Obsidian requestUrl', async () => {
  const { uploadToFuxico } = require('../main.js');

  const mockRequestUrl = async (urlOrOptions, maybeOptions) => {
    const opts = typeof urlOrOptions === 'string' ? maybeOptions : urlOrOptions;
    assert.strictEqual(opts.method, 'POST');
    assert.ok(opts.headers['Content-Type'].startsWith('multipart/form-data; boundary='));
    assert.strictEqual(opts.headers.Authorization, 'Bearer token_teste');
    assert.ok(opts.body);
    return {
      status: 200,
      text: 'https://2lp.in/abcde.md\n'
    };
  };

  const url = await uploadToFuxico(
    'https://2lp.in',
    'token_teste',
    'nota.md',
    '# Conteudo da nota',
    'text/markdown',
    mockRequestUrl
  );

  assert.strictEqual(url, 'https://2lp.in/abcde.md');
});

test('Upload para Fuxico (uploadToFuxico) - Erro HTTP no upload', async () => {
  const { uploadToFuxico } = require('../main.js');

  const mockRequestUrlError = async () => ({
    status: 403,
    text: 'Forbidden'
  });

  await assert.rejects(
    async () =>
      uploadToFuxico(
        'https://2lp.in',
        'token_invalido',
        'nota.md',
        'conteudo',
        'text/markdown',
        mockRequestUrlError
      ),
    /Erro 403 no Fuxico/
  );
});

test('Motores Canônicos (CANONICAL_ENGINES)', () => {
  assert.deepStrictEqual(CANONICAL_ENGINES, [
    'pedtools',
    'kinship2',
    'd2',
    'plantuml',
    'graphviz',
    'openchemlib',
    'openbabel',
    'table'
  ]);
  assert.strictEqual(new Set(CANONICAL_ENGINES).size, CANONICAL_ENGINES.length);
  assert.strictEqual(CANONICAL_ENGINES.includes('kinship'), false);
  assert.strictEqual(CANONICAL_ENGINES.includes('heredograma'), false);
  assert.strictEqual(CANONICAL_ENGINES.includes('pedigree'), false);
  assert.strictEqual(CANONICAL_ENGINES.includes('puml'), false);
});

test('Resolução de Fontes Externas (resolveDiagramSource)', async () => {
  const normalCode = 'id,pai,mae,sex\n1,0,0,1';
  assert.strictEqual(await resolveDiagramSource(normalCode), normalCode);

  const remoteCode = '%% layout.width=80%\n%% src="https://dados.org/familia.csv"\n%% cex=0.9';
  const mockFetch = async (url) => {
    assert.strictEqual(url, 'https://dados.org/familia.csv');
    return {
      text: async () => 'id,pai,mae,sex,afetado\n1,0,0,1,1\n2,0,0,2,0'
    };
  };

  const resolvedRemote = await resolveDiagramSource(remoteCode, null, '', mockFetch);
  assert.ok(resolvedRemote.includes('%% layout.width=80%'));
  assert.ok(resolvedRemote.includes('%% cex=0.9'));
  assert.ok(!resolvedRemote.includes('src='));
  assert.ok(resolvedRemote.includes('id,pai,mae,sex,afetado'));

  const localCode = '%% layout.width=70%\n%% file=pedigrees/familia1.csv';
  const fakeVault = {
    getAbstractFileByPath: (p) => (p === 'pedigrees/familia1.csv' ? { path: p } : null),
    read: async () => 'id,pai,mae,sex\n10,0,0,1'
  };

  const resolvedLocal = await resolveDiagramSource(localCode, fakeVault, 'nota.md');
  assert.ok(resolvedLocal.includes('%% layout.width=70%'));
  assert.ok(!resolvedLocal.includes('file='));
  assert.ok(resolvedLocal.includes('id,pai,mae,sex\n10,0,0,1'));

  const wikilinkCode = '%% src=[[tabela.csv]]';
  const fakeVaultWiki = {
    getAbstractFileByPath: () => null,
    getFirstLinkpathDest: (p) => (p === 'tabela.csv' ? { path: 'anexos/tabela.csv' } : null),
    read: async () => 'id,pai,mae\n1,0,0'
  };
  const resolvedWiki = await resolveDiagramSource(wikilinkCode, fakeVaultWiki, 'pasta/nota.md');
  assert.ok(resolvedWiki.includes('id,pai,mae\n1,0,0'));

  const fakeVaultEmpty = {
    getAbstractFileByPath: () => null,
    getFirstLinkpathDest: () => null,
    getFiles: () => []
  };
  await assert.rejects(
    () => resolveDiagramSource('%% src=nao_existe.csv', fakeVaultEmpty, 'nota.md'),
    /Arquivo referenciado em %% src não encontrado no cofre/
  );
});

test('Resolução em Documento Markdown Completo (resolveMarkdownExternalSources)', async () => {
  const doc = `
# Relatório Genético

\`\`\`pedtools
%% src="https://exemplo.com/dados.csv"
%% layout.width=85%
\`\`\`

Texto intermediário.

\`\`\`d2
a -> b
\`\`\`
`;

  const mockFetch = async () => ({
    text: async () => 'id,pai,mae,sex\n1,0,0,M'
  });

  const processed = await resolveMarkdownExternalSources(doc, null, '', mockFetch);
  assert.ok(processed.includes('```pedtools'));
  assert.ok(processed.includes('id,pai,mae,sex'));
  assert.ok(processed.includes('```d2\na -> b\n```'));
  assert.ok(!processed.includes('https://exemplo.com/dados.csv'));
});

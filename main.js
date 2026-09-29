let obsidian;
try {
  obsidian = require('obsidian');
} catch {
  obsidian = {};
}

let cmState;
let cmView;
let cmLang;
try {
  cmState = require('@codemirror/state');
  cmView = require('@codemirror/view');
  cmLang = require('@codemirror/language');
} catch {
  cmState = {};
  cmView = {};
  cmLang = {};
}

const DEFAULT_SETTINGS = {
  serverUrl: 'http://localhost:3000',
  fuxicoUrl: 'http://localhost:8080',
  fuxicoToken: '',
  tatupebaUrl: 'http://localhost:3001',
  tatupebaToken: '',
  enableCards: true,
  cardsAttachmentDir: '_attachments/cards',
  debounceMs: 400,
  codebergRepo: 'lumenpink/joaju-obsidian',
  codebergBranch: 'main',
  autoCheckUpdate: true
};

/**
 * Cria um cache em memória com limite LRU simples.
 */
function createDiagramCache(maxEntries = 100) {
  const cache = new Map();

  return {
    get(key) {
      if (!cache.has(key)) return null;
      const value = cache.get(key);
      cache.delete(key);
      cache.set(key, value);
      return value;
    },
    set(key, value) {
      if (cache.has(key)) {
        cache.delete(key);
      } else if (cache.size >= maxEntries) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey) cache.delete(oldestKey);
      }
      cache.set(key, value);
    },
    has(key) {
      return cache.has(key);
    },
    clear() {
      cache.clear();
    },
    size() {
      return cache.size;
    }
  };
}

/**
 * Lista canônica e estrita de motores suportados pelo Joaju (sem tags duplicadas).
 */
const CANONICAL_ENGINES = [
  'pedtools',
  'kinship2',
  'd2',
  'plantuml',
  'graphviz',
  'openchemlib',
  'openbabel',
  'table'
];

/**
 * Extrai e resolve fonte de dados externa em blocos de diagramas (%% src=... ou %% file=...).
 * Suporta URLs remotas (http/https) e referências a arquivos locais do cofre (caminho relativo ou [[wikilink]]).
 */
async function resolveDiagramSource(
  rawContent,
  vault = null,
  sourcePath = '',
  requestFn = globalThis.fetch
) {
  if (!rawContent || typeof rawContent !== 'string') return rawContent;

  const srcMatch = rawContent.match(/^%%\s*(?:src|file)=\s*([^\s\n]+)/m);
  if (!srcMatch) return rawContent;

  let ref = srcMatch[1].trim();
  ref = ref
    .replace(/^["']|["']$/g, '')
    .replace(/^\[\[|\]\]$/g, '')
    .trim();

  let fetchedText = null;

  if (ref.startsWith('http://') || ref.startsWith('https://')) {
    try {
      if (obsidian?.requestUrl && (!requestFn || requestFn === obsidian.requestUrl)) {
        const res = await obsidian.requestUrl({ url: ref, method: 'GET' });
        fetchedText = res.text;
      } else {
        const fn = requestFn || globalThis.fetch;
        const res = await fn(ref);
        if (res && typeof res.text === 'function') {
          fetchedText = await res.text();
        } else if (res && typeof res.text === 'string') {
          fetchedText = res.text;
        } else if (typeof res === 'string') {
          fetchedText = res;
        }
      }
    } catch (err) {
      throw new Error(`Falha ao carregar fonte remota (${ref}): ${err.message}`);
    }
  } else if (vault) {
    let targetFile = null;
    if (typeof vault.getAbstractFileByPath === 'function') {
      targetFile = vault.getAbstractFileByPath(ref);
    }

    if (!targetFile && sourcePath && typeof vault.getFirstLinkpathDest === 'function') {
      targetFile = vault.getFirstLinkpathDest(ref, sourcePath);
    }

    if (!targetFile && typeof vault.getFiles === 'function') {
      const files = vault.getFiles();
      targetFile = files.find((f) => f.path === ref || f.name === ref || f.basename === ref);
    }

    if (targetFile && typeof vault.read === 'function') {
      fetchedText = await vault.read(targetFile);
    } else {
      throw new Error(`Arquivo referenciado em %% src não encontrado no cofre: "${ref}"`);
    }
  } else {
    return rawContent;
  }

  if (fetchedText !== null) {
    const remainingDirectives = rawContent
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return trimmed.startsWith('%%') && !trimmed.match(/^%%\s*(?:src|file)=/);
      })
      .join('\n')
      .trim();

    return remainingDirectives
      ? `${remainingDirectives}\n${fetchedText.trim()}`
      : fetchedText.trim();
  }

  return rawContent;
}

/**
 * Varre o Markdown procurando blocos de diagramas dos motores canônicos e resolve diretivas %% src.
 */
async function resolveMarkdownExternalSources(
  markdown,
  vault = null,
  sourcePath = '',
  requestFn = globalThis.fetch
) {
  if (!markdown || typeof markdown !== 'string') return markdown;

  const enginesPattern = CANONICAL_ENGINES.join('|');
  const blockRegex = new RegExp(`\`\`\`(${enginesPattern})\\n([\\s\\S]*?)\\n\`\`\``, 'gi');
  let result = markdown;
  let match;

  const blocksToReplace = [];
  while ((match = blockRegex.exec(markdown)) !== null) {
    const fullMatch = match[0];
    const engine = match[1];
    const content = match[2];

    if (/^%%\s*(?:src|file)=/m.test(content)) {
      blocksToReplace.push({ fullMatch, engine, content });
    }
  }

  for (const block of blocksToReplace) {
    try {
      const resolved = await resolveDiagramSource(block.content, vault, sourcePath, requestFn);
      const newBlock = `\`\`\`${block.engine}\n${resolved}\n\`\`\``;
      result = result.replace(block.fullMatch, newBlock);
    } catch (err) {
      console.warn(
        `[Joaju] Não foi possível resolver arquivo externo no bloco ${block.engine}: ${err.message}`
      );
    }
  }

  return result;
}

/**
 * Normaliza o payload para envio à API do Joaju.
 */
function buildRenderPayload(source, engine) {
  const cleanCode = (source || '').trim();
  if (!cleanCode) {
    throw new Error('Código do diagrama está vazio');
  }

  if (!cleanCode.startsWith('```')) {
    return {
      code: `\`\`\`${engine}\n${cleanCode}\n\`\`\``,
      engine
    };
  }

  return {
    code: cleanCode,
    engine
  };
}

/**
 * Dispara requisição HTTP à API /render do Joaju.
 */
async function fetchDiagramSvg(serverUrl, source, engine, requestFn = globalThis.fetch) {
  const payload = buildRenderPayload(source, engine);
  const normalizedUrl = (serverUrl || DEFAULT_SETTINGS.serverUrl).replace(/\/+$/, '');
  const targetEndpoint = `${normalizedUrl}/render`;

  let responseText = '';
  let status = 200;

  try {
    if (obsidian?.requestUrl && (!requestFn || requestFn === obsidian.requestUrl)) {
      const res = await obsidian.requestUrl({
        url: targetEndpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        throw: false
      });
      status = res.status;
      responseText = res.text;
    } else {
      const fn = requestFn || globalThis.fetch;
      const res = await fn(targetEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (res && typeof res.text === 'function') {
        status = res.status;
        responseText = await res.text();
      } else if (res && typeof res.text === 'string') {
        status = res.status;
        responseText = res.text;
      } else {
        responseText = String(res);
      }
    }
  } catch (err) {
    throw new Error(`Falha de conexão com o servidor Joaju (${normalizedUrl}): ${err.message}`);
  }

  if (status >= 400) {
    let detail = responseText;
    try {
      const parsed = JSON.parse(responseText);
      if (parsed.error) detail = parsed.error;
    } catch {
      // Ignora erro de JSON
    }
    throw new Error(detail || `Erro HTTP ${status} ao compilar diagrama`);
  }

  let svgContent = responseText;
  try {
    const parsed = JSON.parse(responseText);
    if (parsed.svg) {
      svgContent = parsed.svg;
    } else if (parsed.html) {
      return parsed.html;
    }
  } catch {
    // Mantém responseText original
  }

  if (
    !svgContent.includes('<svg') &&
    !svgContent.includes('<?xml') &&
    !svgContent.includes('<table') &&
    !svgContent.includes('joaju-academic-table')
  ) {
    throw new Error('Servidor Joaju respondeu sem SVG ou HTML válido.');
  }

  return svgContent;
}

/**
 * Dispara requisição HTTP à API /compile do Joaju para gerar PDF.
 */
async function compileMarkdownToPdf(serverUrl, markdown, requestFn = globalThis.fetch) {
  const normalizedUrl = (serverUrl || DEFAULT_SETTINGS.serverUrl).replace(/\/+$/, '');
  const targetEndpoint = `${normalizedUrl}/compile`;

  try {
    if (obsidian?.requestUrl && (!requestFn || requestFn === obsidian.requestUrl)) {
      const res = await obsidian.requestUrl({
        url: targetEndpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ markdown }),
        throw: false
      });

      if (res.status >= 400) {
        throw new Error(res.text || `Erro HTTP ${res.status} ao compilar PDF no Joaju`);
      }
      return res.arrayBuffer;
    }

    const fn = requestFn || globalThis.fetch;
    const res = await fn(targetEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ markdown })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(errText || `Erro HTTP ${res.status} ao compilar PDF no Joaju`);
    }

    return await res.arrayBuffer();
  } catch (err) {
    throw new Error(`Falha na compilação do Joaju: ${err.message}`);
  }
}

/**
 * Faz upload de um arquivo binário ou texto para o Fuxico (protocolo 0x0.st / rustypaste).
 * Constrói payload multipart manualmente para suportar tanto obsidian.requestUrl (sem CORS) quanto fetch.
 * Se o arquivo for Markdown, envia os parâmetros doc=true / Fuxico-Doc para gerar o Baked HTML no Fuxico.
 */
async function uploadToFuxico(
  fuxicoUrl,
  token,
  filename,
  fileData,
  mimeType = 'application/octet-stream',
  requestFn = obsidian.requestUrl || globalThis.fetch,
  uploadOptions = {}
) {
  const normalizedUrl = (fuxicoUrl || DEFAULT_SETTINGS.fuxicoUrl).replace(/\/+$/, '');

  const isDoc =
    uploadOptions.doc !== false &&
    (filename.endsWith('.md') || mimeType.includes('markdown') || uploadOptions.doc === true);

  const boundary = `----JoajuBoundary${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const encoder = new TextEncoder();
  const parts = [];

  if (isDoc) {
    parts.push(
      encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="doc"\r\n\r\ntrue\r\n`)
    );
    if (uploadOptions.theme) {
      parts.push(
        encoder.encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="theme"\r\n\r\n${uploadOptions.theme}\r\n`
        )
      );
    }
  }

  parts.push(
    encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
    )
  );

  let bodyBytes;
  if (typeof fileData === 'string') {
    bodyBytes = encoder.encode(fileData);
  } else if (fileData instanceof Uint8Array) {
    bodyBytes = fileData;
  } else if (fileData instanceof ArrayBuffer) {
    bodyBytes = new Uint8Array(fileData);
  } else if (ArrayBuffer.isView(fileData)) {
    bodyBytes = new Uint8Array(fileData.buffer, fileData.byteOffset, fileData.byteLength);
  } else {
    bodyBytes = new Uint8Array(0);
  }
  parts.push(bodyBytes);

  parts.push(encoder.encode(`\r\n--${boundary}--\r\n`));

  let totalLength = 0;
  for (const part of parts) {
    totalLength += part.length;
  }
  const fullBody = new Uint8Array(totalLength);
  let byteOffset = 0;
  for (const part of parts) {
    fullBody.set(part, byteOffset);
    byteOffset += part.length;
  }

  const headers = {
    'Content-Type': `multipart/form-data; boundary=${boundary}`
  };
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  if (isDoc) {
    headers['Fuxico-Doc'] = 'true';
  }

  const endpointUrl = isDoc ? `${normalizedUrl}/?doc=true` : normalizedUrl;

  let status = 200;
  let responseText = '';

  if (obsidian?.requestUrl && (!requestFn || requestFn === obsidian.requestUrl)) {
    const res = await obsidian.requestUrl({
      url: endpointUrl,
      method: 'POST',
      headers,
      body: fullBody.buffer,
      throw: false
    });
    status = res.status;
    responseText = res.text || '';
  } else {
    const fn = requestFn || globalThis.fetch;
    let res;
    // Tenta formato fetch (url, options) ou formato requestUrl (options)
    try {
      res = await fn(endpointUrl, {
        method: 'POST',
        headers,
        body: fullBody
      });
    } catch (e) {
      if (typeof fn === 'function') {
        res = await fn({
          url: endpointUrl,
          method: 'POST',
          headers,
          body: fullBody.buffer,
          throw: false
        });
      } else {
        throw e;
      }
    }

    if (!res && typeof fn === 'function') {
      res = await fn({
        url: endpointUrl,
        method: 'POST',
        headers,
        body: fullBody.buffer,
        throw: false
      });
    }

    if (res && typeof res.text === 'function') {
      status = res.status ?? 200;
      responseText = await res.text().catch(() => '');
    } else if (res && typeof res.text === 'string') {
      status = res.status ?? 200;
      responseText = res.text;
    } else {
      responseText = String(res || '');
    }
  }

  if (status >= 400) {
    throw new Error(`Erro ${status} no Fuxico: ${responseText}`);
  }

  const publicUrl = responseText.trim();
  if (!publicUrl.startsWith('http')) {
    throw new Error(`Resposta inesperada do Fuxico: ${publicUrl}`);
  }

  return publicUrl;
}

/**
 * Atualiza o frontmatter YAML de uma nota incluindo as URLs do Fuxico e tag 'fuxico'.
 */
function updateFrontmatterString(content, { pdfUrl, mdUrl }) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    let yaml = '---\n';
    if (pdfUrl) yaml += `fuxico_pdf: ${pdfUrl}\n`;
    if (mdUrl) yaml += `fuxico_md: ${mdUrl}\n`;
    yaml += 'tags:\n  - fuxico\n---\n\n';
    return yaml + content;
  }

  let yamlBody = match[1];

  if (pdfUrl) {
    if (yamlBody.match(/fuxico_pdf:\s*.+/)) {
      yamlBody = yamlBody.replace(/fuxico_pdf:\s*.+/, `fuxico_pdf: ${pdfUrl}`);
    } else {
      yamlBody += `\nfuxico_pdf: ${pdfUrl}`;
    }
  }

  if (mdUrl) {
    if (yamlBody.match(/fuxico_md:\s*.+/)) {
      yamlBody = yamlBody.replace(/fuxico_md:\s*.+/, `fuxico_md: ${mdUrl}`);
    } else {
      yamlBody += `\nfuxico_md: ${mdUrl}`;
    }
  }

  // Verifica se a tag 'fuxico' já existe no bloco de tags
  const hasFuxicoTag = /-\s*fuxico(\r?\n|$)/.test(yamlBody);
  if (!hasFuxicoTag) {
    if (/tags:\s*(\r?\n|$)/.test(yamlBody)) {
      yamlBody = yamlBody.replace(/tags:\s*(\r?\n)/, '$&  - fuxico$1');
    } else {
      yamlBody += '\ntags:\n  - fuxico';
    }
  }

  return content.replace(/^---\r?\n[\s\S]*?\r?\n---/, `---\n${yamlBody.trim()}\n---`);
}

/**
 * Compara se a versão remota é estritamente maior que a versão atual (SemVer simplificado).
 */
function isNewerVersion(remote, current) {
  if (!remote || !current) return false;
  const clean = (v) =>
    String(v)
      .replace(/^v/, '')
      .split('-')[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);

  const r = clean(remote);
  const c = clean(current);
  for (let i = 0; i < Math.max(r.length, c.length); i++) {
    const rv = r[i] || 0;
    const cv = c[i] || 0;
    if (rv > cv) return true;
    if (rv < cv) return false;
  }
  return false;
}

/**
 * Consulta o Codeberg para verificar se há versão mais recente.
 */
/**
 * Helper HTTP GET compatível com Obsidian requestUrl e fetch nativo/mock.
 */
async function httpGet(url, requestFn) {
  if (requestFn && requestFn !== globalThis.fetch) {
    // Tenta formato do Obsidian: requestUrl({ url, method: 'GET' })
    try {
      const res = await requestFn({ url, method: 'GET' });
      if (res && typeof res.text === 'string') return res.text;
      if (res && typeof res.text === 'function') return await res.text();
    } catch {
      // Fallback para formato padrão: fetch(url, opts)
    }

    const res = await requestFn(url, { method: 'GET' });
    if (res && typeof res.text === 'string') return res.text;
    if (res && typeof res.text === 'function') return await res.text();
    return String(res || '');
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Falha ao consultar URL (${res.status}): ${res.statusText}`);
  }
  return await res.text();
}

/**
 * Consulta o Codeberg para verificar se há versão mais recente.
 */
async function checkCodebergUpdate(repo, branch, currentVersion, requestFn) {
  const url = `https://codeberg.org/${repo}/raw/branch/${branch}/manifest.json?t=${Date.now()}`;
  const manifestText = await httpGet(url, requestFn);

  const remoteManifest = JSON.parse(manifestText);
  const remoteVersion = remoteManifest.version;
  const hasUpdate = isNewerVersion(remoteVersion, currentVersion);

  return {
    hasUpdate,
    currentVersion,
    remoteVersion,
    manifest: remoteManifest
  };
}

/**
 * Baixa os arquivos distribuíveis do plugin no Codeberg (manifest.json, main.js, styles.css).
 */
async function downloadCodebergPluginFiles(repo, branch, requestFn) {
  const files = ['manifest.json', 'main.js', 'styles.css'];
  const downloaded = {};

  for (const file of files) {
    const url = `https://codeberg.org/${repo}/raw/branch/${branch}/${file}?t=${Date.now()}`;
    try {
      downloaded[file] = await httpGet(url, requestFn);
    } catch (err) {
      if (file === 'styles.css') continue;
      throw new Error(`Falha ao baixar ${file} do Codeberg: ${err.message}`);
    }
  }

  return downloaded;
}

/**
 * Dispara a sincronização de referências Zotero no daemon Tatupeba.
 */
async function syncZoteroWithTatupeba(tatupebaUrl, token, requestFn = globalThis.fetch) {
  const cleanUrl = (tatupebaUrl || DEFAULT_SETTINGS.tatupebaUrl).replace(/\/+$/, '');
  const url = `${cleanUrl}/sync`;
  const headers = { 'Content-Type': 'application/json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers['X-Api-Key'] = token;
  }

  if (requestFn && requestFn !== globalThis.fetch) {
    let res;
    try {
      res = await requestFn({ url, method: 'POST', headers });
    } catch (err) {
      if (err?.status === 401) {
        throw new Error('Não autorizado: chave/token do Tatupeba inválido ou ausente');
      }
      try {
        res = await requestFn(url, { method: 'POST', headers });
      } catch (innerErr) {
        if (innerErr?.status === 401) {
          throw new Error('Não autorizado: chave/token do Tatupeba inválido ou ausente');
        }
        throw innerErr;
      }
    }

    if (res?.status === 401 || (res?.ok === false && res?.status === 401)) {
      throw new Error('Não autorizado: chave/token do Tatupeba inválido ou ausente');
    }
    if (res?.status && res.status >= 400) {
      const errText = typeof res.text === 'function' ? await res.text() : res.text || '';
      throw new Error(`Falha na API Tatupeba (${res.status}): ${errText}`);
    }

    if (res?.json && typeof res.json === 'function') {
      return await res.json();
    }
    if (typeof res?.text === 'string') {
      return JSON.parse(res.text || '{}');
    }
    if (typeof res?.json === 'object') {
      return res.json;
    }
  }

  const res = await fetch(url, { method: 'POST', headers });
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error('Não autorizado: chave/token do Tatupeba inválido ou ausente');
    }
    const errText = await res.text();
    throw new Error(`Falha na API Tatupeba (${res.status}): ${errText}`);
  }
  return await res.json();
}

/**
 * Gera um hash alfanumérico rápido para indexação de URLs.
 */
function simpleHash(str) {
  if (!str) return '0';
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

/** Protocolos suportados no atalho !url e nos cards. */
const CARD_PROTO_RE = /^!(https?|gemini|gopher):\/\/\S+$/;

/**
 * Avalia se um elemento <p> do DOM é um link isolado na linha (sem outros textos ou marcadores).
 *
 * Dois casos reconhecidos:
 *   1. `<p><a href="url">texto</a></p>` — link Markdown normal → { linkEl }
 *   2. `<p>!https://url</p>`            — atalho !url           → { rawUrl }
 *
 * Retorna { isIsolated: false } quando não se encaixa.
 */
function isIsolatedLinkParagraph(p) {
  if (!p) return { isIsolated: false };
  if (p.closest?.('li')) return { isIsolated: false };

  const childNodes = p.childNodes || [];

  // ── Caso 2: atalho !url (texto puro, sem <a>) ────────────────────────────
  const nonEmptyText = [];
  let hasElement = false;
  let hasNoCard = false;
  for (let i = 0; i < childNodes.length; i++) {
    const node = childNodes[i];
    if (node.nodeType === 8 && node.textContent?.includes('nocard')) {
      hasNoCard = true;
    } else if (node.nodeType === 3) {
      const t = node.textContent?.trim();
      if (t) nonEmptyText.push(t);
    } else if (node.nodeType === 1) {
      hasElement = true;
    }
  }
  if (!hasNoCard && !hasElement && nonEmptyText.length === 1) {
    const raw = nonEmptyText[0];
    if (CARD_PROTO_RE.test(raw)) {
      return { isIsolated: true, linkEl: null, rawUrl: raw.slice(1) };
    }
  }

  // ── Caso 1: link Markdown (<a> isolado) ──────────────────────────────────
  let hasLink = false;
  let linkEl = null;
  hasNoCard = false;

  for (let i = 0; i < childNodes.length; i++) {
    const node = childNodes[i];
    if (node.nodeType === 8 && node.textContent?.includes('nocard')) {
      hasNoCard = true;
    } else if (node.nodeType === 3) {
      if (node.textContent?.trim().length > 0) return { isIsolated: false };
    } else if (node.nodeType === 1 && node.tagName?.toLowerCase() === 'a') {
      if (hasLink) return { isIsolated: false };
      hasLink = true;
      linkEl = node;
    } else {
      return { isIsolated: false };
    }
  }

  return { isIsolated: hasLink && !hasNoCard, linkEl, rawUrl: null };
}

/**
 * Consulta a API do Joaju para extrair metadados e gerar snapshot de URL.
 */
async function fetchUnfurl(serverUrl, targetUrl, archive = false, requestFn = globalThis.fetch) {
  const cleanServer = (serverUrl || DEFAULT_SETTINGS.serverUrl).replace(/\/+$/, '');
  const endpoint = `${cleanServer}/unfurl`;
  const payload = { url: targetUrl, archive };

  if (obsidian?.requestUrl && (!requestFn || requestFn === obsidian.requestUrl)) {
    const res = await obsidian.requestUrl({
      url: endpoint,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      throw: false
    });
    if (res.status >= 400) {
      const errData = typeof res.json === 'object' ? res.json : {};
      throw new Error(errData.error || `Erro da API Joaju (${res.status})`);
    }
    return res.json;
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `Erro da API Joaju (${res.status})`);
  }
  return data;
}

/**
 * Constrói a estrutura DOM de um card tipográfico.
 */
function renderCardElement(cardEl, data, handlers = {}) {
  if (cardEl.empty && typeof cardEl.empty === 'function') {
    cardEl.empty();
  } else {
    cardEl.innerHTML = '';
  }
  cardEl.className = 'joaju-link-card';
  cardEl.setAttribute('data-url', data.url || '');

  if (!data.imageUrl && !data.localResourcePath) {
    cardEl.classList.add('has-no-image');
  }

  const contentEl = document.createElement('div');
  contentEl.className = 'joaju-card-content';
  cardEl.appendChild(contentEl);

  // Header: Favicon + Domínio + Tempo de Leitura + Ações
  const headerEl = document.createElement('div');
  headerEl.className = 'joaju-card-header';

  const metaLeftEl = document.createElement('div');
  metaLeftEl.className = 'joaju-card-meta-left';

  if (data.faviconUrl) {
    const favImg = document.createElement('img');
    favImg.className = 'joaju-card-favicon';
    favImg.src = data.faviconUrl;
    favImg.alt = '';
    favImg.loading = 'lazy';
    favImg.onerror = () => {
      favImg.style.display = 'none';
    };
    metaLeftEl.appendChild(favImg);
  }

  const domainEl = document.createElement('span');
  domainEl.className = 'joaju-card-domain';
  domainEl.textContent = data.siteName || data.domain || '';
  metaLeftEl.appendChild(domainEl);

  if (data.readingTimeMin) {
    const readingEl = document.createElement('span');
    readingEl.className = 'joaju-card-reading-time';
    readingEl.textContent = `• ${data.readingTimeMin} min`;
    metaLeftEl.appendChild(readingEl);
  }

  headerEl.appendChild(metaLeftEl);

  // Ações em hover (Editar, Recarregar, Snapshot PDF, Abrir no navegador)
  const actionsEl = document.createElement('div');
  actionsEl.className = 'joaju-card-actions';

  if (handlers.onEdit) {
    const editBtn = document.createElement('button');
    editBtn.className = 'joaju-card-btn';
    editBtn.title = 'Editar Markdown';
    editBtn.textContent = '✏️';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      handlers.onEdit();
    });
    actionsEl.appendChild(editBtn);
  }

  if (handlers.onRefresh) {
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'joaju-card-btn';
    refreshBtn.title = 'Recarregar metadados e imagem';
    refreshBtn.textContent = '🔄';
    refreshBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      handlers.onRefresh(data.url);
    });
    actionsEl.appendChild(refreshBtn);
  }

  if (handlers.onArchive) {
    const archiveBtn = document.createElement('button');
    archiveBtn.className = 'joaju-card-btn';
    archiveBtn.title = 'Baixar Snapshot em PDF (Typst)';
    archiveBtn.textContent = '📄';
    archiveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      handlers.onArchive(data.url);
    });
    actionsEl.appendChild(archiveBtn);
  }

  const openBtn = document.createElement('a');
  openBtn.className = 'joaju-card-btn';
  openBtn.title = 'Abrir link no navegador';
  openBtn.href = data.url;
  openBtn.target = '_blank';
  openBtn.rel = 'noopener noreferrer';
  openBtn.textContent = '↗';
  openBtn.addEventListener('click', (e) => {
    e.stopPropagation();
  });
  actionsEl.appendChild(openBtn);

  headerEl.appendChild(actionsEl);
  contentEl.appendChild(headerEl);

  // Título em destaque
  const titleEl = document.createElement('h4');
  titleEl.className = 'joaju-card-title';
  titleEl.textContent = data.title || data.url;
  contentEl.appendChild(titleEl);

  // Descrição
  if (data.description) {
    const descEl = document.createElement('p');
    descEl.className = 'joaju-card-description';
    descEl.textContent = data.description;
    contentEl.appendChild(descEl);
  }

  // Footer: Autor / Data
  if (data.author || data.date) {
    const footerEl = document.createElement('div');
    footerEl.className = 'joaju-card-footer';
    const parts = [];
    if (data.author) parts.push(`Por ${data.author}`);
    if (data.date) parts.push(data.date.slice(0, 10));
    footerEl.textContent = parts.join(' • ');
    contentEl.appendChild(footerEl);
  }

  // Thumbnail de imagem lateral
  const imageSrc = data.localResourcePath || data.imageUrl;
  if (imageSrc) {
    const thumbEl = document.createElement('div');
    thumbEl.className = 'joaju-card-thumbnail';
    const imgEl = document.createElement('img');
    imgEl.src = imageSrc;
    imgEl.alt = data.title || '';
    imgEl.loading = 'lazy';
    imgEl.onerror = () => {
      thumbEl.style.display = 'none';
      cardEl.classList.add('has-no-image');
    };
    thumbEl.appendChild(imgEl);
    cardEl.appendChild(thumbEl);
  }

  // Clique no card abre a URL
  cardEl.style.cursor = 'pointer';
  cardEl.addEventListener('click', (e) => {
    if (e.target?.closest?.('.joaju-card-btn')) return;
    window.open(data.url, '_blank', 'noopener,noreferrer');
  });

  return cardEl;
}

/**
 * Baixa uma imagem remota e armazena na pasta de anexos do cofre.
 */
async function downloadAndCacheCardImage(app, imageUrl, attachmentFolder) {
  if (!imageUrl || !app?.vault) return null;
  try {
    const urlObj = new URL(imageUrl);
    const pathname = urlObj.pathname || '';
    let ext = '.jpg';
    if (pathname.endsWith('.png')) ext = '.png';
    else if (pathname.endsWith('.webp')) ext = '.webp';
    else if (pathname.endsWith('.svg')) ext = '.svg';
    else if (pathname.endsWith('.gif')) ext = '.gif';

    const hash = simpleHash(imageUrl);
    const fileName = `card_${hash}${ext}`;
    const folder = attachmentFolder || DEFAULT_SETTINGS.cardsAttachmentDir;
    const targetPath = `${folder}/${fileName}`;

    const existing = app.vault.getAbstractFileByPath(targetPath);
    if (existing) {
      return {
        vaultPath: targetPath,
        resourcePath: app.vault.adapter?.getResourcePath
          ? app.vault.adapter.getResourcePath(targetPath)
          : targetPath
      };
    }

    const parts = folder.split('/').filter(Boolean);
    let cur = '';
    for (let i = 0; i < parts.length; i++) {
      cur = cur ? `${cur}/${parts[i]}` : parts[i];
      if (!app.vault.getAbstractFileByPath(cur)) {
        try {
          await app.vault.createFolder(cur);
        } catch {}
      }
    }

    const requestFn = obsidian.requestUrl || globalThis.fetch;
    let arrayBuffer = null;

    if (obsidian?.requestUrl && (!requestFn || requestFn === obsidian.requestUrl)) {
      const res = await obsidian.requestUrl({ url: imageUrl, encoding: null, throw: false });
      if (res.status < 400 && res.arrayBuffer) arrayBuffer = res.arrayBuffer;
    } else {
      const res = await fetch(imageUrl);
      if (res.ok) arrayBuffer = await res.arrayBuffer();
    }

    if (arrayBuffer) {
      await app.vault.createBinary(targetPath, arrayBuffer);
      return {
        vaultPath: targetPath,
        resourcePath: app.vault.adapter?.getResourcePath
          ? app.vault.adapter.getResourcePath(targetPath)
          : targetPath
      };
    }
  } catch (err) {
    console.warn(`[Joaju Cards] Falha ao baixar imagem: ${err.message}`);
  }
  return null;
}

/**
 * Solicita ao Joaju o snapshot em PDF e salva no cofre.
 */
async function downloadAndSavePdfSnapshot(app, serverUrl, targetUrl, attachmentFolder) {
  const requestFn = obsidian.requestUrl || globalThis.fetch;
  const result = await fetchUnfurl(serverUrl, targetUrl, true, requestFn);

  if (!result.ok || !result.pdfBase64) {
    throw new Error(result.error || 'Falha ao compilar PDF de snapshot');
  }

  const slug = targetUrl
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 40);
  const folder = attachmentFolder || DEFAULT_SETTINGS.cardsAttachmentDir;
  const targetPath = `${folder}/snap_${slug}.pdf`;

  if (app?.vault) {
    const parts = folder.split('/').filter(Boolean);
    let cur = '';
    for (let i = 0; i < parts.length; i++) {
      cur = cur ? `${cur}/${parts[i]}` : parts[i];
      if (!app.vault.getAbstractFileByPath(cur)) {
        try {
          await app.vault.createFolder(cur);
        } catch {}
      }
    }

    const binaryString = atob(result.pdfBase64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    const existing = app.vault.getAbstractFileByPath(targetPath);
    if (existing) {
      await app.vault.modifyBinary(existing, bytes.buffer);
    } else {
      await app.vault.createBinary(targetPath, bytes.buffer);
    }
  }

  return targetPath;
}

/**
 * Carrega dados (do cache ou do Joaju /unfurl) e renderiza um card completo no cardEl fornecido.
 */
async function loadAndRenderCard(cardEl, targetUrl, plugin, extraHandlers = {}) {
  const isHttp = /^https?:\/\//.test(targetUrl);
  const cacheFile = `${plugin?.manifest?.dir || '.obsidian/plugins/joaju-obsidian'}/cards-cache.json`;

  const handlers = {
    ...extraHandlers,
    onRefresh: async (url) => {
      cardEl.style.opacity = '0.6';
      try {
        const adapter = plugin?.app?.vault?.adapter;
        if (adapter) {
          let cache = {};
          try {
            cache = JSON.parse((await adapter.read(cacheFile)) || '{}');
          } catch {}
          delete cache[simpleHash(url)];
          await adapter.write(cacheFile, JSON.stringify(cache, null, 2));
        }
      } catch {}

      try {
        const requestFn = obsidian.requestUrl || globalThis.fetch;
        const fresh = await fetchUnfurl(plugin?.settings?.serverUrl, url, false, requestFn);
        if (fresh.imageUrl) {
          const img = await downloadAndCacheCardImage(
            plugin?.app,
            fresh.imageUrl,
            plugin?.settings?.cardsAttachmentDir
          );
          if (img) fresh.localResourcePath = img.resourcePath;
        }
        try {
          const adapter = plugin?.app?.vault?.adapter;
          if (adapter) {
            let cache = {};
            try {
              cache = JSON.parse((await adapter.read(cacheFile)) || '{}');
            } catch {}
            cache[simpleHash(url)] = { ...fresh, cachedAt: new Date().toISOString() };
            await adapter.write(cacheFile, JSON.stringify(cache, null, 2));
          }
        } catch {}
        renderCardElement(cardEl, fresh, handlers);
      } catch (err) {
        console.warn('[Joaju Cards] Falha ao atualizar card:', err.message);
      }
      cardEl.style.opacity = '1';
    },
    onArchive: async (url) => {
      if (obsidian.Notice) new obsidian.Notice('⏳ Gerando snapshot PDF...', 4000);
      try {
        const savedPath = await downloadAndSavePdfSnapshot(
          plugin?.app,
          plugin?.settings?.serverUrl,
          url,
          plugin?.settings?.cardsAttachmentDir
        );
        if (obsidian.Notice) new obsidian.Notice(`✅ Snapshot salvo em: ${savedPath}`, 6000);
      } catch (err) {
        if (obsidian.Notice) new obsidian.Notice(`❌ Erro no snapshot: ${err.message}`, 8000);
      }
    }
  };

  // Tenta cache primeiro
  let cardData = null;
  const cacheKey = simpleHash(targetUrl);
  try {
    const adapter = plugin?.app?.vault?.adapter;
    if (adapter) {
      const raw = await adapter.read(cacheFile);
      const cache = JSON.parse(raw || '{}');
      cardData = cache[cacheKey] || null;
    }
  } catch {}

  if (!cardData) {
    if (!isHttp) {
      const proto = targetUrl.split('://')[0];
      const domain = targetUrl.split('://')[1]?.split('/')[0] || targetUrl;
      cardData = {
        url: targetUrl,
        title: domain,
        description: null,
        domain,
        faviconUrl: null,
        imageUrl: null,
        localResourcePath: null,
        author: null,
        date: null,
        readingTimeMin: null,
        hasArticle: false,
        proto
      };
    } else {
      try {
        const requestFn = obsidian.requestUrl || globalThis.fetch;
        cardData = await fetchUnfurl(plugin?.settings?.serverUrl, targetUrl, false, requestFn);
        if (cardData.imageUrl) {
          const img = await downloadAndCacheCardImage(
            plugin?.app,
            cardData.imageUrl,
            plugin?.settings?.cardsAttachmentDir
          );
          if (img) cardData.localResourcePath = img.resourcePath;
        }
        try {
          const adapter = plugin?.app?.vault?.adapter;
          if (adapter) {
            let cache = {};
            try {
              cache = JSON.parse((await adapter.read(cacheFile)) || '{}');
            } catch {}
            cache[cacheKey] = { ...cardData, cachedAt: new Date().toISOString() };
            await adapter.write(cacheFile, JSON.stringify(cache, null, 2));
          }
        } catch {}
      } catch (err) {
        console.warn('[Joaju Cards] Falha ao buscar metadados:', err.message);
        cardEl.style.opacity = '1';
        return;
      }
    }
  }

  renderCardElement(cardEl, cardData, handlers);
  cardEl.style.opacity = '1';
}

/**
 * Extensão CodeMirror 6: preenche o título do link automaticamente quando o cursor sai da linha (Opção B).
 * Converte tanto `[!title](url)` quanto `!url` em `[Título](url)`.
 */
function createAutoTitleExtension(plugin) {
  if (!cmView?.ViewPlugin) return [];

  return cmView.ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.lastLineNumber = this.getCursorLine(view.state);
        this.inFlight = new Set();
      }

      getCursorLine(state) {
        try {
          const pos = state.selection?.main?.head;
          if (pos === undefined) return null;
          return state.doc.lineAt(pos).number;
        } catch {
          return null;
        }
      }

      update(update) {
        if (!plugin?.settings?.enableCards) return;
        if (!update.selectionSet && !update.docChanged) return;

        const currentLine = this.getCursorLine(update.state);
        if (
          this.lastLineNumber !== null &&
          currentLine !== null &&
          this.lastLineNumber !== currentLine
        ) {
          const prevLineNum = this.lastLineNumber;
          this.lastLineNumber = currentLine;
          this.checkAndConvertLine(update.view, prevLineNum);
        } else if (currentLine !== null) {
          this.lastLineNumber = currentLine;
        }
      }

      async checkAndConvertLine(view, lineNum) {
        if (lineNum < 1 || lineNum > view.state.doc.lines) return;
        const line = view.state.doc.line(lineNum);
        const text = line.text;

        const bracketMatch = text.match(/\[!title\]\(((?:https?|gemini|gopher):\/\/[^)\s]+)\)/);
        const shortMatch = text.match(/(^|\s)!(https?|gemini|gopher):\/\/\S+/);

        if (!bracketMatch && !shortMatch) return;

        let targetUrl = null;
        let searchTarget = null;
        let makeReplacement = null;

        if (bracketMatch) {
          targetUrl = bracketMatch[1];
          searchTarget = bracketMatch[0];
          makeReplacement = (title) => `[${title}](${targetUrl})`;
        } else if (shortMatch) {
          const full = shortMatch[0];
          const prefix = shortMatch[1];
          const withBang = full.slice(prefix.length);
          targetUrl = withBang.slice(1);
          searchTarget = withBang;
          makeReplacement = (title) => `[${title}](${targetUrl})`;
        }

        if (!targetUrl || this.inFlight.has(targetUrl)) return;
        this.inFlight.add(targetUrl);

        try {
          let title = targetUrl;
          if (targetUrl.startsWith('http')) {
            const requestFn = obsidian.requestUrl || globalThis.fetch;
            const data = await fetchUnfurl(plugin.settings.serverUrl, targetUrl, false, requestFn);
            title = data.title || targetUrl;
          } else {
            title = targetUrl.split('://')[1]?.split('/')[0] || targetUrl;
          }

          if (!view.dom?.isConnected) return;

          let foundFrom = -1;
          let foundTo = -1;

          if (lineNum <= view.state.doc.lines) {
            const curLine = view.state.doc.line(lineNum);
            const offset = curLine.text.indexOf(searchTarget);
            if (offset !== -1) {
              foundFrom = curLine.from + offset;
              foundTo = foundFrom + searchTarget.length;
            }
          }

          if (foundFrom === -1) {
            const docStr = view.state.doc.toString();
            const idx = docStr.indexOf(searchTarget);
            if (idx !== -1) {
              foundFrom = idx;
              foundTo = idx + searchTarget.length;
            }
          }

          if (foundFrom !== -1) {
            const replacement = makeReplacement(title);
            view.dispatch({
              changes: { from: foundFrom, to: foundTo, insert: replacement }
            });
            if (obsidian.Notice) {
              new obsidian.Notice(`✅ Título preenchido: "${title}"`);
            }
          }
        } catch (err) {
          console.warn('[Joaju Auto-title] Erro ao preencher título:', err.message);
        } finally {
          this.inFlight.delete(targetUrl);
        }
      }
    }
  );
}

/**
 * Widget CodeMirror 6 para renderizar o card tipográfico em substituição à linha de link isolado.
 */
class LinkCardWidget extends (cmView?.WidgetType || class {}) {
  constructor(url, title, plugin, lineNum) {
    super();
    this.url = url;
    this.title = title;
    this.plugin = plugin;
    this.lineNum = lineNum;
  }

  eq(other) {
    return this.url === other.url && this.title === other.title;
  }

  toDOM(view) {
    const cardEl = document.createElement('div');
    cardEl.className = 'joaju-link-card has-no-image';
    cardEl.style.opacity = '0.6';

    const onEdit = () => {
      view.focus();
      try {
        const line = view.state.doc.line(this.lineNum);
        view.dispatch({
          selection: { anchor: line.from }
        });
      } catch {}
    };

    loadAndRenderCard(cardEl, this.url, this.plugin, { onEdit });
    return cardEl;
  }

  ignoreEvent() {
    return true;
  }
}

/**
 * Extensão CodeMirror 6: renderiza cards tipográficos no modo Live Preview (Edição).
 */
function createLivePreviewCardsExtension(plugin) {
  if (!cmView?.ViewPlugin || !cmState?.RangeSetBuilder) return [];

  const ISOLATED_LINK_RE =
    /^[ \t]*(?:\[([^\]]*)\]\(((?:https?|gemini|gopher):\/\/[^)\s]+)\)|!(https?|gemini|gopher):\/\/(\S+))[ \t]*$/;

  class LivePreviewCardsPlugin {
    constructor(view) {
      this.view = view;
      this.decorations = this.buildDecorations(view);
    }

    update(update) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view) {
      if (!plugin?.settings?.enableCards) return cmView.Decoration.none;

      // Verifica frontmatter cards: false
      const activeFile = plugin?.app?.workspace?.getActiveFile?.();
      if (activeFile && plugin?.app?.metadataCache) {
        const cache = plugin.app.metadataCache.getFileCache(activeFile);
        if (cache?.frontmatter?.cards === false) {
          return cmView.Decoration.none;
        }
      }

      const builder = new cmState.RangeSetBuilder();
      const selection = view.state.selection.main;
      const doc = view.state.doc;

      for (const { from, to } of view.visibleRanges) {
        let pos = from;
        while (pos <= to) {
          const line = doc.lineAt(pos);

          // Se o cursor estiver na linha, não decora (permite edição do texto puro)
          const cursorOnLine = selection.from <= line.to && selection.to >= line.from;

          if (!cursorOnLine) {
            const text = line.text;
            if (!text.includes('nocard')) {
              const match = text.match(ISOLATED_LINK_RE);
              if (match) {
                const linkTitle = match[1] || '';
                const linkUrl = match[2] || (match[3] ? `${match[3]}://${match[4]}` : '');

                if (linkUrl) {
                  const widget = new LinkCardWidget(linkUrl, linkTitle, plugin, line.number);
                  builder.add(
                    line.from,
                    line.to,
                    cmView.Decoration.replace({
                      widget,
                      inclusive: false
                    })
                  );
                }
              }
            }
          }

          pos = line.to + 1;
        }
      }

      return builder.finish();
    }
  }

  return cmView.ViewPlugin.fromClass(LivePreviewCardsPlugin, {
    decorations: (v) => v.decorations
  });
}

const PluginBase = obsidian.Plugin || class {};
const PluginSettingTabBase = obsidian.PluginSettingTab || class {};

class JoajuSettingTab extends PluginSettingTabBase {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Configurações do Ecossistema Joaju' });

    if (!obsidian.Setting) return;

    new obsidian.Setting(containerEl)
      .setName('Servidor Joaju (URL)')
      .setDesc('Endereço do compilador e renderizador Joaju.')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.serverUrl)
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim() || DEFAULT_SETTINGS.serverUrl;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl('h3', { text: '🐾 Tatupeba (Sincronização Zotero)' });

    new obsidian.Setting(containerEl)
      .setName('Servidor Tatupeba (URL)')
      .setDesc('Endereço do daemon Tatupeba para sincronização contínua do Zotero.')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.tatupebaUrl)
          .setValue(this.plugin.settings.tatupebaUrl)
          .onChange(async (value) => {
            this.plugin.settings.tatupebaUrl = value.trim() || DEFAULT_SETTINGS.tatupebaUrl;
            await this.plugin.saveSettings();
          })
      );

    new obsidian.Setting(containerEl)
      .setName('Token de Autenticação Tatupeba')
      .setDesc('Chave de segurança (Bearer / X-Api-Key) configurada no daemon.')
      .addText((text) =>
        text
          .setPlaceholder('Chave de segurança (opcional)')
          .setValue(this.plugin.settings.tatupebaToken)
          .onChange(async (value) => {
            this.plugin.settings.tatupebaToken = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new obsidian.Setting(containerEl)
      .setName('Sincronizar Zotero Agora')
      .setDesc('Dispara manualmente a extração de notas e referências BibTeX do Zotero.')
      .addButton((btn) =>
        btn.setButtonText('Sincronizar agora').onClick(async () => {
          btn.setButtonText('Sincronizando...');
          btn.setDisabled(true);
          await this.plugin.triggerTatupebaSync();
          btn.setDisabled(false);
          btn.setButtonText('Sincronizar agora');
        })
      );

    containerEl.createEl('h3', { text: '🦊 Fuxico (Compartilhamento & Pastebin)' });

    new obsidian.Setting(containerEl)
      .setName('Servidor Fuxico (URL)')
      .setDesc('Endereço base do cofre e encurtador Fuxico.')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.fuxicoUrl)
          .setValue(this.plugin.settings.fuxicoUrl)
          .onChange(async (value) => {
            this.plugin.settings.fuxicoUrl = value.trim() || DEFAULT_SETTINGS.fuxicoUrl;
            await this.plugin.saveSettings();
          })
      );

    new obsidian.Setting(containerEl)
      .setName('Token de Autenticação Fuxico')
      .setDesc('Ficha/chave de autorização Bearer para upload no Fuxico.')
      .addText((text) =>
        text
          .setPlaceholder('Chave Bearer (opcional)')
          .setValue(this.plugin.settings.fuxicoToken)
          .onChange(async (value) => {
            this.plugin.settings.fuxicoToken = value.trim() || DEFAULT_SETTINGS.fuxicoToken;
            await this.plugin.saveSettings();
          })
      );

    new obsidian.Setting(containerEl)
      .setName('Debounce (ms)')
      .setDesc('Intervalo para aguardar o fim da digitação antes de renderizar diagramas.')
      .addSlider((slider) =>
        slider
          .setLimits(100, 2000, 50)
          .setValue(this.plugin.settings.debounceMs)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.debounceMs = value;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl('h3', { text: '📇 Cards de Links Tipográficos' });

    new obsidian.Setting(containerEl)
      .setName('Habilitar Cards de Links')
      .setDesc(
        'Renderiza links isolados em uma linha como cards editoriais com metadados e imagem.'
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableCards).onChange(async (value) => {
          this.plugin.settings.enableCards = value;
          await this.plugin.saveSettings();
        })
      );

    new obsidian.Setting(containerEl)
      .setName('Pasta de Anexos para Cards')
      .setDesc('Diretório no cofre onde imagens de capa e snapshots PDF serão armazenados.')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.cardsAttachmentDir)
          .setValue(this.plugin.settings.cardsAttachmentDir)
          .onChange(async (value) => {
            this.plugin.settings.cardsAttachmentDir =
              value.trim() || DEFAULT_SETTINGS.cardsAttachmentDir;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl('h3', { text: '🔄 Atualizações Soberanas (Codeberg)' });

    const currentVersion = this.plugin.manifest?.version || '0.1.0';
    containerEl.createEl('p', {
      text: `Versão instalada: v${currentVersion}`,
      cls: 'setting-item-description'
    });

    new obsidian.Setting(containerEl)
      .setName('Repositório Codeberg')
      .setDesc('Caminho no formato usuario/repositorio.')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.codebergRepo)
          .setValue(this.plugin.settings.codebergRepo)
          .onChange(async (value) => {
            this.plugin.settings.codebergRepo = value.trim() || DEFAULT_SETTINGS.codebergRepo;
            await this.plugin.saveSettings();
          })
      );

    new obsidian.Setting(containerEl)
      .setName('Branch / Canal')
      .setDesc('Branch de onde buscar as atualizações estáveis.')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.codebergBranch)
          .setValue(this.plugin.settings.codebergBranch)
          .onChange(async (value) => {
            this.plugin.settings.codebergBranch = value.trim() || DEFAULT_SETTINGS.codebergBranch;
            await this.plugin.saveSettings();
          })
      );

    new obsidian.Setting(containerEl)
      .setName('Verificar atualizações ao iniciar')
      .setDesc('Checa automaticamente novidades no Codeberg ao abrir o Obsidian.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoCheckUpdate).onChange(async (value) => {
          this.plugin.settings.autoCheckUpdate = value;
          await this.plugin.saveSettings();
        })
      );

    new obsidian.Setting(containerEl)
      .setName('Verificar Atualizações')
      .setDesc('Consulta o Codeberg e atualiza o plugin diretamente pela interface.')
      .addButton((btn) => {
        btn.setButtonText('Verificar agora');
        btn.onClick(async () => {
          btn.setButtonText('Checando...');
          btn.setDisabled(true);
          const result = await this.plugin.checkForUpdates(false);
          btn.setDisabled(false);
          if (result?.hasUpdate) {
            btn.setButtonText(`Atualizar para v${result.remoteVersion}`);
            btn.setCta();
            btn.onClick(async () => {
              btn.setButtonText('Atualizando...');
              btn.setDisabled(true);
              await this.plugin.applyCodebergUpdate(result.remoteVersion);
            });
          } else {
            btn.setButtonText('Verificar agora');
          }
        });
      });
  }
}

class JoajuPlugin extends PluginBase {
  async onload() {
    await this.loadSettings();
    this.cache = createDiagramCache(100);
    this.debounceTimers = new Map();

    for (const engine of CANONICAL_ENGINES) {
      this.registerProcessor(engine, engine);
    }

    // 📇 Link Card Post Processor (Reading View)
    if (this.registerMarkdownPostProcessor) {
      this.registerMarkdownPostProcessor(async (element, context) => {
        if (!this.settings.enableCards) return;

        // Check frontmatter for cards: false
        const frontmatter = context?.frontmatter;
        if (frontmatter && frontmatter.cards === false) return;

        const paragraphs = element.querySelectorAll('p');
        for (const p of paragraphs) {
          const { isIsolated, linkEl, rawUrl } = isIsolatedLinkParagraph(p);
          if (!isIsolated) continue;

          // Resolve URL from link element or bare !url shorthand
          const targetUrl = rawUrl || linkEl?.href || '';
          if (!targetUrl) continue;

          // Create placeholder card while loading
          const cardEl = document.createElement('div');
          cardEl.className = 'joaju-link-card has-no-image';
          cardEl.style.opacity = '0.6';
          p.replaceWith(cardEl);

          await loadAndRenderCard(cardEl, targetUrl, this);
        }
      });
    }

    // 🚀 CodeMirror 6 Live Preview & Auto-title Extensions
    if (this.registerEditorExtension && cmView?.ViewPlugin) {
      this.registerEditorExtension(createAutoTitleExtension(this));
      this.registerEditorExtension(createLivePreviewCardsExtension(this));
    }

    if (obsidian.PluginSettingTab) {
      this.addSettingTab(new JoajuSettingTab(this.app, this));
    }

    // Ribbon Icon (Barra lateral esquerda)
    if (this.addRibbonIcon) {
      this.addRibbonIcon('printer', 'Joaju: Compilar Artigo para PDF', async () => {
        await this.compileCurrentNote(false);
      });
    }

    // Comandos no Command Palette
    if (this.addCommand) {
      this.addCommand({
        id: 'compile-pdf',
        name: 'Compilar nota atual para PDF',
        callback: async () => {
          await this.compileCurrentNote(false);
        }
      });

      this.addCommand({
        id: 'compile-fuxico-pdf',
        name: 'Compilar e Fuxicar (PDF)',
        callback: async () => {
          await this.compileCurrentNote(true);
        }
      });

      this.addCommand({
        id: 'fuxico-markdown',
        name: 'Fuxicar nota atual (Markdown puro)',
        callback: async () => {
          await this.publishCurrentNoteToFuxico();
        }
      });

      this.addCommand({
        id: 'sync-zotero',
        name: 'Sincronizar Zotero (Tatupeba)',
        callback: async () => {
          await this.triggerTatupebaSync();
        }
      });

      this.addCommand({
        id: 'check-codeberg-update',
        name: 'Verificar atualizações no Codeberg',
        callback: async () => {
          await this.checkForUpdates(false);
        }
      });

      // 📇 Card commands
      this.addCommand({
        id: 'fill-link-title',
        name: 'Preencher título do link na linha atual (!title / !url)',
        editorCallback: async (editor) => {
          const cursor = editor.getCursor();
          const line = editor.getLine(cursor.line);

          // Aceita: [!title](https://url)  ou  !https://url  (atalho)
          const bracketMatch = line.match(/\[!title\]\(((?:https?|gemini|gopher):\/\/[^)]+)\)/);
          const shortMatch = line.match(/(^|\s)!(https?|gemini|gopher):\/\/\S+/);

          let url = null;
          let replaceFn = null;

          if (bracketMatch) {
            url = bracketMatch[1];
            replaceFn = (title) => line.replace(/\[!title\]/, `[${title}]`);
          } else if (shortMatch) {
            // Extrai a URL completa (sem o !)
            const rawMatch = line.match(/((?:https?|gemini|gopher):\/\/\S+)/);
            url = rawMatch ? rawMatch[1] : null;
            replaceFn = (title) => line.replace(`!${url}`, `[${title}](${url})`);
          }

          if (!url || !replaceFn) {
            if (obsidian.Notice)
              new obsidian.Notice('⚠️ Nenhum !url ou [!title](url) encontrado na linha atual.');
            return;
          }

          if (!url.startsWith('http')) {
            // Protocolos não-HTTP: sem preview, só converte a sintaxe
            const newLine = replaceFn(url);
            editor.setLine(cursor.line, newLine);
            if (obsidian.Notice) new obsidian.Notice(`✅ Link convertido: "${url}"`);
            return;
          }

          if (obsidian.Notice) new obsidian.Notice('⏳ Buscando título...');
          try {
            const requestFn = obsidian.requestUrl || globalThis.fetch;
            const data = await fetchUnfurl(this.settings.serverUrl, url, false, requestFn);
            const title = data.title || url;
            editor.setLine(cursor.line, replaceFn(title));
            if (obsidian.Notice) new obsidian.Notice(`✅ Título preenchido: "${title}"`);
          } catch (err) {
            if (obsidian.Notice) new obsidian.Notice(`❌ Erro: ${err.message}`, 8000);
          }
        }
      });

      this.addCommand({
        id: 'refresh-all-cards',
        name: 'Recarregar todos os cards desta nota',
        callback: async () => {
          const cacheFile = `${this.manifest?.dir || '.obsidian/plugins/joaju-obsidian'}/cards-cache.json`;
          const activeFile = this.app?.workspace?.getActiveFile?.();
          if (!activeFile) {
            if (obsidian.Notice) new obsidian.Notice('⚠️ Nenhuma nota ativa.');
            return;
          }
          // Read note content, extract all unique URLs from isolated links
          const content = await this.app.vault.read(activeFile);
          const urlMatches = [...content.matchAll(/^\s*\[([^\]]*)\]\((https?:\/\/[^)]+)\)\s*$/gm)];
          const urls = [...new Set(urlMatches.map((m) => m[2]))];
          if (urls.length === 0) {
            if (obsidian.Notice) new obsidian.Notice('ℹ️ Nenhum link isolado encontrado na nota.');
            return;
          }
          // Clear their cache entries
          try {
            const adapter = this.app?.vault?.adapter;
            if (adapter) {
              let cache = {};
              try {
                cache = JSON.parse((await adapter.read(cacheFile)) || '{}');
              } catch {
                /* ignore */
              }
              for (const url of urls) delete cache[simpleHash(url)];
              await adapter.write(cacheFile, JSON.stringify(cache, null, 2));
            }
          } catch {
            /* ignore */
          }
          if (obsidian.Notice)
            new obsidian.Notice(
              `🔄 Cache de ${urls.length} card(s) limpo. Reabra a nota em Leitura para recarregar.`
            );
        }
      });
    }

    if (this.settings.autoCheckUpdate) {
      setTimeout(() => {
        this.checkForUpdates(true);
      }, 4000);
    }
  }

  async compileCurrentNote(andUploadFuxico = false) {
    const activeFile = this.app?.workspace?.getActiveFile?.();
    if (!activeFile) {
      if (obsidian.Notice) new obsidian.Notice('❌ Nenhuma nota ativa para compilar!');
      return;
    }

    if (obsidian.Notice) new obsidian.Notice('⏳ Compilando artigo via Joaju...');

    try {
      const rawContent = await this.app.vault.read(activeFile);
      const requestFn = obsidian.requestUrl || globalThis.fetch;
      const content = await resolveMarkdownExternalSources(
        rawContent,
        this.app?.vault,
        activeFile.path,
        requestFn
      );
      const pdfBuffer = await compileMarkdownToPdf(this.settings.serverUrl, content, requestFn);

      const folderPath = activeFile.parent ? activeFile.parent.path : '';
      const pdfPath = `${folderPath && folderPath !== '/' ? `${folderPath}/` : ''}${activeFile.basename}.pdf`;

      const existingFile = this.app.vault.getAbstractFileByPath(pdfPath);
      if (existingFile) {
        await this.app.vault.modifyBinary(existingFile, pdfBuffer);
      } else {
        await this.app.vault.createBinary(pdfPath, pdfBuffer);
      }

      if (andUploadFuxico) {
        if (obsidian.Notice) new obsidian.Notice('⚡ Espalhando o bafão no Fuxico...');
        const requestFn = obsidian.requestUrl || globalThis.fetch;
        const publicUrl = await uploadToFuxico(
          this.settings.fuxicoUrl,
          this.settings.fuxicoToken,
          `${activeFile.basename}.pdf`,
          pdfBuffer,
          'application/pdf',
          requestFn
        );

        await this.updateNoteFrontmatter(activeFile, { pdfUrl: publicUrl });

        try {
          if (navigator?.clipboard?.writeText) {
            await navigator.clipboard.writeText(publicUrl);
          }
        } catch {}

        if (obsidian.Notice) {
          new obsidian.Notice(`⚡ PDF fuxicado com sucesso:\n${publicUrl}\n(Link copiado!)`, 8000);
        }
      } else {
        if (obsidian.Notice) {
          new obsidian.Notice(`✅ PDF gerado com sucesso: ${activeFile.basename}.pdf`);
        }
      }
    } catch (err) {
      if (obsidian.Notice) {
        new obsidian.Notice(`❌ Erro no Joaju: ${err.message}`, 10000);
      }
    }
  }

  async publishCurrentNoteToFuxico() {
    const activeFile = this.app?.workspace?.getActiveFile?.();
    if (!activeFile) {
      if (obsidian.Notice) new obsidian.Notice('❌ Nenhuma nota ativa para compartilhar!');
      return;
    }

    if (obsidian.Notice) new obsidian.Notice('⚡ Espalhando Markdown no Fuxico...');

    try {
      const rawContent = await this.app.vault.read(activeFile);
      const requestFn = obsidian.requestUrl || globalThis.fetch;
      const content = await resolveMarkdownExternalSources(
        rawContent,
        this.app?.vault,
        activeFile.path,
        requestFn
      );

      let theme = 'zine';
      const fileCache = this.app?.metadataCache?.getFileCache?.(activeFile);
      const fm = fileCache?.frontmatter;
      if (fm?.theme === 'acad' || fm?.perfil === 'acad') {
        theme = 'acad';
      }

      const publicUrl = await uploadToFuxico(
        this.settings.fuxicoUrl,
        this.settings.fuxicoToken,
        `${activeFile.basename}.md`,
        content,
        'text/markdown; charset=utf-8',
        requestFn,
        { doc: true, theme }
      );

      await this.updateNoteFrontmatter(activeFile, { mdUrl: publicUrl });

      try {
        if (navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(publicUrl);
        }
      } catch {}

      if (obsidian.Notice) {
        new obsidian.Notice(
          `⚡ Markdown fuxicado com sucesso:\n${publicUrl}\n(Link copiado!)`,
          8000
        );
      }
    } catch (err) {
      if (obsidian.Notice) {
        new obsidian.Notice(`❌ Erro no Fuxico: ${err.message}`, 10000);
      }
    }
  }

  async updateNoteFrontmatter(file, { pdfUrl, mdUrl }) {
    if (this.app?.fileManager?.processFrontMatter) {
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        if (pdfUrl) fm.fuxico_pdf = pdfUrl;
        if (mdUrl) fm.fuxico_md = mdUrl;
        if (!fm.tags) {
          fm.tags = ['fuxico'];
        } else if (Array.isArray(fm.tags) && !fm.tags.includes('fuxico')) {
          fm.tags.push('fuxico');
        } else if (typeof fm.tags === 'string' && !fm.tags.includes('fuxico')) {
          fm.tags = `${fm.tags}, fuxico`;
        }
      });
    } else if (this.app?.vault) {
      const raw = await this.app.vault.read(file);
      const updated = updateFrontmatterString(raw, { pdfUrl, mdUrl });
      await this.app.vault.modify(file, updated);
    }
  }

  registerProcessor(blockName, canonicalEngine) {
    this.registerMarkdownCodeBlockProcessor(blockName, (source, el, ctx) => {
      this.processDiagramBlock(source, el, canonicalEngine, ctx);
    });
  }

  processDiagramBlock(source, el, engine, ctx) {
    const cleanSource = (source || '').trim();
    if (!cleanSource) {
      el.empty();
      return;
    }

    const cacheKey = `${engine}:${cleanSource}`;

    if (this.cache.has(cacheKey)) {
      const cachedSvg = this.cache.get(cacheKey);
      this.renderSvgToElement(el, cachedSvg);
      return;
    }

    const timerKey = `${ctx?.sourcePath || ''}:${engine}:${el.id || Math.random()}`;
    if (this.debounceTimers.has(timerKey)) {
      clearTimeout(this.debounceTimers.get(timerKey));
    }

    if (el.children.length > 0) {
      el.addClass('joaju-diagram-loading');
    }

    const timer = setTimeout(async () => {
      this.debounceTimers.delete(timerKey);
      await this.executeRender(cleanSource, el, engine, cacheKey, ctx);
    }, this.settings.debounceMs || DEFAULT_SETTINGS.debounceMs);

    this.debounceTimers.set(timerKey, timer);
  }

  async executeRender(source, el, engine, cacheKey, ctx) {
    try {
      const requestFn = obsidian.requestUrl || globalThis.fetch;
      const resolved = await resolveDiagramSource(
        source,
        this.app?.vault,
        ctx?.sourcePath,
        requestFn
      );
      const svg = await fetchDiagramSvg(this.settings.serverUrl, resolved, engine, requestFn);

      this.cache.set(cacheKey, svg);
      el.removeClass('joaju-diagram-loading');
      this.renderSvgToElement(el, svg);
    } catch (err) {
      el.removeClass('joaju-diagram-loading');
      this.renderErrorToElement(el, engine, err.message);
    }
  }

  renderSvgToElement(el, svgString) {
    el.empty();
    const container = el.createDiv({ cls: 'joaju-diagram-container' });
    container.innerHTML = svgString;
  }

  renderErrorToElement(el, engine, errorMessage) {
    el.empty();
    const errorBox = el.createDiv({ cls: 'joaju-diagram-error' });
    const title = errorBox.createDiv({ cls: 'joaju-diagram-error-title' });
    title.setText(`⚠️ Joaju [${engine.toUpperCase()}]: Erro de compilação`);
    const msg = errorBox.createDiv({ cls: 'joaju-diagram-error-message' });
    msg.setText(errorMessage);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async triggerTatupebaSync() {
    if (obsidian.Notice)
      new obsidian.Notice('🐾 [Tatupeba] Sincronizando referências com o Zotero...');
    try {
      const requestFn = obsidian.requestUrl || globalThis.fetch;
      const data = await syncZoteroWithTatupeba(
        this.settings.tatupebaUrl || DEFAULT_SETTINGS.tatupebaUrl,
        this.settings.tatupebaToken || '',
        requestFn
      );

      if (data?.ok && data.summary) {
        if (obsidian.Notice) {
          new obsidian.Notice(
            `✅ Tatupeba: ${data.summary.notesWritten || 0} notas no Obsidian e ${data.summary.bibEntries || 0} referências no Joaju sincronizadas!`,
            8000
          );
        }
      } else {
        if (obsidian.Notice) {
          new obsidian.Notice(
            `⚠️ Tatupeba: ${data?.error || 'Resposta sem resumo de sincronização'}`,
            6000
          );
        }
      }
    } catch (err) {
      if (obsidian.Notice) {
        new obsidian.Notice(`❌ Erro no Tatupeba: ${err.message}`, 10000);
      }
    }
  }

  async checkForUpdates(silent = false) {
    try {
      const currentVer = this.manifest?.version || '0.1.0';
      const requestFn = obsidian.requestUrl || globalThis.fetch;
      const result = await checkCodebergUpdate(
        this.settings.codebergRepo || DEFAULT_SETTINGS.codebergRepo,
        this.settings.codebergBranch || DEFAULT_SETTINGS.codebergBranch,
        currentVer,
        requestFn
      );

      if (result.hasUpdate) {
        if (obsidian.Notice) {
          new obsidian.Notice(
            `🚀 Joaju: Nova versão v${result.remoteVersion} disponível no Codeberg!\nAcesse Configurações para atualizar com 1 clique.`,
            12000
          );
        }
        return result;
      }

      if (!silent && obsidian.Notice) {
        new obsidian.Notice(
          `✅ Joaju Live Preview já está na versão mais recente (v${currentVer}).`
        );
      }
      return result;
    } catch (err) {
      if (!silent && obsidian.Notice) {
        new obsidian.Notice(`⚠️ Erro ao checar atualizações: ${err.message}`);
      }
      return { hasUpdate: false, error: err.message };
    }
  }

  async applyCodebergUpdate(remoteVersion) {
    if (obsidian.Notice) new obsidian.Notice(`⏳ Baixando v${remoteVersion} do Codeberg...`);
    try {
      const requestFn = obsidian.requestUrl || globalThis.fetch;
      const files = await downloadCodebergPluginFiles(
        this.settings.codebergRepo || DEFAULT_SETTINGS.codebergRepo,
        this.settings.codebergBranch || DEFAULT_SETTINGS.codebergBranch,
        requestFn
      );

      const adapter = this.app?.vault?.adapter;
      const pluginDir =
        this.manifest?.dir ||
        `${this.app?.vault?.configDir || '.obsidian'}/plugins/${this.manifest?.id || 'joaju-obsidian'}`;

      if (adapter) {
        if (files['manifest.json']) {
          await adapter.write(`${pluginDir}/manifest.json`, files['manifest.json']);
        }
        if (files['main.js']) {
          await adapter.write(`${pluginDir}/main.js`, files['main.js']);
        }
        if (files['styles.css']) {
          await adapter.write(`${pluginDir}/styles.css`, files['styles.css']);
        }
      }

      if (obsidian.Notice) {
        new obsidian.Notice(`🎉 Joaju atualizado para v${remoteVersion}! Recarregando...`, 6000);
      }

      if (this.app?.plugins?.disablePlugin && this.app?.plugins?.enablePlugin) {
        const id = this.manifest?.id || 'joaju-obsidian';
        await this.app.plugins.disablePlugin(id);
        await this.app.plugins.enablePlugin(id);
      }
    } catch (err) {
      if (obsidian.Notice) {
        new obsidian.Notice(`❌ Falha ao atualizar: ${err.message}`, 10000);
      }
    }
  }

  onunload() {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.cache.clear();
  }
}

module.exports = JoajuPlugin;
module.exports.default = JoajuPlugin;
module.exports.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
module.exports.createDiagramCache = createDiagramCache;
module.exports.buildRenderPayload = buildRenderPayload;
module.exports.fetchDiagramSvg = fetchDiagramSvg;
module.exports.compileMarkdownToPdf = compileMarkdownToPdf;
module.exports.uploadToFuxico = uploadToFuxico;
module.exports.updateFrontmatterString = updateFrontmatterString;
module.exports.isNewerVersion = isNewerVersion;
module.exports.checkCodebergUpdate = checkCodebergUpdate;
module.exports.downloadCodebergPluginFiles = downloadCodebergPluginFiles;
module.exports.syncZoteroWithTatupeba = syncZoteroWithTatupeba;
module.exports.simpleHash = simpleHash;
module.exports.isIsolatedLinkParagraph = isIsolatedLinkParagraph;
module.exports.fetchUnfurl = fetchUnfurl;
module.exports.renderCardElement = renderCardElement;
module.exports.downloadAndCacheCardImage = downloadAndCacheCardImage;
module.exports.downloadAndSavePdfSnapshot = downloadAndSavePdfSnapshot;
module.exports.loadAndRenderCard = loadAndRenderCard;
module.exports.createAutoTitleExtension = createAutoTitleExtension;
module.exports.LinkCardWidget = LinkCardWidget;
module.exports.createLivePreviewCardsExtension = createLivePreviewCardsExtension;
module.exports.CANONICAL_ENGINES = CANONICAL_ENGINES;
module.exports.resolveDiagramSource = resolveDiagramSource;
module.exports.resolveMarkdownExternalSources = resolveMarkdownExternalSources;

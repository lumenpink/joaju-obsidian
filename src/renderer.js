const DEFAULT_SETTINGS = {
  serverUrl: 'https://joaju.lumen.pink',
  debounceMs: 400
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
 * Normaliza o payload para envio à API do Joaju.
 */
function buildRenderPayload(source, engine) {
  const cleanCode = (source || '').trim();
  if (!cleanCode) {
    throw new Error('Código do diagrama está vazio');
  }

  // Se o código não contiver cabeçalho com crases, envelopa no bloco correspondente
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
 * Compatível tanto com fetch padrão quanto com requestUrl do Obsidian.
 */
async function fetchDiagramSvg(serverUrl, source, engine, requestFn = globalThis.fetch) {
  const payload = buildRenderPayload(source, engine);
  const normalizedUrl = (serverUrl || DEFAULT_SETTINGS.serverUrl).replace(/\/+$/, '');
  const targetEndpoint = `${normalizedUrl}/render`;

  let responseText = '';
  let status = 200;

  try {
    if (typeof requestFn === 'function') {
      const res = await requestFn(targetEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      // Suporte a fetch() padrão (res.text() é Promise)
      if (res && typeof res.text === 'function') {
        status = res.status;
        responseText = await res.text();
      } else if (res && typeof res.text === 'string') {
        // Suporte a requestUrl do Obsidian (res.text é string síncrona)
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
      // Ignora erro de JSON e mantém responseText original
    }
    throw new Error(detail || `Erro HTTP ${status} ao compilar diagrama`);
  }

  if (!responseText.includes('<svg') && !responseText.includes('<?xml')) {
    throw new Error('Servidor Joaju respondeu sem SVG válido.');
  }

  return responseText;
}

module.exports = {
  DEFAULT_SETTINGS,
  createDiagramCache,
  buildRenderPayload,
  fetchDiagramSvg
};

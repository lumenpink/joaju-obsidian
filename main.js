let obsidian;
try {
  obsidian = require('obsidian');
} catch {
  obsidian = {};
}

const DEFAULT_SETTINGS = {
  serverUrl: 'http://baquara:3000',
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
      // Ignora erro de JSON e mantém responseText original
    }
    throw new Error(detail || `Erro HTTP ${status} ao compilar diagrama`);
  }

  let svgContent = responseText;
  try {
    const parsed = JSON.parse(responseText);
    if (parsed.svg) {
      svgContent = parsed.svg;
    }
  } catch {
    // Mantém responseText original se já for SVG puro
  }

  if (!svgContent.includes('<svg') && !svgContent.includes('<?xml')) {
    throw new Error('Servidor Joaju respondeu sem SVG válido.');
  }

  return svgContent;
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

    containerEl.createEl('h2', { text: 'Configurações do Joaju Live Preview' });

    if (!obsidian.Setting) return;

    new obsidian.Setting(containerEl)
      .setName('Servidor Joaju (URL)')
      .setDesc('Endereço base do servidor de renderização Joaju.')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.serverUrl)
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim() || DEFAULT_SETTINGS.serverUrl;
            await this.plugin.saveSettings();
          })
      );

    new obsidian.Setting(containerEl)
      .setName('Debounce (ms)')
      .setDesc(
        'Intervalo em milissegundos para aguardar o fim da digitação antes de renderizar o diagrama.'
      )
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
  }
}

class JoajuPlugin extends PluginBase {
  async onload() {
    await this.loadSettings();
    this.cache = createDiagramCache(100);
    this.debounceTimers = new Map();

    const engines = [
      { name: 'kinship', aliases: ['kinship2', 'heredograma', 'pedigree'] },
      { name: 'd2', aliases: [] },
      { name: 'plantuml', aliases: ['puml'] }
    ];

    for (const { name, aliases } of engines) {
      this.registerProcessor(name, name);
      for (const alias of aliases) {
        this.registerProcessor(alias, name);
      }
    }

    if (obsidian.PluginSettingTab) {
      this.addSettingTab(new JoajuSettingTab(this.app, this));
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

    // 1. Se estiver no cache, renderiza de forma instantânea
    if (this.cache.has(cacheKey)) {
      const cachedSvg = this.cache.get(cacheKey);
      this.renderSvgToElement(el, cachedSvg);
      return;
    }

    // 2. Debounce para evitar sobrecarga durante a digitação
    const timerKey = `${ctx?.sourcePath || ''}:${engine}:${el.id || Math.random()}`;
    if (this.debounceTimers.has(timerKey)) {
      clearTimeout(this.debounceTimers.get(timerKey));
    }

    if (el.children.length > 0) {
      el.addClass('joaju-diagram-loading');
    }

    const timer = setTimeout(async () => {
      this.debounceTimers.delete(timerKey);
      await this.executeRender(cleanSource, el, engine, cacheKey);
    }, this.settings.debounceMs || DEFAULT_SETTINGS.debounceMs);

    this.debounceTimers.set(timerKey, timer);
  }

  async executeRender(source, el, engine, cacheKey) {
    try {
      const requestFn = obsidian.requestUrl || globalThis.fetch;
      const svg = await fetchDiagramSvg(this.settings.serverUrl, source, engine, requestFn);

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

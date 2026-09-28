const obsidian = require('obsidian');
const { DEFAULT_SETTINGS, createDiagramCache, fetchDiagramSvg } = require('./src/renderer.js');

class JoajuSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Configurações do Joaju Live Preview' });

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

class JoajuPlugin extends obsidian.Plugin {
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

    this.addSettingTab(new JoajuSettingTab(this.app, this));
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

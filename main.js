let obsidian;
try {
  obsidian = require('obsidian');
} catch {
  obsidian = {};
}

const DEFAULT_SETTINGS = {
  serverUrl: 'http://baquara:3000',
  fuxicoUrl: 'https://2lp.in',
  fuxicoToken: 'juruping4',
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
    }
  } catch {
    // Mantém responseText original
  }

  if (!svgContent.includes('<svg') && !svgContent.includes('<?xml')) {
    throw new Error('Servidor Joaju respondeu sem SVG válido.');
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
 */
async function uploadToFuxico(
  fuxicoUrl,
  token,
  filename,
  fileData,
  mimeType = 'application/octet-stream'
) {
  const normalizedUrl = (fuxicoUrl || DEFAULT_SETTINGS.fuxicoUrl).replace(/\/+$/, '');

  const formData = new FormData();
  let blob;
  if (typeof fileData === 'string') {
    blob = new Blob([fileData], { type: mimeType });
  } else {
    blob = new Blob([fileData], { type: mimeType });
  }
  formData.append('file', blob, filename);

  const headers = {};
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }

  const res = await fetch(normalizedUrl, {
    method: 'POST',
    headers,
    body: formData
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Erro ${res.status} no Fuxico: ${errText}`);
  }

  const rawUrl = await res.text();
  const publicUrl = rawUrl.trim();
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

    containerEl.createEl('h2', { text: 'Configurações do Joaju & Fuxico' });

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
          .setPlaceholder(DEFAULT_SETTINGS.fuxicoToken)
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
        id: 'check-codeberg-update',
        name: 'Verificar atualizações no Codeberg',
        callback: async () => {
          await this.checkForUpdates(false);
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
      const content = await this.app.vault.read(activeFile);
      const requestFn = obsidian.requestUrl || globalThis.fetch;
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
        const publicUrl = await uploadToFuxico(
          this.settings.fuxicoUrl,
          this.settings.fuxicoToken,
          `${activeFile.basename}.pdf`,
          pdfBuffer,
          'application/pdf'
        );

        await this.updateNoteFrontmatter(activeFile, { pdfUrl: publicUrl });

        if (navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(publicUrl);
        }

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
      const content = await this.app.vault.read(activeFile);
      const publicUrl = await uploadToFuxico(
        this.settings.fuxicoUrl,
        this.settings.fuxicoToken,
        `${activeFile.basename}.md`,
        content,
        'text/markdown; charset=utf-8'
      );

      await this.updateNoteFrontmatter(activeFile, { mdUrl: publicUrl });

      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(publicUrl);
      }

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

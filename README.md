# Joaju Live Preview (`joaju-obsidian`)

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![GOST](https://img.shields.io/badge/GOST-2.0.0-emerald.svg)](https://gost.2lp.in)

Plugin oficial do [Obsidian](https://obsidian.md) para o compilador acadêmico **Joaju**, fornecendo renderização instantânea (Live Preview e Reading View) para heredogramas clínicos, fórmulas químicas, diagramas técnicos e cards de links tipográficos com paridade total WYSIWYG.

---

## 🌟 Recursos Principais

- **🧬 Heredogramas Clínicos**: Padrões `pedtools` e Bennett 2008 (`kinship2`).
- **🧪 Química Estrutural 2D**: Visualização vetorial SMILES/MOL via OpenChemLib e OpenBabel.
- **📊 Tabelas Acadêmicas**: Réguas horizontais com tipografia estrita APA e ABNT.
- **📐 Diagramas Técnicos**: Suporte a D2, PlantUML, Mermaid e Graphviz.
- **📦 Empacotamento de Anexos**: Geração de bundles ZIP em memória para compilação PDF remota.
- **📇 Cards Tipográficos**: Expansão de links isolados com Readability e thumbnail local.
- **🦊 Integração com Fuxico**: Publicação e compartilhamento instantâneo de notas e PDFs.
- **🐾 Sincronização Zotero**: Integração em 1 clique com referências via Tatupeba.

Documentação completa de arquitetura e configuração disponível em [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## 🚀 Instalação Rápida

Crie a pasta do plugin dentro do seu vault e baixe os 3 arquivos distribuíveis (`main.js`, `manifest.json`, `styles.css`):

```bash
mkdir -p <caminho-do-seu-vault>/.obsidian/plugins/joaju-obsidian
npm run deploy
```

Ative o plugin em **Configurações > Opções da Comunidade > Joaju Live Preview**.

---

Feito com dedicação • [Apache-2.0](LICENSE)

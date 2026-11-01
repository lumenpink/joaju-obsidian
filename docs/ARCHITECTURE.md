# Joaju Live Preview (`joaju-obsidian`) — Arquitetura e Recursos

Plugin oficial do [Obsidian](https://obsidian.md) para o ecossistema **Joaju**, fornecendo renderização instantânea (Live Preview e Reading View) para heredogramas clínicos, diagramas técnicos e cards tipográficos de links diretamente nas suas notas.

O **joaju-obsidian** fecha o elo de **paridade total (WYSIWYG)**: o mesmo diagrama vetorial que você visualiza enquanto digita na nota é o que será compilado no PDF final com tipografia acadêmica (Typst/ABNT/Vancouver).

---

## 🌟 Recursos Detalhados

- **🧬 Heredogramas Clínicos (`pedtools`, `kinship2`):** Renderiza heredogramas genealógicos canônicos pelo padrão pedsuite em R (`pedtools`) ou padrão Bennett 2008 (`kinship2`).
- **🧪 Química Estrutural 2D (`openchemlib`, `openbabel`):** Visualização vetorial instantânea de moléculas químicas a partir de código SMILES ou arquivos `.mol`/`.smi`.
- **📊 Tabelas Acadêmicas (`table`):** Tabelas formatadas com réguas horizontais APA/ABNT a partir de dados tabulares ou arquivos `.csv`.
- **📐 D2 Declarativo (`d2`):** Diagramação moderna de fluxos, arquiteturas e tabelas SQL com layout de alta legibilidade.
- **🏗️ PlantUML & Graphviz (`plantuml`, `graphviz`, `mermaid`):** Diagramas formais de sequência, classes, estados, atividades e grafos de dependência.
- **📦 Empacotamento de Workspace (ZIP):** Ao compilar a nota para PDF, o plugin cria um pacote ZIP em memória contendo a nota e todos os anexos locais (imagens, CSVs, MOLs), resolvendo wikilinks do Obsidian (`![[foto.png]]`, `![[imagem.png|400]]`), normalizando nomes com caracteres especiais (`_`) e prevenindo colisões de nomes idênticos entre pastas distintas com desambiguação automática.
- **📇 Cards Tipográficos de Links:** Links isolados na linha são automaticamente expandidos em cards ricos com título, imagem de capa, snippet, domínio e tempo de leitura — sem Chromium, usando Readability no backend.
- **📄 Compilação Nativa de Artigos (PDF):** Envia a nota Markdown atual para compilação no Joaju e salva o PDF resultante diretamente na mesma pasta da nota.
- **🦊 Integração com Fuxico (Pastebin):**
  - **Compilar & Fuxicar PDF:** Compila o PDF e faz upload imediato para sua instância Fuxico, adicionando o link (`fuxico_pdf`) e a tag `fuxico` ao frontmatter, com a URL copiada para a área de transferência.
  - **Fuxicar Markdown:** Publica o arquivo Markdown bruto no Fuxico, registrando `fuxico_md` e tag `fuxico` no frontmatter.
- **🐾 Sincronização Bibliográfica Nativa (Tatupeba):** Gatilho em 1 clique para extrair referências, anotações de leitura em PDFs e o arquivo BibTeX do Zotero via daemon conteinerizado.
- **⚡ Cache em Memória LRU:** Re-renderização a 0ms ao rolar ou alternar notas.
- **⏳ Debounce Configurável:** Digite suavemente sem travar o editor nem sobrecarregar o servidor.
- **🛡️ Tratamento Gracioso de Erros:** Avisos discretos inline caso haja erro de sintaxe, sem quebrar o layout da nota.
- **🔒 Privacidade e Controle Local de Dados:** Conecta diretamente aos seus serviços locais/VPN (Joaju, Tatupeba e Fuxico).

---

## ⚙️ Configurações

* **Servidor Joaju (URL):** Endereço da API Joaju (padrão: `http://localhost:3000`).
* **Servidor Tatupeba (URL):** Endereço do daemon Tatupeba para sincronização de referências Zotero (padrão: `http://localhost:3001`).
* **Token de Autenticação Tatupeba:** Chave de segurança para sincronização via webhook (Bearer / X-Api-Key).
* **Debounce (ms):** Tempo de espera (padrão: `400ms`) antes de renderizar diagramas.
* **Servidor Fuxico (URL):** Instância Fuxico para publicação (padrão: `http://localhost:8080`).
* **Token de Autenticação Fuxico:** Chave de API Bearer para envio de arquivos.
* **Repositório Codeberg:** Repositório canônico (`lumenpink/joaju-obsidian`).
* **Branch / Canal:** Branch de busca (`main`).

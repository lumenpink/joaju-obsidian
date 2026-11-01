# GOST Language Specification: JavaScript & TypeScript
**Identificador da Stack:** `javascript`  
**Padrão Base:** GOST `2.0.0`

---

## 1. Visão Geral e Filosofia
Esta especificação define os requisitos de engenharia, ferramentas e padrões para desenvolvimento em **JavaScript** e **TypeScript** no ecossistema GOST.

O ecossistema adota **Node.js 24 LTS** (`>= 24.16.0`) como runtime canônico de servidor e build, mantendo **neutralidade WinterCG / Web Standards** para permitir execução transparente em Cloudflare Workers, Deno, Bun e navegadores. Impõe-se **ESM nativo obrigatório** (`"type": "module"` no `package.json`), **TypeScript 5.8+** em modo estrito (`"strict": true`) e Web Standards nativos.

---

## 2. Ferramental Mandatório de Testes & Qualidade

| Requisito GOST | Ferramenta Padrão | Comando de Validação no CI |
|---|---|---|
| **Test Runner (E2E / Browser)** | **Playwright** | `npx playwright test` |
| **Test Runner (Unit)** | **Vitest** / **Node Test Runner** | `npx vitest run --coverage` (ou `node --test`) |
| **Cobertura (≥ 90%)** | **v8 / Vitest Coverage** | `npx vitest run --coverage --coverage.thresholds.lines 90` |
| **Testes de Mutação** | **Stryker Mutator** | `npx stryker run` |
| **Linter & Formatação** | **Biome** (Canônico) | `npx biome check .` |
| **Auditoria de Segurança** | **npm/pnpm audit** | `npm audit --audit-level=high` |

---

## 3. Gestão de Dependências (Twelve-Factor)
1. **Lockfile Estrito e Congelado:** O arquivo `package-lock.json` ou `pnpm-lock.yaml` **DEVE** estar commitado na raiz.
2. **Instalação Hermética em CI:**
   ```bash
   npm ci
   # ou
   pnpm install --frozen-lockfile
   ```
3. **Anti-Bloat:** Proibição de bibliotecas de terceiros para operações triviais. Preferência absoluta por APIs nativas modernas do JavaScript e padrões WinterCG (`fetch`, `FormData`, `URL`, `crypto.subtle`, `Headers`, `Request`, `Response`).

---

## 4. Arquitetura de Domínio & SOLID Pragmático (Regra GOST-27)
1. **Pureza de Domínio (Zero I/O no Core):** O diretório `src/domain/` é estritamente puro. Em conformidade com a Regra `GOST-27`, é terminantemente proibido importar ou invocar `node:fs`, `node:net`, `node:child_process`, `node:http`, `fetch(`, `process.env` ou `localStorage` dentro dos modelos e contratos do Core.
2. **Estrutura de Pastas Canônica:**
   ```text
   src/
   ├── domain/             # Regras de negócio puras, contratos de tipos e discriminated unions
   ├── application/        # Casos de uso e orquestração
   └── infrastructure/     # Adaptadores de I/O (HTTP clients, DB, fakes in-memory)
   ```
3. **In-Memory Fakes:** Testes unitários substituem I/O real por implementações em memória baseadas em `Map` ou arrays simples, sem frameworks pesados de mocking dinâmico. Fakes e adaptadores reais compartilham os mesmos testes de contrato (LSP).
4. **Parse, Don't Validate:** Validação de payloads na borda (parsers leves ou esquemas seguros). O Core opera com primitivos confiáveis.
5. **Modelagem com Discriminated Unions:**
   ```typescript
   export type ProcessState =
     | { status: 'idle' }
     | { status: 'running'; startedAt: number }
     | { status: 'succeeded'; result: string }
     | { status: 'failed'; error: Error };
   ```

---

## 5. Padrões de Sistema e Containers OCI
1. **Conformidade XDG (Node.js):**
   ```javascript
   import path from 'node:path';
   import os from 'node:os';

   export function getConfigDir(appName) {
       const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
       return path.join(base, appName);
   }
   ```
2. **Dockerfile Canônico (Multi-stage + Alpine Non-Root com Prune):**
   ```dockerfile
   FROM node:24-alpine AS builder
   WORKDIR /app
   COPY package*.json ./
   RUN npm ci
   COPY . .
   RUN npm run build --if-present
   RUN npm prune --omit=dev

   FROM node:24-alpine
   USER 1000:1000
   WORKDIR /app
   COPY --chown=node:node --from=builder /app ./
   ENTRYPOINT ["node", "dist/index.js"]
   ```
3. **Streams:** `console.log()` estritamente para dados de saída; `console.error()` / `console.warn()` para logs diagnósticos e progresso.

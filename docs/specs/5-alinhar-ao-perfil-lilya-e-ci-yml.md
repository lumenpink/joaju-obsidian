# Spec: Ticket #5 - Alinhar ao Perfil Lilya e ci.yml

## 1. Contexto e Motivação
Alinhamento do repositório `joaju-obsidian` às normas GOST v2.0 com perfil `lilya` (`https://lilya.2lp.in/profile.md`), adoção de `.forgejo/workflows/ci.yml`, condensação de `README.md` para respeitar o teto de 50 linhas (GOST-20) migrando a documentação de arquitetura para `docs/ARCHITECTURE.md`, e expurgo de terminologia obsoleta.

## 2. Requisitos Técnicos
- Renomeação de `.forgejo/workflows/ci.yaml` para `.forgejo/workflows/ci.yml`.
- Migração de documentação para `docs/ARCHITECTURE.md`.
- Condensação do `README.md` para <= 50 linhas com metadados essenciais.
- Conformidade total com `cccp check --strict`.

## 3. Critérios de Aceitação
- Testes unitários (`npm test`) 100% verdes.
- 100% de conformidade com `cccp check --strict`.

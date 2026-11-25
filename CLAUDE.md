# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Este repositório é o `cap-release-apk`, um CLI (devDependency) que gera APK/AAB assinados para projetos Capacitor. As convenções completas (escopo de alterações, regras de segurança do keystore, limitações) estão em `AGENTS.md` — leia-o antes de mudar código ou docs.

## Comandos

```bash
npm install                      # instala commander e @clack/prompts
npm test                         # node --test (runner nativo)
node --check src/build.js        # checagem de sintaxe (não há lint configurado)
node bin/apk.js --help           # executa o CLI a partir do repositório
```

- Não há suíte de testes nem arquivos `*.test.js` hoje; `npm test` não executa nada útil. Para um arquivo específico, use `node --test <arquivo>`.
- Não existe lint nem formatter configurado.
- Testar o fluxo real (`init`, `build`, `doctor`) exige um projeto Capacitor host com `android/` e `capacitor.config.*`. Rodar dentro deste repositório não cobre esse fluxo, pois não há `android/` aqui.

## Arquitetura

**Entrada e dispatch.** `bin/apk.js` (commander) registra três comandos (`init`, `build`, `doctor`), cada um delegando a uma função exportada de `src/init.js`, `src/build.js` e `src/doctor.js`. Erros são capturados no `action` e viram `process.exitCode = 1`.

**Sem estado interno: o estado vive no projeto host.** Cada comando resolve a raiz com `findProjectRoot` (sobe a partir do `cwd`) e opera sobre o `android/` do host. Os artefatos compartilhados entre comandos são arquivos:
- `android/keystore.properties` (escrito pelo `init`, lido pelo `build` e `doctor`, e pelo loader Groovy injetado no `build.gradle`);
- o keystore `.jks` (resolvido via `resolveKeystorePath` / `findKeystoreFile`, que tolera `.jks`, `.keystore` e nome sem caminho);
- `android/app/build.gradle`, patchado textualmente.

**Pipeline do `init`** (`src/init.js`): valores vêm com prioridade `opções CLI > env (com --yes) > prompts` → gera keystore com `keytool` se não existir → grava `keystore.properties` e o `.example` → `patchGradle` → `ensureGitignore` → injeta `scripts.apk` e `scripts.aab` no `package.json` do host. Como o `init` pode ser rodado de novo, cada passo precisa ser idempotente.

**Patch do Gradle** (`src/patch-gradle.js`): é uma edição de string, não um parser. A idempotência vem de checar a presença de marcadores (`keystorePropertiesFile`, `signingConfigs`, `signingConfig signingConfigs.release`) antes de cada injeção. Se o `build.gradle` mudar de forma, o patch pode falhar ou emitir aviso, então qualquer alteração nele precisa preservar essas checagens.

**Pipeline do `build`** (`src/build.js`):
1. Checagens rápidas (`android/`, `gradlew`, `keystore.properties` em release, `build.gradle`, `java -version`).
2. Auto-correção de `storeFile` quando o arquivo real diverge do caminho gravado.
3. `npx cap sync android` (fallback para `npx cap sync`). O build web **não** é feito pelo CLI; o projeto deve gerar o bundle web antes.
4. Gradle com timeout de 300s: `assembleRelease`/`assembleDebug` (APK) ou `bundleRelease`/`bundleDebug` com `--aab`/`--bundle`/`--debug`.
5. Se a saída tiver o erro de estado incremental do AGP 8 (`package-aware-r.txt` ou `symbol_list_with_package_name`), roda `gradlew clean` e tenta **uma** vez mais. `--clean` faz o `clean` sempre, antes do build.
6. Copia o artefato de `android/app/build/outputs/{apk,bundle}/{release,debug}/` para `cap-apk-outputs/`.

**`doctor`** (`src/doctor.js`) só verifica e reporta; retorna `0` ou `1`. Não altera nada.

**Compatibilidade de SO.** Os `spawnSync` usam `shell: process.platform === 'win32'`, e o wrapper do Gradle muda entre `gradlew` e `gradlew.bat`. Qualquer novo spawn precisa seguir esse padrão. O `findAndroidSdk` em `src/utils.js` também considera `ANDROID_HOME`, `ANDROID_SDK_ROOT` e `sdk.dir` em `android/local.properties`.

## Cuidados que não são óbvios

- O pacote publica apenas `bin/`, `src/` e `template/` (campo `files` do `package.json`). Não mova arquivos para fora dessas pastas sem ajustar isso.
- Não gerar keystore novo em CI para releases: perder o `.jks` impede atualizações assinadas com a mesma chave. Veja a seção de segurança em `AGENTS.md`.
- Não commitar `*.jks`, `*.keystore` ou `android/keystore.properties`. O `.gitignore` da raiz cobre `*.jks` e `*.keystore`; o `ensureGitignore` cobre `keystore.properties` dentro do projeto host.
- Apenas Groovy DSL (`build.gradle`). Kotlin DSL (`build.gradle.kts`) não é suportado.

# CapReleaseAPK

[English](./README.en.md) | [Español](./README.es.md)

CLI para gerar **APK e AAB assinados** em projetos Capacitor com um único comando — perguntas interativas + build.

```bash
npx cap-release-apk init   # configura keystore e patch do Gradle (interativo)
npx cap-release-apk build  # npm run build + cap sync + gradlew assembleRelease
npm run apk                # = cap-release-apk build (APK em cap-apk-outputs/)
npm run aab                # = cap-release-apk build --aab (AAB em cap-apk-outputs/)
```

Funciona em qualquer projeto Capacitor com `android/` no Windows, macOS e Linux.

## O que faz

Automatiza o fluxo manual de assinatura:

1. Cria o keystore (`*.jks`) via `keytool` (RSA 2048)
2. Cria `android/keystore.properties` (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`)
3. Cria `android/keystore.properties.example` (sem senhas, pode commitar)
4. Aplica patch idempotente em `android/app/build.gradle` para `signingConfigs.release`
5. Atualiza `.gitignore` (raiz e `android/`) com `*.jks`, `*.keystore`, `keystore.properties`
6. Adiciona `scripts.apk = "cap-release-apk build"` e `scripts.aab = "cap-release-apk build --aab"` no `package.json` do projeto host
7. No `build`, roda `npm run build` (se existir) → `npx cap sync android` → `gradlew assembleRelease` (APK → `cap-apk-outputs/`) ou `gradlew bundleRelease` com `--aab`/`--bundle` (AAB → `cap-apk-outputs/`)

No primeiro uso faz perguntas interativas (`@clack/prompts`); depois, um comando gera o APK ou AAB novamente.

## Requisitos

- **Node** ≥ 18
- Projeto Capacitor com `android/` criado (`npx cap add android`) e `capacitor.config.*`
- **JDK 17+** (AGP 8+) com `java` e `keytool` no `PATH`
- **Android SDK** com `ANDROID_HOME`/`ANDROID_SDK_ROOT` ou `sdk.dir` em `android/local.properties`
- **Gradle Wrapper** (`android/gradlew` ou `android/gradlew.bat` no Windows)

## Instalação

```bash
npm i -D cap-release-apk
```

Disponibiliza três binários equivalentes: `apk`, `cap-apk` (compatibilidade) e `cap-release-apk`.

## Uso

### 1. Inicializar — `npx cap-release-apk init`

```bash
npx cap-release-apk init
# aliases compatíveis
npx apk init
npx cap-apk init
```

Perguntas (pula se já passado via CLI):

| Campo | Default | Observação |
|---|---|---|
| `storeFile` | `android/app/release.jks` | caminho do keystore |
| `keyAlias` | `release` | alias da chave |
| `storePassword` | *(obrigatório, ≥6 chars)* | input `password` |
| `keyPassword` | `= storePassword` | Enter para reusar |
| `dname` | `CN=CapReleaseAPK, OU=Mobile, O=App, C=BR` | Distinguished Name |
| `validity` | `10000` dias | ~27 anos |
| `keyAlg` / `keysize` | `RSA` / `2048` | fixo, exibido como `note` |

Se o arquivo não existir, pergunta se deve gerar via:

```bash
keytool -genkeypair -v -keystore <storeFile> -alias <alias> -keyalg RSA -keysize 2048 -validity <days> -storepass <pass> -keypass <pass> -dname "<dname>"
```

Comportamento do `init`:

- Se `storeFile` estiver dentro de `android/app/`, grava só o filename em `keystore.properties`; caso contrário, grava caminho relativo a `android/` (ex.: `../my-keystore.jks`) ou absoluto se fora do projeto. O `build.gradle` resolve via `rootProject.file()` com fallback `file()` para bare filename.
- Patch idempotente em `android/app/build.gradle`: injeta loader de `keystore.properties` antes de `android {`, bloco `signingConfigs.release` e `signingConfig signingConfigs.release` em `buildTypes.release`.
- Atualiza `.gitignore` (descomenta se estiver como `# *.jks`).
- Não sobrescreve `scripts.apk` nem `scripts.aab` se já existirem.

#### Modo não-interativo (`--yes` / CI)

```bash
npx cap-release-apk init --yes \
  --storeFile android/app/release.jks \
  --keyAlias release \
  --storePassword "$CAP_APK_STORE_PASSWORD" \
  --keyPassword "$CAP_APK_KEY_PASSWORD"
```

Com `--yes` também lê variáveis de ambiente:

`CAP_APK_STORE_FILE`, `CAP_APK_STORE_PASSWORD`, `CAP_APK_KEY_ALIAS`, `CAP_APK_KEY_PASSWORD`, `CAP_APK_DNAME`, `CAP_APK_VALIDITY`

Se `keystore.properties` já existir, `--yes` reaproveita valores válidos como defaults.

### 2. Gerar APK ou AAB — `npx cap-release-apk build`

| Comando | O que faz | Saída |
|---|---|---|
| `npx cap-release-apk init` | configura keystore + patch Gradle | `android/keystore.properties` |
| `npx cap-release-apk build` | gera APK release assinado | `android/app/build/outputs/apk/release/` + `cap-apk-outputs/` |
| `npx cap-release-apk build --aab` (ou `--bundle`) | gera AAB release assinado | `android/app/build/outputs/bundle/release/` + `cap-apk-outputs/` |
| `npx cap-release-apk doctor` | diagnostica ambiente/config | relatório no terminal |
| `npm run apk` | atalho para `cap-release-apk build` | mesmo que APK acima |
| `npm run aab` | atalho para `cap-release-apk build --aab` | mesmo que AAB acima |

```bash
npx cap-release-apk build          # release → assembleRelease (requer keystore.properties)
npx cap-release-apk build --aab    # release → bundleRelease (requer keystore.properties)
npx cap-release-apk build --debug  # debug → assembleDebug (não exige keystore)
npx cap-release-apk build --aab --debug # debug → bundleDebug (não exige keystore)
npx cap-release-apk build --verbose # mostra saída completa do Gradle

# via scripts criados pelo init (flags passam com --)
npm run apk
npm run apk -- --debug
npm run apk -- --verbose
npm run aab
npm run aab -- --debug
npm run aab -- --verbose
```

Etapas:

1. Checagens (`java`, `keystore.properties` quando release, `gradlew`, `build.gradle`)
2. `npm run build` (se houver `scripts.build`)
3. `npx cap sync android` (fallback `npx cap sync`)
4. `gradlew assembleRelease` ou `gradlew bundleRelease` com `--aab` (`gradlew.bat` no Windows) com timeout de 300s
5. Localiza `android/app/build/outputs/apk/release/app-release.apk` (ou `debug/app-debug.apk`) ou `android/app/build/outputs/bundle/release/app-release.aab` (ou `debug/app-debug.aab`), exibe tamanho e copia para `cap-apk-outputs/`

### 3. Diagnóstico — `npx cap-release-apk doctor`

```bash
npx cap-release-apk doctor
```

Verifica e reporta (exit `0` ok, `1` com problemas):

- Node ≥ 18
- `java -version` (JDK 17+ recomendado)
- `keytool` disponível
- `ANDROID_HOME` / `ANDROID_SDK_ROOT` ou `sdk.dir` em `android/local.properties`
- `android/` e `gradlew`/`gradlew.bat`
- `capacitor.config.*`
- `keystore.properties` existe e aponta para keystore válido (tolerância `.jks`/`.keystore`)
- `build.gradle` contém `signingConfigs` + `keystoreProperties`

## CI

Mantenha `*.jks` fora do Git. Use Secrets e restaure em CI:

```yaml
- uses: actions/setup-java@v4
  with:
    distribution: temurin
    java-version: '17'
- uses: android-actions/setup-android@v3

- name: Setup keystore
  env:
    CAP_APK_STORE_PASSWORD: ${{ secrets.CAP_APK_STORE_PASSWORD }}
    CAP_APK_KEY_PASSWORD: ${{ secrets.CAP_APK_KEY_PASSWORD }}
  run: |
    echo "$KEYSTORE_BASE64" | base64 -d > android/app/release.jks
    npx cap-release-apk init --yes --storeFile android/app/release.jks --keyAlias release --storePassword "$CAP_APK_STORE_PASSWORD" --keyPassword "$CAP_APK_KEY_PASSWORD"

- run: npx cap-release-apk build
```

> Não gere um keystore novo em CI para releases — use um estável versionado via secret base64.

## Segurança

- `android/keystore.properties` contém senhas em texto puro — **nunca commite**. O `init` já adiciona `keystore.properties`, `*.jks` e `*.keystore` ao `.gitignore`.
- Versione apenas `android/keystore.properties.example` (senhas como `***`).
- Em CI, injete senhas via `CAP_APK_STORE_PASSWORD` / `CAP_APK_KEY_PASSWORD` (Secrets).
- Faça backup seguro do `.jks` — perdê-lo impede atualizar o app na Play Store com a mesma assinatura.
- O patch do Gradle lê senhas só se `keystore.properties` existir; fora isso, o `signingConfig` fica vazio.

## Limitações

- Gera **APK** (`assembleRelease` / `assembleDebug`) e **AAB** (`bundleRelease` / `bundleDebug` com `--aab`/`--bundle`).
- Suporta apenas **Groovy DSL** (`android/app/build.gradle`). Não há suporte a Kotlin DSL (`build.gradle.kts`).
- `RSA 2048` fixo no `keytool`; `validity` e `dname` são configuráveis.
- Requer `android/` já existente (`npx cap add android`).

## Para LLMs e agentes

Orientações para agentes automatizados que trabalham neste repositório:

- Leia `AGENTS.md` antes de alterar qualquer arquivo.
- Entenda que o projeto é uma **CLI Node.js ESM** (`"type": "module"`) para gerar **APK e AAB assinados** em projetos Capacitor (Android).
- Use `package.json`, `bin/apk.js` e `src/*.js` como fontes de verdade; não assuma comportamentos fora desses arquivos.
- Não invente suporte a **Kotlin DSL** (`build.gradle.kts`), novas funcionalidades ou testes — apenas o que está implementado.
- Preserve os aliases `apk`, `cap-apk`, `cap-release-apk` e o comportamento idempotente do patch em `android/app/build.gradle` e do `.gitignore`, salvo solicitação explícita.
- Mantenha alterações focadas no escopo solicitado e, quando a documentação mudar, atualize `README.md`, `README.en.md` e `README.es.md` de forma consistente.
- Após alterações, execute `npm test` (`node --test`) e valide os links relativos dos READMEs (`./README.md`, `./README.en.md`, `./README.es.md`, `./LICENSE`).
- Nunca exponha ou commite `*.jks`, `*.keystore`, `android/keystore.properties` ou senhas — versione apenas `android/keystore.properties.example` com `***`.

## Licença

MIT — veja [LICENSE](./LICENSE).

# CapReleaseAPK

[Português](./README.md) | [English](./README.en.md)

CLI para generar un **APK firmado** en proyectos Capacitor con un solo comando — preguntas interactivas + build.

```bash
npx cap-release-apk init   # configura el keystore y parchea Gradle (interactivo)
npx cap-release-apk build  # npm run build + cap sync + gradlew assembleRelease
```

Funciona en cualquier proyecto Capacitor con `android/` en Windows, macOS y Linux.

## Qué hace

Automatiza el flujo manual de firma:

1. Crea el keystore (`*.jks`) vía `keytool` (RSA 2048)
2. Crea `android/keystore.properties` (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`)
3. Crea `android/keystore.properties.example` (sin contraseñas, se puede commitear)
4. Aplica un parche idempotente en `android/app/build.gradle` para `signingConfigs.release`
5. Actualiza `.gitignore` (raíz y `android/`) con `*.jks`, `*.keystore`, `keystore.properties`
6. Agrega `scripts.apk = "cap-release-apk build"` al `package.json` del proyecto host
7. En `build`, ejecuta `npm run build` (si existe) → `npx cap sync android` → `gradlew assembleRelease` → copia el APK a `dist-apk/` y `android/app/build/outputs/apk/release/`

En el primer uso hace preguntas interactivas (`@clack/prompts`); después, un solo comando regenera el APK.

## Requisitos

- **Node** ≥ 18
- Proyecto Capacitor con `android/` creado (`npx cap add android`) y `capacitor.config.*`
- **JDK 17+** (AGP 8+) con `java` y `keytool` en el `PATH`
- **Android SDK** con `ANDROID_HOME`/`ANDROID_SDK_ROOT` o `sdk.dir` en `android/local.properties`
- **Gradle Wrapper** (`android/gradlew` o `android/gradlew.bat` en Windows)

## Instalación

```bash
npm i -D cap-release-apk
```

Expone tres binarios equivalentes: `apk`, `cap-apk` (compatibilidad) y `cap-release-apk`.

## Uso

### 1. Inicializar — `npx cap-release-apk init`

```bash
npx cap-release-apk init
# alias
npx apk init
npx cap-apk init
```

Preguntas (se omiten si ya se pasaron por CLI):

| Campo | Default | Observación |
|---|---|---|
| `storeFile` | `android/app/release.jks` | ruta del keystore |
| `keyAlias` | `release` | alias de la clave |
| `storePassword` | *(obligatorio, ≥6 caracteres)* | input `password` |
| `keyPassword` | `= storePassword` | Enter para reutilizar |
| `dname` | `CN=CapReleaseAPK, OU=Mobile, O=App, C=BR` | Distinguished Name |
| `validity` | `10000` días | ~27 años |
| `keyAlg` / `keysize` | `RSA` / `2048` | fijo, mostrado como `note` |

Si el archivo no existe, pregunta si debe generarlo vía:

```bash
keytool -genkeypair -v -keystore <storeFile> -alias <alias> -keyalg RSA -keysize 2048 -validity <days> -storepass <pass> -keypass <pass> -dname "<dname>"
```

Comportamiento de `init`:

- Si `storeFile` está dentro de `android/app/`, graba solo el filename en `keystore.properties`; en caso contrario, graba una ruta relativa a `android/` (ej.: `../my-keystore.jks`) o absoluta si está fuera del proyecto. El `build.gradle` lo resuelve vía `rootProject.file()` con fallback `file()` para bare filename.
- Parche idempotente en `android/app/build.gradle`: inyecta el loader de `keystore.properties` antes de `android {`, el bloque `signingConfigs.release` y `signingConfig signingConfigs.release` en `buildTypes.release`.
- Actualiza `.gitignore` (descomenta si está como `# *.jks`).
- No sobrescribe `scripts.apk` si ya existe.

#### Modo no interactivo (`--yes` / CI)

```bash
npx cap-release-apk init --yes \
  --storeFile android/app/release.jks \
  --keyAlias release \
  --storePassword "$CAP_APK_STORE_PASSWORD" \
  --keyPassword "$CAP_APK_KEY_PASSWORD"
```

Con `--yes` también lee variables de entorno:

`CAP_APK_STORE_FILE`, `CAP_APK_STORE_PASSWORD`, `CAP_APK_KEY_ALIAS`, `CAP_APK_KEY_PASSWORD`, `CAP_APK_DNAME`, `CAP_APK_VALIDITY`

Si `keystore.properties` ya existe, `--yes` reutiliza valores válidos como defaults.

### 2. Generar APK — `npx cap-release-apk build`

```bash
npx cap-release-apk build          # release → assembleRelease (requiere keystore.properties)
npx cap-release-apk build --debug  # debug → assembleDebug (no requiere keystore)
npx cap-release-apk build --verbose # muestra salida completa de Gradle

# vía script creado por init
npm run apk
npm run apk -- --debug
```

Pasos:

1. Verificaciones (`java`, `keystore.properties`, `gradlew`, `build.gradle`)
2. `npm run build` (si existe `scripts.build`)
3. `npx cap sync android` (fallback `npx cap sync`)
4. `gradlew assembleRelease` (`gradlew.bat` en Windows) con timeout de 300s
5. Localiza `android/app/build/outputs/apk/release/app-release.apk` (o `debug/app-debug.apk`), muestra tamaño y copia a `dist-apk/`

### 3. Diagnóstico — `npx cap-release-apk doctor`

```bash
npx cap-release-apk doctor
```

Verifica y reporta (exit `0` ok, `1` con problemas):

- Node ≥ 18
- `java -version` (JDK 17+ recomendado)
- `keytool` disponible
- `ANDROID_HOME` / `ANDROID_SDK_ROOT` o `sdk.dir` en `android/local.properties`
- `android/` y `gradlew`/`gradlew.bat`
- `capacitor.config.*`
- `keystore.properties` existe y apunta a un keystore válido (tolera `.jks`/`.keystore`)
- `build.gradle` contiene `signingConfigs` + `keystoreProperties`

## CI

Mantén `*.jks` fuera de Git. Usa Secrets y restáuralo en CI:

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

> No generes un keystore nuevo en CI para releases — usa uno estable guardado como secret en base64.

## Seguridad

- `android/keystore.properties` contiene contraseñas en texto plano — **nunca lo commitees**. `init` ya agrega `keystore.properties`, `*.jks` y `*.keystore` a `.gitignore`.
- Versiona solo `android/keystore.properties.example` (contraseñas como `***`).
- En CI, inyecta contraseñas vía `CAP_APK_STORE_PASSWORD` / `CAP_APK_KEY_PASSWORD` (Secrets).
- Haz backup seguro del `.jks` — perderlo impide actualizar la app en Play Store con la misma firma.
- El parche de Gradle lee contraseñas solo si `keystore.properties` existe; de lo contrario, `signingConfig` queda vacío.

## Limitaciones

- Genera solo **APK** (`assembleRelease` / `assembleDebug`). Sin soporte para AAB.
- Soporta solo **Groovy DSL** (`android/app/build.gradle`). Sin soporte para Kotlin DSL (`build.gradle.kts`).
- `RSA 2048` fijo en `keytool`; `validity` y `dname` son configurables.
- Requiere `android/` existente (`npx cap add android`).

## Licencia

MIT — ver [LICENSE](./LICENSE).

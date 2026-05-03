# MakeUniversal Guide for users of Electron.Net

This guide explains how to use `Scripts/MakeUniversal.js` to build, sign, notarize, and package a universal macOS application.

The script currently supports:

- building `osx-x64` and `osx-arm64` publishes
- merging both outputs into one universal `.app`
- signing the universal `.app` with `electron-osx-sign`
- notarizing and stapling the `.app` for `pkg` and `dmg` targets
- packaging the app as:
  - `pkg` using native macOS tools (`pkgbuild` / `productbuild`)
  - `dmg` using native macOS tools (`hdiutil`)
- signing the final `pkg` installer with `productsign`
- optional `pkg` welcome / license resources
- optional JSON-based configuration with command-line override precedence

---

## Table of contents

- [1. Overview](#1-overview)
- [2. Prerequisites](#2-prerequisites)
- [3. Required inputs](#3-required-inputs)
- [4. Command-line usage](#4-command-line-usage)
- [5. Target-specific examples](#5-target-specific-examples)
- [6. Using `MakeUniversal.config.json`](#6-using-makeuniversalconfigjson)
- [7. Config template structure](#7-config-template-structure)
- [8. Identity and certificate inputs](#8-identity-and-certificate-inputs)
- [9. Common Apple certificate combinations by target](#9-common-apple-certificate-combinations-by-target)
- [10. Advanced `electron-osx-sign` pass-through options](#10-advanced-electron-osx-sign-pass-through-options)
- [11. Print the effective config](#11-print-the-effective-config)
- [12. Notarization behavior](#12-notarization-behavior)
- [13. Output locations](#13-output-locations)
- [14. Troubleshooting](#14-troubleshooting)
- [15. Recommended workflow](#15-recommended-workflow)
- [16. Summary](#16-summary)

---

## 1. Overview

`Scripts/MakeUniversal.js` reads the active macOS target from:

- `Properties/electron-builder.json`

That target controls the final packaging behavior:

- `pkg` → create a signed installer package
- `dmg` → create a drag-and-drop disk image
- `mas` / `mas-dev` → no installer packaging step; the output remains a signed `.app`

The high-level flow is:

1. `dotnet publish` for `osx-x64`
2. `dotnet publish` for `osx-arm64`
3. clean unwanted files
4. merge both builds into one universal `.app`
5. sign the universal `.app`
6. if target is `pkg` or `dmg`:
   - notarize the signed `.app`
   - staple the notarization ticket to the `.app`
7. package as `pkg` or `dmg`
8. if target is `pkg`, sign the installer with `productsign`

---

## 2. Prerequisites

### Required tools

You need the following available on macOS:

- `dotnet`
- `node`
- `npm`
- Xcode command-line tools
- Apple packaging / notarization tools:
  - `pkgbuild`
  - `productbuild`
  - `productsign`
  - `hdiutil`
  - `xcrun notarytool`
  - `xcrun stapler`
  - `ditto`

### Required npm packages

`ElectronHostHook/package.json` should include:

```json
{
  "devDependencies": {
    "@electron/universal": "^3.0.3",
    "electron-osx-sign": "^0.6.0"
  }
}
```

Install them with:

```zsh
cd "./ElectronHostHook"
npm install
```

### Required publish profiles

The script expects publish profiles in:

- `Properties/PublishProfiles/`

You must provide both:

- one for `osx-x64`
- one for `osx-arm64`

Each profile must contain the correct `<RuntimeIdentifier>`.

---

## 3. Required inputs

At minimum, `MakeUniversal.js` needs:

- `--app-name`
- `--publish-profile-osx-x64`
- `--publish-profile-osx-arm64`
- a signing identity for the active target unless `--no-sign` is used

If the target is `pkg`, installer creation is enabled, and signing is enabled, it also needs:

- `--installer-identity`

If the target is `pkg` or `dmg`, signing is enabled, and notarization has not been disabled, it also needs notarization credentials:

- `--notarize-apple-id`
- `--notarize-app-password`
- `--notarize-team-id`

---

## 4. Command-line usage

### Basic structure

```zsh
node "./Scripts/MakeUniversal.js" \
  --app-name="ExampleApp" \
  --publish-profile-osx-x64="publish-osx-x64" \
  --publish-profile-osx-arm64="publish-osx-arm64" \
  --sign-identity="Apple Development: Your Name (TEAMID)"
```

### Additional dotnet publish arguments

You can pass extra `dotnet publish` arguments repeatedly:

```zsh
node "./Scripts/MakeUniversal.js" \
  --app-name="ExampleApp" \
  --publish-profile-osx-x64="publish-osx-x64" \
  --publish-profile-osx-arm64="publish-osx-arm64" \
  --sign-identity="Apple Development: Your Name (TEAMID)" \
  --dotnet-arg="-p:SomeProp=Value" \
  --dotnet-arg="-p:LangVersion=latest"
```

### Skip signing entirely

For a local test build:

```zsh
node "./Scripts/MakeUniversal.js" \
  --app-name="ExampleApp" \
  --publish-profile-osx-x64="publish-osx-x64" \
  --publish-profile-osx-arm64="publish-osx-arm64" \
  --no-sign
```

### Skip notarization but keep signing enabled

Use this when you want the `.app` to be signed but do not want the notarization step to run:

```zsh
node "./Scripts/MakeUniversal.js" \
  --app-name="ExampleApp" \
  --publish-profile-osx-x64="publish-osx-x64" \
  --publish-profile-osx-arm64="publish-osx-arm64" \
  --sign-identity="Developer ID Application: Your Name (TEAMID)" \
  --installer-identity="Developer ID Installer: Your Name (TEAMID)" \
  --no-notarization
```

### Skip installer creation but keep the universal app build

Use this when you want the script to stop after building/signing the universal `.app` instead of creating a `pkg` or `dmg` installer.

```zsh
node "./Scripts/MakeUniversal.js" \
  --app-name="ExampleApp" \
  --publish-profile-osx-x64="publish-osx-x64" \
  --publish-profile-osx-arm64="publish-osx-arm64" \
  --sign-identity="Developer ID Application: Your Name (TEAMID)" \
  --no-installer
```

If notarization is still enabled and the active target is `pkg` or `dmg`, the `.app` will still be notarized and stapled before installer creation is skipped.

---

## 5. Target-specific examples

> The active target comes from `Properties/electron-builder.json`.
> If you want `dmg`, `pkg`, `mas`, or `mas-dev`, update that file first.

### Example: `pkg`

```zsh
node "./Scripts/MakeUniversal.js" \
  --app-name="ExampleApp" \
  --publish-profile-osx-x64="publish-osx-x64" \
  --publish-profile-osx-arm64="publish-osx-arm64" \
  --sign-identity="Apple Development: Your Name (TEAMID)" \
  --installer-identity="Developer ID Installer: Your Name (TEAMID)" \
  --notarize-apple-id="your-apple-id@example.com" \
  --notarize-app-password="xxxx-xxxx-xxxx-xxxx" \
  --notarize-team-id="TEAMID1234"
```

### Example: `pkg` with welcome and license

```zsh
node "./Scripts/MakeUniversal.js" \
  --app-name="ExampleApp" \
  --publish-profile-osx-x64="publish-osx-x64" \
  --publish-profile-osx-arm64="publish-osx-arm64" \
  --sign-identity="Apple Development: Your Name (TEAMID)" \
  --installer-identity="Developer ID Installer: Your Name (TEAMID)" \
  --pkg-welcome="InstallerResources/welcome.rtf" \
  --pkg-license="InstallerResources/license.rtf" \
  --notarize-apple-id="your-apple-id@example.com" \
  --notarize-app-password="xxxx-xxxx-xxxx-xxxx" \
  --notarize-team-id="TEAMID1234"
```

### Example: `dmg`

```zsh
node "./Scripts/MakeUniversal.js" \
  --app-name="ExampleApp" \
  --publish-profile-osx-x64="publish-osx-x64" \
  --publish-profile-osx-arm64="publish-osx-arm64" \
  --sign-identity="Apple Development: Your Name (TEAMID)" \
  --notarize-apple-id="your-apple-id@example.com" \
  --notarize-app-password="xxxx-xxxx-xxxx-xxxx" \
  --notarize-team-id="TEAMID1234"
```

### Example: `dmg` or `pkg` with notarization zip cleanup

```zsh
node "./Scripts/MakeUniversal.js" \
  --app-name="ExampleApp" \
  --publish-profile-osx-x64="publish-osx-x64" \
  --publish-profile-osx-arm64="publish-osx-arm64" \
  --sign-identity="Apple Development: Your Name (TEAMID)" \
  --installer-identity="Developer ID Installer: Your Name (TEAMID)" \
  --notarize-apple-id="your-apple-id@example.com" \
  --notarize-app-password="xxxx-xxxx-xxxx-xxxx" \
  --notarize-team-id="TEAMID1234" \
  --delete-notarize-zip
```

### Example: `mas`

```zsh
node "./Scripts/MakeUniversal.js" \
  --app-name="ExampleApp" \
  --publish-profile-osx-x64="publish-osx-x64" \
  --publish-profile-osx-arm64="publish-osx-arm64" \
  --sign-identity="Apple Distribution: Your Name (TEAMID)"
```

### Example: `mas-dev`

```zsh
node "./Scripts/MakeUniversal.js" \
  --app-name="ExampleApp" \
  --publish-profile-osx-x64="publish-osx-x64" \
  --publish-profile-osx-arm64="publish-osx-arm64" \
  --sign-identity="Apple Development: Your Name (TEAMID)"
```

---

## 6. Using `MakeUniversal.config.json`

If you do not want to pass many switches every time, use the JSON config template.

### Template file

Start from:

- `Scripts/MakeUniversal.config.template.json`

You can also start from one of the target-specific examples:

- `Scripts/MakeUniversal.config.pkg.example.json`
- `Scripts/MakeUniversal.config.dmg.example.json`
- `Scripts/MakeUniversal.config.mas.example.json`

Copy it to one of these locations:

- `Scripts/MakeUniversal.config.json`
- `MakeUniversal.config.json`

or point to a custom file explicitly:

```zsh
node "./Scripts/MakeUniversal.js" --config="./Scripts/MakeUniversal.config.json"
```

### Resolution order

The script uses this precedence:

```text
command line switch > config file value > built-in default
```

That means you can keep a stable config file and still override individual values from the command line.

---

## 7. Config template structure

The template supports these main sections:

### Top-level fields

- `appName`
- `projectRoot`
- `buildCwd`
- `packaging.enabled`
- `installerIdentity`

### Publish profiles

```json
"publishProfiles": {
  "osxX64": "publish-osx-x64",
  "osxArm64": "publish-osx-arm64"
}
```

### Packaging

```json
"packaging": {
  "enabled": true
}
```

Set `enabled` to `false` when you want to skip creating the final `pkg` or `dmg` installer while still keeping the universal app build.

### PKG presentation

```json
"pkg": {
  "welcome": null,
  "license": null
}
```

Set these to `null` if unused, or to relative/absolute file paths.

### Notarization

```json
"notarization": {
  "enabled": true,
  "appleId": "your-apple-id@example.com",
  "appPassword": "xxxx-xxxx-xxxx-xxxx",
  "teamId": "TEAMID1234",
  "deleteZipOnSuccess": false
}
```

Set `enabled` to `false` when you want to keep app signing active but skip notarization.

### mac signing

```json
"macSigning": {
  "defaults": {
    "type": "distribution",
    "timestamp": "http://timestamp.apple.com/ts01",
    "gatekeeperAssess": false,
    "verbose": true,
    "extraOptions": {
      "identity-validation": false
    }
  },
  "targets": {
    "pkg": {
      "signIdentity": "Developer ID Application: Your Name (TEAMID)",
      "entitlements": "entitlements.mac.plist",
      "entitlementsInherit": "entitlements.mac.inherit.plist",
      "provisioningProfile": null,
      "hardenedRuntime": true,
      "extraOptions": {}
    }
  }
}
```

For `pkg` and `dmg`, `provisioningProfile` is optional. If your direct-distribution app needs Apple Services outside the App Store, use a Developer ID provisioning profile there.
For `mas` and `mas-dev`, a provisioning profile is normally required.

---

## 8. Identity and certificate inputs

`MakeUniversal.js` uses two different signing identity concepts:

### App signing identity

This is the identity used by `electron-osx-sign` to sign the universal `.app`.

You can provide it by:

- CLI:
  - `--sign-identity="<certificate name or hash>"`
- environment variable:
  - `SIGN_IDENTITY`
- config file:
  - `macSigning.targets.<target>.signIdentity`

Examples:

- `Apple Development: Your Name (TEAMID)`
- `Apple Distribution: Your Name (TEAMID)`
- `Developer ID Application: Your Name (TEAMID)`
- certificate SHA-1 hash if you prefer using the key hash instead of the display name

This identity is required for all signed app targets unless you use `--no-sign`.
The target-specific config location is important because `pkg` / `dmg`, `mas`, and `mas-dev` often need different Apple certificates.

### Installer signing identity

This is only used for final `pkg` installer signing with `productsign`.

You can provide it by:

- CLI:
  - `--installer-identity="<certificate name or hash>"`
- environment variable:
  - `INSTALLER_IDENTITY`
- config file:
  - `installerIdentity`

Examples:

- `Developer ID Installer: Your Name (TEAMID)`
- `3rd Party Mac Developer Installer: Your Name (TEAMID)`
- installer certificate SHA-1 hash

This identity is only required when:

- target = `pkg`
- signing is enabled

### Tiny identity cheat sheet

These common Apple certificate names usually map to the following purposes:

- `Developer ID Application` → app signing for direct distribution outside the Mac App Store
- `Developer ID Installer` → installer signing for direct-distribution `pkg` files
- `Apple Distribution` → App Store-style app signing, commonly used for `mas`
- `Apple Development` → local / development / test signing, commonly used for `mas-dev` or internal builds

For target-specific combinations, see [9. Common Apple certificate combinations by target](#9-common-apple-certificate-combinations-by-target).

### Identity precedence

The script resolves values in this order:

```text
CLI switch > config file value > environment variable (where supported) > built-in/default behavior
```

In practice:

- app signing identity:
  - CLI `--sign-identity`
  - config `macSigning.targets.<target>.signIdentity`
  - env `SIGN_IDENTITY`
- installer signing identity:
  - CLI `--installer-identity`
  - config `installerIdentity`
  - env `INSTALLER_IDENTITY`

### Which identity goes with which target?

- `pkg`
  - app identity signs the `.app`
  - installer identity signs the final `.pkg`
- `dmg`
  - app identity signs the `.app`
  - no installer identity is used because no `pkg` is produced
- `mas`
  - app identity signs the `.app`
  - no installer identity is used in this script
- `mas-dev`
  - app identity signs the `.app`
  - no installer identity is used in this script

### How to confirm what the script resolved

Use:

```zsh
node "./Scripts/MakeUniversal.js" \
  --config="./Scripts/MakeUniversal.config.json" \
  --print-effective-config
```

That output includes:

- `signing.identity`
- `signing.installerIdentity`
- resolved `osxSign` settings for the active target

### How to find your certificate names

On macOS, you can list available signing identities from your keychains with `security find-identity`.

List all code-signing identities:

```zsh
security find-identity -v -p codesigning
```

List identities from the login keychain only:

```zsh
security find-identity -v -p codesigning ~/Library/Keychains/login.keychain-db
```

If you want to filter for common certificate types, you can grep the output:

```zsh
security find-identity -v -p codesigning | grep -E "Developer ID|Apple Development|Apple Distribution|Installer"
```

The output usually includes:

- the certificate SHA-1 hash
- the human-readable certificate name

You can use either form with `MakeUniversal.js`:

- certificate name, for example `Developer ID Application: Your Name (TEAMID)`
- certificate hash, if you prefer using the key hash instead of the display name

---

## 9. Common Apple certificate combinations by target

The exact certificates Apple expects depend on your distribution channel. `MakeUniversal.js` does not hardcode the identity name, but these combinations are the most common starting points.

| Target | Common app signing certificate | Common installer signing certificate | Notarization | Typical entitlements / profile | Hardened runtime |
| --- | --- | --- | --- | --- | --- |
| `pkg` | `Developer ID Application` for direct distribution, or `Apple Development` for local/testing workflows | `Developer ID Installer` | Yes for direct distribution | `entitlements.mac.plist`, `entitlements.mac.inherit.plist`, optional Developer ID provisioning profile when Apple Services are needed | `true` |
| `dmg` | `Developer ID Application` for direct distribution, or `Apple Development` for local/testing workflows | Not applicable | Yes for direct distribution | `entitlements.mac.plist`, `entitlements.mac.inherit.plist`, optional Developer ID provisioning profile when Apple Services are needed | `true` |
| `mas` | `Apple Distribution` | Not applicable in this script because no installer is produced | No | `entitlements.mas.plist`, `entitlements.mas.inherit.plist`, App Store provisioning profile, `platform: "mas"` | `false` |
| `mas-dev` | `Apple Development` | Not applicable in this script because no installer is produced | No | `entitlements.mas.plist`, `entitlements.mas.inherit.plist`, development provisioning profile, `platform: "mas"`, `type: "development"` | `false` |

### Notes by target

#### `pkg`

Common direct-distribution combination:

- app signing: `Developer ID Application`
- installer signing: `Developer ID Installer`
- notarization: yes
- hardened runtime: `true`
- entitlements: `entitlements.mac.plist` + `entitlements.mac.inherit.plist`
- provisioning profile: optional Developer ID provisioning profile when Apple Services are needed

For local/internal testing, teams sometimes use `Apple Development` for the app identity, but that is not the usual public distribution setup.

#### `dmg`

Common direct-distribution combination:

- app signing: `Developer ID Application`
- installer signing: not applicable
- notarization: yes
- hardened runtime: `true`
- entitlements: `entitlements.mac.plist` + `entitlements.mac.inherit.plist`
- provisioning profile: optional Developer ID provisioning profile when Apple Services are needed

#### `mas`

Common App Store combination:

- app signing: `Apple Distribution`
- installer signing: not applicable in this script
- notarization: not part of this script’s MAS flow
- hardened runtime: `false`
- entitlements: `entitlements.mas.plist` + `entitlements.mas.inherit.plist`
- provisioning profile: App Store distribution profile
- platform: `mas`
- type: `distribution`

#### `mas-dev`

Common development / sandboxed test combination:

- app signing: `Apple Development`
- installer signing: not applicable in this script
- notarization: not part of this script’s MAS-dev flow
- hardened runtime: `false`
- entitlements: `entitlements.mas.plist` + `entitlements.mas.inherit.plist`
- provisioning profile: development profile
- platform: `mas`
- type: `development`

Use `--print-effective-config` to confirm what the script will actually use for the current target.

---

## 10. Advanced `electron-osx-sign` pass-through options

The config file also supports raw pass-through options for `electron-osx-sign`.

Use:

- `macSigning.defaults.extraOptions`
- `macSigning.targets.<target>.extraOptions`

Example:

```json
"macSigning": {
  "defaults": {
    "extraOptions": {
      "identity-validation": false
    }
  },
  "targets": {
    "pkg": {
      "extraOptions": {
        "strict-verify": false
      }
    }
  }
}
```

These values are passed to `electron-osx-sign`, but the script’s known structured options still take precedence.

---

## 11. Print the effective config

To see exactly what the script resolved after combining:

- CLI switches
- config file values
- defaults
- target-specific rules

run:

```zsh
node "./Scripts/MakeUniversal.js" \
  --config="./Scripts/MakeUniversal.config.json" \
  --print-effective-config
```

This prints the final normalized configuration and exits.

Notes:

- the notarization password is redacted
- this is useful for debugging target-specific `osx-sign` resolution

---

## 12. Notarization behavior

For `pkg` and `dmg`, the script notarizes the signed universal `.app` before packaging unless notarization has been disabled.

Flow:

1. sign the universal `.app`
2. zip the `.app`
3. submit to `xcrun notarytool`
4. wait for Apple’s response
5. staple the `.app`
6. validate the stapled `.app`
7. package the installer

If notarization fails:

- the zip is preserved
- the script prints a `xcrun notarytool log ...` command when it can determine the submission ID

If `--delete-notarize-zip` is used:

- the zip is deleted only after successful notarization and stapling

If you want signing to remain enabled but notarization to be skipped, use either:

- CLI:
  - `--no-notarization`
  - `--skip-notarization`
- config file:
  - `"notarization": { "enabled": false }`

If you want installer creation to be skipped, use either:

- CLI:
  - `--no-installer`
  - `--skip-installer`
- config file:
  - `"packaging": { "enabled": false }`

---

## 13. Output locations

The universal application is created under:

- `bin/Desktop/universal/`

Typical outputs include:

- `bin/Desktop/universal/<AppName>.app`
- `bin/Desktop/universal/<ProductName>-<version>.pkg`
- `bin/Desktop/universal/<ProductName>-<version>.dmg`

---

## 14. Troubleshooting

### Print resolved config

Use:

```zsh
node "./Scripts/MakeUniversal.js" --config="./Scripts/MakeUniversal.config.json" --print-effective-config
```

### Missing signing file

If you see an error like:

```text
Signing entitlements file not found: ...
```

check that the configured path is valid relative to the project root / `buildCwd`, or use an absolute path.

### Missing installer identity

If the target is `pkg`, installer creation is enabled, and signing is enabled, you must provide:

- `--installer-identity`

or set:

- `INSTALLER_IDENTITY`

### Notarization credentials incomplete

For `pkg` / `dmg` with signing enabled and notarization enabled, provide all three:

- `--notarize-apple-id`
- `--notarize-app-password`
- `--notarize-team-id`

or the corresponding environment variables.

### Top-level `signIdentity` no longer used in config templates

Use:

- `macSigning.targets.dmg.signIdentity`
- `macSigning.targets.pkg.signIdentity`
- `macSigning.targets.mas.signIdentity`
- `macSigning.targets.mas-dev.signIdentity`

If you have an older config file that still uses a top-level `signIdentity`, move that value into the active target block.

### PKG welcome / license ignored

`--pkg-welcome` and `--pkg-license` are only used when the active target is `pkg`.

### Installer creation intentionally skipped

If you use:

- `--no-installer`
- `--skip-installer`
- or `"packaging": { "enabled": false }`

the script will still build the universal `.app`, and it may still notarize/staple that `.app` for `pkg` / `dmg` targets unless notarization is also disabled.

### Hardened runtime mismatch

If the script errors about hardened runtime:

- use the correct value for the target
- check the resolved value with `--print-effective-config`

---

## 15. Recommended workflow

### Option A: CLI-only

Use this when you want full control per run.

### Option B: Config-driven

1. Copy the template:

```zsh
cp "Scripts/MakeUniversal.config.template.json" "Scripts/MakeUniversal.config.json"
```

2. Edit the file for your identities, profiles, signing settings, and notarization info.

3. Validate the resolved config:

```zsh
node "./Scripts/MakeUniversal.js" --config="./Scripts/MakeUniversal.config.json" --print-effective-config
```

4. Run the real build:

```zsh
node "./Scripts/MakeUniversal.js" --config="./Scripts/MakeUniversal.config.json"
```

---

## 16. Summary

Use `Scripts/MakeUniversal.js` when you need a repeatable macOS release pipeline that can:

- build a universal app
- sign it correctly for the selected target
- notarize and staple it when needed
- package it as `pkg` or `dmg`
- sign the final `pkg`
- be driven either from CLI switches or from a reusable JSON config file


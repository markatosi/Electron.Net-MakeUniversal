# MakeUniversal Guide

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
- [8. Common Apple certificate combinations by target](#8-common-apple-certificate-combinations-by-target)
- [9. Advanced `electron-osx-sign` pass-through options](#9-advanced-electron-osx-sign-pass-through-options)
- [10. Print the effective config](#10-print-the-effective-config)
- [11. Notarization behavior](#11-notarization-behavior)
- [12. Output locations](#12-output-locations)
- [13. Troubleshooting](#13-troubleshooting)
- [14. Recommended workflow](#14-recommended-workflow)
- [15. Summary](#15-summary)

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
- `--sign-identity` unless `--no-sign` is used

If the target is `pkg` and signing is enabled, it also needs:

- `--installer-identity`

If the target is `pkg` or `dmg` and signing is enabled, it also needs notarization credentials:

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
- `signIdentity`
- `installerIdentity`

### Publish profiles

```json
"publishProfiles": {
  "osxX64": "publish-osx-x64",
  "osxArm64": "publish-osx-arm64"
}
```

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
  "appleId": "your-apple-id@example.com",
  "appPassword": "xxxx-xxxx-xxxx-xxxx",
  "teamId": "TEAMID1234",
  "deleteZipOnSuccess": false
}
```

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
      "entitlements": "entitlements.mac.plist",
      "entitlementsInherit": "entitlements.mac.inherit.plist",
      "hardenedRuntime": true,
      "extraOptions": {}
    }
  }
}
```

---

## 8. Common Apple certificate combinations by target

The exact certificates Apple expects depend on your distribution channel. `MakeUniversal.js` does not hardcode the identity name, but these combinations are the most common starting points.

| Target | Common app signing certificate | Common installer signing certificate | Notarization | Typical entitlements / profile | Hardened runtime |
| --- | --- | --- | --- | --- | --- |
| `pkg` | `Developer ID Application` for direct distribution, or `Apple Development` for local/testing workflows | `Developer ID Installer` | Yes for direct distribution | `entitlements.mac.plist`, `entitlements.mac.inherit.plist`, usually no provisioning profile | `true` |
| `dmg` | `Developer ID Application` for direct distribution, or `Apple Development` for local/testing workflows | Not applicable | Yes for direct distribution | `entitlements.mac.plist`, `entitlements.mac.inherit.plist`, usually no provisioning profile | `true` |
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
- provisioning profile: usually not needed

For local/internal testing, teams sometimes use `Apple Development` for the app identity, but that is not the usual public distribution setup.

#### `dmg`

Common direct-distribution combination:

- app signing: `Developer ID Application`
- installer signing: not applicable
- notarization: yes
- hardened runtime: `true`
- entitlements: `entitlements.mac.plist` + `entitlements.mac.inherit.plist`
- provisioning profile: usually not needed

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

## 9. Advanced `electron-osx-sign` pass-through options

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

## 10. Print the effective config

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

## 11. Notarization behavior

For `pkg` and `dmg`, the script notarizes the signed universal `.app` before packaging.

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

---

## 12. Output locations

The universal application is created under:

- `bin/Desktop/universal/`

Typical outputs include:

- `bin/Desktop/universal/<AppName>.app`
- `bin/Desktop/universal/<ProductName>-<version>.pkg`
- `bin/Desktop/universal/<ProductName>-<version>.dmg`

---

## 13. Troubleshooting

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

If the target is `pkg` and signing is enabled, you must provide:

- `--installer-identity`

or set:

- `INSTALLER_IDENTITY`

### Notarization credentials incomplete

For `pkg` / `dmg` with signing enabled, provide all three:

- `--notarize-apple-id`
- `--notarize-app-password`
- `--notarize-team-id`

or the corresponding environment variables.

### PKG welcome / license ignored

`--pkg-welcome` and `--pkg-license` are only used when the active target is `pkg`.

### Hardened runtime mismatch

If the script errors about hardened runtime:

- use the correct value for the target
- check the resolved value with `--print-effective-config`

---

## 14. Recommended workflow

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

## 15. Summary

Use `Scripts/MakeUniversal.js` when you need a repeatable macOS release pipeline that can:

- build a universal app
- sign it correctly for the selected target
- notarize and staple it when needed
- package it as `pkg` or `dmg`
- sign the final `pkg`
- be driven either from CLI switches or from a reusable JSON config file


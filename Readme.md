# MakeUniversal Release Notes for users of Electron.Net

This is the short release-oriented summary for `Scripts/MakeUniversal.js`.

For the full guide, examples, config reference, troubleshooting, and certificate notes, see:

- [`README-MakeUniversal.md`](README-MakeUniversal.md)

---

## What MakeUniversal does

`Scripts/MakeUniversal.js` can:

- build `osx-x64` and `osx-arm64`
- merge them into one universal `.app`
- sign the universal `.app` with `electron-osx-sign`
- notarize and staple the `.app` for `pkg` / `dmg` targets
- package native macOS installers:
  - `pkg` via `pkgbuild` / `productbuild`
  - `dmg` via `hdiutil`
- build multiple installer targets in one run, such as `pkg` + `dmg`
- sign the final `pkg` installer with `productsign`
- use either command-line switches or a JSON config file

---

## Quick start

At minimum, the script needs:

- `--app-name`
- `--publish-profile-osx-x64`
- `--publish-profile-osx-arm64`
- a signing identity for the primary configured target unless `--no-sign` is used

For runs where `pkg` is among the installer targets and installer creation is enabled, it also needs:

- `--installer-identity`

For runs where one or more installer targets are present (`pkg` / `dmg`), signing is enabled, and notarization is enabled, it also needs notarization credentials:

- `--notarize-apple-id`
- `--notarize-app-password`
- `--notarize-team-id`

Example:

```zsh
node "./Scripts/MakeUniversal.js" \
  --app-name="ExampleApp" \
  --publish-profile-osx-x64="publish-osx-x64" \
  --publish-profile-osx-arm64="publish-osx-arm64" \
  --sign-identity="Apple Development: Your Name (TEAMID)"
```

Example with multiple installer targets configured in `Properties/electron-builder.json`:

```json
{
  "mac": {
    "target": [
      "pkg",
      "dmg"
    ]
  }
}
```

```zsh
node "./Scripts/MakeUniversal.js" \
  --app-name="ExampleApp" \
  --publish-profile-osx-x64="publish-osx-x64" \
  --publish-profile-osx-arm64="publish-osx-arm64" \
  --sign-identity="Developer ID Application: Your Name (TEAMID)" \
  --installer-identity="Developer ID Installer: Your Name (TEAMID)" \
  --notarize-apple-id="your-apple-id@example.com" \
  --notarize-app-password="xxxx-xxxx-xxxx-xxxx" \
  --notarize-team-id="TEAMID1234"
```

That single run signs and notarizes the universal `.app` once, then creates both installers.

---

## Config file support

You can avoid passing a large number of switches by copying:

- `Scripts/MakeUniversal.config.template.json`

to either:

- `Scripts/MakeUniversal.config.json`
- `MakeUniversal.config.json`

or by pointing to a custom file:

```zsh
node "./Scripts/MakeUniversal.js" --config="./Scripts/MakeUniversal.config.json"
```

Precedence is:

```text
command line switch > config file value > built-in default
```

You can inspect the fully resolved config with:

```zsh
node "./Scripts/MakeUniversal.js" \
  --config="./Scripts/MakeUniversal.config.json" \
  --print-effective-config
```

Target-specific example configs are also available:

- `Scripts/MakeUniversal.config.pkg-dmg.example.json`
- `Scripts/MakeUniversal.config.pkg.example.json`
- `Scripts/MakeUniversal.config.dmg.example.json`
- `Scripts/MakeUniversal.config.mas.example.json`

Recommended starting point for direct distribution:

- copy `Scripts/MakeUniversal.config.pkg-dmg.example.json`
- set `Properties/electron-builder.json` `mac.target` to both `"pkg"` and `"dmg"`

The main template file, `Scripts/MakeUniversal.config.template.json`, also already contains both `macSigning.targets.pkg` and `macSigning.targets.dmg`, so it can be used as a generic multi-target starter as well.

If multiple installer targets are configured, `MakeUniversal.js` uses the first configured target as the primary signing target when resolving `macSigning.targets.<target>` values for the universal `.app` signing step.

---

## Common Apple certificate combinations by target

These are practical starting points. The exact certificates Apple expects still depend on your distribution channel.

| Target | Common app signing certificate | Common installer signing certificate | Notarization | Hardened runtime |
| --- | --- | --- | --- | --- |
| `pkg` | `Developer ID Application` for direct distribution, or `Apple Development` for local/testing | `Developer ID Installer` | Yes for direct distribution | `true` |
| `dmg` | `Developer ID Application` for direct distribution, or `Apple Development` for local/testing | Not applicable | Yes for direct distribution | `true` |
| `mas` | `Apple Distribution` | Not applicable in this script | No | `false` |
| `mas-dev` | `Apple Development` | Not applicable in this script | No | `false` |

For `pkg` and `dmg`, a Developer ID provisioning profile is optional but may be needed when the app uses Apple Services outside the App Store. For `mas` and `mas-dev`, provisioning profiles are normally required.

For the full target-by-target explanation, see the certificate section in:

- [`README-MakeUniversal.md`](README-MakeUniversal.md)

---

## Additional features

`MakeUniversal.js` also supports:

- optional `pkg` welcome / license resources
- native notarization + stapling before packaging
- one notarization pass before building multiple installer outputs such as `pkg` + `dmg`
- `--no-installer` / `--skip-installer` to skip final installer creation while keeping the universal app build
- `--no-notarization` / `--skip-notarization` to keep signing enabled while skipping notarization
- target-aware `electron-osx-sign` settings
- JSON pass-through `electron-osx-sign` `extraOptions`

The JSON config also supports:

- `"packaging": { "enabled": false }`

to skip creating the final `pkg` / `dmg` installer.

The JSON config now stores app signing identities per target under:

- `macSigning.targets.dmg.signIdentity`
- `macSigning.targets.pkg.signIdentity`
- `macSigning.targets.mas.signIdentity`
- `macSigning.targets.mas-dev.signIdentity`

Current multi-target support is intended for installer-style combinations that share the same Electron.NET output directory family, such as `pkg` + `dmg`. Mixed combinations such as `pkg` + `mas` are not supported.

---

## Read the full guide

For the full documentation, use:

- [`README-MakeUniversal.md`](README-MakeUniversal.md)


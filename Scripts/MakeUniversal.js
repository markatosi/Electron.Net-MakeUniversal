/*
MARKNET TECHNOLOGIES, LLC
Copyright (c)  2023 - 2026 MARKNET TECHNOLOGIES, LLC
ALL RIGHTS RESERVED
LICENSE: MIT
*/

import path from 'path';
import {pathToFileURL} from 'url';
import fs from 'fs/promises';
import {existsSync} from 'fs';
import {spawn} from 'child_process';
import {createRequire} from 'module';

function getFirstDefined(...values) {
    for (const value of values) {
        if (value !== undefined && value !== null && value !== '') {
            return value;
        }
    }
    return null;
}

function resolvePathFromBase(baseDir, targetPath) {
    if (!targetPath) return null;
    return path.isAbsolute(targetPath)
        ? path.resolve(targetPath)
        : path.resolve(baseDir, targetPath);
}

function getConfigValue(obj, pathParts) {
    let current = obj;
    for (const part of pathParts) {
        if (current == null || typeof current !== 'object' || !(part in current)) {
            return undefined;
        }
        current = current[part];
    }
    return current;
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function redactSecret(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    return '***';
}

function parseBooleanish(value, description) {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    if (typeof value === 'boolean') {
        return value;
    }

    const normalized = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
        return true;
    }
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
        return false;
    }

    throw new Error(`${description} must be a boolean value (true/false). Received: ${value}`);
}

async function loadMakeUniversalConfig(baseDir, explicitConfigPath) {
    const candidates = explicitConfigPath
        ? [resolvePathFromBase(baseDir, explicitConfigPath)]
        : [
            path.join(baseDir, 'Scripts', 'MakeUniversal.config.json'),
            path.join(baseDir, 'MakeUniversal.config.json'),
        ];

    for (const candidate of candidates) {
        if (!candidate) continue;
        if (!existsSync(candidate)) {
            if (explicitConfigPath) {
                throw new Error(`MakeUniversal config file not found: ${candidate}`);
            }
            continue;
        }

        const raw = await fs.readFile(candidate, 'utf8');
        let config;
        try {
            config = JSON.parse(raw);
        } catch (e) {
            throw new Error(`Failed to parse MakeUniversal config file at ${candidate}: ${e.message}`);
        }

        return {
            config,
            configPath: candidate,
            configDir: path.dirname(candidate),
        };
    }

    return {
        config: null,
        configPath: null,
        configDir: baseDir,
    };
}

function findProjectRootByCsproj(startDir, csprojName) {
    if (!csprojName) return null;
    const candidateFile = csprojName.endsWith('.csproj') ? csprojName : `${csprojName}.csproj`;
    let dir = startDir;
    const root = path.parse(dir).root;
    while (dir !== root) {
        if (existsSync(path.join(dir, candidateFile))) {
            return dir;
        }
        dir = path.dirname(dir);
    }
    return null;
}

function getFirstPositionalPath() {
    const argv = process.argv.slice(2);
    for (const arg of argv) {
        if (arg === '--') continue;
        if (arg.startsWith('-')) continue; // skip flags and --flag=value forms
        // accept if it contains a path separator, looks relative/absolute, or exists on disk
        if (arg.includes(path.sep) || arg.startsWith('.') || arg.startsWith('~') || existsSync(arg)) {
            return arg;
        }
    }
    return null;
}

const cliConfigPath = getFlagValue(['--config', '--make-universal-config']);
const printEffectiveConfig = process.argv.includes('--print-effective-config');
const firstPositionalPath = getFirstPositionalPath();
const bootstrapBaseDir = path.resolve(process.env.APP_BASE_DIR || firstPositionalPath || process.cwd());
const {
    config: makeUniversalConfig,
    configPath: makeUniversalConfigPath,
    configDir: makeUniversalConfigDir,
} = await loadMakeUniversalConfig(bootstrapBaseDir, cliConfigPath);

const cliAppName = getFirstDefined(
    getFlagValue(['--app-name']),
    getConfigValue(makeUniversalConfig, ['appName']),
    getConfigValue(makeUniversalConfig, ['app', 'name'])
);
const explicitPath = getFirstDefined(
    process.env.APP_BASE_DIR,
    firstPositionalPath,
    getConfigValue(makeUniversalConfig, ['projectRoot'])
);
const projectRoot =
    explicitPath ? resolvePathFromBase(makeUniversalConfigDir, explicitPath) : findProjectRootByCsproj(process.cwd(), cliAppName) || null;

console.log("this is the root " + projectRoot);
if (makeUniversalConfigPath) {
    console.log(`Using MakeUniversal config file: ${makeUniversalConfigPath}`);
}
if (!projectRoot) {
    console.error('Error: Could not determine project root by locating the application .csproj.');
    console.error('Provide the app with --app-name=<AppName> and ensure `<AppName>.csproj` is in a parent directory,');
    console.error('or set APP_BASE_DIR or pass an explicit path as the first positional argument.');
    process.exit(1);
}

// buildCwd (must be inside projectRoot)
const buildCwd = resolvePathFromBase(
    makeUniversalConfigDir,
    getFirstDefined(process.env.APP_BUILD_CWD, getConfigValue(makeUniversalConfig, ['buildCwd']), projectRoot)
);
if (!isPathInside(projectRoot, buildCwd) && buildCwd !== projectRoot) {
    throw new Error(`APP_BUILD_CWD must be inside the project root. Resolved: ${buildCwd}`);
}

// Accept basenames (with or without `.pubxml`) located in `buildCwd/Properties/PublishProfiles`
const cliProfileX64 = getFirstDefined(
    getFlagValue(['--publish-profile-osx-x64']),
    getConfigValue(makeUniversalConfig, ['publishProfiles', 'osxX64']),
    getConfigValue(makeUniversalConfig, ['publishProfileOsxX64'])
);
const cliProfileArm = getFirstDefined(
    getFlagValue(['--publish-profile-osx-arm64']),
    getConfigValue(makeUniversalConfig, ['publishProfiles', 'osxArm64']),
    getConfigValue(makeUniversalConfig, ['publishProfileOsxArm64'])
);
const cliIdentityOverride = getFlagValue(['--sign-identity', '--identity']);

// Installer certificate for PKG signing — separate from the app-bundle codesign identity.
// Supply via --installer-identity=<cert> or the INSTALLER_IDENTITY environment variable.
const cliInstallerIdentity = getFirstDefined(
    getFlagValue(['--installer-identity']),
    getConfigValue(makeUniversalConfig, ['installerIdentity'])
);

// Optional PKG presentation resources. When supplied, the script switches from a plain
// pkgbuild component package to a pkgbuild + productbuild distribution package so the
// installer can show welcome/license screens.
const cliPkgWelcome = getFirstDefined(
    getFlagValue(['--pkg-welcome', '--installer-welcome']),
    getConfigValue(makeUniversalConfig, ['pkg', 'welcome'])
);
const cliPkgLicense = getFirstDefined(
    getFlagValue(['--pkg-license', '--installer-license']),
    getConfigValue(makeUniversalConfig, ['pkg', 'license'])
);

// Notarization credentials are only used for dmg/pkg targets and only after the
// universal .app has been signed.
const cliNotaryAppleId = getFirstDefined(
    getFlagValue(['--notarize-apple-id', '--apple-id', '--notary-apple-id']),
    getConfigValue(makeUniversalConfig, ['notarization', 'appleId'])
);
const cliNotaryPassword = getFirstDefined(
    getFlagValue(['--notarize-app-password', '--apple-password', '--app-password', '--notary-password']),
    getConfigValue(makeUniversalConfig, ['notarization', 'appPassword']),
    getConfigValue(makeUniversalConfig, ['notarization', 'password'])
);
const cliNotaryTeamId = getFirstDefined(
    getFlagValue(['--notarize-team-id', '--team-id', '--notary-team-id']),
    getConfigValue(makeUniversalConfig, ['notarization', 'teamId'])
);
const configPackagingEnabled = parseBooleanish(
    getConfigValue(makeUniversalConfig, ['packaging', 'enabled']),
    'packaging.enabled'
);
const skipInstaller =
    process.argv.includes('--no-installer') ||
    process.argv.includes('--skip-installer') ||
    configPackagingEnabled === false;
const configNotarizationEnabled = parseBooleanish(
    getConfigValue(makeUniversalConfig, ['notarization', 'enabled']),
    'notarization.enabled'
);
const skipNotarization =
    process.argv.includes('--no-notarization') ||
    process.argv.includes('--skip-notarization') ||
    configNotarizationEnabled === false;
const deleteNotarizationZipOnSuccess =
    process.argv.includes('--delete-notarize-zip') ||
    process.argv.includes('--delete-notarization-zip') ||
    parseBooleanish(getConfigValue(makeUniversalConfig, ['notarization', 'deleteZipOnSuccess']), 'notarization.deleteZipOnSuccess') ||
    false;

const cliSignEntitlements = getFlagValue(['--sign-entitlements', '--entitlements']);
const cliSignEntitlementsInherit = getFlagValue(['--sign-entitlements-inherit', '--entitlements-inherit']);
const cliSignProvisioningProfile = getFlagValue(['--sign-provisioning-profile', '--provisioning-profile']);
const cliSignPlatform = getFlagValue(['--sign-platform', '--platform']);
const cliSignType = getFlagValue(['--sign-type', '--type']);
const cliSignTimestamp = getFlagValue(['--sign-timestamp', '--timestamp']);
const cliSignHardenedRuntime = getFlagValue(['--sign-hardened-runtime', '--hardened-runtime']);
const cliSignGatekeeperAssess = getFlagValue(['--sign-gatekeeper-assess', '--gatekeeper-assess']);
const cliSignVerbose = getFlagValue(['--sign-verbose', '--verbose']);
const envIdentity = process.env.SIGN_IDENTITY;
const notaryAppleId = cliNotaryAppleId || process.env.APPLE_ID || null;
const notaryPassword = cliNotaryPassword || process.env.NOTARIZE_PASSWORD || null;
const notaryTeamId = cliNotaryTeamId || process.env.NOTARIZE_TEAM_ID || null;
const profilesDir = path.resolve(buildCwd, 'Properties', 'PublishProfiles');
const skipSign = process.argv.includes('--no-sign') || process.argv.includes('--skip-sign');

// Require an explicit app name
if (!cliAppName) {
    console.error('Error: The --app-name switch is required. The name of your app is the project file (.csproj)');
    console.error('Usage: node `./MakeUniversal.js` --app-name=<AppName> --publish-profile-osx-x64=<profile> --publish-profile-osx-arm64=<profile> --sign-identity=<identity> (or set SIGN_IDENTITY in env)');
    process.exit(1);
}

// Require both publish profile switches
if (!cliProfileX64 || !cliProfileArm) {
    console.error('Error: Both --publish-profile-osx-x64 and --publish-profile-osx-arm64 must be provided.');
    console.error('Usage: node `.MakeUniversal.js` --publish-profile-osx-x64=<profile-basename> --publish-profile-osx-arm64=<profile-basename> [other options]');
    console.error('Place the `.pubxml` files in `Properties/PublishProfiles` and pass only the file basenames (with or without the `.pubxml` extension).');
    process.exit(1);
}

/**
 * Read all values of a flag from process.argv.
 * Accepts forms: --flag=value (multiple) or --flag value (multiple).
 * Returns an array of all values found.
 */
function getFlagValues(names) {
    const argv = process.argv.slice(2);
    const result = [];
    for (let i = 0; i < argv.length; i++) {
        for (const name of names) {
            if (argv[i] === name && argv[i + 1] !== undefined) {
                result.push(argv[i + 1]);
                i++;
            } else if (argv[i].startsWith(`${name}=`)) {
                result.push(argv[i].split('=', 2)[1]);
            }
        }
    }
    return result;
}

// Collect arbitrary extra dotnet publish arguments
const extraDotnetArgs = getFlagValues(['--dotnet-arg']);

function isPathInside(base, target) {
    const rel = path.relative(base, target);
    if (rel === '') return true; // same path
    return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Read a flag value from process.argv.
 * Accepts forms: --flag=value  or  --flag value
 */
function getFlagValue(names) {
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        for (const name of names) {
            if (argv[i] === name && argv[i + 1]) {
                return argv[i + 1];
            }
            if (argv[i].startsWith(`${name}=`)) {
                return argv[i].split('=')[1];
            }
        }
    }
    return null;
}

// ensure projectRoot is absolute and exists
if (!existsSync(projectRoot)) {
    throw new Error(`Project root does not exist: ${projectRoot}`);
}

async function validatePublishProfile(nameOrNull, expectedRuntime) {
    if (!nameOrNull) return null;

    // Reject paths; only accept a basename (with or without .pubxml)
    if (path.isAbsolute(nameOrNull) || nameOrNull.includes(path.sep) || nameOrNull.includes('/') || nameOrNull.includes('\\')) {
        throw new Error(`Publish profile must be a file name (not a path). Place the file in \`${path.join('Properties', 'PublishProfiles')}\` and pass only the file name.`);
    }

    const candidateFile = nameOrNull.endsWith('.pubxml') ? nameOrNull : `${nameOrNull}.pubxml`;
    const fullPath = path.join(profilesDir, candidateFile);
    if (!existsSync(fullPath)) {
        throw new Error(`Publish profile not found: \`${fullPath}\`. Make sure the file exists in \`${path.join('Properties', 'PublishProfiles')}\`.`);
    }

    const xml = await fs.readFile(fullPath, 'utf8');

    // Validate runtime identifier
    const m = xml.match(/<RuntimeIdentifier>\s*([^<\s]+)\s*<\/RuntimeIdentifier>/i);
    if (!m) {
        throw new Error(`No <RuntimeIdentifier> element found in \`${fullPath}\`.`);
    }
    const actual = m[1].trim();
    if (actual !== expectedRuntime) {
        throw new Error(`Publish profile \`${candidateFile}\` has RuntimeIdentifier='${actual}', expected '${expectedRuntime}'.`);
    }

    // Extract PublishUrl (treat as a file path)
    const u = xml.match(/<PublishUrl>\s*([^<]+?)\s*<\/PublishUrl>/i);
    const publishUrlRaw = u ? u[1].trim() : null;

    // Resolve publish path: absolute stays absolute, relative resolves against buildCwd
    let publishPath = null;
    if (publishUrlRaw) {
        publishPath = path.isAbsolute(publishUrlRaw)
            ? path.resolve(publishUrlRaw)
            : path.resolve(buildCwd, publishUrlRaw);

        // Normalize (remove trailing sep)
        if (publishPath.endsWith(path.sep)) publishPath = publishPath.slice(0, -1);

        // Warn if resolved outside project root
        if (!isPathInside(projectRoot, publishPath) && publishPath !== projectRoot) {
            console.warn(`Warning: Publish path for profile \`${candidateFile}\` resolves outside project root: ${publishPath}`);
        }

        // It's ok if the path does not yet exist (publish may create it) — just warn
        if (!existsSync(publishPath)) {
            console.warn(`Publish path does not exist (yet): ${publishPath}`);
        }
    }

    return {
        name: path.parse(candidateFile).name,
        publishUrlRaw,   // original value from the .pubxml (e.g. "bin/Desktop/x86/")
        publishPath,     // resolved absolute file path (or null)
        fullPath
    };
}

function resolveOptionalInputFilePath(filePathOrNull, description) {
    if (!filePathOrNull) return null;

    const resolved = path.isAbsolute(filePathOrNull)
        ? path.resolve(filePathOrNull)
        : path.resolve(buildCwd, filePathOrNull);

    if (!existsSync(resolved)) {
        throw new Error(`${description} file not found: ${resolved}`);
    }

    return resolved;
}

function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * Reads and parses Properties/electron-builder.json from the project root.
 * Returns the full parsed config object.
 */
async function readElectronBuilderConfig() {
    const configPath = path.join(projectRoot, 'Properties', 'electron-builder.json');
    if (!existsSync(configPath)) {
        throw new Error(`electron-builder.json not found at: ${configPath}`);
    }
    const raw = await fs.readFile(configPath, 'utf8');
    try {
        return JSON.parse(raw);
    } catch (e) {
        throw new Error(`Failed to parse electron-builder.json: ${e.message}`);
    }
}

/**
 * Reads Properties/electron-builder.json from the project root and returns:
 * {
 *   targetNames,          // all configured target strings in declared order
 *   primaryTargetName,    // the first configured target
 *   installerTargetNames, // installer-style targets among targetNames
 *   dirName               // publish output directory family used by Electron.NET
 * }
 *
 * Supported multi-target mode is limited to installer-style targets that share the
 * same publish output directory family (e.g. pkg + dmg => mac / mac-arm64).
 */
async function readMacTargets() {
    const config = await readElectronBuilderConfig();
    const macTarget = config?.mac?.target;
    if (!macTarget) {
        throw new Error('No mac.target found in Properties/electron-builder.json.');
    }

    const rawTargets = Array.isArray(macTarget) ? macTarget : [macTarget];
    const targetNames = rawTargets
        .map(t => typeof t === 'string' ? t : t?.target)
        .filter(t => typeof t === 'string');

    if (targetNames.length === 0) {
        throw new Error(`Could not resolve any target strings from mac.target in electron-builder.json. Got: ${JSON.stringify(macTarget)}`);
    }

    // electron-builder uses "mac" / "mac-arm64" as the output directory names
    // for installer-style targets; channel-style targets use their own name.
    const installerTargets = new Set(['dmg', 'pkg', 'zip', 'tar.gz']);
    const installerTargetNames = targetNames.filter(targetName => installerTargets.has(targetName));
    const nonInstallerTargetNames = targetNames.filter(targetName => !installerTargets.has(targetName));

    if (targetNames.length > 1) {
        if (installerTargetNames.length > 0 && nonInstallerTargetNames.length > 0) {
            throw new Error(
                `Unsupported mac.target combination in electron-builder.json: ${targetNames.join(', ')}. ` +
                'Mixing installer targets (pkg/dmg/zip/tar.gz) with channel-style targets (mas/mas-dev/...) is not supported by MakeUniversal.js.'
            );
        }

        if (nonInstallerTargetNames.length > 1) {
            throw new Error(
                `Unsupported mac.target combination in electron-builder.json: ${targetNames.join(', ')}. ` +
                'Multiple channel-style targets are not supported by MakeUniversal.js.'
            );
        }
    }

    const primaryTargetName = targetNames[0];
    const dirName = installerTargets.has(primaryTargetName) ? 'mac' : primaryTargetName;

    return {
        targetNames,
        primaryTargetName,
        installerTargetNames,
        dirName,
    };
}

const profileX64 = await validatePublishProfile(cliProfileX64, 'osx-x64'); // null or {name, publishUrlRaw, publishPath, fullPath}
const profileArm = await validatePublishProfile(cliProfileArm, 'osx-arm64');

const publishProfileOsxX64Name = profileX64 ? profileX64.name : null;
const publishProfileOsxArmName = profileArm ? profileArm.name : null;

const publishPathX64 = profileX64 ? profileX64.publishPath : null;
const publishPathArm = profileArm ? profileArm.publishPath : null;
const pkgWelcomePath = resolveOptionalInputFilePath(cliPkgWelcome, 'PKG welcome');
const pkgLicensePath = resolveOptionalInputFilePath(cliPkgLicense, 'PKG license');

if (profileX64) {
    console.log(`Using publish profile for osx-x64: ${path.join('Properties', 'PublishProfiles', profileX64.name + '.pubxml')}`);
    console.log(`  Publish path: ${publishPathX64 || '<none>'} (raw: ${profileX64.publishUrlRaw || '<none>'})`);
}
if (profileArm) {
    console.log(`Using publish profile for osx-arm64: ${path.join('Properties', 'PublishProfiles', profileArm.name + '.pubxml')}`);
    console.log(`  Publish path: ${publishPathArm || '<none>'} (raw: ${profileArm.publishUrlRaw || '<none>'})`);
}
if (pkgWelcomePath) {
    console.log(`Using PKG welcome resource: ${pkgWelcomePath}`);
}
if (pkgLicensePath) {
    console.log(`Using PKG license resource: ${pkgLicensePath}`);
}

// Publish URLs were paths; variables available for later use:
//  - publishPathX64
//  - publishPathArm

const appBundleName = cliAppName.endsWith('.app') ? cliAppName : `${cliAppName}.app`;

// Require publish paths from the provided publish profiles; quit if missing
if (!publishPathX64) {
    console.error('Error: PublishUrl is empty for the osx-x64 publish profile. Provide a `PublishUrl` in `Properties/PublishProfiles/<profile>.pubxml` and re-run.');
    process.exit(1);
}
if (!publishPathArm) {
    console.error('Error: PublishUrl is empty for the osx-arm64 publish profile. Provide a `PublishUrl` in `Properties/PublishProfiles/<profile>.pubxml` and re-run.');
    process.exit(1);
}

// Read the mac target from electron-builder.json — drives the output directory names
// and determines whether a post-merge installer package should be produced.
const macTarget = await readMacTargets();
console.log(`Mac targets (from Properties/electron-builder.json): targetNames=${macTarget.targetNames.join(', ')}, primaryTargetName=${macTarget.primaryTargetName}, dirName=${macTarget.dirName}`);
const packagingTargets = new Set(['dmg', 'pkg']);
const shouldCreateInstaller = macTarget.installerTargetNames.length > 0 && !skipInstaller;
const configTargetSignIdentity = getConfigValue(makeUniversalConfig, ['macSigning', 'targets', macTarget.primaryTargetName, 'signIdentity']);
const legacyConfigIdentity = getConfigValue(makeUniversalConfig, ['signIdentity']);
const identity = getFirstDefined(cliIdentityOverride, configTargetSignIdentity, legacyConfigIdentity, envIdentity);
const shouldNotarizeApp = macTarget.installerTargetNames.length > 0 && !skipSign && !skipNotarization;

if (!printEffectiveConfig && !skipSign && !identity) {
    console.error(`Error: No signing identity was resolved for target "${macTarget.primaryTargetName}".`);
    console.error('Supply it via one of:');
    console.error('  --sign-identity="<identity>"');
    console.error('  SIGN_IDENTITY="<identity>"');
    console.error(`  macSigning.targets.${macTarget.primaryTargetName}.signIdentity   (MakeUniversal config file)`);
    console.error('');
    console.error('For target-aware config, prefer setting signIdentity inside the active target definition.');
    console.error('To skip all signing (and therefore notarization) pass --no-sign.');
    process.exit(1);
}

if (legacyConfigIdentity && !cliIdentityOverride && !configTargetSignIdentity) {
    console.warn('Warning: Top-level MakeUniversal config property `signIdentity` is deprecated. Move it to macSigning.targets.<target>.signIdentity.');
}

// Early validation: PKG target requires an installer identity for signing.
// Fail before the builds start (which can take many minutes) rather than at the end.
if (macTarget.installerTargetNames.includes('pkg') && shouldCreateInstaller && !skipSign && !printEffectiveConfig) {
    const installerIdentity = cliInstallerIdentity || process.env.INSTALLER_IDENTITY;
    if (!installerIdentity) {
        console.error('Error: The target is "pkg" but no installer certificate identity was provided.');
        console.error('PKG installers must be signed with a dedicated Installer certificate — this is');
        console.error('separate from the app-bundle codesign identity (--sign-identity).');
        console.error('');
        console.error('Supply the installer certificate via one of:');
        console.error('  --installer-identity="3rd Party Mac Developer Installer: Your Name (TEAMID)"');
        console.error('  --installer-identity="Developer ID Installer: Your Name (TEAMID)"');
        console.error('  INSTALLER_IDENTITY="<cert>"   (environment variable)');
        console.error('');
        console.error('You may also use the certificate hash instead of its name.');
        console.error('To skip all signing (e.g. for a local test build) pass --no-sign.');
        process.exit(1);
    }
}
if (shouldNotarizeApp && !printEffectiveConfig) {
    if (!notaryAppleId || !notaryPassword || !notaryTeamId) {
        console.error(`Error: The installer targets are "${macTarget.installerTargetNames.join(', ')}" but notarization credentials are incomplete.`);
        console.error('dmg/pkg builds require notarization of the signed universal .app before packaging.');
        console.error('');
        console.error('Supply all values via switches:');
        console.error('  --notarize-apple-id="<your-apple-id>"');
        console.error('  --notarize-app-password="<app-specific-password>"');
        console.error('  --notarize-team-id="<team-id>"');
        console.error('');
        console.error('Environment variable fallbacks are also supported:');
        console.error('  APPLE_ID, NOTARIZE_PASSWORD, NOTARIZE_TEAM_ID');
        console.error('');
        console.error('To skip signing/notarization for a local build, pass --no-sign.');
        process.exit(1);
    }
}
if (!macTarget.installerTargetNames.includes('pkg') && (pkgWelcomePath || pkgLicensePath)) {
    console.warn('Warning: --pkg-welcome / --pkg-license were provided, but "pkg" is not among the current mac targets. These resources will be ignored.');
}
if (macTarget.installerTargetNames.length === 0 && (cliNotaryAppleId || cliNotaryPassword || cliNotaryTeamId || deleteNotarizationZipOnSuccess)) {
    console.warn('Warning: notarization switches were provided, but none of the current mac targets are installer targets ("pkg" / "dmg"). These notarization options will be ignored.');
}
if (macTarget.installerTargetNames.length > 0 && !skipSign && skipNotarization) {
    console.log('Notarization is disabled for this run (--no-notarization / --skip-notarization or notarization.enabled=false).');
}
if (macTarget.installerTargetNames.length > 0 && skipInstaller) {
    console.log('Installer creation is disabled for this run (--no-installer / --skip-installer or packaging.enabled=false).');
}

// Compute app bundle paths using the publish paths (no fallbacks)
const x64AppPath = path.resolve(publishPathX64, macTarget.dirName, appBundleName);
const arm64AppPath = path.resolve(publishPathArm, `${macTarget.dirName}-arm64`, appBundleName);
const outAppPath = path.resolve(buildCwd, 'bin', 'Desktop', 'universal', appBundleName);

// Validate containment (must remain inside project root)
for (const p of [x64AppPath, arm64AppPath, outAppPath]) {
    if (!isPathInside(projectRoot, p) && !p.startsWith(projectRoot + path.sep)) {
        throw new Error(`Resolved path is outside project root: ${p}`);
    }
}

function formatCommandForLog(command, args, sensitiveValues = []) {
    const masked = new Set(sensitiveValues.filter(Boolean));
    const displayArgs = args.map(arg => masked.has(arg) ? '***' : arg);
    return `${command} ${displayArgs.join(' ')}`;
}

function runCommand(command, args, cwd, options = {}) {
    console.log(`Running command: ${formatCommandForLog(command, args, options.sensitiveValues)} in ${cwd}`);
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {cwd, stdio: 'inherit'});
        child.on('error', reject);
        child.on('close', (code) => {
            if (code !== 0) reject(new Error(`Command failed with exit code ${code}`));
            else resolve();
        });
    });
}

function runCommandCapture(command, args, cwd, options = {}) {
    console.log(`Running command: ${formatCommandForLog(command, args, options.sensitiveValues)} in ${cwd}`);
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk) => {
            const text = chunk.toString();
            stdout += text;
            process.stdout.write(text);
        });

        child.stderr.on('data', (chunk) => {
            const text = chunk.toString();
            stderr += text;
            process.stderr.write(text);
        });

        child.on('error', reject);
        child.on('close', (code) => {
            if (code !== 0) {
                const error = new Error(`Command failed with exit code ${code}`);
                error.code = code;
                error.stdout = stdout;
                error.stderr = stderr;
                reject(error);
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
}

async function stageSignedAppBundle(destinationAppPath) {
    await fs.rm(destinationAppPath, { recursive: true, force: true });

    console.log('Staging signed app bundle with ditto (preserves bundle metadata and signatures):');
    console.log(`  Source      : ${outAppPath}`);
    console.log(`  Destination : ${destinationAppPath}`);

    await runCommand('ditto', [outAppPath, destinationAppPath], projectRoot);
}

// Ensure required npm packages are present and dynamically import makeUniversalApp
async function ensureDependenciesAndImport() {
    const electronHostHookDir = path.resolve(projectRoot, 'ElectronHostHook');
    const require = createRequire(path.join(electronHostHookDir, 'package.json'));

    // Check that packages exist in ElectronHostHook/node_modules (clear guidance if missing)
    const requiredPackages = ['@electron/universal', 'electron-osx-sign'];
    for (const pkg of requiredPackages) {
        try {
            require.resolve(pkg);
        } catch (e) {
            throw new Error(`Missing required package ${pkg}. Run:\n\n  npm install\n\nin the ElectronHostHook directory: ${electronHostHookDir}`);
        }
    }

    // Dynamic import of @electron/universal to avoid import-time crash
    let mod;
    try {
        const resolvedPath = require.resolve('@electron/universal');
        mod = await import(pathToFileURL(resolvedPath).href);
    } catch (e) {
        throw new Error(`Failed to import @electron/universal: ${e.message}`);
    }

    const makeUniversalApp = mod.makeUniversalApp || mod.default;
    if (!makeUniversalApp) {
        throw new Error('@electron/universal does not export makeUniversalApp');
    }
    return {makeUniversalApp};
}

// Acquire makeUniversalApp after verifying dependencies
const {makeUniversalApp} = await ensureDependenciesAndImport();


// Debugging output to confirm resolved locations
console.log('Resolved paths:');
console.log('projectRoot:', projectRoot);
console.log('buildCwd:', buildCwd);
console.log('macTarget.targetNames:', macTarget.targetNames);
console.log('macTarget.primaryTargetName:', macTarget.primaryTargetName);
console.log('macTarget.dirName:', macTarget.dirName);
console.log('x64AppPath:', x64AppPath);
console.log('arm64AppPath:', arm64AppPath);
console.log('outAppPath:', outAppPath);

if (printEffectiveConfig) {
    console.log('\n=== EFFECTIVE CONFIG ===');
    console.log(JSON.stringify(buildEffectiveConfig(), null, 2));
    process.exit(0);
}

async function cleanUnwantedFilesFromApp(appPath, architecture) {
    const binPath = path.join(appPath, 'Contents', 'Resources', 'bin');
    console.log(`=== Cleaning unwanted files from ${architecture} app ===`);

    if (!existsSync(binPath)) {
        console.log(`Bin directory does not exist: ${binPath}`);
        return;
    }

    // Remove runtimes/win-x64 directory if it exists
    const winX64Path = path.join(binPath, 'runtimes', 'win-x64');
    if (existsSync(winX64Path)) {
        console.log(`Removing directory: runtimes/win-x64`);
        await fs.rm(winX64Path, {recursive: true, force: true});
    }

    const files = await fs.readdir(binPath, {withFileTypes: true});

    for (const file of files) {
        const filePath = path.join(binPath, file.name);

        // Remove .pdb files
        if (file.isFile() && file.name.endsWith('.pdb')) {
            console.log(`Removing .pdb file: ${file.name}`);
            await fs.rm(filePath, {force: true});
        }

        // Remove any temp directories
        if (file.isDirectory() && file.name.startsWith('temp-')) {
            console.log(`Removing temp directory: ${file.name}`);
            await fs.rm(filePath, {recursive: true, force: true});
        }
    }
}

async function processDirectoryForDuplicates(dirPath) {
    const entries = await fs.readdir(dirPath, {withFileTypes: true});

    // Recurse into subdirectories first
    for (const entry of entries) {
        if (entry.isDirectory()) {
            await processDirectoryForDuplicates(path.join(dirPath, entry.name));
        }
    }

    // Build a Set of all filenames in this folder for O(1) lookup
    const allFiles = new Set(entries.filter(e => e.isFile()).map(e => e.name));

    for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (entry.name.endsWith('.br')) continue; // .br files are always kept

        // Pattern A: "myfile.css" / "myfile.css.br"
        // The .br version is the full filename with .br appended
        if (allFiles.has(entry.name + '.br')) {
            console.log(`  Removing duplicate (keeping .br): ${entry.name}`);
            await fs.rm(path.join(dirPath, entry.name), {force: true});
            continue;
        }

        // Pattern B: "myfile.js" / "myfile.gz" / "myfile.br"
        // The .br version shares the same stem but has .br as its sole extension
        const stem = path.basename(entry.name, path.extname(entry.name));
        if (stem && allFiles.has(stem + '.br')) {
            console.log(`  Removing duplicate (keeping .br): ${entry.name}`);
            await fs.rm(path.join(dirPath, entry.name), {force: true});
        }
    }
}


async function removeContentDuplicatesWithDifferentExtensions(appPath, architecture) {
    const contentPath = path.join(appPath, 'Contents', 'Resources', 'bin', 'wwwroot');
    console.log(`=== Removing duplicate content files (keeping .br) from ${architecture} app ===`);

    if (!existsSync(contentPath)) {
        console.log(`_content directory does not exist: ${contentPath}`);
        return;
    }

    await processDirectoryForDuplicates(contentPath);
}


async function copyJsonFile() {
    const src = path.resolve(arm64AppPath, 'Contents', 'Resources', 'bin', `${cliAppName}.staticwebassets.endpoints.json`);
    const dest = path.resolve(x64AppPath, 'Contents', 'Resources', 'bin', `${cliAppName}.staticwebassets.endpoints.json`);
    if (!isPathInside(projectRoot, src) || !isPathInside(projectRoot, dest)) {
        console.warn('Copy paths are outside project root; skipping copy to avoid accidental overwrite.');
        return;
    }
    if (existsSync(src)) {
        await fs.copyFile(src, dest);
    }
}


/**
 * Reads the <Version> element from the project's .csproj file.
 * Used as a fallback when the ElectronNET package.json cannot be found.
 * Returns the version string truncated to 3-part semver (e.g. "1.1.1.1" → "1.1.1"),
 * or "1.0.0" if the file or element cannot be found.
 */
async function readProjectVersion() {
    const csprojPath = path.join(buildCwd, `${cliAppName}.csproj`);
    if (!existsSync(csprojPath)) {
        console.warn(`Warning: .csproj not found at ${csprojPath}; using version "1.0.0" for packaging.`);
        return '1.0.0';
    }
    const xml = await fs.readFile(csprojPath, 'utf8');
    const m = xml.match(/<Version>\s*([^<\s]+)\s*<\/Version>/i);
    if (!m) {
        console.warn('Warning: <Version> not found in .csproj; using version "1.0.0" for packaging.');
        return '1.0.0';
    }
    return m[1].trim().split('.').slice(0, 3).join('.');
}

/**
 * Builds a copy-friendly installer base name such as "ExampleApp-1.1.1".
 * Product metadata comes from Properties/electron-builder.json so existing
 * project settings continue to drive naming without depending on electron-builder.
 */
async function getInstallerArtifactBaseName() {
    const ebConfig = await readElectronBuilderConfig();
    const productName = ebConfig.productName || cliAppName;
    const version = await readProjectVersion();
    return `${productName}-${version}`;
}

function getDerivedHardenedRuntimeForTarget(targetName) {
    if (targetName === 'pkg' || targetName === 'dmg') {
        return true;
    }
    if (targetName === 'mas' || targetName === 'mas-dev') {
        return false;
    }
    return null;
}

function getMacSigningTargetConfig(targetName) {
    return getConfigValue(makeUniversalConfig, ['macSigning', 'targets', targetName]) || {};
}

function getMacSigningDefaultConfig() {
    return getConfigValue(makeUniversalConfig, ['macSigning', 'defaults']) || {};
}

function getMacSigningExtraOptions(targetName) {
    const defaultsExtra = getConfigValue(makeUniversalConfig, ['macSigning', 'defaults', 'extraOptions']);
    const targetExtra = getConfigValue(makeUniversalConfig, ['macSigning', 'targets', targetName, 'extraOptions']);

    if (defaultsExtra != null && !isPlainObject(defaultsExtra)) {
        throw new Error('macSigning.defaults.extraOptions must be a JSON object.');
    }
    if (targetExtra != null && !isPlainObject(targetExtra)) {
        throw new Error(`macSigning.targets.${targetName}.extraOptions must be a JSON object.`);
    }

    return {
        ...(defaultsExtra || {}),
        ...(targetExtra || {}),
    };
}

function resolveMacSigningOptions(targetName) {
    const signingDefaults = getMacSigningDefaultConfig();
    const signingTarget = getMacSigningTargetConfig(targetName);

    const resolvedHardenedRuntime = parseBooleanish(
        getFirstDefined(
            cliSignHardenedRuntime,
            signingTarget.hardenedRuntime,
            signingDefaults.hardenedRuntime,
            getDerivedHardenedRuntimeForTarget(targetName)
        ),
        'hardened-runtime'
    );

    const resolvedGatekeeperAssess = parseBooleanish(
        getFirstDefined(
            cliSignGatekeeperAssess,
            signingTarget.gatekeeperAssess,
            signingDefaults.gatekeeperAssess,
            false
        ),
        'gatekeeper-assess'
    );

    const resolvedVerbose = parseBooleanish(
        getFirstDefined(
            cliSignVerbose,
            signingTarget.verbose,
            signingDefaults.verbose,
            true
        ),
        'verbose'
    );

    const options = {
        app: outAppPath,
        identity,
        entitlements: resolveOptionalInputFilePath(
            getFirstDefined(cliSignEntitlements, signingTarget.entitlements, signingDefaults.entitlements),
            'Signing entitlements'
        ),
        entitlementsInherit: resolveOptionalInputFilePath(
            getFirstDefined(cliSignEntitlementsInherit, signingTarget.entitlementsInherit, signingDefaults.entitlementsInherit),
            'Signing inherit entitlements'
        ),
        provisioningProfile: resolveOptionalInputFilePath(
            getFirstDefined(cliSignProvisioningProfile, signingTarget.provisioningProfile, signingDefaults.provisioningProfile),
            'Signing provisioning profile'
        ),
        platform: getFirstDefined(cliSignPlatform, signingTarget.platform, signingDefaults.platform),
        type: getFirstDefined(cliSignType, signingTarget.type, signingDefaults.type, 'distribution'),
        timestamp: getFirstDefined(cliSignTimestamp, signingTarget.timestamp, signingDefaults.timestamp, 'http://timestamp.apple.com/ts01'),
        hardenedRuntime: resolvedHardenedRuntime,
        gatekeeperAssess: resolvedGatekeeperAssess,
        verbose: resolvedVerbose,
        extraOptions: getMacSigningExtraOptions(targetName),
    };

    const expectedHardenedRuntime = getDerivedHardenedRuntimeForTarget(targetName);
    if (expectedHardenedRuntime !== null && options.hardenedRuntime !== expectedHardenedRuntime) {
        if ((targetName === 'pkg' || targetName === 'dmg') && shouldNotarizeApp) {
            throw new Error(`The target "${targetName}" requires hardened-runtime=true when notarization is enabled. Resolve this via CLI or MakeUniversal config.`);
        }
        if (targetName === 'mas' || targetName === 'mas-dev') {
            throw new Error(`The target "${targetName}" requires hardened-runtime=false. Resolve this via CLI or MakeUniversal config.`);
        }
        console.warn(`Warning: hardened-runtime=${options.hardenedRuntime} does not match the usual expectation for target "${targetName}" (${expectedHardenedRuntime}).`);
    }

    return options;
}

function buildEffectiveConfig() {
    const resolvedSigning = resolveMacSigningOptions(macTarget.primaryTargetName);

    return {
        configSource: makeUniversalConfigPath || '<none>',
        appName: cliAppName,
        projectRoot,
        buildCwd,
        macTarget,
        primarySigningTarget: macTarget.primaryTargetName,
        packaging: {
            installerTargets: Array.from(packagingTargets),
            shouldCreateInstaller,
            shouldNotarizeApp,
            skipSign,
            skipInstaller,
            skipNotarization,
        },
        publishProfiles: {
            osxX64: {
                name: publishProfileOsxX64Name,
                publishPath: publishPathX64,
            },
            osxArm64: {
                name: publishProfileOsxArmName,
                publishPath: publishPathArm,
            },
        },
        pkg: {
            welcome: pkgWelcomePath,
            license: pkgLicensePath,
        },
        signing: {
            identity: identity || null,
            installerIdentity: cliInstallerIdentity || process.env.INSTALLER_IDENTITY || null,
            osxSign: {
                entitlements: resolvedSigning.entitlements,
                entitlementsInherit: resolvedSigning.entitlementsInherit,
                provisioningProfile: resolvedSigning.provisioningProfile,
                platform: resolvedSigning.platform,
                type: resolvedSigning.type,
                timestamp: resolvedSigning.timestamp,
                hardenedRuntime: resolvedSigning.hardenedRuntime,
                gatekeeperAssess: resolvedSigning.gatekeeperAssess,
                verbose: resolvedSigning.verbose,
                extraOptions: resolvedSigning.extraOptions,
            },
        },
        notarization: {
            enabled: !skipNotarization,
            appleId: notaryAppleId,
            appPassword: redactSecret(notaryPassword),
            teamId: notaryTeamId,
            deleteZipOnSuccess: deleteNotarizationZipOnSuccess,
        },
    };
}

function tryParseJson(text) {
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function extractNotarySubmissionId(text) {
    if (!text) return null;

    const parsed = tryParseJson(text);
    if (parsed?.id) return parsed.id;

    const patterns = [
        /"id"\s*:\s*"([^"]+)"/i,
        /\bid:\s*([0-9a-f-]{8,})/i,
        /\bRequestUUID\b[^0-9a-fA-F]*([0-9a-fA-F-]{8,})/i,
        /\bsubmission id\b[^0-9a-fA-F]*([0-9a-fA-F-]{8,})/i,
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
            return match[1];
        }
    }

    return null;
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildNotaryLogCommand(submissionId) {
    const args = [
        'xcrun',
        'notarytool',
        'log',
        submissionId,
        '--apple-id', notaryAppleId,
        '--password', notaryPassword,
        '--team-id', notaryTeamId,
        '--output-format', 'json',
    ];

    return args.map(shellQuote).join(' ');
}

function injectPkgPresentationNodes(distributionXml, options) {
    const closingTag = '</installer-gui-script>';
    const insertIndex = distributionXml.lastIndexOf(closingTag);
    if (insertIndex === -1) {
        throw new Error('Failed to find </installer-gui-script> in synthesized distribution XML.');
    }

    let insertContent = '';
    if (options.welcomeFileName) {
        insertContent += `    <welcome file="${escapeXml(options.welcomeFileName)}"/>
`;
    }
    if (options.licenseFileName) {
        insertContent += `    <license file="${escapeXml(options.licenseFileName)}"/>
`;
    }

    return distributionXml.slice(0, insertIndex) + insertContent + distributionXml.slice(insertIndex);
}

async function createPkgInstallerWithPresentation(baseName, version, appId) {
    const ebConfig = await readElectronBuilderConfig();
    const productName = ebConfig.productName || cliAppName;
    const universalDir = path.dirname(outAppPath);
    const artifactPath = path.join(universalDir, `${baseName}.pkg`);
    const tempDir = await fs.mkdtemp(path.join(universalDir, 'pkg-stage-'));
    const resourcesDir = path.join(tempDir, 'resources');
    const pkgRootDir = path.join(tempDir, 'root');
    const applicationsDir = path.join(pkgRootDir, 'Applications');
    const stagedAppPath = path.join(applicationsDir, path.basename(outAppPath));
    const componentPkgName = `${appId}.pkg`;
    const componentPkgPath = path.join(tempDir, componentPkgName);
    const distributionPath = path.join(tempDir, 'distribution.xml');

    try {
        await fs.rm(artifactPath, { force: true });
        await fs.mkdir(resourcesDir, { recursive: true });
        await fs.mkdir(applicationsDir, { recursive: true });
        await stageSignedAppBundle(stagedAppPath);

        console.log('Creating PKG component package with pkgbuild (presentation mode):');
        console.log(`  App        : ${outAppPath}`);
        console.log(`  Staged App : ${stagedAppPath}`);
        console.log(`  Identifier : ${appId}`);
        console.log(`  Version    : ${version}`);
        console.log(`  Component  : ${componentPkgPath}`);

        await runCommand('pkgbuild', [
            '--root', pkgRootDir,
            '--install-location', '/',
            '--identifier', appId,
            '--version', version,
            componentPkgPath,
        ], projectRoot);

        if (pkgWelcomePath) {
            await fs.copyFile(pkgWelcomePath, path.join(resourcesDir, path.basename(pkgWelcomePath)));
        }
        if (pkgLicensePath) {
            await fs.copyFile(pkgLicensePath, path.join(resourcesDir, path.basename(pkgLicensePath)));
        }

        await runCommand('productbuild', [
            '--synthesize',
            '--package', componentPkgPath,
            distributionPath,
        ], tempDir);

        let distributionXml = await fs.readFile(distributionPath, 'utf8');

        if (!distributionXml.includes('<title>')) {
            distributionXml = distributionXml.replace(
                '<installer-gui-script minSpecVersion="2">',
                `<installer-gui-script minSpecVersion="2">\n    <title>${escapeXml(productName)}</title>`
            );
        }

        distributionXml = injectPkgPresentationNodes(distributionXml, {
            welcomeFileName: pkgWelcomePath ? path.basename(pkgWelcomePath) : null,
            licenseFileName: pkgLicensePath ? path.basename(pkgLicensePath) : null,
        });

        await fs.writeFile(distributionPath, distributionXml, 'utf8');

        console.log('Creating final PKG with productbuild resources:');
        console.log(`  Distribution : ${distributionPath}`);
        console.log(`  Resources    : ${resourcesDir}`);
        console.log(`  Output       : ${artifactPath}`);

        await runCommand('productbuild', [
            '--distribution', distributionPath,
            '--package-path', tempDir,
            '--resources', resourcesDir,
            artifactPath,
        ], tempDir);

        const stat = await fs.stat(artifactPath);
        console.log(`✔  PKG installer created: ${artifactPath}  (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
        return artifactPath;
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}

/**
 * Creates a macOS PKG directly with pkgbuild.
 *
 * We intentionally avoid electron-builder here because its PKG path was producing
 * a distribution-only wrapper (~14kb) that omitted the real component payload.
 * pkgbuild creates a flat, installable component package containing the app bundle.
 * If signing is requested, productsign runs afterwards in signPkgInstaller().
 */
async function createPkgInstaller() {
    const ebConfig = await readElectronBuilderConfig();
    const baseName = await getInstallerArtifactBaseName();
    const artifactPath = path.join(path.dirname(outAppPath), `${baseName}.pkg`);
    const version = await readProjectVersion();
    const appId = ebConfig.appId || 'com.example.app';
    const universalDir = path.dirname(outAppPath);

    if (pkgWelcomePath || pkgLicensePath) {
        return await createPkgInstallerWithPresentation(baseName, version, appId);
    }

    const tempDir = await fs.mkdtemp(path.join(universalDir, 'pkg-root-'));
    const pkgRootDir = path.join(tempDir, 'root');
    const applicationsDir = path.join(pkgRootDir, 'Applications');
    const stagedAppPath = path.join(applicationsDir, path.basename(outAppPath));

    try {
        await fs.rm(artifactPath, { force: true });
        await fs.mkdir(applicationsDir, { recursive: true });
        await stageSignedAppBundle(stagedAppPath);

        const args = [
            '--root', pkgRootDir,
            '--install-location', '/',
            '--identifier', appId,
            '--version', version,
            artifactPath,
        ];

        console.log('Creating PKG with pkgbuild:');
        console.log(`  App        : ${outAppPath}`);
        console.log(`  Staged App : ${stagedAppPath}`);
        console.log(`  Identifier : ${appId}`);
        console.log(`  Version    : ${version}`);
        console.log(`  Output     : ${artifactPath}`);

        await runCommand('pkgbuild', args, projectRoot);

        const stat = await fs.stat(artifactPath);
        console.log(`✔  PKG installer created: ${artifactPath}  (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
        return artifactPath;
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}

/**
 * Creates a compressed macOS DMG using hdiutil.
 *
 * The DMG contains:
 *  • the signed universal .app bundle
 *  • an Applications symlink for drag-and-drop installation
 */
async function createDmgInstaller() {
    const ebConfig = await readElectronBuilderConfig();
    const baseName = await getInstallerArtifactBaseName();
    const productName = ebConfig.productName || cliAppName;
    const universalDir = path.dirname(outAppPath);
    const artifactPath = path.join(universalDir, `${baseName}.dmg`);
    const stageDir = await fs.mkdtemp(path.join(universalDir, 'dmg-stage-'));
    const stagedAppPath = path.join(stageDir, path.basename(outAppPath));

    try {
        await fs.rm(artifactPath, { force: true });
        await fs.cp(outAppPath, stagedAppPath, { recursive: true });
        await fs.symlink('/Applications', path.join(stageDir, 'Applications'));

        console.log('Creating DMG with hdiutil:');
        console.log(`  Volume name : ${productName}`);
        console.log(`  Staging dir : ${stageDir}`);
        console.log(`  Output      : ${artifactPath}`);

        await runCommand('hdiutil', [
            'create',
            '-volname', productName,
            '-srcfolder', stageDir,
            '-ov',
            '-format', 'UDZO',
            artifactPath,
        ], projectRoot);

        const stat = await fs.stat(artifactPath);
        console.log(`✔  DMG installer created: ${artifactPath}  (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
        return artifactPath;
    } finally {
        await fs.rm(stageDir, { recursive: true, force: true });
    }
}

/**
 * Packages the already-assembled universal .app into a native macOS installer.
 * Output is placed in the same universal folder as the .app.
 *
 * Only called for installer-style targets (dmg, pkg).
 * mas / mas-dev are never packaged here — they ship as bare .app via the App Store.
 *
 * Native tooling used:
 *  • pkgbuild  — produces a flat installable PKG directly from the .app
 *  • hdiutil   — produces a compressed drag-and-drop DMG
 */
async function packageUniversalApp(targetName) {
    console.log(`=== PACKAGING STEP: Creating ${targetName} installer for universal app ===`);
    if (targetName === 'pkg') {
        return await createPkgInstaller();
    }
    if (targetName === 'dmg') {
        return await createDmgInstaller();
    }
    throw new Error(`Unsupported native macOS installer target: ${targetName}`);
}

/**
 * Signs a PKG installer using the macOS `productsign` command-line tool.
 *
 * PKG installers require a dedicated "Installer" certificate that is entirely
 * separate from the codesign identity used for the .app bundle.  Common names:
 *   • "3rd Party Mac Developer Installer: Your Name (TEAMID)"  — Mac App Store
 *   • "Developer ID Installer: Your Name (TEAMID)"             — Direct distribution
 *
 * Supply the certificate via:
 *   --installer-identity="<cert name or hash>"   (CLI flag)
 *   INSTALLER_IDENTITY="<cert>"                  (environment variable)
 *
 * productsign writes to a new file; this function then replaces the original
 * so the caller always ends up with the signed file at the same path.
 *
 * Only called when the target is "pkg" and --no-sign / --skip-sign is NOT set.
 */
async function signPkgInstaller(pkgPath) {
    const installerIdentity = cliInstallerIdentity || process.env.INSTALLER_IDENTITY;
    if (!installerIdentity) {
        throw new Error(
            'PKG installer signing requires an installer certificate identity.\n' +
            'Supply it via  --installer-identity="<cert>"  or set the INSTALLER_IDENTITY\n' +
            'environment variable.  Typical certificate names:\n' +
            '  • "3rd Party Mac Developer Installer: Your Name (TEAMID)"  (Mac App Store)\n' +
            '  • "Developer ID Installer: Your Name (TEAMID)"             (Direct distribution)\n' +
            'You may also pass the certificate hash instead of the name.\n' +
            'Use --no-sign / --skip-sign to skip all signing.'
        );
    }

    const signedPkgPath = pkgPath + '.signed.pkg';

    console.log(`\n=== PKG SIGNING: ${path.basename(pkgPath)} ===`);
    console.log(`  Installer identity : ${installerIdentity}`);
    console.log(`  Input              : ${pkgPath}`);
    console.log(`  Signed output      : ${signedPkgPath}  (will replace input)`);

    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;
    const spinner = setInterval(() => {
        process.stdout.write(`\r${frames[i++ % frames.length]}  PKG signing in progress...`);
    }, 100);

    try {
        await new Promise((resolve, reject) => {
            const child = spawn(
                'productsign',
                ['--sign', installerIdentity, pkgPath, signedPkgPath],
                { stdio: 'inherit' }
            );
            child.on('close', (code) => {
                if (code !== 0) reject(new Error(`productsign exited with code ${code}`));
                else resolve();
            });
        });

        // Replace the unsigned PKG with the signed one.
        await fs.rename(signedPkgPath, pkgPath);

        clearInterval(spinner);
        process.stdout.write('\r✔  PKG signing complete.                                      \n');
        console.log(`Signed PKG: ${pkgPath}`);
    } catch (err) {
        clearInterval(spinner);
        process.stdout.write('\r✖  PKG signing failed.                                        \n');
        // Best-effort cleanup of the partial signed file.
        if (existsSync(signedPkgPath)) {
            await fs.rm(signedPkgPath, { force: true });
        }
        console.error(err);
        throw err;
    }
}

async function signUniversalApp() {
    const electronHostHookDir = path.resolve(projectRoot, 'ElectronHostHook');
    const hookRequire = createRequire(path.join(electronHostHookDir, 'package.json'));
    const {default: sign} = await import(pathToFileURL(hookRequire.resolve('electron-osx-sign')).href);
    const signingOptions = resolveMacSigningOptions(macTarget.primaryTargetName);

    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;
    const spinner = setInterval(() => {
        process.stdout.write(`\r${frames[i++ % frames.length]}  Signing in progress... (this can take several minutes)`);
    }, 100);

    try {
        await new Promise((resolve, reject) => {
            const osxSignOptions = {
                ...signingOptions.extraOptions,
                app: signingOptions.app,
                identity: signingOptions.identity,
                type: signingOptions.type,
                timestamp: signingOptions.timestamp,
                'hardened-runtime': signingOptions.hardenedRuntime,
                'gatekeeper-assess': signingOptions.gatekeeperAssess,
                verbose: signingOptions.verbose,
                ...(signingOptions.entitlements ? { 'entitlements': signingOptions.entitlements } : {}),
                ...(signingOptions.entitlementsInherit ? { 'entitlements-inherit': signingOptions.entitlementsInherit } : {}),
                ...(signingOptions.provisioningProfile ? { 'provisioning-profile': signingOptions.provisioningProfile } : {}),
                ...(signingOptions.platform ? { platform: signingOptions.platform } : {}),
            };

            console.log('Resolved osx-sign options:');
            console.log(`  target              : ${macTarget.primaryTargetName}`);
            console.log(`  entitlements        : ${signingOptions.entitlements || '<none>'}`);
            console.log(`  entitlementsInherit : ${signingOptions.entitlementsInherit || '<none>'}`);
            console.log(`  provisioningProfile : ${signingOptions.provisioningProfile || '<none>'}`);
            console.log(`  platform            : ${signingOptions.platform || '<none>'}`);
            console.log(`  type                : ${signingOptions.type}`);
            console.log(`  timestamp           : ${signingOptions.timestamp || '<none>'}`);
            console.log(`  hardenedRuntime     : ${signingOptions.hardenedRuntime}`);
            console.log(`  gatekeeperAssess    : ${signingOptions.gatekeeperAssess}`);
            console.log(`  verbose             : ${signingOptions.verbose}`);
            console.log(`  extraOptions        : ${JSON.stringify(signingOptions.extraOptions)}`);

            sign(osxSignOptions, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        clearInterval(spinner);
        process.stdout.write('\r✔  Signing complete.                                          \n');
    } catch (err) {
        clearInterval(spinner);
        process.stdout.write('\r✖  Signing failed.                                            \n');
        console.error(err);
        throw err;
    }
}

async function failNotarization(err, zipPath, submissionId) {
    const combinedOutput = `${err?.stdout || ''}\n${err?.stderr || ''}\n${err?.message || ''}`;
    const resolvedSubmissionId = err?.submissionId || submissionId || extractNotarySubmissionId(combinedOutput);

    console.error('\n✖  Notarization failed.');
    console.error(`The notarization zip has been preserved at: ${zipPath}`);

    if (resolvedSubmissionId) {
        console.error(`Submission ID: ${resolvedSubmissionId}`);
        console.error('Warning: this command includes the app-specific password.');
        console.error('\n');
        console.error('To fetch Apple\'s notarization log, run:');
        console.error(buildNotaryLogCommand(resolvedSubmissionId));
        
    } else {
        console.error('Apple did not return a notarization submission ID, so a log command could not be generated automatically.');
    }

    throw err;
}

async function notarizeAndStapleUniversalApp() {
    const universalDir = path.dirname(outAppPath);
    const zipBaseName = path.basename(outAppPath, '.app');
    const zipPath = path.join(universalDir, `${zipBaseName}.notarization.zip`);

    console.log('\n=== NOTARIZATION STEP: Zipping signed app for notarization ===');
    console.log(`  App : ${outAppPath}`);
    console.log(`  Zip : ${zipPath}`);

    await fs.rm(zipPath, { force: true });

    await runCommand('ditto', [
        '-c', '-k', '--sequesterRsrc', '--keepParent',
        outAppPath,
        zipPath,
    ], projectRoot);

    let submissionId = null;

    console.log('\n=== NOTARIZATION STEP: Submitting app to Apple ===');
    console.log(`  Apple ID : ${notaryAppleId}`);
    console.log(`  Team ID  : ${notaryTeamId}`);

    const submitArgs = [
        'notarytool', 'submit', zipPath,
        '--apple-id', notaryAppleId,
        '--password', notaryPassword,
        '--team-id', notaryTeamId,
        '--wait',
        '--output-format', 'json',
    ];

    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;
    const spinner = setInterval(() => {
        process.stdout.write(`\r${frames[i++ % frames.length]}  Waiting for Apple notarization approval...`);
    }, 100);

    let result;
    try {
        result = await runCommandCapture('xcrun', submitArgs, projectRoot, {
            sensitiveValues: [notaryPassword],
        });
    } catch (err) {
        clearInterval(spinner);
        process.stdout.write('\r✖  Apple notarization request failed.                          \n');
        return await failNotarization(err, zipPath, submissionId);
    }

    clearInterval(spinner);
    process.stdout.write('\r✔  Apple notarization approval received.                     \n');

    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    const parsed = tryParseJson(result.stdout) || tryParseJson(result.stderr);
    submissionId = parsed?.id || extractNotarySubmissionId(combinedOutput);

    if (parsed?.status && parsed.status !== 'Accepted') {
        const error = new Error(`Notarization finished with status "${parsed.status}" instead of "Accepted".`);
        error.submissionId = submissionId;
        error.stdout = result.stdout;
        error.stderr = result.stderr;
        return await failNotarization(error, zipPath, submissionId);
    }

    console.log('\n=== NOTARIZATION STEP: Stapling notarization ticket to .app ===');
    try {
        await runCommand('xcrun', ['stapler', 'staple', '-v', outAppPath], projectRoot);
        console.log('\n=== NOTARIZATION STEP: Validating stapled .app ===');
        await runCommand('xcrun', ['stapler', 'validate', '-v', outAppPath], projectRoot);
    } catch (err) {
        return await failNotarization(err, zipPath, submissionId);
    }

    if (deleteNotarizationZipOnSuccess) {
        console.log(`Deleting notarization zip after successful notarization/stapling: ${zipPath}`);
        await fs.rm(zipPath, { force: true });
    } else {
        console.log(`Keeping notarization zip: ${zipPath}`);
    }
}




// Step 1: Build the Electron applications (this creates the .app bundles)
console.log('=== STEP 2: Building Electron applications ===');

// Determine publish profile arguments (fall back to defaults if none provided)
const publishArgX64_2 = publishProfileOsxX64Name ? `-p:PublishProfile=${publishProfileOsxX64Name}` : '-p:PublishProfile=publish-osx-x64';
const publishArgArm_2 = publishProfileOsxArmName ? `-p:PublishProfile=${publishProfileOsxArmName}` : '-p:PublishProfile=publish-osx-arm64';

await runCommand('dotnet', ['publish', `${cliAppName}.csproj`, publishArgX64_2,  ...extraDotnetArgs], buildCwd);
await runCommand('dotnet', ['publish', `${cliAppName}.csproj`, publishArgArm_2,  ...extraDotnetArgs], buildCwd);



// Step 2: Final cleanup of unwanted files from both apps
console.log('=== STEP 2: Final cleanup of unwanted files ===');
await cleanUnwantedFilesFromApp(x64AppPath, 'x64');
await cleanUnwantedFilesFromApp(arm64AppPath, 'arm64');
await removeContentDuplicatesWithDifferentExtensions(x64AppPath, 'x64');
await removeContentDuplicatesWithDifferentExtensions(arm64AppPath, 'arm64');

// Step 3: Create universal app
console.log('=== STEP 3: Creating universal app ===');
console.log('makeUniversalApp options:');
console.log('  x64AppPath:', x64AppPath);
console.log('  arm64AppPath:', arm64AppPath);
console.log('  outAppPath:', outAppPath);

await copyJsonFile();
console.log('Copying JSON file for endpoints...');
console.log('Making the universal bundle');
await makeUniversalApp({
    x64AppPath,
    arm64AppPath,
    outAppPath,
    force: true,
    x64ArchFiles: ['**/Example/**/*', '**/Example-SQLite.Interop.dll'],
    mergeASARs: true,
});
console.log('Universal app created at:', outAppPath + '\n');
if (!skipSign) {
    console.log('=== LAST STEP: Signing universal app.\n\n');
    console.log('===> THIS CAN TAKE A LONG TIME, NOTHING IS WRONG, BE PATIENT... RELAX <===\n\n');
    await signUniversalApp();
} else {
    console.log('Signing skipped by user (--no-sign / --skip-sign). ===\n');
}
if (shouldNotarizeApp) {
    console.log('\n=== LAST STEP: Notarizing and stapling universal app. ===\n');
    await notarizeAndStapleUniversalApp();
}

// Package the universal .app into an installer for dmg/pkg targets.
// mas and mas-dev are distributed as bare .app bundles via the App Store — no installer needed.
if (shouldCreateInstaller) {
    for (const installerTargetName of macTarget.installerTargetNames) {
        await packageUniversalApp(installerTargetName);

        // PKG installers must be signed with a separate Installer certificate after creation.
        // DMG files do not require a dedicated installer-signing step.
        if (installerTargetName === 'pkg' && !skipSign) {
            const universalDir = path.dirname(outAppPath);
            const dirEntries = await fs.readdir(universalDir);
            const pkgFiles = dirEntries.filter(f => f.endsWith('.pkg'));
            if (pkgFiles.length === 0) {
                throw new Error(`PKG signing: no .pkg file found in ${universalDir}`);
            }
            if (pkgFiles.length > 1) {
                console.warn(`PKG signing: multiple .pkg files found; signing all of them.`);
            }
            for (const pkgFile of pkgFiles) {
                await signPkgInstaller(path.join(universalDir, pkgFile));
            }
        }
    }
} else if (macTarget.installerTargetNames.length > 0) {
    console.log(`Packaging step skipped by user/config — installer targets '${macTarget.installerTargetNames.join(', ')}' were requested, but installer creation is disabled.`);
} else {
    console.log(`Packaging step skipped — none of the current mac targets require an installer.`);
}

console.log('=== BUILD COMPLETE ===');

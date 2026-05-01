/* HOW TO RUN

1) Temporary for current shell session (zsh/bash)
export SIGN_IDENTITY="YOUR_SIGN_IDENTITY_VALUE"
node yourFolderPath/MakeUniversal.js

2) One‑shot for a single command
SIGN_IDENTITY="YOUR_SIGN_IDENTITY_VALUE" node yourFolderPath/MakeUniversal.js

3) Persist across sessions (macOS default shell is zsh)
append to `~/.zshrc` (or `~/.bash_profile` if you use bash)

echo 'export SIGN_IDENTITY="YOUR_SIGN_IDENTITY_VALUE"' >> ~/.zshrc

apply immediately
source ~/.zshrc

4) JetBrains Rider (Run/Debug configuration)
 - Open Run | Edit Configurations...
 - Select your configuration
 - Add environment variable: SIGN_IDENTITY=YOUR_SIGN_IDENTITY_VALUE
 - Save and run the configuration

5) GitHub Actions (use secrets, do NOT commit the value)
 put the secret in repo Settings -> Secrets -> New repository secret (name: SIGN_IDENTITY)
 workflow snippet:
 (place under a job)

env:
  SIGN_IDENTITY: ${{ secrets.SIGN_IDENTITY }}
steps:
  - name: Run make universal
    run: node yourFolderPath/MakeUniversal.js

HOW TO INSTALL DEPENDANCIES

1. Place or add the following content in the package.json located in the ElectronHostHook folder 

"devDependencies": {
    "@electron/universal": "^3.0.3",
    "electron-osx-sign": "^0.6.0"
  }

Make sure to adjust the version numbers to whatever is current for the two packages

2. In a terminal window change directory to the ElectronHostHook folder and execute the follwing commands
npm install --save-dev @electron/universal
npm install --save-dev electron-osx-sign

HOW TO RUN THIS SCRIPT. EXAMPLE COMMAND

The script needs to be in a folder in your main project's source tree, such as: MyProject/Scripts/MakeUniversal.js

1. Change directory to this folder and execute
node ./MakeUniversal.js --app-name=MyProject  --publish-profile-osx-x64=publish-osx-x64.pubxml --publish-profile-osx-arm64=publish-osx-arm64.pubxml --sign-identity="Apple Development: Your Cert name including the ID in side the ()"

Additional dotnet publish arguments can be passed with --dotnet-arg (repeated):
node ./MakeUniversal.js --app-name=MyProject --publish-profile-osx-x64=publish-osx-x64.pubxml --publish-profile-osx-arm64=publish-osx-arm64.pubxml --sign-identity="Apple Development: ..." --dotnet-arg="-p:SomeProp=Value" --dotnet-arg="-p:LangVersion=latest"

Sign identity is whichever apple signing certificate you need to use for your distribution channel type. Sometimes 
osx-sign has a hard time picking the correct certificate id in which case just use the hash value of the key instead of
the english name.

2. Adjust the signUniversalApp() function promise to use the details for your project
You can add or remove/change the properties as per your requirements for your Apple distribution channel. Please
consult the Apple documentation for signing applications.
 
await new Promise((resolve, reject) => {
            sign({
                app: outAppPath,
                identity,
                'entitlements': path.join(projectRoot, 'entitlements.mas.plist'),
                'entitlements-inherit': path.join(projectRoot, 'entitlements.mas.inherit.plist'),
                'provisioning-profile': path.join(projectRoot, 'Development.provisionprofile'),
                type: 'distribution',
                platform: 'mas',
                timestamp: 'http://timestamp.apple.com/ts01',
                'hardened-runtime': false,
                'gatekeeper-assess': false,
                verbose: true
            }, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });



MARKNET TECHNOLOGIES, LLC
Copyright (c)  2023 - 2026 MARKNET TECHNOLOGIES, LLC
ALL RIGHTS RESERVED
LICENSE: MIT
*/

import path from 'path';
import {fileURLToPath, pathToFileURL} from 'url';
import fs from 'fs/promises';
import {existsSync} from 'fs';
import {spawn} from 'child_process';
import {createRequire} from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

const cliAppName = getFlagValue(['--app-name']);
const explicitPath = process.env.APP_BASE_DIR || getFirstPositionalPath();
const projectRoot =
    explicitPath ? path.resolve(explicitPath) : findProjectRootByCsproj(process.cwd(), cliAppName) || null;

console.log("this is the root " + projectRoot);
if (!projectRoot) {
    console.error('Error: Could not determine project root by locating the application .csproj.');
    console.error('Provide the app with --app-name=<AppName> and ensure `<AppName>.csproj` is in a parent directory,');
    console.error('or set APP_BASE_DIR or pass an explicit path as the first positional argument.');
    process.exit(1);
}

// buildCwd (must be inside projectRoot)
const buildCwd = path.resolve(process.env.APP_BUILD_CWD || projectRoot);
if (!isPathInside(projectRoot, buildCwd) && buildCwd !== projectRoot) {
    throw new Error(`APP_BUILD_CWD must be inside the project root. Resolved: ${buildCwd}`);
}

// Accept basenames (with or without `.pubxml`) located in `buildCwd/Properties/PublishProfiles`
const cliProfileX64 = getFlagValue(['--publish-profile-osx-x64']);
const cliProfileArm = getFlagValue(['--publish-profile-osx-arm64']);
const cliIdentity = getFlagValue(['--sign-identity', '--identity']);
const envIdentity = process.env.SIGN_IDENTITY;
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

// Require a signing identity (env or CLI) unless skipSign is present
if (!skipSign && !cliIdentity && !envIdentity) {
    console.error('Error: A signing identity must be supplied via the SIGN_IDENTITY environment variable or the --sign-identity / --identity switch.');
    console.error('Usage: set SIGN_IDENTITY in the environment or run:');
    console.error('  node `./MakeUniversal.js` --sign-identity=<identity> [other options]');
    console.error('Do not commit signing identities to source control.');
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

// require identity from env for safety (do not hardcode secrets)

const identity = cliIdentity || process.env.SIGN_IDENTITY;
if (!skipSign && !identity) {
    throw new Error('Signing identity required: set SIGN_IDENTITY in your environment (not committed to repo).');
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

/**
 * Reads Properties/electron-builder.json from the project root and returns
 * the first mac target string (e.g. "mas-dev", "mas", "dmg").
 * electron-builder appends "-arm64" to the target directory name for the
 * arm64 slice — that convention is mirrored when computing arm64AppPath.
 */
async function readMacTarget() {
    const configPath = path.join(projectRoot, 'Properties', 'electron-builder.json');
    if (!existsSync(configPath)) {
        throw new Error(`electron-builder.json not found at: ${configPath}`);
    }
    const raw = await fs.readFile(configPath, 'utf8');
    let config;
    try {
        config = JSON.parse(raw);
    } catch (e) {
        throw new Error(`Failed to parse electron-builder.json: ${e.message}`);
    }
    const macTarget = config?.mac?.target;
    if (!macTarget) {
        throw new Error('No mac.target found in Properties/electron-builder.json.');
    }
    // target can be a string, an object {target,arch}, or an array of either
    const first = Array.isArray(macTarget) ? macTarget[0] : macTarget;
    const targetName = (typeof first === 'string') ? first : first?.target;
    if (!targetName || typeof targetName !== 'string') {
        throw new Error(`Could not resolve a target string from mac.target in electron-builder.json. Got: ${JSON.stringify(first)}`);
    }
    // electron-builder uses "mac" / "mac-arm64" as the output directory names
    // for target types that produce a macOS installer (dmg, pkg) rather than
    // a named distribution channel (mas, mas-dev, etc.).
    const macDirTargets = new Set(['dmg', 'pkg', 'zip', 'tar.gz']);
    return macDirTargets.has(targetName) ? 'mac' : targetName;
}

const profileX64 = await validatePublishProfile(cliProfileX64, 'osx-x64'); // null or {name, publishUrlRaw, publishPath, fullPath}
const profileArm = await validatePublishProfile(cliProfileArm, 'osx-arm64');

const publishProfileOsxX64Name = profileX64 ? profileX64.name : null;
const publishProfileOsxArmName = profileArm ? profileArm.name : null;

const publishPathX64 = profileX64 ? profileX64.publishPath : null;
const publishPathArm = profileArm ? profileArm.publishPath : null;

if (profileX64) {
    console.log(`Using publish profile for osx-x64: ${path.join('Properties', 'PublishProfiles', profileX64.name + '.pubxml')}`);
    console.log(`  Publish path: ${publishPathX64 || '<none>'} (raw: ${profileX64.publishUrlRaw || '<none>'})`);
}
if (profileArm) {
    console.log(`Using publish profile for osx-arm64: ${path.join('Properties', 'PublishProfiles', profileArm.name + '.pubxml')}`);
    console.log(`  Publish path: ${publishPathArm || '<none>'} (raw: ${profileArm.publishUrlRaw || '<none>'})`);
}

// Publish URLs were paths; variables available for later use:
//  - publishPathX64
//  - publishPathArm

// Determine publish profile arguments (fall back to defaults if none provided)
const publishArgX64 = publishProfileOsxX64Name ? `-p:PublishProfile=${publishProfileOsxX64Name}` : '-p:PublishProfile=publish-osx-x64';
const publishArgArm = publishProfileOsxArmName ? `-p:PublishProfile=${publishProfileOsxArmName}` : '-p:PublishProfile=publish-osx-arm64';

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

// Read the mac target from electron-builder.json — drives the output directory names.
// electron-builder names the x64 output dir after the target (e.g. "mas-dev") and
// appends "-arm64" for the arm64 slice (e.g. "mas-dev-arm64").
const macTarget = await readMacTarget();
console.log(`Mac target (from Properties/electron-builder.json): ${macTarget}`);

// Compute app bundle paths using the publish paths (no fallbacks)
const x64AppPath = path.resolve(publishPathX64, macTarget, appBundleName);
const arm64AppPath = path.resolve(publishPathArm, `${macTarget}-arm64`, appBundleName);
const outAppPath = path.resolve(buildCwd, 'bin', 'Desktop', 'universal', appBundleName);

// Validate containment (must remain inside project root)
for (const p of [x64AppPath, arm64AppPath, outAppPath]) {
    if (!isPathInside(projectRoot, p) && !p.startsWith(projectRoot + path.sep)) {
        throw new Error(`Resolved path is outside project root: ${p}`);
    }
}

function runCommand(command, args, cwd) {
    console.log(`Running command: ${command} ${args.join(' ')} in ${cwd}`);
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {cwd, stdio: 'inherit'});
        child.on('close', (code) => {
            if (code !== 0) reject(new Error(`Command failed with exit code ${code}`));
            else resolve();
        });
    });
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
    try {
        const resolvedPath = require.resolve('@electron/universal');
        const mod = await import(pathToFileURL(resolvedPath).href);
        const makeUniversalApp = mod.makeUniversalApp || mod.default;
        if (!makeUniversalApp) {
            throw new Error('@electron/universal does not export makeUniversalApp');
        }
        return {makeUniversalApp};
    } catch (e) {
        throw new Error(`Failed to import @electron/universal: ${e.message}`);
    }
}

// Acquire makeUniversalApp after verifying dependencies
const {makeUniversalApp} = await ensureDependenciesAndImport();


// Debugging output to confirm resolved locations
console.log('Resolved paths:');
console.log('projectRoot:', projectRoot);
console.log('buildCwd:', buildCwd);
console.log('macTarget:', macTarget);
console.log('x64AppPath:', x64AppPath);
console.log('arm64AppPath:', arm64AppPath);
console.log('outAppPath:', outAppPath);

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

async function signUniversalApp() {
    const electronHostHookDir = path.resolve(projectRoot, 'ElectronHostHook');
    const hookRequire = createRequire(path.join(electronHostHookDir, 'package.json'));
    const {default: sign} = await import(pathToFileURL(hookRequire.resolve('electron-osx-sign')).href);

    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;
    const spinner = setInterval(() => {
        process.stdout.write(`\r${frames[i++ % frames.length]}  Signing in progress... (this can take several minutes)`);
    }, 100);

    try {
        await new Promise((resolve, reject) => {
            sign({
                app: outAppPath,
                identity,
                'entitlements': path.join(projectRoot, 'entitlements.mas.plist'),
                'entitlements-inherit': path.join(projectRoot, 'entitlements.mas.inherit.plist'),
                'provisioning-profile': path.join(projectRoot, 'Development.provisionprofile'),
                type: 'distribution',
                //platform: 'mas',
                timestamp: 'http://timestamp.apple.com/ts01',
                'hardened-runtime': false,
                'gatekeeper-assess': false,
                verbose: true
            }, (err) => {
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

console.log('=== BUILD COMPLETE ===');

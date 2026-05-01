# Electron.Net-MakeUniversal
A script to facilitate building a macos universal binary with Electron.Net

THIS IS NOT A ONE SIZE FITS ALL SORT OF THING. YOU WILL LIKELY NEED TO MAKE CHANGES TO SUIT
YOUR LOCAL DEVELOPMENT ARCHTECTURE.

This script is offered without warranty or support. Use it as you see fit.

HOW TO RUN

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

'use strict';
// afterPack — give the unsigned arm64 mac build a CLEAN, self-consistent ad-hoc signature.
//
// electron-builder with `mac.identity: null` skips its re-seal step. That leaves the app's linker
// signature stale relative to the modified bundle (`codesign --verify` fails: "code has no resources
// but signature indicates they must be present"). On a DOWNLOADED copy (which carries the
// com.apple.quarantine flag) that stale seal makes Gatekeeper report the app as "damaged / can't be
// opened" instead of the normal "unidentified developer" prompt. A deep ad-hoc re-sign makes the
// bundle internally consistent again.
//
// This is still UNSIGNED / NOT NOTARIZED — it only fixes internal consistency. First-run users must
// clear quarantine once: right-click → Open, or `xattr -cr "/Applications/SGEN Site QA.app"`.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename + '.app';
  const appPath = path.join(context.appOutDir, appName);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  console.log('  • afterPack: applied ad-hoc signature to ' + appName);
};

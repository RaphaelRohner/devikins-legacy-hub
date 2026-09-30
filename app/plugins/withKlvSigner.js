/**
 * withKlvSigner.js - Expo config plugin
 *
 * Android 11 and newer hide other installed apps from each app by default
 * ("package visibility"). For the Hub to be able to open the KLV Signer
 * app (see src/api/klvSigner.js), Android needs to be told in advance, in
 * the app's manifest:
 *
 *   <queries><package android:name="com.raphaelrohner.klvsigner" /></queries>
 *
 * Expo generates the manifest from app.json during the build (prebuild),
 * and app.json has no direct setting for <queries>, so this small plugin
 * adds it. It's listed in app.json's "plugins". It only affects which apps
 * the Hub may *talk to*; it doesn't add any permission.
 */

const { withAndroidManifest } = require('expo/config-plugins');

const SIGNER_PACKAGE = 'com.raphaelrohner.klvsigner';

module.exports = function withKlvSigner(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    // Add to the existing <queries> block if there is one (Expo already
    // creates one), instead of starting a second block.
    if (!manifest.queries || manifest.queries.length === 0) manifest.queries = [{}];
    const block = manifest.queries[0];
    block.package = block.package || [];
    const alreadyThere = block.package.some((p) => p.$ && p.$['android:name'] === SIGNER_PACKAGE);
    if (!alreadyThere) block.package.push({ $: { 'android:name': SIGNER_PACKAGE } });
    return cfg;
  });
};

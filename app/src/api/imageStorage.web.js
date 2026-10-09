/**
 * imageStorage.web.js
 *
 * The website version of imageStorage.js. When the Hub is built for the
 * browser, the build tool automatically picks this ".web.js" file instead
 * of the phone one.
 *
 * On the phone, imageStorage.js saves every NFT picture into the app's own
 * storage so it still shows when Moonlabs' image server is slow or down.
 * A website can't write files like that, and every attempt only printed a
 * warning ("getInfoAsync is not available on web"). The browser keeps its
 * own copy of pictures it has shown anyway, so on the website we simply
 * skip saving: every function here answers "nothing stored", and the app
 * shows the picture straight from Moonlabs' image server, as it always
 * does when no saved copy exists.
 *
 * Same function names and answers as the phone file, so the rest of the
 * app doesn't need to know the difference.
 */

export function setActiveImagesDirName() {}

export async function storeImage() {
  return { localImagePath: null, etag: null };
}

// Used by the "has this picture changed?" check. Returning null means
// "couldn't tell", which makes that check leave everything as it is.
export async function fetchImageEtag() {
  return null;
}

export async function deleteStoredImagesForDir() {}

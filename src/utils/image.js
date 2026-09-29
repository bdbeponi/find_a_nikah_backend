/**
 * The longest edge an uploaded image keeps.
 *
 * 1600 covers every place the site shows one: a full-bleed hero on a 2x laptop
 * is about 1500 CSS pixels of artwork, and next/image asks for smaller copies
 * than that everywhere else. Anything above this is detail nobody ever sees,
 * paid for on every page load.
 */
const MAX_EDGE = 1600;
const QUALITY = 82;

/**
 * sharp is loaded on first use, not at import time, and its absence is not an
 * error.
 *
 * It ships a native binary per platform, so an install that skipped optional
 * dependencies — or a node_modules copied between machines — leaves a package
 * that throws the moment it is imported. Compressing uploads is worth having;
 * it is not worth the whole API refusing to start for. Without it, files are
 * stored exactly as they arrive.
 */
let sharp = null;
let loaded = false;

const load = async () => {
  if (loaded) return sharp;
  loaded = true;

  try {
    sharp = (await import("sharp")).default;
  } catch (err) {
    console.warn(
      `⚠️  sharp could not be loaded (${err.message}) - uploads will be stored ` +
        "as received, uncompressed.\n" +
        "   Fix with:  npm install --include=optional sharp"
    );
  }

  return sharp;
};

const pipeline = (image) =>
  image
    // EXIF orientation first - resizing a phone photo without this turns it
    // on its side.
    .rotate()
    .resize({
      width: MAX_EDGE,
      height: MAX_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    });

/**
 * Shrinks one uploaded image and says what extension to store it under.
 *
 * The output is WebP. Most of what gets uploaded here is a photograph saved as
 * PNG — a 1536x1024 one weighs 2.7MB as PNG and 310KB as WebP, the same
 * picture — and WebP keeps transparency, so logos survive it too.
 *
 * Compression must never cost someone their upload: anything sharp cannot read
 * is stored exactly as it arrived, and so is anything that would come out
 * bigger than it went in (which happens with small, already-tight logos).
 */
export const shrink = async (buffer, originalExt = ".jpg") => {
  const lib = await load();
  if (!lib) return { buffer, ext: originalExt };

  try {
    const out = await pipeline(lib(buffer, { failOn: "none" }))
      .webp({ quality: QUALITY })
      .toBuffer();

    if (out.length < buffer.length) return { buffer: out, ext: ".webp" };
  } catch {
    /* unreadable image - keep the original bytes */
  }

  return { buffer, ext: originalExt };
};

/** Whether compression is actually available, for scripts that report it. */
export const canCompress = async () => Boolean(await load());

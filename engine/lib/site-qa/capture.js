'use strict';
// site-qa/capture.js — ONE canonical, deterministic screenshot pipeline, reused by every capture site
// (visual-match, cross-browser, production audit). The caller navigates first (waitUntil:'networkidle');
// this module then settles fonts + image decode, runs a deterministic lazy-load scroll pass, stabilizes,
// takes the screenshot, and returns additive capture metadata.
//
// Backward-compatible: same file path + same fullPage semantics as before — only the pixels are more
// complete (lazy content in, fonts settled) and a metadata object is returned for the evidence record.
// v1.0.1 evidence-capture hardening. Modifies capture ONLY — no certification / registry / algorithm change.

const CAPTURE_SCHEMA = '1.0';
let ENGINE_VERSION = '1.0.1';
try { ENGINE_VERSION = require('./inventory/versions').SCHEMA.migrationQaEngine; } catch (_) {}

// document.fonts.ready — resolves when all @font-face are loaded; false if the API is unavailable.
async function settleFonts(page) {
  try { return await page.evaluate(() => (document.fonts && document.fonts.ready) ? document.fonts.ready.then(() => true).catch(() => false) : false); }
  catch (_) { return false; }
}

// Wait for image decoding where supported (img.decode()); safe fallback + 3s cap so a stuck image can't hang.
async function decodeImages(page) {
  try {
    return await page.evaluate(async () => {
      if (!('decode' in HTMLImageElement.prototype)) return false;
      const imgs = [...document.images].filter(i => i.src && !i.complete);
      await Promise.race([
        Promise.allSettled(imgs.map(i => i.decode().catch(() => {}))),
        new Promise(r => setTimeout(r, 3000)),
      ]);
      return true;
    });
  } catch (_) { return false; }
}

// Deterministic lazy-load activation: top → incremental (≈0.85 viewport steps) → bottom → back to top.
// Small fixed steps (never one giant jump) so IntersectionObserver / loading="lazy" images fire in order.
async function lazyScroll(page) {
  try {
    const vp = (page.viewportSize && page.viewportSize()) || {};
    const vpH = vp.height || 900;
    const total = await page.evaluate(() => document.documentElement.scrollHeight);
    const step = Math.max(200, Math.floor(vpH * 0.85));
    for (let y = 0; y <= total; y += step) { await page.evaluate((yy) => window.scrollTo(0, yy), y); await page.waitForTimeout(60); }
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await page.waitForTimeout(90);
    await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(60);
    return true;
  } catch (_) { return false; }
}

// Real content bottom = the lowest point any VISIBLE descendant element actually paints (text, media,
// a non-transparent background, or a visible border). html/body are excluded on purpose: their box always
// spans the full scrollHeight, so trailing blank (body background extending past the last real element) is
// exactly scrollHeight - contentBottom. If any element genuinely fills to the bottom (a full-height wrapper,
// a tall footer), contentBottom == scrollHeight and nothing is trimmed. Returns 0 on any failure (= no trim).
async function measureContentBottom(page) {
  try {
    return await page.evaluate(() => {
      var maxB = 0, els = document.body ? document.body.getElementsByTagName('*') : [];
      for (var i = 0; i < els.length; i++) {
        var el = els[i], tag = el.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') continue;
        var r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        var cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) continue;
        var hasText = false;
        for (var n = 0; n < el.childNodes.length; n++) { var c = el.childNodes[n]; if (c.nodeType === 3 && c.textContent.trim()) { hasText = true; break; } }
        var media = /^(IMG|SVG|CANVAS|VIDEO|IFRAME|INPUT|BUTTON|TEXTAREA|SELECT|HR|PICTURE)$/.test(tag);
        var bg = cs.backgroundImage !== 'none' || (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent');
        var border = parseFloat(cs.borderBottomWidth) > 0 || parseFloat(cs.borderTopWidth) > 0 || cs.boxShadow !== 'none';
        if (!hasText && !media && !bg && !border) continue;
        var b = r.bottom + window.scrollY;
        if (b > maxB) maxB = b;
      }
      return Math.ceil(maxB);
    });
  } catch (_) { return 0; }
}

// Canonical capture. Caller must have already navigated (networkidle). Returns additive metadata.
async function stableCapture(page, { fullPage = true, path: shotPath, engine = 'chromium', navigation = 'networkidle', settleMs = 400 } = {}) {
  const t0 = Date.now();
  const fontsLoaded = await settleFonts(page);
  const imageDecode = await decodeImages(page);
  const lazyLoadPass = await lazyScroll(page);
  await page.waitForTimeout(settleMs);                 // final stabilization (≈300–500ms)
  let documentHeight = 0;
  try { documentHeight = await page.evaluate(() => document.documentElement.scrollHeight); } catch (_) {}
  const vp = (page.viewportSize && page.viewportSize()) || {};
  let trimmedTrailingBlank = null;
  if (shotPath) {
    // scale:'css' captures at CSS-pixel size instead of the context's deviceScaleFactor.
    //
    // This matters now that the matrix emulates real device DPR (2 / 3 / 3.75). Playwright's
    // default, scale:'device', bakes that multiplier into the PNG: a full-page shot of a long page
    // at 360·Galaxy S (dpr 3) measured **6.70 MB**, and a single audit's report.html reached
    // **136 MB** — 133 MB of it base64-inlined screenshots. Unsendable, and a regression introduced
    // by the DPR work itself (the pre-3.0 engine never set deviceScaleFactor, so it was always 1).
    //
    // Measured on sgen.com @ 360·Galaxy S, dpr 3:  device 6.70 MB -> css 1.15 MB (-82.9%).
    //
    // Crucially this ONLY affects the capture, not the page: devicePixelRatio stays 3 and touch
    // stays true, so srcset / image-set / retina asset fetching are still genuinely exercised — we
    // keep the emulation and drop only the pixels nobody reads. Evidence shots are for a human to
    // look at; they do not need 3x density.
    await page.screenshot({ path: shotPath, fullPage, scale: 'css' });
    // Trim trailing blank on full-page shots: the fullPage capture is the whole scrollHeight, which often
    // includes a tall empty run of body background below the last real element. Crop the PNG down to the
    // measured content bottom (+ small pad). Guarded so real content is never cut: only when the blank gap
    // is large AND no element extends into it; any failure leaves the original shot untouched.
    if (fullPage && documentHeight > 0) {
      try {
        const contentBottom = await measureContentBottom(page);
        if (contentBottom > 0 && (documentHeight - contentBottom) > 120) {
          const sharp = require('sharp');
          const meta = await sharp(shotPath).metadata();
          const dsf = meta.height / documentHeight;                 // device px per CSS px
          const cropH = Math.min(meta.height, Math.round((contentBottom + 16) * dsf));
          if (meta.height - cropH > 24) {
            const buf = await sharp(shotPath).extract({ left: 0, top: 0, width: meta.width, height: cropH }).png().toBuffer();
            require('fs').writeFileSync(shotPath, buf);
            trimmedTrailingBlank = { fromPx: meta.height, toPx: cropH, contentBottomCss: contentBottom, scrollHeightCss: documentHeight };
          }
        }
      } catch (_) { /* keep the untrimmed full-page shot on any error */ }
    }

    // Write a compressed sibling preview for the report to inline. The PNG stays as the lossless
    // archive; `<name>.preview.jpg` is what report.html embeds.
    //
    // Why here: renderReport() is SYNC and every caller invokes it sync, but sharp's toBuffer() is
    // Promise-only — compressing there would inline "[object Promise]". This function is already
    // async and already requires sharp (above), so the preview is built where it can be.
    //
    // Why JPEG and not WebP: measured — sharp throws "Processed image is too large for the WebP
    // format" on these captures. WebP caps at 16383px/side; the worst full-page shot on sgen.com is
    // 1024x29386px. JPEG has no such limit here.
    //
    // Measured on that evidence, 26 inlined shots: raw PNG base64 62.27 MB -> JPEG q82 16.92 MB.
    if (fullPage && shotPath && /\.png$/i.test(shotPath)) {
      try {
        const sharp = require('sharp');
        const previewPath = shotPath.replace(/\.png$/i, '.preview.jpg');
        await sharp(shotPath).jpeg({ quality: 82, mozjpeg: true }).toFile(previewPath);
      } catch (_) { /* no preview -> report.js falls back to the PNG. Never fail a capture over this. */ }
    }
  }
  return {
    browser: engine,
    viewport: `${vp.width || '?'}x${vp.height || '?'}`,
    viewportWidth: vp.width || null,
    viewportHeight: vp.height || null,
    captureMode: fullPage ? 'full-page' : 'viewport',
    fullPage: !!fullPage,
    navigationStrategy: navigation,
    fontsLoaded,
    lazyLoadPass,
    imageDecode,
    documentHeight,
    trimmedTrailingBlank,
    capturedAt: new Date().toISOString(),
    captureDurationMs: Date.now() - t0,
    engineVersion: ENGINE_VERSION,
    captureSchema: CAPTURE_SCHEMA,
  };
}

module.exports = { stableCapture, CAPTURE_SCHEMA };

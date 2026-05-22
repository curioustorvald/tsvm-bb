/*
 * aalib.mjs — AAlib port for TSVM/TVDOS
 *
 *   Original:  Jan Hubicka & the AA-group, 1997
 *   Port:      CuriousTorvald
 *
 * Mirrors a useful subset of AAlib's interface:
 *
 *   - Context owns an "imagebuffer" (8-bit luminance, high-res) and a
 *     pair of "textbuffer"/"attrbuffer" arrays (the rendered ASCII).
 *   - The image buffer is 2x the screen resolution in each dimension,
 *     so every character cell sees a 2x2 NW/NE/SW/SE patch.
 *   - aa.render() picks the best CP437 glyph for each 2x2 patch via
 *     a brightness-pattern table, with optional Floyd-Steinberg or
 *     random error distribution dithering.
 *   - aa.flush() blits textbuffer to the terminal using con.move() +
 *     print() and ANSI SGR sequences for AA_BOLD / AA_DIM / AA_REVERSE.
 *   - aa.print() rasterises a scalable bitmap font straight into the
 *     image buffer, so big text re-emerges as ASCII art after render().
 *
 * Usage (matches the BB demo's idioms):
 *
 *     const aa = require("aalib")
 *     const ctx = aa.init()             // grabs terminal size
 *     const p   = aa.getrenderparams()
 *     for (...) { aa.putpixel(ctx, x, y, lum) }
 *     aa.render(ctx, p, 0, 0, aa.scrwidth(ctx), aa.scrheight(ctx))
 *     aa.flush(ctx)
 */

// ── Attribute constants ─────────────────────────────────────────────────────
const AA_NORMAL   = 0
const AA_DIM      = 1
const AA_BOLD     = 2
const AA_BOLDFONT = 3
const AA_REVERSE  = 4
const AA_SPECIAL  = 5

// ── Dither modes ────────────────────────────────────────────────────────────
const AA_NONE         = 0
const AA_ERRORDISTRIB = 1
const AA_FLOYD_S      = 2

// ── Glyph palette ───────────────────────────────────────────────────────────
// Each row: [CP437 code, NW, NE, SW, SE]; quadrant values are 0..1.
// Ordered loosely from lightest to heaviest. Half-block / shade glyphs give
// us the directional and density patterns that the original 8x16 PC font
// supplied to AA-lib.
const GLYPHS = [
    [0x20, 0.00, 0.00, 0.00, 0.00],   // ' '
    [0x2E, 0.00, 0.00, 0.00, 0.30],   // .
    [0x2C, 0.00, 0.00, 0.30, 0.00],   // ,
    [0x60, 0.30, 0.00, 0.00, 0.00],   // `
    [0x27, 0.00, 0.30, 0.00, 0.00],   // '
    [0x2D, 0.30, 0.30, 0.00, 0.00],   // -  (middle-ish, but mostly upper)
    [0x5F, 0.00, 0.00, 0.50, 0.50],   // _
    [0x22, 0.00, 0.40, 0.00, 0.00],   // "  (paired ticks, treat as top)
    [0x3A, 0.45, 0.00, 0.45, 0.00],   // :
    [0x3B, 0.00, 0.45, 0.45, 0.00],   // ;
    [0x7E, 0.00, 0.40, 0.40, 0.00],   // ~
    [0x2F, 0.00, 0.55, 0.55, 0.00],   // /
    [0x5C, 0.55, 0.00, 0.00, 0.55],   // \
    [0x28, 0.50, 0.00, 0.50, 0.00],   // (
    [0x29, 0.00, 0.50, 0.00, 0.50],   // )
    [0x7C, 0.45, 0.45, 0.45, 0.45],   // |
    [0x21, 0.55, 0.00, 0.30, 0.00],   // !
    [0x2B, 0.30, 0.30, 0.30, 0.30],   // +
    [0x2A, 0.50, 0.50, 0.30, 0.30],   // *
    [0x6F, 0.55, 0.55, 0.55, 0.55],   // o
    [0x6E, 0.55, 0.55, 0.45, 0.45],   // n
    [0x78, 0.50, 0.50, 0.50, 0.50],   // x
    // [0xB0, 0.30, 0.30, 0.30, 0.30],   // ░
    [0x4F, 0.65, 0.65, 0.65, 0.65],   // O
    [0x25, 0.65, 0.65, 0.65, 0.65],   // %
    // [0xB1, 0.55, 0.55, 0.55, 0.55],   // ▒
    [0x23, 0.75, 0.75, 0.75, 0.75],   // #
    [0x40, 0.80, 0.80, 0.80, 0.80],   // @
    // [0xB2, 0.80, 0.80, 0.80, 0.80],   // ▓
    // [0xDF, 1.00, 1.00, 0.00, 0.00],   // ▀ top half
    // [0xDC, 0.00, 0.00, 1.00, 1.00],   // ▄ bottom half
    // [0xDD, 1.00, 0.00, 1.00, 0.00],   // ▌ left half
    // [0xDE, 0.00, 1.00, 0.00, 1.00],   // ▐ right half
    // [0xDB, 1.00, 1.00, 1.00, 1.00],   // █ full
    // [0xFE, 0.55, 0.55, 0.55, 0.55],   // ■ centred dot
]

// Pre-scale quadrant values to 0..255 once.
const _G_CH = new Uint8Array(GLYPHS.length)
const _G_Q  = new Float32Array(GLYPHS.length * 4)
for (let i = 0; i < GLYPHS.length; i++) {
    _G_CH[i]      = GLYPHS[i][0]
    _G_Q[i*4 + 0] = GLYPHS[i][1] * 255
    _G_Q[i*4 + 1] = GLYPHS[i][2] * 255
    _G_Q[i*4 + 2] = GLYPHS[i][3] * 255
    _G_Q[i*4 + 3] = GLYPHS[i][4] * 255
}

// ── Built-in 5x7 font (used when caller doesn't supply one) ─────────────────
const _FONT5x7_SRC = {
    " ":["     ","     ","     ","     ","     ","     ","     "],
    "A":["  #  "," # # ","#   #","#####","#   #","#   #","#   #"],
    "B":["#### ","#   #","#   #","#### ","#   #","#   #","#### "],
    "C":[" ####","#    ","#    ","#    ","#    ","#    "," ####"],
    "D":["#### ","#   #","#   #","#   #","#   #","#   #","#### "],
    "E":["#####","#    ","#    ","#### ","#    ","#    ","#####"],
    "F":["#####","#    ","#    ","#### ","#    ","#    ","#    "],
    "G":[" ####","#    ","#    ","#  ##","#   #","#   #"," ####"],
    "H":["#   #","#   #","#   #","#####","#   #","#   #","#   #"],
    "I":["#####","  #  ","  #  ","  #  ","  #  ","  #  ","#####"],
    "J":["#####","    #","    #","    #","#   #","#   #"," ### "],
    "K":["#   #","#  # ","# #  ","##   ","# #  ","#  # ","#   #"],
    "L":["#    ","#    ","#    ","#    ","#    ","#    ","#####"],
    "M":["#   #","## ##","# # #","#   #","#   #","#   #","#   #"],
    "N":["#   #","##  #","# # #","#  ##","#   #","#   #","#   #"],
    "O":[" ### ","#   #","#   #","#   #","#   #","#   #"," ### "],
    "P":["#### ","#   #","#   #","#### ","#    ","#    ","#    "],
    "Q":[" ### ","#   #","#   #","#   #","# # #","#  # "," ## #"],
    "R":["#### ","#   #","#   #","#### ","# #  ","#  # ","#   #"],
    "S":[" ####","#    ","#    "," ### ","    #","    #","#### "],
    "T":["#####","  #  ","  #  ","  #  ","  #  ","  #  ","  #  "],
    "U":["#   #","#   #","#   #","#   #","#   #","#   #"," ### "],
    "V":["#   #","#   #","#   #","#   #","#   #"," # # ","  #  "],
    "W":["#   #","#   #","#   #","#   #","# # #","## ##","#   #"],
    "X":["#   #","#   #"," # # ","  #  "," # # ","#   #","#   #"],
    "Y":["#   #","#   #"," # # ","  #  ","  #  ","  #  ","  #  "],
    "Z":["#####","    #","   # ","  #  "," #   ","#    ","#####"],
    "0":[" ### ","#   #","#  ##","# # #","##  #","#   #"," ### "],
    "1":["  #  "," ##  ","# #  ","  #  ","  #  ","  #  ","#####"],
    "2":[" ### ","#   #","    #","  ## "," #   ","#    ","#####"],
    "3":[" ### ","#   #","    #","  ## ","    #","#   #"," ### "],
    "4":["   # ","  ## "," # # ","#  # ","#####","   # ","   # "],
    "5":["#####","#    ","#### ","    #","    #","#   #"," ### "],
    "6":[" ### ","#    ","#    ","#### ","#   #","#   #"," ### "],
    "7":["#####","    #","   # ","  #  "," #   "," #   "," #   "],
    "8":[" ### ","#   #","#   #"," ### ","#   #","#   #"," ### "],
    "9":[" ### ","#   #","#   #"," ####","    #","    #"," ### "],
    "?":[" ### ","#   #","    #","   # ","  #  ","     ","  #  "],
    "!":["  #  ","  #  ","  #  ","  #  ","  #  ","     ","  #  "],
    ".":["     ","     ","     ","     ","     ","     ","  #  "],
    ",":["     ","     ","     ","     ","     ","  #  "," #   "],
    ":":["     ","     ","  #  ","     ","     ","  #  ","     "],
    ";":["     ","     ","  #  ","     ","     ","  #  "," #   "],
    "-":["     ","     ","     ","#####","     ","     ","     "],
    "/":["    #","    #","   # ","  #  "," #   ","#    ","#    "],
    "(":["  #  "," #   ","#    ","#    ","#    "," #   ","  #  "],
    ")":["  #  ","   # ","    #","    #","    #","   # ","  #  "],
    "'":["  #  ","  #  ","     ","     ","     ","     ","     "],
    "\"":[" # # "," # # ","     ","     ","     ","     ","     "],
    "*":["     "," # # ","  #  ","#####","  #  "," # # ","     "],
    "+":["     ","  #  ","  #  ","#####","  #  ","  #  ","     "],
    "=":["     ","     ","#####","     ","#####","     ","     "],
    "%":["##  #","## # ","   # ","  #  "," #   ","# ## ","#  ##"],
    "&":[" ##  ","#  # "," #   ","  #  "," # # ","#   #"," ## #"],
}

// Build the font as { width, height, data: Uint8Array[256*width*height] }
function _buildFont5x7() {
    const fw = 5, fh = 7
    const data = new Uint8Array(256 * fw * fh)
    const keys = Object.keys(_FONT5x7_SRC)
    for (let k = 0; k < keys.length; k++) {
        const ch = keys[k]
        const rows = _FONT5x7_SRC[ch]
        const code = ch.charCodeAt(0)
        const base = code * fw * fh
        for (let y = 0; y < fh; y++) {
            const row = rows[y]
            for (let x = 0; x < fw; x++) {
                data[base + y * fw + x] = (row.charAt(x) === "#") ? 0xFF : 0x00
            }
        }
    }
    return { width: fw, height: fh, data: data }
}

let _font5x7 = null
function font5x7() {
    if (!_font5x7) _font5x7 = _buildFont5x7()
    return _font5x7
}

// Build a font from a flat bitmap blob (AA-lib compatible layout).
// `data` is a Uint8Array of length 256 * width * height where each glyph
// is stored top-to-bottom, left-to-right with non-zero bytes meaning "ink".
function fontFromBitmap(width, height, data) {
    return { width: width | 0, height: height | 0, data: data }
}

// Load a TSVM-style packed character ROM (".chr" file) and unpack it into
// the flat 256*width*height byte layout `aa.print` expects.
//
// File layout: `numChars * height` bytes, one byte per glyph row, with
// bit (width-1) as the leftmost pixel (matches the convention used by
// GraphicsAdapter.kt's font ROM and assets/disk0/sysfnt_*.chr).
//
//   path     full path including drive letter, e.g. "A:/home/bb/font.chr"
//   width    glyph width  (TSVM system font: 7)
//   height   glyph height (TSVM system font: 14)
//   numChars defaults to 256
function loadChrFont(path, width, height, numChars) {
    width   = width   | 0
    height  = height  | 0
    numChars = (numChars | 0) || 256
    const expectedBytes = numChars * height
    const fh = files.open(path)
    if (!fh.exists) throw Error("aalib.loadChrFont: file not found: " + path)
    const blob = fh.bread()
    if (blob.length < expectedBytes) {
        throw Error("aalib.loadChrFont: file too short (" + blob.length +
                    " < " + expectedBytes + " bytes) for " + numChars +
                    "x" + width + "x" + height + " font")
    }
    const data = new Uint8Array(256 * width * height)
    for (let c = 0; c < numChars; c++) {
        const dstBase = c * width * height
        const srcBase = c * height
        for (let r = 0; r < height; r++) {
            const b = blob[srcBase + r] & 0xFF
            for (let x = 0; x < width; x++) {
                data[dstBase + r * width + x] =
                    ((b >> (width - 1 - x)) & 1) ? 0xFF : 0x00
            }
        }
    }
    return { width: width, height: height, data: data }
}

// ── Context ─────────────────────────────────────────────────────────────────

function _termSize() {
    const yx = con.getmaxyx()
    return { rows: yx[0], cols: yx[1] }
}

function init(scrW, scrH) {
    if (scrW === undefined || scrH === undefined) {
        const s = _termSize()
        if (scrW === undefined) scrW = s.cols
        if (scrH === undefined) scrH = s.rows
    }
    scrW = scrW | 0
    scrH = scrH | 0
    const imgW = scrW * 2
    const imgH = scrH * 2
    return {
        scrW: scrW, scrH: scrH,
        imgW: imgW, imgH: imgH,
        // mm dimensions: TSVM character cells are ~1:1 (8x8 px).
        // Pick mm = number-of-cells so aspect ratios stay sane downstream.
        mmW: scrW, mmH: scrH,
        imagebuffer: new Uint8Array(imgW * imgH),
        textbuffer:  new Uint8Array(scrW * scrH).fill(0x20),
        attrbuffer:  new Uint8Array(scrW * scrH),
        cursorX: 0, cursorY: 0,
        // Full-image float error map for Floyd-Steinberg dithering.
        // Allocated lazily on the first FS render to avoid taxing scenes
        // that never dither.
        _err: null,
        _flushed: false,
    }
}

function close(ctx) {
    // Reset terminal state. We don't own the screen; just behave nicely.
    print("\x1B[m")
    con.curs_set(1)
}

function imgwidth(ctx)  { return ctx.imgW }
function imgheight(ctx) { return ctx.imgH }
function scrwidth(ctx)  { return ctx.scrW }
function scrheight(ctx) { return ctx.scrH }
function mmwidth(ctx)   { return ctx.mmW }
function mmheight(ctx)  { return ctx.mmH }

function putpixel(ctx, x, y, color) {
    x |= 0; y |= 0
    if (x < 0 || x >= ctx.imgW || y < 0 || y >= ctx.imgH) return
    let c = color | 0
    if (c < 0) c = 0
    if (c > 255) c = 255
    ctx.imagebuffer[y * ctx.imgW + x] = c
}

function getpixel(ctx, x, y) {
    x |= 0; y |= 0
    if (x < 0 || x >= ctx.imgW || y < 0 || y >= ctx.imgH) return 0
    return ctx.imagebuffer[y * ctx.imgW + x]
}

function clear(ctx) {
    ctx.imagebuffer.fill(0)
}

function cleartext(ctx) {
    ctx.textbuffer.fill(0x20)
    ctx.attrbuffer.fill(AA_NORMAL)
}

function gotoxy(ctx, x, y) { ctx.cursorX = x | 0; ctx.cursorY = y | 0 }

function puts(ctx, x, y, attr, text) {
    x |= 0; y |= 0
    if (y < 0 || y >= ctx.scrH) return
    const w = ctx.scrW
    const tb = ctx.textbuffer, ab = ctx.attrbuffer
    for (let i = 0; i < text.length && x + i < w; i++) {
        if (x + i < 0) continue
        tb[y * w + x + i] = text.charCodeAt(i) & 0xFF
        ab[y * w + x + i] = attr | 0
    }
}

function hidecursor(ctx) { con.curs_set(0) }
function showcursor(ctx) { con.curs_set(1) }

// ── Render parameters ───────────────────────────────────────────────────────
function getrenderparams() {
    return {
        bright:    0,         // -255..+255
        contrast:  0,         // -255..+255 (0 = identity)
        gamma:     1.0,       // applied as a luminance LUT when != 1.0
        dither:    AA_NONE,
        randomval: 0,         // 0..100
        inversion: 0,         // 0 or 1
    }
}

// ── Render ──────────────────────────────────────────────────────────────────
function _clamp8(v) {
    v = v | 0
    return v < 0 ? 0 : (v > 255 ? 255 : v)
}

// Find best glyph for a 2x2 NW/NE/SW/SE sample. Returns
// { ch, q0, q1, q2, q3 } so the caller can compute per-quadrant error.
function _bestGlyph(nw, ne, sw, se) {
    let bestI = 0
    let bestD = 1e30
    const G = _G_Q
    const N = _G_CH.length
    for (let i = 0; i < N; i++) {
        const k = i * 4
        const d0 = G[k    ] - nw
        const d1 = G[k + 1] - ne
        const d2 = G[k + 2] - sw
        const d3 = G[k + 3] - se
        const d = d0*d0 + d1*d1 + d2*d2 + d3*d3
        if (d < bestD) { bestD = d; bestI = i }
    }
    const k = bestI * 4
    return { ch: _G_CH[bestI], q: [G[k], G[k+1], G[k+2], G[k+3]] }
}

function render(ctx, params, sx, sy, sw, sh) {
    if (sx === undefined) { sx = 0; sy = 0; sw = ctx.scrW; sh = ctx.scrH }
    sx |= 0; sy |= 0; sw |= 0; sh |= 0
    if (sw <= 0 || sh <= 0) return

    const imgW = ctx.imgW
    const imgH = ctx.imgH
    const scrW = ctx.scrW
    const buf  = ctx.imagebuffer
    const tb   = ctx.textbuffer
    const ab   = ctx.attrbuffer
    const bright   = params.bright   | 0
    const contrast = params.contrast | 0
    const dither   = params.dither   | 0
    const randval  = params.randomval| 0
    const inv      = params.inversion ? 1 : 0
    const contMul  = (256 + contrast) / 256
    const gamma    = (params.gamma === undefined) ? 1.0 : params.gamma
    let gLut = null
    if (gamma !== 1.0) {
        if (!ctx._gammaLut || ctx._gammaG !== gamma) {
            ctx._gammaLut = new Uint8Array(256)
            for (let v = 0; v < 256; v++) {
                let g = Math.pow(v / 255, gamma) * 255
                if (g < 0) g = 0
                if (g > 255) g = 255
                ctx._gammaLut[v] = g | 0
            }
            ctx._gammaG = gamma
        }
        gLut = ctx._gammaLut
    }

    const useFS = (dither === AA_FLOYD_S)
    let err = null
    if (useFS) {
        if (!ctx._err || ctx._err.length !== imgW * imgH) {
            ctx._err = new Float32Array(imgW * imgH)
        }
        err = ctx._err
        err.fill(0)
    }

    for (let cy = sy; cy < sy + sh; cy++) {
        const py = cy * 2
        for (let cx = sx; cx < sx + sw; cx++) {
            const px = cx * 2
            const iNW = py * imgW + px
            const iNE = iNW + 1
            const iSW = iNW + imgW
            const iSE = iSW + 1

            let nw = buf[iNW], ne = buf[iNE], sw2 = buf[iSW], se = buf[iSE]

            if (gLut) {
                nw = gLut[nw]; ne = gLut[ne]; sw2 = gLut[sw2]; se = gLut[se]
            }

            if (contrast || bright) {
                nw  = _clamp8((nw  - 128) * contMul + 128 + bright)
                ne  = _clamp8((ne  - 128) * contMul + 128 + bright)
                sw2 = _clamp8((sw2 - 128) * contMul + 128 + bright)
                se  = _clamp8((se  - 128) * contMul + 128 + bright)
            }

            if (inv) { nw = 255 - nw; ne = 255 - ne; sw2 = 255 - sw2; se = 255 - se }

            if (randval || dither === AA_ERRORDISTRIB) {
                const r = randval || 16
                nw  = _clamp8(nw  + ((Math.random() * 2 - 1) * r) | 0)
                ne  = _clamp8(ne  + ((Math.random() * 2 - 1) * r) | 0)
                sw2 = _clamp8(sw2 + ((Math.random() * 2 - 1) * r) | 0)
                se  = _clamp8(se  + ((Math.random() * 2 - 1) * r) | 0)
            }

            if (useFS) {
                nw  = _clamp8(nw  + err[iNW])
                ne  = _clamp8(ne  + err[iNE])
                sw2 = _clamp8(sw2 + err[iSW])
                se  = _clamp8(se  + err[iSE])
            }

            const g = _bestGlyph(nw, ne, sw2, se)
            tb[cy * scrW + cx] = g.ch
            ab[cy * scrW + cx] = AA_NORMAL

            if (useFS) {
                _spreadFS(err, imgW, imgH, iNW, px,     py,     nw  - g.q[0])
                _spreadFS(err, imgW, imgH, iNE, px + 1, py,     ne  - g.q[1])
                _spreadFS(err, imgW, imgH, iSW, px,     py + 1, sw2 - g.q[2])
                _spreadFS(err, imgW, imgH, iSE, px + 1, py + 1, se  - g.q[3])
            }
        }
    }
}

// Standard Floyd-Steinberg kernel: 7/16 right, 3/16 BL, 5/16 B, 1/16 BR.
function _spreadFS(err, W, H, idx, x, y, e) {
    if (!e) return
    if (x + 1 < W)     err[idx + 1]     += e * 0.4375   // 7/16
    if (y + 1 < H) {
        err[idx + W] += e * 0.3125                       // 5/16
        if (x - 1 >= 0) err[idx + W - 1] += e * 0.1875  // 3/16
        if (x + 1 < W)  err[idx + W + 1] += e * 0.0625  // 1/16
    }
}

// ── Render a "palette" (LUT 0..255 → 0..255 luminance) ──────────────────────
// renderpalette() in original AAlib re-maps every pixel through `pal` before
// rendering. We support it by sampling the LUT into a per-context scratch
// buffer and swapping it in while render() runs.
function renderpalette(ctx, palette, params, sx, sy, sw, sh) {
    const orig = ctx.imagebuffer
    if (!ctx._palScratch || ctx._palScratch.length !== orig.length) {
        ctx._palScratch = new Uint8Array(orig.length)
    }
    const remapped = ctx._palScratch
    for (let i = 0; i < orig.length; i++) remapped[i] = palette[orig[i]] & 0xFF
    ctx.imagebuffer = remapped
    try { render(ctx, params, sx, sy, sw, sh) }
    finally { ctx.imagebuffer = orig }
}

// ── Flush to terminal ───────────────────────────────────────────────────────
// Writes the textbuffer (and attribute-derived FG/BG planes) STRAIGHT to the
// GPU text-mode VRAM via sys.pokeBytes. This bypasses the terminal cursor
// entirely, so painting into the bottom-right cell never triggers a scroll
// (which is what happens if you print() past column TCOLS on row TROWS).
//
// VRAM layout (from GraphicsAdapter.kt):
//   peripheral byte k lives at JS address (gpuMemBase - k)
//   textArea starts at peripheral relative offset 253950
//   fore plane: textArea bytes    2 .. 2561   (80x32 cells, row-major)
//   back plane: textArea bytes 2562 .. 5121
//   char plane: textArea bytes 5122 .. 7681
//
// FG/BG palette indices match BB's conventions:
//   BLACK = 255, WHITE = 254, GREY = 253, DARKGREY = 245.
const _FG_NORMAL  = 254
const _FG_BOLD    = 254
const _FG_DIM     = 253
const _FG_SPECIAL = 250
const _BG_NORMAL  = 255

const _HW_TXT_W = 80                 // TSVM text mode is always 80x32
const _HW_TXT_H = 32
const _TA_FORE  = 2
const _TA_BACK  = 2562
const _TA_CHAR  = 5122
const _TA_BASE  = 253950             // peripheral relative offset of textArea[0]

let _gpuBase = 0                     // gpuMemBase - _TA_BASE, cached
let _gpuBaseInit = false
function _vramBase() {
    if (!_gpuBaseInit) {
        _gpuBase = graphics.getGpuMemBase() - _TA_BASE
        _gpuBaseInit = true
    }
    return _gpuBase
}

// Reusable scratch planes (allocated lazily so contexts with no attrs only
// pay for the char plane).
let _scratchFore = null
let _scratchBack = null

function flush(ctx) {
    const scrW = ctx.scrW
    const scrH = ctx.scrH
    const tb = ctx.textbuffer
    const ab = ctx.attrbuffer
    const base = _vramBase()
    const len = scrW * scrH

    // Char plane — single bulk copy if our scrW matches the hardware width
    // (which is the common case in TSVM). Otherwise stitch row-by-row so we
    // don't smear data across the 80-column hardware stride.
    if (scrW === _HW_TXT_W) {
        sys.pokeBytes(base - _TA_CHAR, tb, len)
    } else {
        for (let y = 0; y < scrH; y++) {
            sys.pokeBytes(base - _TA_CHAR - y * _HW_TXT_W,
                          tb.subarray(y * scrW, y * scrW + scrW), scrW)
        }
    }

    // Attribute planes — skip entirely if nothing but AA_NORMAL was set.
    let needAttr = false
    for (let i = 0; i < len; i++) {
        if (ab[i] !== AA_NORMAL) { needAttr = true; break }
    }
    if (!needAttr) {
        // Even when all-NORMAL we still want a known palette across the cells
        // we just touched, otherwise leftover colours from prior text-mode
        // output bleed through. Fill the visible region with WHITE-on-BLACK.
        if (!_scratchFore || _scratchFore.length < len) {
            _scratchFore = new Uint8Array(len)
            _scratchBack = new Uint8Array(len)
        }
        _scratchFore.fill(_FG_NORMAL, 0, len)
        _scratchBack.fill(_BG_NORMAL, 0, len)
    } else {
        if (!_scratchFore || _scratchFore.length < len) {
            _scratchFore = new Uint8Array(len)
            _scratchBack = new Uint8Array(len)
        }
        for (let i = 0; i < len; i++) {
            const a = ab[i]
            let fg = _FG_NORMAL
            let bg = _BG_NORMAL
            if      (a === AA_REVERSE)  { fg = _BG_NORMAL; bg = _FG_NORMAL }
            else if (a === AA_DIM)      { fg = _FG_DIM     }
            else if (a === AA_BOLD ||
                     a === AA_BOLDFONT) { fg = _FG_BOLD    }
            else if (a === AA_SPECIAL)  { fg = _FG_SPECIAL }
            _scratchFore[i] = fg
            _scratchBack[i] = bg
        }
    }

    if (scrW === _HW_TXT_W) {
        sys.pokeBytes(base - _TA_FORE, _scratchFore, len)
        sys.pokeBytes(base - _TA_BACK, _scratchBack, len)
    } else {
        for (let y = 0; y < scrH; y++) {
            const off = y * scrW
            sys.pokeBytes(base - _TA_FORE - y * _HW_TXT_W,
                          _scratchFore.subarray(off, off + scrW), scrW)
            sys.pokeBytes(base - _TA_BACK - y * _HW_TXT_W,
                          _scratchBack.subarray(off, off + scrW), scrW)
        }
    }
    ctx._flushed = true
}

// ── Drawing a bitmap font into the image buffer ─────────────────────────────
// Reproduces bb/print.c:print() / pscale() / fastscale(). The font glyph is
// rasterised at the requested width × height (subpixel scaling via DDA), with
// the per-pixel font value clamped against `color` (which is the ink intensity
// applied where the source glyph is non-zero).
function _fastscale(b1, b1Base, b2, b2Base, x1, x2, y1, y2, width1, width2, color) {
    if (!x1 || !x2 || !y1 || !y2) return
    width2 -= x2
    let ddx = x1 + x1
    const ddx1 = x2 + x2
    let spx = 0
    if (ddx1 < ddx) { spx = (ddx / ddx1) | 0; ddx = ddx % ddx1 }
    let ddy = y1 + y1
    const ddy1 = y2 + y2
    let spy = 0
    if (ddy1 < ddy) { spy = ((ddy / ddy1) | 0) * width1; ddy = ddy % ddy1 }
    let ey = -ddy1
    let p1 = b1Base
    let p1Line = b1Base
    let p2 = b2Base
    for (let yy = y2; yy > 0; yy--) {
        let ex = -ddx1
        let pp = p1
        for (let xx = x2; xx > 0; xx--) {
            if (b1[pp]) b2[p2] = color
            p2++
            pp += spx
            ex += ddx
            if (ex > 0) { pp++; ex -= ddx1 }
        }
        p2 += width2
        p1Line += spy
        ey += ddy
        if (ey > 0) { p1Line += width1; ey -= ddy1 }
        p1 = p1Line
    }
}

function _pscale(ctx, x1, y1, x2, y2, gdata, gbase, gw, gh, color) {
    const W = ctx.imgW, H = ctx.imgH
    const buf = ctx.imagebuffer
    if (x2 <= 0 || x1 >= W || y2 <= 0 || y1 >= H) return
    // Fast path: fully inside.
    if (x1 >= 0 && x2 < W && y1 >= 0 && y2 <= H) {
        _fastscale(gdata, gbase, buf, x1 + W * y1,
                   gw, x2 - x1, gh, y2 - y1, gw, W, color)
        return
    }
    // Clipped path.
    let stepX = gw / (x2 - x1)
    let xx1, xx2
    if (x1 < 0) { xx1 = (-stepX * x1) | 0; x1 = 0 } else xx1 = 0
    if (x2 > W) { xx2 = (stepX * (W - x1)) | 0; x2 = W - 1 } else xx2 = gw
    let stepY = gh / (y2 - y1)
    let yy1, yy2
    if (y1 < 0) { yy1 = (-stepY * y1) | 0; y1 = 0 } else yy1 = 0
    if (y2 > H) { yy2 = (stepY * (H - y1)) | 0; y2 = H - 1 } else yy2 = gh
    _fastscale(gdata, gbase + xx1 + yy1 * gw,
               buf, x1 + W * y1,
               xx2 - xx1, x2 - x1, yy2 - yy1, y2 - y1, gw, W, color)
}

// aa.print(ctx, x, y, width, height, font, color, text)
//   x, y    : top-left in image-buffer pixels (NOT screen cells)
//   width   : pixel width of EACH glyph after scaling
//   height  : pixel height after scaling
//   font    : font descriptor from font5x7() / fontFromBitmap()
//   color   : ink luminance (0..255) drawn where the glyph is non-zero
//   text    : string
function _print(ctx, x, y, width, height, font, color, text) {
    if (!font) font = font5x7()
    const fw = font.width, fh = font.height
    width  = width  | 0
    height = height | 0
    color  = color  | 0
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i) & 0xFF
        _pscale(ctx,
                (x + i * width) | 0, y | 0,
                (x + (i + 1) * width) | 0, (y + height) | 0,
                font.data, code * fw * fh,
                fw, fh, color)
    }
}

// ── A few line / fill primitives that operate on the image buffer ──────────
function line(ctx, x0, y0, x1, y1, color) {
    x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1
    const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1
    let err = dx + dy
    for (let safety = 0; safety < 65536; safety++) {
        putpixel(ctx, x0, y0, color)
        if (x0 === x1 && y0 === y1) return
        const e2 = 2 * err
        if (e2 >= dy) { err += dy; x0 += sx }
        if (e2 <= dx) { err += dx; y0 += sy }
    }
}

// ── backconvert: inverse of render() ────────────────────────────────────────
// Mirrors bb/backconv.c. Reads (char, attr) cells from the text+attr buffers
// and writes the matching 4-pixel quadrant back into the image buffer. Used by
// messager.c's tographics() so devezen* can apply image-domain fade effects to
// content that was originally typeset in text mode.
//
// The C implementation indexes a per-glyph LUT (context->parameters) built at
// startup. We rebuild the equivalent lazily on first call from GLYPHS.
let _BC_LUT = null
function _buildBackconvertLUT() {
    if (_BC_LUT) return _BC_LUT
    // 256 entries, each Uint8Array(4) [NW, NE, SW, SE]
    const lut = new Uint8Array(256 * 4)
    // Default everything to mid-grey so unknown chars don't render as black.
    for (let i = 0; i < 256; i++) {
        lut[i*4+0] = lut[i*4+1] = lut[i*4+2] = lut[i*4+3] = 0
    }
    for (let g = 0; g < GLYPHS.length; g++) {
        const code = _G_CH[g]
        lut[code*4+0] = _G_Q[g*4+0] | 0
        lut[code*4+1] = _G_Q[g*4+1] | 0
        lut[code*4+2] = _G_Q[g*4+2] | 0
        lut[code*4+3] = _G_Q[g*4+3] | 0
    }
    _BC_LUT = lut
    return lut
}

function backconvert(ctx, x1, y1, x2, y2) {
    const lut = _buildBackconvertLUT()
    const scrW = ctx.scrW
    const imgW = ctx.imgW
    const tb = ctx.textbuffer, ab = ctx.attrbuffer, ib = ctx.imagebuffer
    if (x1 < 0) x1 = 0
    if (y1 < 0) y1 = 0
    if (x2 > scrW) x2 = scrW
    if (y2 > ctx.scrH) y2 = ctx.scrH
    for (let y = y1; y < y2; y++) {
        for (let x = x1; x < x2; x++) {
            const idx = y * scrW + x
            const ch  = tb[idx] & 0xFF
            const att = ab[idx]
            let nw = lut[ch*4+0]
            let ne = lut[ch*4+1]
            let sw = lut[ch*4+2]
            let se = lut[ch*4+3]
            if (att === AA_REVERSE) { nw = 255-nw; ne = 255-ne; sw = 255-sw; se = 255-se }
            const ix = x * 2, iy = y * 2
            ib[iy * imgW + ix]         = nw
            ib[iy * imgW + ix + 1]     = ne
            ib[(iy + 1) * imgW + ix]     = sw
            ib[(iy + 1) * imgW + ix + 1] = se
        }
    }
}

function fillrect(ctx, x, y, w, h, color) {
    const x1 = (x + w) | 0
    const y1 = (y + h) | 0
    for (let yy = y | 0; yy < y1; yy++)
        for (let xx = x | 0; xx < x1; xx++)
            putpixel(ctx, xx, yy, color)
}

// ── Export ──────────────────────────────────────────────────────────────────
exports = {
    AA_NORMAL: AA_NORMAL,
    AA_DIM: AA_DIM,
    AA_BOLD: AA_BOLD,
    AA_BOLDFONT: AA_BOLDFONT,
    AA_REVERSE: AA_REVERSE,
    AA_SPECIAL: AA_SPECIAL,

    AA_NONE: AA_NONE,
    AA_ERRORDISTRIB: AA_ERRORDISTRIB,
    AA_FLOYD_S: AA_FLOYD_S,

    init: init,
    close: close,
    imgwidth: imgwidth,
    imgheight: imgheight,
    scrwidth: scrwidth,
    scrheight: scrheight,
    mmwidth: mmwidth,
    mmheight: mmheight,

    putpixel: putpixel,
    getpixel: getpixel,
    clear: clear,
    cleartext: cleartext,

    render: render,
    renderpalette: renderpalette,
    flush: flush,

    gotoxy: gotoxy,
    puts: puts,
    hidecursor: hidecursor,
    showcursor: showcursor,
    getrenderparams: getrenderparams,

    print: _print,
    line: line,
    fillrect: fillrect,
    backconvert: backconvert,

    font5x7: font5x7,
    fontFromBitmap: fontFromBitmap,
    loadChrFont: loadChrFont,
}

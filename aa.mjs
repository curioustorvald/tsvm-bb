/*
 * aalib.mjs — AAlib port for TSVM/TVDOS
 *
 *   Original:  Jan Hubicka & the AA-group, 1997
 *   Port:      CuriousTorvald
 *
 * Faithful port of AAlib 1.2's core renderer:
 *
 *   - aa_calcparams() reduces every glyph in a bitmap font (default 8x16) to
 *     a five-tuple (NW/NE/SW/SE brightness + sum) under each enabled attribute
 *     (NORMAL / DIM / BOLD / BOLDFONT / REVERSE) — exactly mirroring aafont.c.
 *   - aa_mktable() builds a 65536-entry LUT keyed on the 4-bit quantised image
 *     quadrants, plus a 256-entry "filltable" for nearly-uniform cells.
 *     A BFS pass propagates each placed entry to its 8 neighbours, identically
 *     to aamktabl.c.
 *   - aa_render() / aa_renderpalette() apply brightness/contrast/gamma,
 *     optional dither (none / error-distribution / Floyd-Steinberg), then
 *     look up (char, attr) directly from the LUTs — same control flow as
 *     aarender.c.
 *   - aa_flush() blits the textbuffer + a 4-colour FG/BG palette derived from
 *     the attribute plane (black background; dark-grey / grey / white inks;
 *     reverse cells flip FG/BG) straight into TSVM text-mode VRAM.
 *
 * Differences from the C original:
 *
 *   - The "all-uniform cell" branch uses the filltable; otherwise we use the
 *     pos(NE,NW,SE,SW) → table[] lookup (matching aalib's bit layout).
 *   - We treat AA_SPECIAL (5) as a user-only overlay colour, exactly like
 *     the original AAlib: render() never produces it, but puts()/flush()
 *     route it to a distinct foreground hue.
 *   - aa.print(), aa.line(), aa.fillrect(), aa.backconvert(),
 *     fontFromBitmap(), loadChrFont(), loadChrFontROM() are TSVM extensions
 *     kept from the previous port — they operate on the image buffer.
 *   - There is no embedded default font: callers must load one (typically via
 *     loadChrFontROM() pointed at a font ROM in the format produced by
 *     tvdos/tuidev/font_rom_builder.c) and pass it to aa.init() as opts.font.
 */

// ── Attribute constants ─────────────────────────────────────────────────────
const AA_NORMAL   = 0
const AA_DIM      = 1
const AA_BOLD     = 2
const AA_BOLDFONT = 3
const AA_REVERSE  = 4
const AA_SPECIAL  = 5

const AA_NATTRS = 5
const AA_NPARAMS = 5
const NCHARS = 256 * AA_NATTRS

// ── Supported-mask flags (which attribute sets to build into the LUT) ───────
const AA_NORMAL_MASK   = 1 << AA_NORMAL
const AA_DIM_MASK      = 1 << AA_DIM
const AA_BOLD_MASK     = 1 << AA_BOLD
const AA_BOLDFONT_MASK = 1 << AA_BOLDFONT
const AA_REVERSE_MASK  = 1 << AA_REVERSE
const AA_ALL    = 128   // accept all bytes, not just printable
const AA_EIGHT  = 256   // accept 8-bit characters > 160

// ── Dither modes ────────────────────────────────────────────────────────────
const AA_NONE         = 0
const AA_ERRORDISTRIB = 1
const AA_FLOYD_S      = 2

// ── Glyph-attribute priority for tie-breaking in aa_mktable ─────────────────
// Higher = preferred. Order: NORMAL=4, DIM=5, BOLD=3, BOLDFONT=2, REVERSE=1.
const _PRIORITY = [4, 5, 3, 2, 1]

// ── Default tuning (matches aalib.c) ────────────────────────────────────────
const _DEFAULT_DIMMUL  = 5.3
const _DEFAULT_BOLDMUL = 2.7
const _DEFAULT_SUPPORTED = AA_NORMAL_MASK | AA_DIM_MASK | AA_BOLD_MASK


// ── ALOWED — same predicate as aaint.h ──────────────────────────────────────
function _isgraph(c) { return c >= 33 && c <= 126 }
function _alowed(i, supported) {
    const c = i & 0xff
    const attr = (i >> 8) | 0
    if (!_isgraph(c) &&
        c !== 0x20 &&
        !(c > 160 && (supported & AA_EIGHT)) &&
        !((supported & AA_ALL) && c)) return false
    return (supported & (1 << attr)) !== 0
}

// ── aa_calcparams — port of aafont.c ────────────────────────────────────────
const _MUL = 8

// Returns the four raw quadrant brightnesses for glyph `code` under attribute
// `attr`. Works on the pixel-per-byte font layout (the same one used by
// loadChrFont() and aa.print()), so any font width × height is supported —
// AAlib's original was hard-coded to 8 pixels wide, but the underlying maths
// is just "count set pixels in each of the four quadrants".
//
// Quadrant convention matches AAlib's bit-numbering quirk: v1 is RIGHT-top,
// v2 is LEFT-top, v3 is RIGHT-bottom, v4 is LEFT-bottom. The table lookup
// (pos(NE, NW, SE, SW) below) swaps left/right back to recover the natural
// orientation.
function _glyphValues(font, code, attr, dimmul, boldmul, out) {
    const fd = font.data
    const fw = font.width | 0
    const fh = font.height | 0
    const base = code * fw * fh
    const halfW = fw >> 1                  // floor — for 7-wide: 3
    const halfH = fh >> 1                  // for 14-tall: 7
    const leftW = halfW                    // left half cols [0..leftW-1]
    const rightW = fw - halfW              // right half cols [leftW..fw-1]
    const topH = halfH                     // top rows [0..topH-1]
    const botH = fh - halfH                // bottom rows [topH..fh-1]
    let v1 = 0, v2 = 0, v3 = 0, v4 = 0
    // Top half rows
    for (let r = 0; r < topH; r++) {
        const rowBase = base + r * fw
        // Left half → v2 (left-top)
        for (let x = 0; x < leftW; x++) if (fd[rowBase + x]) v2++
        // Right half → v1 (right-top)
        for (let x = leftW; x < fw; x++) if (fd[rowBase + x]) v1++
    }
    // Bottom half rows
    for (let r = topH; r < fh; r++) {
        const rowBase = base + r * fw
        for (let x = 0; x < leftW; x++) if (fd[rowBase + x]) v4++
        for (let x = leftW; x < fw; x++) if (fd[rowBase + x]) v3++
    }
    v1 *= _MUL; v2 *= _MUL; v3 *= _MUL; v4 *= _MUL
    if (attr === AA_REVERSE) {
        // Per-quadrant max (asymmetric for odd widths/heights).
        const mNE = rightW * topH * _MUL
        const mNW = leftW  * topH * _MUL
        const mSE = rightW * botH * _MUL
        const mSW = leftW  * botH * _MUL
        v1 = mNE - v1; v2 = mNW - v2; v3 = mSE - v3; v4 = mSW - v4
    } else if (attr === AA_DIM) {
        v1 = (v1 + 1) / dimmul
        v2 = (v2 + 1) / dimmul
        v3 = (v3 + 1) / dimmul
        v4 = (v4 + 1) / dimmul
    } else if (attr === AA_BOLD) {
        v1 = v1 * boldmul
        v2 = v2 * boldmul
        v3 = v3 * boldmul
        v4 = v4 * boldmul
    } else if (attr === AA_BOLDFONT) {
        // BOLDFONT thickens the glyph by counting "would-light-up-if-bolded"
        // neighbour pixels — the canset() condition of aafont.c, generalised
        // from "bit n is 0 but bit n-1 is 1" to "this pixel is dark but the
        // pixel immediately to its left is lit". Each such pixel adds MUL.
        for (let r = 0; r < topH; r++) {
            const rowBase = base + r * fw
            for (let x = 0; x < leftW; x++) {
                if (fd[rowBase + x]) v2 += _MUL
                else if (x > 0 && fd[rowBase + x - 1]) v2 += _MUL
            }
            for (let x = leftW; x < fw; x++) {
                if (fd[rowBase + x]) v1 += _MUL
                else if (x > 0 && fd[rowBase + x - 1]) v1 += _MUL
            }
        }
        for (let r = topH; r < fh; r++) {
            const rowBase = base + r * fw
            for (let x = 0; x < leftW; x++) {
                if (fd[rowBase + x]) v4 += _MUL
                else if (x > 0 && fd[rowBase + x - 1]) v4 += _MUL
            }
            for (let x = leftW; x < fw; x++) {
                if (fd[rowBase + x]) v3 += _MUL
                else if (x > 0 && fd[rowBase + x - 1]) v3 += _MUL
            }
        }
    }
    out[0] = v1; out[1] = v2; out[2] = v3; out[3] = v4
}

// Computes a (NCHARS * 5) Uint16Array of glyph parameters. parameters[i*5 + k]
// holds p[k] for character/attribute combination i (i = attr*256 + char).
function aa_calcparams(font, supported, dimmul, boldmul) {
    const params = new Uint16Array((NCHARS + 1) * AA_NPARAMS)
    const tmp = new Float64Array(4)
    let ma1 = 0, ma2 = 0, ma3 = 0, ma4 = 0, msum = 0
    let mi1 = 50000, mi2 = 50000, mi3 = 50000, mi4 = 50000, misum = 50000
    // First pass — find min/max ranges (uses ALOWED).
    for (let i = 0; i < NCHARS; i++) {
        if (!_alowed(i, supported)) continue
        const ch = i & 0xff, attr = i >>> 8
        _glyphValues(font, ch, attr, dimmul, boldmul, tmp)
        const v1 = tmp[0], v2 = tmp[1], v3 = tmp[2], v4 = tmp[3]
        if (v1 > ma1) ma1 = v1
        if (v2 > ma2) ma2 = v2
        if (v3 > ma3) ma3 = v3
        if (v4 > ma4) ma4 = v4
        const s = v1 + v2 + v3 + v4
        if (s > msum) msum = s
        if (v1 < mi1) mi1 = v1
        if (v2 < mi2) mi2 = v2
        if (v3 < mi3) mi3 = v3
        if (v4 < mi4) mi4 = v4
        if (s < misum) misum = s
    }
    msum -= misum
    mi1 = misum / 4; mi2 = misum / 4; mi3 = misum / 4; mi4 = misum / 4
    ma1 = msum / 4;  ma2 = msum / 4;  ma3 = msum / 4;  ma4 = msum / 4
    // Second pass — write normalised parameters (ALOWED1 in C is always true).
    for (let i = 0; i < NCHARS; i++) {
        const ch = i & 0xff, attr = i >>> 8
        _glyphValues(font, ch, attr, dimmul, boldmul, tmp)
        const v1r = tmp[0], v2r = tmp[1], v3r = tmp[2], v4r = tmp[3]
        const sr = v1r + v2r + v3r + v4r
        let sum = Math.floor((sr - misum) * (1020 / msum) + 0.5)
        let v1 = Math.floor((v1r - mi1) * (255 / ma1) + 0.5)
        let v2 = Math.floor((v2r - mi2) * (255 / ma2) + 0.5)
        let v3 = Math.floor((v3r - mi3) * (255 / ma3) + 0.5)
        let v4 = Math.floor((v4r - mi4) * (255 / ma4) + 0.5)
        if (v1 > 255) v1 = 255; else if (v1 < 0) v1 = 0
        if (v2 > 255) v2 = 255; else if (v2 < 0) v2 = 0
        if (v3 > 255) v3 = 255; else if (v3 < 0) v3 = 0
        if (v4 > 255) v4 = 255; else if (v4 < 0) v4 = 0
        if (sum > 1020) sum = 1020; else if (sum < 0) sum = 0
        params[i * 5 + 0] = v1
        params[i * 5 + 1] = v2
        params[i * 5 + 2] = v3
        params[i * 5 + 3] = v4
        params[i * 5 + 4] = sum
    }
    return params
}

// ── aa_mktable — port of aamktabl.c ─────────────────────────────────────────
function _pow2(x) { return x * x }
function _pos(i1, i2, i3, i4) { return (i1 << 12) + (i2 << 8) + (i3 << 4) + i4 }
function _dist(i1, i2, i3, i4, i5, y1, y2, y3, y4, y5) {
    return 2 * (_pow2(i1 - y1) + _pow2(i2 - y2) + _pow2(i3 - y3) + _pow2(i4 - y4)) + _pow2(i5 - y5)
}
function _dist1(i1, i2, i3, i4, i5, y1, y2, y3, y4, y5) {
    return _pow2(i1 - y1) + _pow2(i2 - y2) + _pow2(i3 - y3) + _pow2(i4 - y4) + 2 * _pow2(i5 - y5)
}

function aa_mktable(parameters, supported) {
    const TABLESIZE = 65536
    const table = new Uint16Array(TABLESIZE)
    const filltable = new Uint16Array(256)
    const next = new Int32Array(TABLESIZE)
    for (let i = 0; i < TABLESIZE; i++) next[i] = i
    let first = -1, last = -1
    function add(i) {
        if (next[i] === i && last !== i) {
            if (last !== -1) { next[last] = i; last = i }
            else { last = first = i }
        }
    }
    // 1) Place every allowed glyph at its quantised position; if a slot is
    //    already taken, keep whichever glyph is closer to the slot's centre
    //    (with priority resolving ties).
    for (let i = 0; i < NCHARS; i++) {
        if (!_alowed(i, supported)) continue
        const i1 = parameters[i * 5 + 0]
        const i2 = parameters[i * 5 + 1]
        const i3 = parameters[i * 5 + 2]
        const i4 = parameters[i * 5 + 3]
        const i5 = parameters[i * 5 + 4]
        let p1 = i1 >> 4, p2 = i2 >> 4, p3 = i3 >> 4, p4 = i4 >> 4
        const p = _pos(p1, p2, p3, p4)
        if (table[p]) {
            const ex = table[p]
            const ex1 = parameters[ex * 5 + 0]
            const ex2 = parameters[ex * 5 + 1]
            const ex3 = parameters[ex * 5 + 2]
            const ex4 = parameters[ex * 5 + 3]
            const ex5 = parameters[ex * 5 + 4]
            const pp1 = (p1 << 4) | p1
            const pp2 = (p2 << 4) | p2
            const pp3 = (p3 << 4) | p3
            const pp4 = (p4 << 4) | p4
            const ppsum = pp1 + pp2 + pp3 + pp4
            const dNew = _dist(i1, i2, i3, i4, i5,  pp1, pp2, pp3, pp4, ppsum)
            const dOld = _dist(ex1, ex2, ex3, ex4, ex5,  pp1, pp2, pp3, pp4, ppsum)
            if (dNew > dOld) continue
            if (dNew === dOld && _PRIORITY[(i >> 8)] <= _PRIORITY[(ex >> 8)]) continue
        }
        table[p] = i
        add(p)
    }
    // 2) Build filltable — best glyph for a uniform-brightness cell.
    for (let q = 0; q < 256; q++) {
        let mindist = Infinity
        let best = 0
        for (let i = 0; i < NCHARS; i++) {
            if (!_alowed(i, supported)) continue
            const d1 = _dist1(parameters[i * 5 + 0], parameters[i * 5 + 1],
                              parameters[i * 5 + 2], parameters[i * 5 + 3],
                              parameters[i * 5 + 4],
                              q, q, q, q, q * 4)
            if (d1 < mindist ||
                (d1 === mindist && _PRIORITY[(i >> 8)] > _PRIORITY[(best >> 8)])) {
                filltable[q] = i
                mindist = d1
                best = i
            }
        }
    }
    // 3) BFS propagation: for every placed slot, look at its 8 neighbours
    //    along the 4 quadrant axes. If a neighbour is empty (or holds a
    //    glyph further from its slot centre than the current one), claim it.
    while (true) {
        if (last !== -1) next[last] = last
        else break
        const blocked = last
        let i = first
        if (i === -1) break
        first = -1; last = -1
        let prev
        do {
            const m0 = (i >> 12) & 15
            const m1 = (i >> 8) & 15
            const m2 = (i >> 4) & 15
            const m3 = i & 15
            const c = table[i]
            const cp0 = parameters[c * 5 + 0]
            const cp1 = parameters[c * 5 + 1]
            const cp2 = parameters[c * 5 + 2]
            const cp3 = parameters[c * 5 + 3]
            const cp4 = parameters[c * 5 + 4]
            for (let dm = 0; dm < 4; dm++) {
                for (let sgn = -1; sgn <= 1; sgn += 2) {
                    let n0 = m0, n1 = m1, n2 = m2, n3 = m3
                    if (dm === 0) { n0 += sgn; if (n0 < 0 || n0 >= 16) continue }
                    else if (dm === 1) { n1 += sgn; if (n1 < 0 || n1 >= 16) continue }
                    else if (dm === 2) { n2 += sgn; if (n2 < 0 || n2 >= 16) continue }
                    else { n3 += sgn; if (n3 < 0 || n3 >= 16) continue }
                    const index = _pos(n0, n1, n2, n3)
                    const ch = table[index]
                    if (ch === c || index === blocked) continue
                    let replace = !ch
                    if (!replace) {
                        const ii1 = (n0 << 4) | n0
                        const ii2 = (n1 << 4) | n1
                        const ii3 = (n2 << 4) | n2
                        const ii4 = (n3 << 4) | n3
                        const iisum = ii1 + ii2 + ii3 + ii4
                        const dNew = _dist(ii1, ii2, ii3, ii4, iisum,
                                           cp0, cp1, cp2, cp3, cp4)
                        const dOld = _dist(ii1, ii2, ii3, ii4, iisum,
                                           parameters[ch * 5 + 0],
                                           parameters[ch * 5 + 1],
                                           parameters[ch * 5 + 2],
                                           parameters[ch * 5 + 3],
                                           parameters[ch * 5 + 4])
                        if (dNew < dOld) replace = true
                    }
                    if (replace) { table[index] = c; add(index) }
                }
            }
            prev = i
            i = next[i]
            next[prev] = prev
        } while (i !== prev)
    }
    return { table: table, filltable: filltable }
}

// ── TSVM extension ──────────────────────────────────

function fontFromBitmap(width, height, data) {
    return { width: width | 0, height: height | 0, data: data }
}

// loadChrFontROM — load a TSVM native 7×14 font ROM file in the format
// produced by tvdos/tuidev/font_rom_builder.c. This is the same byte layout
// the hardware character ROM (GraphicsAdapter.kt) uses, so the glyph-selection
// brightness profile computed by aa_calcparams() stays consistent with what
// the text mode actually draws.
//
// File format:
//   - Each glyph is 14 bytes (one byte per row); bit 6 = leftmost pixel.
//   - 128 glyphs per ROM (1792 bytes) padded to 1920 bytes.
//   - 3840-byte file = low ROM (chars 0-127) ++ high ROM (chars 128-255).
//   - 1920-byte file = high ROM only; chars 0-127 stay blank.
const _ROM_PADDED_SIZE = 1920
const _ROM_GLYPHS_PER_HALF = 128
const _ROM_GLYPH_BYTES = 14
const _ROM_FW = 7
const _ROM_FH = 14

function _parseChrFontROM(blob) {
    if (blob.length !== _ROM_PADDED_SIZE && blob.length !== _ROM_PADDED_SIZE * 2) {
        throw Error("aalib.loadChrFontROM: bad ROM size " + blob.length +
                    " (expected " + _ROM_PADDED_SIZE + " or " +
                    (_ROM_PADDED_SIZE * 2) + ")")
    }
    const data = new Uint8Array(256 * _ROM_FW * _ROM_FH)
    const halves = blob.length / _ROM_PADDED_SIZE
    // 1920-byte file = high-only ROM (chars 128-255); chars 0-127 stay blank.
    const startHalf = (halves === 2) ? 0 : 1
    for (let h = 0; h < halves; h++) {
        const romStart = h * _ROM_PADDED_SIZE
        const charBase = (startHalf + h) * _ROM_GLYPHS_PER_HALF
        for (let c = 0; c < _ROM_GLYPHS_PER_HALF; c++) {
            const srcBase = romStart + c * _ROM_GLYPH_BYTES
            const dstBase = (charBase + c) * _ROM_FW * _ROM_FH
            for (let r = 0; r < _ROM_FH; r++) {
                const b = blob[srcBase + r] & 0xFF
                for (let x = 0; x < _ROM_FW; x++) {
                    data[dstBase + r * _ROM_FW + x] =
                        ((b >> (6 - x)) & 1) ? 0xFF : 0x00
                }
            }
        }
    }
    return {
        width: _ROM_FW, height: _ROM_FH,
        data: data,
        name: "TSVM 7x14 ROM font",
        shortname: "tsvm",
    }
}

function loadChrFontROM(path) {
    const fh = files.open(path)
    if (!fh.exists) throw Error("aalib.loadChrFontROM: file not found: " + path)
    return _parseChrFontROM(fh.bread())
}

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

// Lazily-built shared table cache, keyed by (font, supported, dimmul, boldmul).
// Two contexts that share the same render settings re-use the same 128KB+
// LUT instead of rebuilding it.
const _tableCache = []
function _getTables(font, supported, dimmul, boldmul) {
    for (let i = 0; i < _tableCache.length; i++) {
        const e = _tableCache[i]
        if (e.font === font && e.supported === supported &&
            e.dimmul === dimmul && e.boldmul === boldmul) return e
    }
    const params = aa_calcparams(font, supported, dimmul, boldmul)
    const t = aa_mktable(params, supported)
    const mval = params[t.filltable[255] * 5 + 4]
    const e = {
        font: font, supported: supported, dimmul: dimmul, boldmul: boldmul,
        parameters: params, table: t.table, filltable: t.filltable,
        mval: mval || 1,
    }
    _tableCache.push(e)
    return e
}

function init(scrW, scrH, opts) {
    if (scrW === undefined || scrH === undefined) {
        const s = _termSize()
        if (scrW === undefined) scrW = s.cols
        if (scrH === undefined) scrH = s.rows
    }
    scrW = scrW | 0
    scrH = scrH | 0
    const imgW = scrW * 2
    const imgH = scrH * 2
    opts = opts || {}
    const font     = opts.font
    if (!font) throw Error("aalib.init: opts.font is required (load via aalib.loadChrFontROM)")
    const supported= (opts.supported !== undefined) ? opts.supported : _DEFAULT_SUPPORTED
    const dimmul   = opts.dimmul    || _DEFAULT_DIMMUL
    const boldmul  = opts.boldmul   || _DEFAULT_BOLDMUL
    const t = _getTables(font, supported, dimmul, boldmul)
    return {
        scrW: scrW, scrH: scrH,
        imgW: imgW, imgH: imgH,
        mmW: scrW, mmH: scrH,
        imagebuffer: new Uint8Array(imgW * imgH),
        textbuffer:  new Uint8Array(scrW * scrH).fill(0x20),
        attrbuffer:  new Uint8Array(scrW * scrH),
        cursorX: 0, cursorY: 0,
        font: font,
        supported: supported,
        dimmul: dimmul, boldmul: boldmul,
        parameters: t.parameters,
        table: t.table,
        filltable: t.filltable,
        mval: t.mval,
        _err: null,
        _flushed: false,
    }
}

function close(ctx) {
    print("\x1B[m")
    con.curs_set(1)
}

function setfont(ctx, font) {
    const t = _getTables(font, ctx.supported, ctx.dimmul, ctx.boldmul)
    ctx.font = font
    ctx.parameters = t.parameters
    ctx.table = t.table
    ctx.filltable = t.filltable
    ctx.mval = t.mval
}

function setsupported(ctx, supported) {
    const t = _getTables(ctx.font, supported, ctx.dimmul, ctx.boldmul)
    ctx.supported = supported
    ctx.parameters = t.parameters
    ctx.table = t.table
    ctx.filltable = t.filltable
    ctx.mval = t.mval
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

function clear(ctx) { ctx.imagebuffer.fill(0) }

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
        bright:    0,
        contrast:  0,
        gamma:     1.0,
        dither:    AA_NONE,
        randomval: 0,
        inversion: 0,
    }
}

// ── Render ──────────────────────────────────────────────────────────────────
// Mirror of aalib's DO_CONTRAST macro.
function _doContrast(i, c) {
    if (i < c) return 0
    if (i > 256 - c) return 255
    return ((i - c) * 255 / (255 - 2 * c)) | 0
}
const _VAL = 13

// LCG matching aalib's myrand() — keeps dithering reproducible.
let _rngState = 0
function _myrand() {
    _rngState = ((Math.imul(_rngState, 1103515245) + 12345) | 0) & 0xffffffff
    return _rngState
}

function renderpalette(ctx, palette, params, x1, y1, x2, y2) {
    if (x1 === undefined) { x1 = 0; y1 = 0; x2 = ctx.scrW; y2 = ctx.scrH }
    x1 |= 0; y1 |= 0; x2 |= 0; y2 |= 0
    if (x2 < 0 || y2 < 0 || x1 > ctx.scrW || y1 > ctx.scrH) return
    if (x2 > ctx.scrW) x2 = ctx.scrW
    if (y2 > ctx.scrH) y2 = ctx.scrH
    if (x1 < 0) x1 = 0
    if (y1 < 0) y1 = 0

    const wi      = ctx.imgW
    const scrW    = ctx.scrW
    const img     = ctx.imagebuffer
    const tb      = ctx.textbuffer
    const ab      = ctx.attrbuffer
    const tbl     = ctx.table
    const fill    = ctx.filltable
    const params5 = ctx.parameters
    const mval    = ctx.mval || 1

    const bright   = params.bright   | 0
    const contrast = params.contrast | 0
    const dither   = params.dither   | 0
    const randval  = params.randomval| 0
    const inv      = params.inversion ? 1 : 0
    const gamma    = (params.gamma === undefined) ? 1.0 : params.gamma
    const useGamma = gamma !== 1.0

    // Build the brightness LUT — palette + bright/contrast/gamma/inversion.
    const table256 = new Uint8Array(256)
    for (let i = 0; i < 256; i++) {
        let y = palette[i] + bright
        if (y > 255) y = 255
        else if (y < 0) y = 0
        if (contrast) y = _doContrast(y, contrast)
        if (useGamma) {
            y = Math.pow(y / 255, gamma) * 255 + 0.5
            y = y | 0
        }
        if (inv) y = 255 - y
        if (y > 255) y = 255
        else if (y < 0) y = 0
        table256[i] = y
    }
    let randHalf = 0
    if (randval) randHalf = (randval / 2) | 0

    // Floyd-Steinberg state — two single-row error buffers (one for the
    // current row being read, one for the row whose error we're accumulating).
    let errs0 = null, errs1 = null, cur = 0
    if (dither === AA_FLOYD_S) {
        errs0 = new Int32Array(x2 + 6)
        errs1 = new Int32Array(x2 + 6)
        cur = 0
    }

    for (let y = y1; y < y2; y++) {
        let pos  = 2 * y * wi
        let pos1 = y * scrW
        let esum = 0
        for (let x = x1; x < x2; x++) {
            let i1 = table256[img[pos]]
            let i2 = table256[img[pos + 1]]
            let i3 = table256[img[pos + wi]]
            let i4 = table256[img[pos + 1 + wi]]
            if (randval) {
                const r = _myrand() >>> 0
                i1 += (r          % randval) - randHalf
                i2 += ((r >>> 8)  % randval) - randHalf
                i3 += ((r >>> 16) % randval) - randHalf
                i4 += ((r >>> 24) % randval) - randHalf
                if (i1 < 0) i1 = 0; else if (i1 > 255) i1 = 255
                if (i2 < 0) i2 = 0; else if (i2 > 255) i2 = 255
                if (i3 < 0) i3 = 0; else if (i3 > 255) i3 = 255
                if (i4 < 0) i4 = 0; else if (i4 > 255) i4 = 255
            }
            if (dither === AA_ERRORDISTRIB) {
                const e4 = (esum + 2) >> 2
                i1 += e4; i2 += e4; i3 += e4; i4 += e4
            } else if (dither === AA_FLOYD_S) {
                if (i1 | i2 | i3 | i4) {
                    // Spread the previous esum into this row's neighbours.
                    errs1[x - 2 + 3] += esum >> 4
                    errs1[x - 1 + 3] += (5 * esum) >> 4
                    errs1[x + 3]      = (3 * esum) >> 4
                    esum = (7 * esum) >> 4
                    esum += errs0[x + 3]
                    i1 += (esum + 1) >> 2
                    i2 += (esum)     >> 2
                    i3 += (esum + 3) >> 2
                    i4 += (esum + 2) >> 2
                }
            }

            let val
            if (dither) {
                let s = i1 + i2 + i3 + i4
                let avg = s >> 2
                if (Math.abs(i1 - avg) < _VAL &&
                    Math.abs(i2 - avg) < _VAL &&
                    Math.abs(i3 - avg) < _VAL &&
                    Math.abs(i4 - avg) < _VAL) {
                    if (s >= 4 * 256) { avg = 255; s = 4 * 256 - 1 }
                    else if (avg < 0) { avg = 0 }
                    val = fill[avg]
                } else {
                    if (i1 < 0) i1 = 0; else if (i1 > 255) i1 = 255
                    if (i2 < 0) i2 = 0; else if (i2 > 255) i2 = 255
                    if (i3 < 0) i3 = 0; else if (i3 > 255) i3 = 255
                    if (i4 < 0) i4 = 0; else if (i4 > 255) i4 = 255
                    s = i1 + i2 + i3 + i4
                    val = tbl[((i2 >> 4) << 12) | ((i1 >> 4) << 8) |
                              ((i4 >> 4) << 4)  | (i3 >> 4)]
                }
                esum = s - ((params5[val * 5 + 4] * 1020 / mval) | 0)
            } else {
                const s = i1 + i2 + i3 + i4
                let avg = s >> 2
                if (Math.abs(i1 - avg) < _VAL &&
                    Math.abs(i2 - avg) < _VAL &&
                    Math.abs(i3 - avg) < _VAL &&
                    Math.abs(i4 - avg) < _VAL) {
                    val = fill[avg]
                } else {
                    val = tbl[((i2 >> 4) << 12) | ((i1 >> 4) << 8) |
                              ((i4 >> 4) << 4)  | (i3 >> 4)]
                }
            }
            ab[pos1] = val >> 8
            tb[pos1] = val & 0xff
            pos  += 2
            pos1 += 1
        }
        if (dither === AA_FLOYD_S) {
            if (x2 - 1 > x1) errs1[(x2 - 2) + 3] += esum >> 4
            if (x2 > x1)     errs1[(x2 - 1) + 3] += (5 * esum) >> 4
            // Rotate row buffers; clear the "new" current row's slot.
            const tmp = errs0; errs0 = errs1; errs1 = tmp
            errs1.fill(0)
            errs0[x1 + 3] = errs0[x1 + 3]   // (no-op; just clarity)
            cur ^= 1
        }
    }
}

// aa_render() in the C original just calls renderpalette with identity.
const _IDENTITY_PALETTE = (function() {
    const p = new Uint16Array(256)
    for (let i = 0; i < 256; i++) p[i] = i
    return p
})()
function render(ctx, params, x1, y1, x2, y2) {
    renderpalette(ctx, _IDENTITY_PALETTE, params, x1, y1, x2, y2)
}

// ── backconvert: inverse of render() ────────────────────────────────────────
// Uses the live parameters table (the same one render() picks from), so a
// cell's character → (NW, NE, SW, SE) brightness mapping stays consistent
// regardless of font.
function backconvert(ctx, x1, y1, x2, y2) {
    const scrW = ctx.scrW
    const imgW = ctx.imgW
    const tb = ctx.textbuffer, ab = ctx.attrbuffer, ib = ctx.imagebuffer
    const params = ctx.parameters
    if (x1 < 0) x1 = 0
    if (y1 < 0) y1 = 0
    if (x2 > scrW) x2 = scrW
    if (y2 > ctx.scrH) y2 = ctx.scrH
    for (let y = y1; y < y2; y++) {
        for (let x = x1; x < x2; x++) {
            const idx = y * scrW + x
            const ch  = tb[idx] & 0xFF
            const att = ab[idx]
            const k = ((att & 7) * 256 + ch) * 5
            // Parameters store (right-top, left-top, right-bot, left-bot);
            // the image quadrants are (left-top, right-top, left-bot, right-bot).
            let nw = params[k + 1]
            let ne = params[k + 0]
            let sw = params[k + 3]
            let se = params[k + 2]
            const ix = x * 2, iy = y * 2
            ib[iy * imgW + ix]           = nw
            ib[iy * imgW + ix + 1]       = ne
            ib[(iy + 1) * imgW + ix]     = sw
            ib[(iy + 1) * imgW + ix + 1] = se
        }
    }
}

// ── Flush to terminal (TSVM text-mode VRAM blit) ────────────────────────────
// Original AAlib supports 4 visible intensity levels by combining:
//   AA_NORMAL  → terminal default ink
//   AA_DIM     → dim ink           (darker than NORMAL)
//   AA_BOLD    → bold ink          (brighter than NORMAL)
//   AA_REVERSE → swap FG/BG        (brightest possible cell)
// Map those to the TSVM palette: dark grey, mid grey, white, and inverted
// (black-on-white) respectively. BOLDFONT shares BOLD's colour because it's
// an AAlib variant of BOLD that brightens the glyph shape, not the colour.
// AA_SPECIAL is a user-driven overlay colour.
const _BG_BLACK = 255
const _FG_WHITE = 254
const _FG_GREY  = 253
const _FG_DARKGREY = 245
const _FG_SPECIAL  = 250

function _attrFG(a) {
    switch (a) {
        case AA_DIM:      return _FG_DARKGREY
        case AA_NORMAL:   return _FG_GREY
        case AA_BOLD:
        case AA_BOLDFONT: return _FG_WHITE
        case AA_REVERSE:  return _BG_BLACK
        case AA_SPECIAL:  return _FG_SPECIAL
        default:          return _FG_GREY
    }
}
function _attrBG(a) {
    if (a === AA_REVERSE) return _FG_WHITE
    return _BG_BLACK
}

const _HW_TXT_W = 80
const _TA_FORE  = 2
const _TA_BACK  = 2562
const _TA_CHAR  = 5122
const _TA_BASE  = 253950

let _gpuBase = 0
let _gpuBaseInit = false
function _vramBase() {
    if (!_gpuBaseInit) {
        _gpuBase = graphics.getGpuMemBase() - _TA_BASE
        _gpuBaseInit = true
    }
    return _gpuBase
}

let _scratchFore = null
let _scratchBack = null

function flush(ctx) {
    const scrW = ctx.scrW
    const scrH = ctx.scrH
    const tb = ctx.textbuffer
    const ab = ctx.attrbuffer
    const base = _vramBase()
    const len = scrW * scrH

    if (scrW === _HW_TXT_W) {
        sys.pokeBytes(base - _TA_CHAR, tb, len)
    } else {
        for (let y = 0; y < scrH; y++) {
            sys.pokeBytes(base - _TA_CHAR - y * _HW_TXT_W,
                          tb.subarray(y * scrW, y * scrW + scrW), scrW)
        }
    }

    if (!_scratchFore || _scratchFore.length < len) {
        _scratchFore = new Uint8Array(len)
        _scratchBack = new Uint8Array(len)
    }
    // Always paint the FG/BG planes so we don't inherit leftover colours.
    for (let i = 0; i < len; i++) {
        const a = ab[i]
        _scratchFore[i] = _attrFG(a)
        _scratchBack[i] = _attrBG(a)
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

// ── aa.print: rasterise a bitmap font into the image buffer ─────────────────
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
    if (x1 >= 0 && x2 < W && y1 >= 0 && y2 <= H) {
        _fastscale(gdata, gbase, buf, x1 + W * y1,
                   gw, x2 - x1, gh, y2 - y1, gw, W, color)
        return
    }
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

function _print(ctx, x, y, width, height, font, color, text) {
    if (!font) font = ctx.font
    if (!font) throw Error("aalib.print: no font (pass one or set ctx.font)")
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

    AA_NORMAL_MASK: AA_NORMAL_MASK,
    AA_DIM_MASK: AA_DIM_MASK,
    AA_BOLD_MASK: AA_BOLD_MASK,
    AA_BOLDFONT_MASK: AA_BOLDFONT_MASK,
    AA_REVERSE_MASK: AA_REVERSE_MASK,
    AA_ALL: AA_ALL,
    AA_EIGHT: AA_EIGHT,

    AA_NONE: AA_NONE,
    AA_ERRORDISTRIB: AA_ERRORDISTRIB,
    AA_FLOYD_S: AA_FLOYD_S,

    init: init,
    close: close,
    setfont: setfont,
    setsupported: setsupported,
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

    fontFromBitmap: fontFromBitmap,
    loadChrFont: loadChrFont,
    loadChrFontROM: loadChrFontROM,
}

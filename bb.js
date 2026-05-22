/*
 * BB — a port of the AA-group ASCII demo (1997) to TSVM/TVDOS.
 *
 *   Original: Jan Hubicka, Filip Kupsa, Mojmir Svoboda, Kamil Toman
 *   Music:    bb.taud / bb2.taud / bb3.taud (converted from the S3M originals)
 *   Port:     CuriousTorvald
 *
 * Run from TVDOS:  bb
 * Skip a scene:    Backspace
 * Quit:            Q  (or Esc)
 */

const taud = require("taud")

// ============================================================================
// Asset directory — relative to the current drive
// ============================================================================
function _resolveBBDir() {
    // Prefer the same drive as the running script. /home/bb/ is the package
    // location (matches hop.per's expectation for a HopperProvides:bb pkg).
    try {
        const r = _G.shell.resolvePathInput("/home/bb")
        return r.drive + ":/home/bb/"
    } catch (e) {
        return "A:/home/bb/"
    }
}
const BB_DIR = _resolveBBDir()

const aa = require(BB_DIR+"aalib.mjs")

// ============================================================================
// Terminal geometry & globals
// ============================================================================
const [TROWS, TCOLS] = con.getmaxyx()
const HALF_W = (TCOLS / 2) | 0
const HALF_H = (TROWS / 2) | 0

const BLACK = 255
const WHITE = 254
const GREY  = 253
const DARKGREY = 245
const DIM   = 244

let g_t0_ns = 0
let g_quit  = false
let g_skip  = false

// ============================================================================
// AAlib context — created on demand so scenes that don't need it cost nothing.
// Image buffer is 2x screen resolution in each axis (TROWS*2 by TCOLS*2);
// each text cell maps to a 2x2 NW/NE/SW/SE patch sampled at render time.
// ============================================================================
let g_aa      = null
let g_aaPar   = null
let g_aaFont  = null  // TSVM 7x14 system font (lazy-loaded)
function aaCtx() {
    if (!g_aa) {
        g_aa    = aa.init(TCOLS, TROWS)
        g_aaPar = aa.getrenderparams()
    }
    return g_aa
}
function aaFont() {
    if (!g_aaFont) {
        try { g_aaFont = aa.loadChrFont(BB_DIR + "tsvm_font.chr", 7, 14) }
        catch (e) {
            serial.println("bb: tsvm_font.chr load failed (" + e + "), falling back to 5x7")
            g_aaFont = aa.font5x7()
        }
    }
    return g_aaFont
}

function sysNow() { return sys.nanoTime() }
function sleepMs(ms) { if (ms > 0) sys.sleep(ms) }

// ============================================================================
// Key polling
// ============================================================================
// Keyboard MMIO snapshot lives at -40..-48 (see JS_INIT.js con.poll_keys).
const KEY_BACKSPACE = 67
const KEY_ESC       = 111
const KEY_Q         = 45

function checkInput() {
    sys.poke(-40, 1)
    for (let a = -41; a >= -48; a--) {
        const k = sys.peek(a)
        if (k === 0) continue
        if (k === KEY_BACKSPACE) g_skip = true
        else if (k === KEY_ESC || k === KEY_Q) { g_quit = true; g_skip = true }
    }
}

// ============================================================================
// Drawing primitives
// ============================================================================
function setFG(c) { print("\x1B[38;5;" + (c|0) + "m") }
function setBG(c) { print("\x1B[48;5;" + (c|0) + "m") }
function reset()  { print("\x1B[m") }

function clearScreen() { con.color_pair(WHITE, BLACK); con.clear() }

// ============================================================================
// Direct-VRAM text helpers — never trigger scrolling on (TROWS, TCOLS).
//
// Writing to the bottom-right cell via the cursor (print() or mvaddch) makes
// the cursor advance past column TCOLS, wrap to row TROWS+1, and scroll the
// entire screen up by one row. By poking the GPU text-plane VRAM directly we
// place characters without moving the cursor at all.
//
// Layout: peripheral byte k lives at JS address (gpuMemBase - k).
//   char plane : textArea[5122..7681]  (80 x 32, row-major)
//   fore plane : textArea[2..2561]
//   back plane : textArea[2562..5121]
// ============================================================================
const _GPU_BASE     = graphics.getGpuMemBase()
const _TXT_CHAR_PTR = _GPU_BASE - 259072    // textArea[5122]
const _TXT_FORE_PTR = _GPU_BASE - 253952    // textArea[2]
const _TXT_BACK_PTR = _GPU_BASE - 256512    // textArea[2562]

function putCh(y, x, ch) {
    if (y < 1 || y > TROWS || x < 1 || x > TCOLS) return
    const off = (y - 1) * 80 + (x - 1)
    sys.poke(_TXT_CHAR_PTR - off, ch & 0xFF)
    sys.poke(_TXT_FORE_PTR - off, con.get_color_fore())
    sys.poke(_TXT_BACK_PTR - off, con.get_color_back())
}

// Write a row of characters into VRAM at (y, x) 1-indexed. Clips to TCOLS,
// honours the cursor's current FG/BG via the colour planes.
function vramPutRow(y, x, str) {
    if (y < 1 || y > TROWS) return
    if (x > TCOLS) return
    let s = str
    if (x < 1) { s = s.substring(1 - x); x = 1 }
    const room = TCOLS - x + 1
    if (s.length > room) s = s.substring(0, room)
    const len = s.length
    if (len <= 0) return
    const off = (y - 1) * 80 + (x - 1)
    const fg  = con.get_color_fore()
    const bg  = con.get_color_back()
    const cA  = new Uint8Array(len)
    const fA  = new Uint8Array(len)
    const bA  = new Uint8Array(len)
    for (let i = 0; i < len; i++) {
        cA[i] = s.charCodeAt(i) & 0xFF
        fA[i] = fg
        bA[i] = bg
    }
    sys.pokeBytes(_TXT_CHAR_PTR - off, cA, len)
    sys.pokeBytes(_TXT_FORE_PTR - off, fA, len)
    sys.pokeBytes(_TXT_BACK_PTR - off, bA, len)
}

function centerText(y, text) {
    if (y < 1 || y > TROWS) return
    let x = ((TCOLS - text.length) >>> 1) + 1
    if (x < 1) x = 1
    vramPutRow(y, x, text)
}

function drawText(y, x, text) {
    if (y < 1 || y > TROWS) return
    if (x > TCOLS) return
    vramPutRow(y, x, text)
}

const RAMP = " .,:;ox%#@"
function rampChar(v) {
    let i = (v * (RAMP.length - 1) / 255) | 0
    if (i < 0) i = 0
    if (i > RAMP.length - 1) i = RAMP.length - 1
    return RAMP.charAt(i)
}

// ============================================================================
// 5x7 bitmap font for big-text rendering
// ============================================================================
const FONT5x7 = {
    " ": ["     ","     ","     ","     ","     ","     ","     "],
    "A": ["  #  "," # # ","#   #","#####","#   #","#   #","#   #"],
    "B": ["#### ","#   #","#   #","#### ","#   #","#   #","#### "],
    "C": [" ####","#    ","#    ","#    ","#    ","#    "," ####"],
    "D": ["#### ","#   #","#   #","#   #","#   #","#   #","#### "],
    "E": ["#####","#    ","#    ","#### ","#    ","#    ","#####"],
    "F": ["#####","#    ","#    ","#### ","#    ","#    ","#    "],
    "G": [" ####","#    ","#    ","#  ##","#   #","#   #"," ####"],
    "H": ["#   #","#   #","#   #","#####","#   #","#   #","#   #"],
    "I": ["#####","  #  ","  #  ","  #  ","  #  ","  #  ","#####"],
    "J": ["#####","    #","    #","    #","#   #","#   #"," ### "],
    "K": ["#   #","#  # ","# #  ","##   ","# #  ","#  # ","#   #"],
    "L": ["#    ","#    ","#    ","#    ","#    ","#    ","#####"],
    "M": ["#   #","## ##","# # #","#   #","#   #","#   #","#   #"],
    "N": ["#   #","##  #","# # #","#  ##","#   #","#   #","#   #"],
    "O": [" ### ","#   #","#   #","#   #","#   #","#   #"," ### "],
    "P": ["#### ","#   #","#   #","#### ","#    ","#    ","#    "],
    "Q": [" ### ","#   #","#   #","#   #","# # #","#  # "," ## #"],
    "R": ["#### ","#   #","#   #","#### ","# #  ","#  # ","#   #"],
    "S": [" ####","#    ","#    "," ### ","    #","    #","#### "],
    "T": ["#####","  #  ","  #  ","  #  ","  #  ","  #  ","  #  "],
    "U": ["#   #","#   #","#   #","#   #","#   #","#   #"," ### "],
    "V": ["#   #","#   #","#   #","#   #","#   #"," # # ","  #  "],
    "W": ["#   #","#   #","#   #","#   #","# # #","## ##","#   #"],
    "X": ["#   #","#   #"," # # ","  #  "," # # ","#   #","#   #"],
    "Y": ["#   #","#   #"," # # ","  #  ","  #  ","  #  ","  #  "],
    "Z": ["#####","    #","   # ","  #  "," #   ","#    ","#####"],
    "0": [" ### ","#   #","#  ##","# # #","##  #","#   #"," ### "],
    "1": ["  #  "," ##  ","# #  ","  #  ","  #  ","  #  ","#####"],
    "2": [" ### ","#   #","    #","  ## "," #   ","#    ","#####"],
    "3": [" ### ","#   #","    #","  ## ","    #","#   #"," ### "],
    "4": ["   # ","  ## "," # # ","#  # ","#####","   # ","   # "],
    "5": ["#####","#    ","#### ","    #","    #","#   #"," ### "],
    "6": [" ### ","#    ","#    ","#### ","#   #","#   #"," ### "],
    "7": ["#####","    #","   # ","  #  "," #   "," #   "," #   "],
    "8": [" ### ","#   #","#   #"," ### ","#   #","#   #"," ### "],
    "9": [" ### ","#   #","#   #"," ####","    #","    #"," ### "],
    "?": [" ### ","#   #","    #","   # ","  #  ","     ","  #  "],
    "!": ["  #  ","  #  ","  #  ","  #  ","  #  ","     ","  #  "],
    ".": ["     ","     ","     ","     ","     ","     ","  #  "],
    ",": ["     ","     ","     ","     ","     ","  #  "," #   "],
    ":": ["     ","     ","  #  ","     ","     ","  #  ","     "],
    ";": ["     ","     ","  #  ","     ","     ","  #  "," #   "],
    "-": ["     ","     ","     ","#####","     ","     ","     "],
    "/": ["    #","    #","   # ","  #  "," #   ","#    ","#    "],
    "(": ["  #  "," #   ","#    ","#    ","#    "," #   ","  #  "],
    ")": ["  #  ","   # ","    #","    #","    #","   # ","  #  "],
    "'": ["  #  ","  #  ","     ","     ","     ","     ","     "],
    "\"": [" # # "," # # ","     ","     ","     ","     ","     "],
    "*": ["     "," # # ","  #  ","#####","  #  "," # # ","     "],
    "+": ["     ","  #  ","  #  ","#####","  #  ","  #  ","     "],
    "=": ["     ","     ","#####","     ","#####","     ","     "],
    "%": ["##  #","## # ","   # ","  #  "," #   ","# ## ","#  ##"],
    "&": [" ##  ","#  # "," #   ","  #  "," # # ","#   #"," ## #"],
}

// Draw 'text' starting at row y, centred horizontally by default.
// xCenter overrides the column-centre (1-indexed); useful for off-centre BB.
function bigText(y, text, scale, fill, xCenter) {
    if (!fill) fill = 0xDB
    text = ("" + text).toUpperCase()
    const wPerChar = 5 * scale + scale
    const totalW = text.length * wPerChar - scale
    const centre = (xCenter === undefined) ? ((TCOLS / 2) | 0) : (xCenter | 0)
    let startX = centre - ((totalW / 2) | 0) + 1
    if (startX < 1) startX = 1
    const startY = y - (((7 * scale) / 2) | 0) + 1
    for (let i = 0; i < text.length; i++) {
        const glyph = FONT5x7[text.charAt(i)] || FONT5x7[" "]
        const x0 = startX + i * wPerChar - 1
        for (let gy = 0; gy < 7; gy++) {
            const row = glyph[gy]
            for (let gx = 0; gx < 5; gx++) {
                if (row.charAt(gx) === "#") {
                    for (let dy = 0; dy < scale; dy++) {
                        for (let dx = 0; dx < scale; dx++) {
                            putCh(startY + gy * scale + dy, x0 + gx * scale + dx, fill)
                        }
                    }
                }
            }
        }
    }
}

// ============================================================================
// Music
// ============================================================================
const PLAYHEAD = 0
function loadSong(path) {
    audio.resetParams(PLAYHEAD)
    audio.purgeQueue(PLAYHEAD)
    audio.stop(PLAYHEAD)
    try {
        taud.uploadTaudFile(path, 0, PLAYHEAD)
        audio.setMasterVolume(PLAYHEAD, 255)
        audio.setMasterPan(PLAYHEAD, 128)
        audio.setCuePosition(PLAYHEAD, 0)
        return true
    } catch (e) {
        serial.println("bb: music load failed: " + path + " - " + e)
        return false
    }
}
function startMusic() { audio.play(PLAYHEAD) }
function stopMusic()  { audio.stop(PLAYHEAD) }

// ============================================================================
// Scene runner
// ============================================================================
function runScene(durUs, fps, tick) {
    if (g_quit) return false
    g_skip = false
    const frameUs = Math.max(1, (1000000 / fps) | 0)
    const start = sysNow()
    let lastFrame = -1
    while (true) {
        if (g_quit || g_skip) break
        const elapsedUs = ((sysNow() - start) / 1000) | 0
        if (elapsedUs >= durUs) break
        const f = (elapsedUs / frameUs) | 0
        if (f !== lastFrame) {
            tick(elapsedUs, durUs)
            lastFrame = f
        }
        checkInput()
        const sleep = 1 + ((frameUs / 1000) >> 2)
        sleepMs(sleep)
    }
    g_skip = false
    return !g_quit
}

function waitMs(ms) {
    return runScene(ms * 1000, 60, function() {})
}

// ============================================================================
// SCENE 1 — near-verbatim port of scene1.c
//
// Constants mirror the C #defines:
//   EFECT=2  → ETIME = 2 s per typewriter / scramble phase
//   EFECT2=6.0 → 6 s of "decrandom" (AA / PRESENTS sharpening)
//   N_STEP=30, MAXSHIFT=800, MAXRAND=40, MAXEFECT2=3570
//
// The original drives every effect through timestuff(rate, control, draw, dur):
// the control() function fires at `rate` Hz and receives n ticks elapsed since
// the last call; draw() repaints between ticks. We reproduce that semantics.
// ============================================================================
const _S1_EFECT     = 2
const _S1_EFECT2    = 6.0
const _S1_ETIME     = _S1_EFECT * 1000000     // 2,000,000 µs
const _S1_ETIME1    = _S1_EFECT * 1000000
const _S1_MAXSHIFT  = _S1_EFECT * 400         // 800
const _S1_MAXRAND   = _S1_EFECT * 20          // 40
const _S1_N_STEP    = 30
const _S1_MAXEFECT2 = (_S1_N_STEP * _S1_EFECT2 * 20 - _S1_N_STEP) | 0   // 3570

// HEXA — every other call yields a hex digit (A-F or 0-9), one in three a
// space. The C macro is `(rand()&2 ? 'A'+rand()%6 : '0'+rand()%10)`; we keep
// the same A-F vs 0-9 split.
function _s1Hexa() {
    return (Math.random() < 0.5)
        ? String.fromCharCode(0x41 + ((Math.random() * 6)  | 0))   // A-F
        : String.fromCharCode(0x30 + ((Math.random() * 10) | 0))   // 0-9
}

// timestuff(rate, control, draw, durUs) — fires control(n) at |rate| Hz with
// n = number of ticks accumulated since the previous call, and draw() at
// frame pace between firings. Returns false if the user quit, true otherwise.
function timestuff(rate, control, draw, durUs) {
    if (g_quit) return false
    if (control === null) rate = -40
    const absRate = Math.abs(rate)
    const intervalUs = Math.max(1, (1000000 / absRate) | 0)
    const start = sysNow()
    let nextTickUs = intervalUs
    if (control !== null) control(1)              // initial kick, matching C
    while (true) {
        if (g_quit || g_skip) break
        const elapsedUs = ((sysNow() - start) / 1000) | 0
        if (elapsedUs >= durUs) break
        if (control !== null && elapsedUs >= nextTickUs) {
            const n = 1 + (((elapsedUs - nextTickUs) / intervalUs) | 0)
            nextTickUs += n * intervalUs
            control(n)
        }
        if (draw) draw()
        checkInput()
        sleepMs(1)
    }
    if (draw && !g_quit) draw()
    g_skip = false
    return !g_quit
}

// Image-buffer centerprint — mirror of bb.c:centerprint(x, y, size, color, t, 0)
//   height = imgH / size
//   width  = height * imgW * 0.75 / imgH * mmH / mmW
// In our context mmW == scrW and mmH == scrH, so mmH/mmW == scrH/scrW.
function _s1Centerprint(ctx, font, x, y, size, color, text) {
    const W = aa.imgwidth(ctx), H = aa.imgheight(ctx)
    const mmW = aa.mmwidth(ctx), mmH = aa.mmheight(ctx)
    const height = H / size
    const width  = height * W * 0.75 / H * mmH / mmW
    if (width < 1 || height < 1) return
    const w0 = Math.max(1, width  | 0)
    const h0 = Math.max(1, height | 0)
    aa.print(ctx,
        (x - (w0 * text.length) / 2) | 0,
        (y - (h0 >>> 1)) | 0,
        w0, h0, font, color | 0, text)
}

// Same for centerprinth — width is the divisor:
//   width  = imgW / size
//   height = width * imgH * 1.333 / imgW * mmW / mmH
function _s1Centerprinth(ctx, font, x, y, size, color, text) {
    const W = aa.imgwidth(ctx), H = aa.imgheight(ctx)
    const mmW = aa.mmwidth(ctx), mmH = aa.mmheight(ctx)
    const width  = W / size
    const height = width * H * 1.333 / W * mmW / mmH
    if (width < 1 || height < 1) return
    const w0 = Math.max(1, width  | 0)
    const h0 = Math.max(1, height | 0)
    aa.print(ctx,
        (x - (w0 * text.length) / 2) | 0,
        (y - (h0 >>> 1)) | 0,
        w0, h0, font, color | 0, text)
}

// ── Module-level draw / strobik (mirror of bb.c:draw, scene1.c:strobik*) ────
// `bbDraw` is the global draw(): calls the current drawptr (if any), renders
// the image buffer into the text buffer (via aa.render), overlays the current
// status text in AA_SPECIAL, then flushes. Used by every effect that wants
// the standard pipeline.
let g_drawptr     = null
let g_overlayText = ""

function bbOverlay() {
    if (!g_overlayText || !g_overlayText.length) return
    const ctx = aaCtx()
    const scrW = aa.scrwidth(ctx), scrH = aa.scrheight(ctx)
    const x = ((scrW - g_overlayText.length) / 2) | 0
    aa.puts(ctx, x, (scrH / 2) | 0, aa.AA_SPECIAL, g_overlayText)
}

function bbDraw() {
    const ctx = aaCtx()
    if (g_drawptr !== null) g_drawptr()
    aa.render(ctx, g_aaPar)
    bbOverlay()
    aa.flush(ctx)
}

// strobikstart / strobikend — the white-flash + fade primitives. Each portrait
// transition, every blazinec card, and the scene1 → scene3 handoff all pivot
// on these.
function strobikstart() {
    const params = g_aaPar
    params.bright = 0
    timestuff(-60, function(n) { params.bright += n * 50 }, bbDraw, (1000000 / 15) | 0)
    params.bright = 255
    bbDraw()
}

function strobikend() {
    const params = g_aaPar
    timestuff(-60, function(n) { params.bright = params.bright >> n }, bbDraw, (1000000 / 3.5) | 0)
    params.bright = 0
    bbDraw()
}

// bbwait — equivalent of bb.c:bbwait(): block for `us` microseconds while
// keeping input polling alive. Returns false if the user quit.
function bbwait(us) { return runScene(us, 60, function() {}) }

function scene1() {
    const ctx    = aaCtx()
    const params = g_aaPar
    const font   = aaFont()
    const scrW = aa.scrwidth(ctx), scrH = aa.scrheight(ctx)
    const imgW = aa.imgwidth(ctx),  imgH = aa.imgheight(ctx)
    const tb = ctx.textbuffer, ab = ctx.attrbuffer

    clearScreen(); con.curs_set(0)
    aa.cleartext(ctx)
    aa.clear(ctx)
    aa.flush(ctx)

    params.dither    = aa.AA_FLOYD_S
    params.bright    = 0
    params.contrast  = 0
    params.randomval = 0

    g_overlayText = "Please wait. Precalculating data"
    g_drawptr     = null
    let cursorx = 0, cursory = 0
    let s1_bright = 255
    let s1_pos = 0, s1_delta = 0, s1_dist = 0
    let s1_f = -10.0
    let randshift = 0, randcharacters = 0, randattrs = 0

    // ── drawwait: just flush current textbuffer with overlay ────────────────
    const drawwait = function() {
        bbOverlay()
        aa.flush(ctx)
    }

    // ── calculateslow: write one cell per call (the "slow typewriter") ─────
    const calculateslow = function(n) {
        cursorx++
        if (cursorx >= scrW) {
            cursory++
            cursorx = 1
            if (cursory >= scrH) cursory = 0
        }
        const ch = ((cursorx % 3) !== 0) ? _s1Hexa().charCodeAt(0) : 0x20
        tb[cursory * scrW + cursorx - 1] = ch
        ab[cursory * scrW + cursorx - 1] = aa.AA_NORMAL
    }

    // ── drawline: full-row scramble used by calculatefast / drawwait3 ──────
    const drawline = function(y) {
        const useShift = (Math.random() * _S1_MAXSHIFT) < randshift
        const shift = useShift ? ((Math.random() * 1048576) | 0) : -1
        const base = y * scrW
        for (let x = 0; x < scrW; x++) {
            if (randattrs && (Math.random() * _S1_MAXRAND) < randattrs) {
                // leave attr alone
            } else {
                ab[base + x] = aa.AA_NORMAL
            }
            if (randcharacters && (Math.random() * _S1_MAXRAND) < randcharacters) {
                // leave char alone
                continue
            }
            tb[base + x] = (((x - shift) % 3) !== 0) ? _s1Hexa().charCodeAt(0) : 0x20
        }
    }

    // ── calculatefast: scramble n whole lines per call ─────────────────────
    const calculatefast = function(n) {
        if (randshift) randshift += n
        for (let i = 0; i < n; i++) {
            drawline(cursory)
            cursory++
            cursorx = 0
            if (cursory >= scrH) cursory = 0
        }
    }

    // ── drawwait3: render the (empty) image buffer then scramble all rows ──
    const drawwait3 = function() {
        aa.render(ctx, params)
        for (let y = 0; y < scrH; y++) drawline(y)
        bbOverlay()
        aa.flush(ctx)
    }

    // ── calculatefastest: just ramp randcharacters / randattrs in place ────
    const calculatefastest = function(n) {
        if (randcharacters) randcharacters += n
        if (randattrs)      randattrs      += n
    }

    // ── decrandom: decrease params.randomval (sharpens the AA/PRESENTS) ────
    const decrandom = function(n) {
        if (params.randomval > 0) params.randomval -= n * _S1_N_STEP
        if (params.randomval < 60) params.randomval = 60
    }

    // ── decbright: decrease the local `bright` (fades the AA/PRESENTS) ─────
    const decbright = function(n) { s1_bright -= n * 16 }

    // ── makepos / makepos1 / makepos2: damped harmonic for the two B's ─────
    const makepos = function(n) {
        for (let i = 0; i < n; i++) {
            s1_f += (imgH / 2 - s1_pos) / 60.0
            s1_f *= 0.95
            s1_pos += s1_f
        }
    }
    const makepos1 = function(n) {
        for (let i = 0; i < n; i++) {
            s1_f += (imgH / 2 - s1_pos) / 60.0
            s1_f *= 0.95
            s1_pos += s1_f
            s1_delta += 0.2
        }
    }
    const makepos2 = function(n) {
        for (let i = 0; i < n; i++) {
            s1_f += (imgH / 2 - s1_pos) / 60.0
            s1_f *= 0.95
            s1_pos += s1_f
            s1_delta -= 0.2
            if (s1_delta <= 2) s1_delta = 0.1
            s1_dist += 0.08
        }
    }

    // ── drawwait2: AA + PRESENTS (image-buffer ink, faded via `bright`) ────
    const drawwait2 = function() {
        let i = s1_bright
        if (i < 0) i = 0
        _s1Centerprint(ctx, font, imgW / 2, imgH / 3, 2, i, "AA")
        i = s1_bright + 255
        if (i < 0) i = 0
        if (i > 255) i = 255
        _s1Centerprinth(ctx, font, imgW / 2, 2 * imgH / 3, 8, i, "PRESENTS")
    }

    // ── drawwait4: two mirrored B's drifting on a damped harmonic ──────────
    const drawwait4 = function() {
        aa.clear(ctx)
        const size = 1.1 + s1_delta / 2
        _s1Centerprint(ctx, font, imgW / 4 - s1_dist * imgW,        s1_pos,         size, 255, "B")
        _s1Centerprint(ctx, font, 3 * imgW / 4 + s1_dist * imgW,    imgH - s1_pos,  size, 255, "B")
    }

    const hlaska = function(t, sz) {
        aa.clear(ctx)
        _s1Centerprint(ctx, font, imgW / 2, imgH / 2, sz, 255, t)
    }
    const blazinec = function() {
        const blText = [
            "the","100 %","TSVM","COMPATIBLE","DEMO",";^D","(^;",
            "FULL","80-COL","TEXT","MODE","",
            "DEVELOPED","UNDER","TVDOS","!","!","!","?",
        ]
        const blSize = [3,3.5,3.5,4.2,3,2,2,3,3,3,3,1,5,3,3,1,2,3,4.2]
        for (let i = 0; i < blText.length; i++) {
            if (g_quit || g_skip) { g_skip = false; return }
            strobikstart()
            params.randomval = 0
            hlaska(blText[i], blSize[i] / 1.5) // arbitrary resizing
            strobikend()
        }
        strobikstart()
        bbDraw()
    }

    // ── Opening typewriter ramp — 7 phases × ETIME (2 s each) = 14 s ───────
    timestuff(-10,  calculateslow, drawwait, _S1_ETIME1)
    timestuff(-40,  calculateslow, drawwait, _S1_ETIME1)
    timestuff(-80,  calculateslow, drawwait, _S1_ETIME1)
    timestuff(-30,  calculatefast, drawwait, _S1_ETIME1)
    timestuff(-200, calculatefast, drawwait, _S1_ETIME1)
    timestuff(-420, calculatefast, drawwait, _S1_ETIME)
    if (g_quit) return

    randshift = 1
    timestuff(600, calculatefast, drawwait, _S1_ETIME1)
    randshift = _S1_MAXSHIFT
    params.randomval = _S1_MAXEFECT2 + 50
    g_overlayText = ""
    aa.gotoxy(ctx, 0, 0)
    aa.hidecursor(ctx)
    if (g_quit) return

    // ── Full-screen scramble — 5 phases × ETIME (2 s each) = 10 s ──────────
    timestuff(20, calculatefastest, drawwait3, _S1_ETIME)
    timestuff(20, calculatefastest, drawwait3, _S1_ETIME)
    randcharacters = 1
    timestuff(20, calculatefastest, drawwait3, _S1_ETIME)
    randcharacters = _S1_MAXRAND
    randattrs = 1
    timestuff(20, calculatefastest, drawwait3, _S1_ETIME)
    randattrs = _S1_MAXRAND
    timestuff(20, calculatefastest, drawwait3, _S1_ETIME)
    if (g_quit) return

    // ── play(): music fires HERE, exactly as in scene1.c:377 ───────────────
    g_drawptr = drawwait2
    startMusic()

    // ── AA / PRESENTS — randomval drops, then bright fades ─────────────────
    timestuff(20, decrandom, bbDraw, (_S1_EFECT2 * 1000000) | 0)   // 6 s
    timestuff(20, decbright, bbDraw, _S1_ETIME)                    // 2 s
    if (g_quit) return

    // ── Two falling B's, harmonic settles, then they part and exit ─────────
    s1_pos = imgH * 2
    g_drawptr = drawwait4
    timestuff(60, makepos,  bbDraw, 5   * 1000000)
    timestuff(60, makepos1, bbDraw, 0.2 * 1000000)
    timestuff(60, makepos2, bbDraw, 0.3 * 1000000)
    g_drawptr = null
    if (g_quit) return

    // ── Final strobe parade ────────────────────────────────────────────────
    blazinec()
}

// ============================================================================
// SCENE 2 — Greetings scroller + group-name zoomer parade
// ============================================================================
function scene2() {
    clearScreen()

    // Cross-scroll banner: "TO" travels left -> right at the top third;
    // "GREETINGS" travels right -> left at the bottom third.  Off-centre
    // positioning via bigText's xCenter argument lets them sweep across.
    const ok = runScene(2750000, 24, function(el, total) {
        con.clear()
        const t = el / total
        // map t in [0,1] to centre column from -8 to TCOLS+8 (and inverse)
        const sweepW = TCOLS + 16
        const xTo  = (-8 + t * sweepW) | 0
        const xGr  = (TCOLS + 8 - t * sweepW) | 0
        bigText((TROWS / 3) | 0,       "TO",        2, 0xDB, xTo)
        bigText(((TROWS * 2) / 3) | 0, "GREETINGS", 1, 0xDB, xGr)
    })
    if (!ok) return

    // Parade of group-name pop-ups, each ~0.65 s
    const GROUPS = [
        "FUTURE CREW", "TRITON", "CASCADA", "COMPLEX",
        "PASCAL", "TITANS", "XOGRAPHY", "SONIC PC",
        "SCRYMAG", "...", "MICROSOFT", "?!?",
    ]
    for (let i = 0; i < GROUPS.length; i++) {
        if (g_quit) return
        const ok2 = runScene(650000, 30, function(el, dur) {
            con.clear()
            const t = el / dur
            const sc = Math.max(1, Math.round(3 - t * 2))
            const y = 4 + ((i % 3) * ((TROWS - 8) / 2)) | 0
            bigText(y, GROUPS[i], sc)
        })
        if (!ok2) return
    }
}

// ============================================================================
// SCENE 3 — plasma + sliding messages
//
// Near-verbatim port of scene3.c (plasma engine) + scene2.c's message() /
// centerprint() (the wobbly bottom-to-top scrollers).
//
//   - 190-step zoom table of signed cosine values is precomputed once
//     (initPlasmaTables). Each plasma pixel reads six entries from the
//     active zoom slice and sums them mod 256.
//   - Two custom palettes (Pal[0], Pal[1]) are cross-faded into TempPal
//     every 64 ticks via cplasma(). aa.renderpalette() applies the result
//     across the whole image buffer at render time.
//   - message() rasterises text into the image buffer at a size that
//     oscillates as (1+cos(pp))*5+2 (huge → tiny → huge) while scrolling
//     up the screen, with brightness sin(pp/2)*255 (fade in, peak, fade out).
//   - The text ink lands in the image buffer as raw luminance values, which
//     get re-mapped by the same plasma palette — so bright text reads as
//     dark "voids" cut into the plasma, matching the C demo.
// ============================================================================
const _PLASMA_ZTABSIZE = 190    // (2.70 - 0.80) / 0.01
const _PLASMA_FRAMERATE = 35
const _PLASMA_STIME = 11 * 1000000     // first message starts at +11 s
const _PLASMA_TTIME = 1 * 1000000      // each message slot is 1 s apart
const _PLASMA_MAXPOS = 2500000         // each message lives for 2.5 s
const _PLASMA_DUR_US = 42 * 1000000    // scene length

let g_plasmaTbl  = null    // Int8Array(190*256)
let g_plasmaPal  = null    // [Uint8Array(256), Uint8Array(256)]
let g_plasmaTemp = null    // Uint8Array(256)

function initPlasmaTables() {
    if (g_plasmaTbl) return
    g_plasmaTbl = new Int8Array(_PLASMA_ZTABSIZE * 256)
    for (let pnum = 0; pnum < _PLASMA_ZTABSIZE; pnum++) {
        const czoom = 0.80 + pnum * 0.01
        const div = czoom * czoom * czoom * czoom
        const base = pnum * 256
        for (let i = 0; i < 256; i++) {
            // RAD(i * 256/180) — angle in degrees, converted to radians.
            const angle = (i * 256 / 180) * Math.PI / 180
            // Cast to signed 8-bit (Int8Array auto-wraps via two's complement),
            // matching the original `(char)` truncation.
            g_plasmaTbl[base + i] = (Math.cos(angle) * 256 / div) | 0
        }
    }
    const p0 = new Uint8Array(256)
    const p1 = new Uint8Array(256)
    for (let i = 0;   i <  64; i++) { p0[i] = i * 4;            p1[i] = i * 1            }
    for (let i = 64;  i < 128; i++) { p0[i] = (128 - i) * 4;    p1[i] = (128 - i) * 1    }
    for (let i = 128; i < 192; i++) { p0[i] = (i - 128) * 1;    p1[i] = (i - 128) * 4    }
    for (let i = 192; i < 256; i++) { p0[i] = (256 - i) * 1;    p1[i] = (256 - i) * 4    }
    g_plasmaPal  = [p0, p1]
    g_plasmaTemp = new Uint8Array(256)
}

function scene3() {
    // Do NOT clear VRAM here: scene1's final strobikstart() leaves the
    // textbuffer in a white-out state (params.bright=255 saturates every
    // cell). Preserving that fill — and letting the plasma loop's per-tick
    // `bright -= 2` decay it — reproduces scene1.c → scene3.c's white-fade
    // transition near-verbatim.
    const ctx    = aaCtx()
    const params = g_aaPar
    const font   = aaFont()
    params.dither    = aa.AA_FLOYD_S
    params.contrast  = 0
    params.randomval = 0

    initPlasmaTables()

    const W = aa.imgwidth(ctx)
    const H = aa.imgheight(ctx)
    const buf = ctx.imagebuffer
    const tbl = g_plasmaTbl
    const fw = font.width, fh = font.height

    // Message list — straight from scene3.c's `text[]`. Empty strings act
    // as pauses so the TTIME-spaced slots stay aligned with the C timing.
    const TEXTS = [
        "STILL", "WATCHING", "BB", "?", "GREAT",
        "", "",
        "NOW", "IT'S", "A GREAT", "TIME", "TO",
        "FILL", "IN", "YOUR", "REGISTRATION", "CARD",
        "",
        "????",
        "NEVER", "MORE",
        "",
        "(E.A. POE)",
        "...",
    ]

    // Plasma state
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0
    let pnum = 0, dir = 1
    let m = 0, n = 0, f = 0
    // Inherit whatever bright value scene1 left behind (255 after the final
    // strobikstart()); do_plasma decays it back to 0 — that's the fade-in.
    let bright = params.bright | 0

    // centerprint(x, y, size, color, text) — drives aa.print using the
    // same "size is a divisor of image height" convention as the C code,
    // but with the font's native aspect (so chars don't look squat).
    function centerprint(cx, cy, size, color, text) {
        if (!text.length) return
        let height = H / size
        let width  = height * fw / fh
        // Clip the per-glyph width so the line still fits horizontally.
        // (REGISTRATION at size=2 would otherwise overflow on a 160px buffer.)
        const maxTotalW = W * 0.95
        if (width * text.length > maxTotalW) width = maxTotalW / text.length
        if (width < 1 || height < 1) return
        const w0 = width  | 0
        const h0 = height | 0
        aa.print(ctx,
            (cx - (w0 * text.length) / 2) | 0,
            (cy - (h0 >>> 1)) | 0,
            w0, h0, font, color | 0, text)
    }

    function drawMessage(text, stateUs) {
        if (stateUs <= 0 || stateUs >= _PLASMA_MAXPOS) return
        const pp = stateUs * Math.PI * 2 / _PLASMA_MAXPOS
        const size = (1 + Math.cos(pp)) * 5 + 2          // 12 → 2 → 12
        if (size <= 0) return
        const ypos = (H - H * stateUs / _PLASMA_MAXPOS) | 0
        const color = (Math.sin(pp / 2) * 255) | 0
        centerprint(W >>> 1, ypos, size, color, text)
    }

    // Initial half-second pause to match `bbwait(500000)`.
    if (!waitMs(500)) return

    runScene(_PLASMA_DUR_US, _PLASMA_FRAMERATE, function(elapsed, total) {
        // ── do_plasma(step=1) ────────────────────────────────────────────
        // Dim the global brightness as we approach the end of the scene.
        const closing = (total - elapsed) < (128 * 1000000 / _PLASMA_FRAMERATE)
        bright -= 2
        if (!closing && bright < 0) bright = 0
        params.bright = bright

        // Palette cross-fade.
        f += 1
        if (f > 64) {
            f = 0
            m = n
            n = (Math.random() * 2) | 0
        }
        const pa = g_plasmaPal[n], pb = g_plasmaPal[m], tp = g_plasmaTemp
        for (let j = 0; j < 256; j++) {
            tp[j] = (pb[j] + ((pa[j] - pb[j]) * f / 64)) & 0xFF
        }

        // Advance the scroll positions (uchar wrap).
        pos1 = (pos1 - 4 - ((Math.random() * 2) | 0)) & 0xFF
        pos3 = (pos3 + 4 + ((Math.random() * 1) | 0)) & 0xFF
        pos2 = (pos2 -      ((Math.random() * 2) | 0)) & 0xFF
        pos4 = (pos4 -      ((Math.random() * 2) | 0)) & 0xFF
        pnum += dir
        if (pnum > _PLASMA_ZTABSIZE - 2) dir = -1
        else if (pnum <= 0)              dir = +1

        // ── draw_plasma() ────────────────────────────────────────────────
        const tblBase = pnum * 256
        let p3 = pos3, p4 = pos4
        for (let i = 0; i < W; i++) {
            let p1 = pos1
            let p2 = pos2
            const vi = tbl[tblBase + (i & 0xFF)]
            const v3 = tbl[tblBase + p3]
            const v4 = tbl[tblBase + p4]
            for (let j = 0; j < H; j++) {
                const vj = tbl[tblBase + (j & 0xFF)]
                const color = tbl[tblBase + p1] + tbl[tblBase + p2] + v3 + v4 + vi + vj
                buf[j * W + i] = color & 0xFF
                p1 = (p1 + 3) & 0xFF
                p2 = (p2 + 1) & 0xFF
            }
            p3 = (p3 + 2) & 0xFF
            p4 = (p4 + 3) & 0xFF
        }

        // Messages — each slot fires `_PLASMA_STIME + i*_PLASMA_TTIME` µs in.
        for (let i = 0; i < TEXTS.length; i++) {
            if (!TEXTS[i]) continue
            const stateUs = elapsed - (_PLASMA_STIME + i * _PLASMA_TTIME)
            drawMessage(TEXTS[i], stateUs)
        }

        // Re-map every pixel through the cross-faded palette as we render.
        aa.renderpalette(ctx, g_plasmaTemp, params)
        aa.flush(ctx)
    })

    params.bright = 0
    setFG(WHITE)
    if (g_quit) return
    con.clear()
}

// ============================================================================
// SCENE 4 — space invaders & fire
// ============================================================================
function scene4() {
    clearScreen()
    const rowYs = [3, 6, 9]
    for (let x = 1; x <= TCOLS - 8; x += 6) {
        if (g_quit) return
        for (let i = 0; i < rowYs.length; i++) drawText(rowYs[i], x, " ----")
        if (!waitMs(20)) return
    }
    for (let x = 1; x <= TCOLS - 8; x += 6) {
        if (g_quit) return
        for (let i = 0; i < rowYs.length; i++) drawText(rowYs[i], x, " -oo-")
        if (!waitMs(10)) return
    }
    let cannonX = HALF_W

    let frame = 0
    const okMarch = runScene(2200000, 16, function() {
        const ch = (frame & 1) ? " /OO\\" : " \\oo/"
        for (let x = 1; x <= TCOLS - 8; x += 6) {
            for (let i = 0; i < rowYs.length; i++) drawText(rowYs[i], x, ch)
        }
        cannonX += ((Math.random() * 3) | 0) - 1
        if (cannonX < 4) cannonX = 4
        if (cannonX > TCOLS - 4) cannonX = TCOLS - 4
        drawText(TROWS - 1, cannonX - 2, "  [^]  ")
        frame++
    })
    if (!okMarch) return

    // Invaders die — explosion flicker
    for (let blink = 0; blink < 5; blink++) {
        if (g_quit) return
        for (let x = 1; x <= TCOLS - 8; x += 6)
            for (let i = 0; i < rowYs.length; i++) drawText(rowYs[i], x, " /**\\")
        if (!waitMs(120)) return
        for (let x = 1; x <= TCOLS - 8; x += 6)
            for (let i = 0; i < rowYs.length; i++) drawText(rowYs[i], x, "     ")
        if (!waitMs(120)) return
    }

    // Fire effect
    const cols = TCOLS
    const bot = new Array(cols).fill(0)
    const fld = []
    for (let y = 0; y < TROWS; y++) {
        const a = new Array(cols)
        for (let x = 0; x < cols; x++) a[x] = 0
        fld.push(a)
    }
    const fireRamp = " .,:^*&%$#@"
    const okFire = runScene(3500000, 22, function(el, total) {
        for (let x = 0; x < cols; x++) {
            bot[x] = Math.max(0, bot[x] + ((Math.random() * 80) | 0) - 30)
            if (bot[x] > 255) bot[x] = 255
            fld[TROWS - 1][x] = bot[x]
        }
        for (let y = 0; y < TROWS - 1; y++) {
            const dst = fld[y], src = fld[y + 1]
            for (let x = 0; x < cols; x++) {
                const lx = (x === 0) ? x : x - 1
                const rx = (x === cols - 1) ? x : x + 1
                dst[x] = ((src[lx] + src[x] + src[rx]) / 3.05) | 0
            }
        }
        for (let y = 1; y <= TROWS; y++) {
            const buf = fld[y - 1]
            let row = ""
            for (let x = 0; x < cols; x++) {
                const v = buf[x]
                let idx = (v * fireRamp.length / 256) | 0
                if (idx > fireRamp.length - 1) idx = fireRamp.length - 1
                row += fireRamp.charAt(idx)
            }
            vramPutRow(y, 1, row)
        }
    })
    if (!okFire) return
    con.clear()
}

// ============================================================================
// SCENE 5 — text shower (substitute for the 3D-torus dithering demo)
// ============================================================================
function scene5() {
    clearScreen()
    const captions = [
        "SUPPORTS", "ANTIALIASING", "256 COLOURS", "ASCII",
        "DITHERING", "RANDOM", "ERROR", "DISTRIBUTION",
        "FLOYD", "STEINBERG", "GAMMA", "CORRECTION",
    ]
    for (let i = 0; i < captions.length; i++) {
        if (g_quit) return
        const ok = runScene(850000, 30, function(el, dur) {
            con.clear()
            const t = el / dur
            const sc = 1 + (((1 - Math.abs(t - 0.5) * 2) * 2) | 0)
            const y = 4 + (((Math.sin(i * 1.2) + 1) * (TROWS - 8)) / 2 | 0)
            bigText(y, captions[i], Math.max(1, sc))
            for (let n = 0; n < 25; n++) {
                const px = 1 + ((Math.random() * TCOLS) | 0)
                const py = 1 + ((Math.random() * TROWS) | 0)
                putCh(py, px, ".".charCodeAt(0))
            }
        })
        if (!ok) return
    }
    con.clear()
}

// ============================================================================
// SCENE 7 — Mandelbrot tribute (XaoS)
// ============================================================================
function mandel(cx, cy, maxIter) {
    let x = 0, y = 0, i = 0
    while (i < maxIter) {
        const x2 = x * x, y2 = y * y
        if (x2 + y2 > 4) return i
        const xy = x * y
        x = x2 - y2 + cx
        y = xy + xy + cy
        i++
    }
    return maxIter
}

function renderMandel(cx, cy, zoom, maxIter) {
    // Cell aspect (h:w ~ 2:1) — stretch x scale by 2 so the picture isn't squished.
    const sx = (zoom * 2.5) / TCOLS
    const sy = (zoom * 1.5) / TROWS
    for (let py = 0; py < TROWS; py++) {
        const fy = cy + (py - TROWS / 2) * sy
        let row = ""
        for (let px = 0; px < TCOLS; px++) {
            const fx = cx + (px - TCOLS / 2) * sx
            const it = mandel(fx, fy, maxIter)
            if (it === maxIter) row += ' '
            else row += RAMP.charAt(it % RAMP.length)
        }
        vramPutRow(py + 1, 1, row)
        // Check input mid-render so a slow frame can still be skipped.
        if (py % 6 === 5) { checkInput(); if (g_quit || g_skip) return }
    }
}

function scene7() {
    clearScreen()
    const KF = [
        { cx: -0.5,         cy:  0.0,    zoom: 1.5,    iter: 18, label: "XaoS - the fast portable realtime fractal zoomer" },
        { cx: -0.745,       cy:  0.113,  zoom: 0.4,    iter: 28, label: "MANDELBROT SET, z := z^2 + c" },
        { cx: -0.7453,      cy:  0.1127, zoom: 0.06,   iter: 40, label: "DEEPER..." },
        { cx: -0.74543,     cy:  0.11301,zoom: 0.012,  iter: 55, label: "...DEEPER" },
        { cx: -0.16,        cy:  1.04,   zoom: 0.3,    iter: 35, label: "JULIA-LIKE SPIRAL" },
        { cx:  0.275,       cy:  0.005,  zoom: 0.05,   iter: 60, label: "FINE STRUCTURE" },
        { cx: -0.5,         cy:  0.0,    zoom: 2.0,    iter: 22, label: "...AND BACK" },
    ]
    for (let k = 0; k < KF.length; k++) {
        if (g_quit) return
        const f = KF[k]
        renderMandel(f.cx, f.cy, f.zoom, f.iter)
        if (g_quit || g_skip) { g_skip = false; continue }
        setBG(BLACK); setFG(WHITE)
        drawText(TROWS, 2, f.label)
        if (!waitMs(1900)) return
    }
    con.clear()
}

// ============================================================================
// SCENE 8 — ASCII art pan substitute for the zebra zoom
// ============================================================================
const ZEBRA_ART = (
    "+------------------------------------------------------------------+\n" +
    "|             A A   A A     P R O J E C T   1 9 9 7                |\n" +
    "+------------------------------------------------------------------+\n" +
    "                                                                    \n" +
    "         /\\        /\\           /\\        /\\        /\\               \n" +
    "        /  \\      /  \\         /  \\      /  \\      /  \\              \n" +
    "       /    \\____/    \\_______/    \\____/    \\____/    \\____         \n" +
    "      |   .  .  .          .  .          .          .   .   |        \n" +
    "      |  ASCII   ART    DEMONSTRATION    BY     AA-GROUP    |        \n" +
    "       \\_____      ____      _____      ____      ______    /        \n" +
    "            \\____/    \\____/     \\____/    \\____/      \\___/         \n" +
    "                                                                     \n" +
    "       8888   8888    Welcome  to  the  text-mode  generation        \n" +
    "      88   88 88   88     where    every    pixel    is    a         \n" +
    "      8888888 8888888       letter,    and    every    letter        \n" +
    "      88   88 88   88           tells   a   tiny   story.            \n" +
    "      88   88 88   88                                                \n"
).split("\n")

function scene8() {
    clearScreen()
    const lines = ZEBRA_ART
    const H = lines.length
    let maxW = 0
    for (let i = 0; i < lines.length; i++) if (lines[i].length > maxW) maxW = lines[i].length
    const okPan = runScene(8000000, 22, function(el, total) {
        const t = el / total
        const span = Math.max(0, maxW - TCOLS)
        const ox = ((Math.sin(t * Math.PI * 2) * 0.5 + 0.5) * span) | 0
        const oy = (Math.sin(t * Math.PI * 4) * 4) | 0
        for (let y = 1; y <= TROWS; y++) {
            const sy = y - 1 + oy
            let row
            if (sy < 0 || sy >= H) row = ""
            else {
                row = lines[sy]
                if (row === undefined) row = ""
                row = row.substring(ox, ox + TCOLS)
            }
            while (row.length < TCOLS) row += " "
            vramPutRow(y, 1, row)
        }
    })
    if (!okPan) return
    con.clear()
}

// ============================================================================
// SCENE 9/10 — wireframe cube (substitute for 3D-torus / patnik)
// ============================================================================
function scene910() {
    clearScreen()
    const okCube = runScene(6500000, 18, function(el) {
        con.clear()
        const t = el / 200000
        const V = [
            [-1,-1,-1],[ 1,-1,-1],[ 1, 1,-1],[-1, 1,-1],
            [-1,-1, 1],[ 1,-1, 1],[ 1, 1, 1],[-1, 1, 1],
        ]
        const E = [
            [0,1],[1,2],[2,3],[3,0],
            [4,5],[5,6],[6,7],[7,4],
            [0,4],[1,5],[2,6],[3,7],
        ]
        const sa = Math.sin(t * 0.013), ca = Math.cos(t * 0.013)
        const sb = Math.sin(t * 0.011), cb = Math.cos(t * 0.011)
        const proj = []
        for (let i = 0; i < V.length; i++) {
            const x = V[i][0], y = V[i][1], z = V[i][2]
            const x1 = x * ca - z * sa
            const z1 = x * sa + z * ca
            const y2 = y * cb - z1 * sb
            const z2 = y * sb + z1 * cb
            const d  = 3 + z2
            proj[i] = [
                ((x1 / d) * TCOLS * 0.7 + TCOLS / 2) | 0,
                ((y2 / d) * TROWS * 1.5 + TROWS / 2) | 0,
            ]
        }
        for (let i = 0; i < E.length; i++) {
            const a = proj[E[i][0]], b = proj[E[i][1]]
            let x0 = a[0], y0 = a[1]
            const x1 = b[0], y1 = b[1]
            const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1
            const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1
            let err = dx + dy
            for (let safety = 0; safety < 200; safety++) {
                putCh(y0 + 1, x0 + 1, 0xDB)
                if (x0 === x1 && y0 === y1) break
                const e2 = 2 * err
                if (e2 >= dy) { err += dy; x0 += sx }
                if (e2 <= dx) { err += dx; y0 += sy }
            }
        }
        const cap = (el < 1500000) ? "3D ENGINE"
                  : (el < 3000000) ? "ROTATING CUBE"
                  : (el < 4500000) ? "PSEUDO 3D"
                  :                  "TEXT MODE!"
        bigText(TROWS - 3, cap, 1)
    })
    if (!okCube) return
    con.clear()
}

// ============================================================================
// Portraits, vezen, messager, devezen — near-verbatim ports of scene1.c:vezen,
// messager.c:messager, and messager.c:devezen1..4.
//
// Portrait images: the original loads BW image files and dispimg()'s them into
// the image buffer. We keep our pre-rendered ASCII portrait .txt files: each
// is written straight into the aalib textbuffer, and a backconvert() pass
// projects the cell-mode portrait back into the image buffer so the image-
// domain strobik fade + devezen wipes operate on it the same way as in C.
// ============================================================================
function loadPortrait(path) {
    let fh
    try { fh = files.open(path) } catch (e) { return null }
    if (!fh.exists) return null
    const data = fh.sread()
    if (!data) return null
    const lines = data.split("\n")
    const header = lines[0].split(" ")
    const cols = (header[0] | 0)
    const rows = (header[1] | 0)
    if (!cols || !rows) return null
    return { cols: cols, rows: rows, lines: lines.slice(1, 1 + rows) }
}

// Write a portrait into the aalib text+attr buffer (centred), then mirror it
// into the image buffer via backconvert so the strobik fade has something to
// render. After this, aa.render(image→text) reproduces the portrait — that's
// what bbDraw drives during strobikend.
function loadPortraitToBuffer(p) {
    const ctx = aaCtx()
    aa.cleartext(ctx)
    aa.clear(ctx)
    if (!p) return
    const scrW = aa.scrwidth(ctx), scrH = aa.scrheight(ctx)
    const x0 = ((scrW - p.cols) / 2) | 0
    const y0 = ((scrH - p.rows) / 2) | 0
    for (let i = 0; i < p.rows; i++) {
        const row = p.lines[i] || ""
        const yy = y0 + i
        if (yy < 0 || yy >= scrH) continue
        aa.puts(ctx, x0 < 0 ? 0 : x0, yy, aa.AA_NORMAL, row)
    }
    aa.backconvert(ctx, 0, 0, scrW, scrH)
}

// vezen(set) — exact mirror of scene1.c:vezen(): for each of 4 portraits, a
// strobikstart() flashes white, the next portrait is loaded, strobikend()
// fades back; bbwait(500ms) between, bbwait(1000ms) after the last.
function vezen(set) {
    g_drawptr     = null
    g_overlayText = ""
    for (let i = 1; i <= 4; i++) {
        if (g_quit) return
        strobikstart()
        const p = loadPortraitToBuffer(loadPortrait(BB_DIR + set + i + ".txt"))
        strobikend()
        if (i < 4) {
            if (!bbwait(500000)) return
        } else {
            if (!bbwait(1000000)) return
        }
    }
}

// ── messager(c) — near-verbatim port of messager.c:messager() ──────────────
// `start` tracks the top of the messager region. Each newline() shrinks it
// until it hits 0, after which the textbuffer scrolls up one row per newline.
// The result: the bio crawls up from the bottom row, pushing the previous
// content (the vezen portrait) off the top. A reverse-video cursor sits at
// the next write position. `bbflushwait(30ms)` per char ≈ ~33 char/s.
let g_messagerStart = 0
function messager(c) {
    const ctx = aaCtx()
    const scrW = aa.scrwidth(ctx), scrH = aa.scrheight(ctx)
    const tb = ctx.textbuffer, ab = ctx.attrbuffer
    const s = c.length

    g_drawptr     = null
    g_overlayText = ""

    let start = scrH - 1
    let cursor_x = 0
    let cursor_y = scrH - 1
    g_messagerStart = start

    const newline = function() {
        while (cursor_x < scrW) {
            tb[cursor_x + cursor_y * scrW] = 0x20
            ab[cursor_x + cursor_y * scrW] = aa.AA_NORMAL
            cursor_x++
        }
        start--
        if (start < 0) start = 0
        g_messagerStart = start
        cursor_y++
        cursor_x = 0
        if (cursor_y >= scrH) {
            // Scroll: rows [start+1 .. scrH-1] move up to [start .. scrH-2],
            // and the now-empty bottom row is blanked.
            const rowLen = scrW
            const off    = start * rowLen
            const tail   = scrW * (scrH - start - 1)
            tb.copyWithin(off, off + rowLen, off + rowLen + tail)
            ab.copyWithin(off, off + rowLen, off + rowLen + tail)
            for (let x = 0; x < scrW; x++) {
                tb[(scrH - 1) * scrW + x] = 0x20
                ab[(scrH - 1) * scrW + x] = aa.AA_NORMAL
            }
            cursor_y--
        }
    }

    const put = function(ch) {
        if (ch === 0x0A) { newline(); return }
        tb[cursor_x + cursor_y * scrW] = ch
        ab[cursor_x + cursor_y * scrW] = aa.AA_NORMAL
        cursor_x++
        if (cursor_x === scrW) newline()
    }

    const putcursor = function() {
        // AA_REVERSE block at the next write position.
        if (cursor_x >= 0 && cursor_x < scrW && cursor_y >= 0 && cursor_y < scrH) {
            ab[cursor_x + cursor_y * scrW] = aa.AA_REVERSE
            tb[cursor_x + cursor_y * scrW] = 0x20
        }
    }

    // bbflushwait — like bbwait but flushes the textbuffer first.
    const bbflushwait = function(us) {
        aa.flush(ctx)
        return bbwait(us)
    }

    for (let i = 0; i < s; i++) {
        if (g_quit) return
        if (g_skip) { g_skip = false; break }
        put(c.charCodeAt(i))
        // The reverse-video cursor is overwritten naturally by the next put().
        putcursor()
        if (!bbflushwait(0.03 * 1000000)) return
        if ((i & 7) === 0) checkInput()
    }
    aa.flush(ctx)
    bbwait(1000000)
    aa.gotoxy(ctx, 0, 0)
}

// ── devezen1..4 — fade-out transitions out of the messager screen ─────────
// All four start by backconvert()-ing the current text screen into the image
// buffer (`tographics`) so the per-pixel fade effects have something to work
// on. They differ only in WHICH timestuff control(s) they run.
function tographics() {
    const ctx = aaCtx()
    const scrW = aa.scrwidth(ctx)
    const scrH = aa.scrheight(ctx)
    aa.backconvert(ctx, 0, g_messagerStart, scrW, scrH)
}

// Snapshot a copy of the current image buffer (used by devezen1's two-buffer
// scroll wipe).
function _imgSnapshot() {
    const ctx = aaCtx()
    return ctx.imagebuffer.slice()
}

function devezen1() {
    // Pixel-domain scroll wipe between TWO snapshots of the image buffer:
    //   bckup  — pre-tographics image buffer (whatever the previous scene
    //            left behind; in main() flow that's the post-messager state
    //            *before* backconvert, ie. the last vezen frame's pixels).
    //   bckup1 — post-tographics image buffer (the messager text rendered
    //            back to pixels).
    // toblack1() ramps a moving Y boundary across the screen, with two
    // intensity multipliers that blend between bckup and bckup1 above the
    // line and below it. The result reads as the bio sliding away.
    const ctx = aaCtx()
    const params = g_aaPar
    const W = aa.imgwidth(ctx), H = aa.imgheight(ctx)
    const bckup  = _imgSnapshot()
    tographics()
    const bckup1 = _imgSnapshot()
    const buf    = ctx.imagebuffer
    const start  = sysNow()
    const durUs  = 5000000
    g_drawptr = null
    g_overlayText = ""

    const toblack1 = function() {
        const elapsed = ((sysNow() - start) / 1000) | 0
        const stage   = elapsed
        const total   = durUs
        const pos = (stage * (H + H) / total - H) | 0
        let minpos = 0
        for (let y = 0; y < H; y++) {
            let mul1 = y - pos
            if (mul1 < 0) mul1 = 0
            else mul1 = (mul1 * 256 * 4 / H) | 0
            if (mul1 > 256) mul1 = 256

            let mul2 = y - pos - H
            if (mul2 < 0) mul2 = 0
            else mul2 = (mul2 * 256 * 8 / H) | 0
            if (mul2 > 256) mul2 = 256

            if (mul2 === 0) minpos = y
            const blend = mul1 - mul2
            const base = y * W
            for (let x = 0; x < W; x++) {
                const v = (blend * bckup[base + x] + mul2 * bckup1[base + x]) >> 8
                buf[base + x] = v < 0 ? 0 : (v > 255 ? 255 : v)
            }
        }
        let renderH = pos + ((3 * H) >> 2)
        if (renderH < 0) renderH = 0
        if (renderH > H) renderH = H
        // aa.render only takes screen-cell rects, not pixel rects; map back.
        aa.render(ctx, params, 0, 0, aa.scrwidth(ctx), Math.min(aa.scrheight(ctx), (renderH >> 1)))
        aa.flush(ctx)
    }

    g_drawptr = toblack1
    timestuff(0, null, toblack1, durUs)
    g_drawptr = null
}

function devezen2() {
    // Fade to black: params.bright decays from 0 → -256 over 1 s.
    tographics()
    const params = g_aaPar
    const start = sysNow()
    const durUs = 1000000
    g_overlayText = ""
    g_drawptr = function() {
        const stage = ((sysNow() - start) / 1000) | 0
        params.bright = -stage * 256 / durUs
    }
    timestuff(0, null, bbDraw, durUs)
    g_drawptr = null
    params.bright = 0
}

function devezen3() {
    // Crank up randomval to 100 over 1 s, then fade to black over another 1 s.
    tographics()
    const params = g_aaPar
    let start = sysNow()
    const durUs = 1000000
    g_overlayText = ""
    g_drawptr = function() {
        const stage = ((sysNow() - start) / 1000) | 0
        params.randomval = (stage * 100 / durUs) | 0
    }
    timestuff(0, null, bbDraw, durUs)
    params.randomval = 100
    start = sysNow()
    g_drawptr = function() {
        const stage = ((sysNow() - start) / 1000) | 0
        params.bright = -stage * 256 / durUs
    }
    timestuff(0, null, bbDraw, durUs)
    params.randomval = 0
    params.bright = 0
    g_drawptr = null
}

function devezen4() {
    // Drop contrast for 0.5 s, then ramp bright to +256 (white-out) for 0.5 s.
    tographics()
    const params = g_aaPar
    let start = sysNow()
    const durUs = 500000
    g_overlayText = ""
    g_drawptr = function() {
        const stage = ((sysNow() - start) / 1000) | 0
        params.contrast = -stage * 256 / durUs
    }
    timestuff(0, null, bbDraw, durUs)
    start = sysNow()
    g_drawptr = function() {
        const stage = ((sysNow() - start) / 1000) | 0
        params.bright = stage * 256 / durUs
    }
    timestuff(0, null, bbDraw, durUs)
    params.bright = 0
    params.contrast = 0
    g_drawptr = null
}

const BIO_FK = (
    "FILIP KUPSA known as FK, Tingle Notions, Dawn Music\n" +
    "birth: June 22 1979, Tabor, Czech Republic, sex: male\n" +
    "\n" +
    "1992 - Changed his piano for 386/pc-speaker music\n" +
    "1993 - Got his first Sound Blaster\n" +
    "1995 - Changed his SB for a new GUS technology\n" +
    "1996 - Composed his first great hits\n" +
    "1996 - FAT recomposition made by Windows 95\n" +
    "1997 - Released his musac in BB\n" +
    "1998 - Got retired"
)

const BIO_MS = (
    "MOJMIR SVOBODA known as MS, TiTania, MSS, Bill\n" +
    "birth: ??, Tabor, Czech Republic, sex: ? male ?\n" +
    "\n" +
    "1993 - Installed Linux on his 386sx/25 + 40MB HDD\n" +
    "1994 - Removed Linux to make space for Doom\n" +
    "1995 - Reinstalled Linux on his 486Dx4/120 + 850MB\n" +
    "1996 - Removed Linux to make space for Windows 95\n" +
    "1997 - Removed Windows 95 to make space for aalib"
)

const BIO_KT = (
    "KAMIL TOMAN known as KT, Kato, Whale, Bart\n" +
    "birth: May 19 1979, Tabor, Czech Republic, sex: male\n" +
    "\n" +
    "1993 - Became a linux extremist\n" +
    "1993 - Successful attempt to establish a secret\n" +
    "       organisation: Commandline Brotherhood\n" +
    "1995 - Action 'koules' - a secret project to train\n" +
    "       brotherhood members - covered as a game\n" +
    "1998 - Heading a new wave of command line revolution"
)

const BIO_HH = (
    "JAN HUBICKA known as HH, Jahusoft, JHS, UNIX, Honza\n" +
    "birth: Apr 1 1978, Tabor, Czech Republic, sex: male\n" +
    "\n" +
    "1991 - Installed underground hackers OS Linux\n" +
    "1995 - Headed Action 'koules'\n" +
    "1996 - Famous troan XaoS to convert all Windows\n" +
    "       installations into Linux\n" +
    "1998 - Secret plan to make 'Text Windows' system\n" +
    "2001 - Planning an assassination of dictator Bill G."
)

// ============================================================================
// Credits — starfield + scroller
// ============================================================================
function credits() {
    clearScreen()
    loadSong(BB_DIR + "bb2.taud"); startMusic()

    const NSTARS = 90
    const MAXFAR = 1000
    const stars = []
    function spawnStar(i) {
        stars[i] = {
            x: (Math.random() - 0.5) * 800,
            y: (Math.random() - 0.5) * 800,
            z: Math.random() * MAXFAR + 1,
        }
    }
    for (let i = 0; i < NSTARS; i++) spawnStar(i)

    const CREDITS = [
        "THANK YOU", "FOR", "WATCHING", "BB", "...", "CREDITS",
        "FK:", "MUSIC",
        "MS:", "3D ENGINE", "TYRE",
        "KT:", "SOUND ENGINE", "PLASMA", "STARS", "SNOWING",
        "HH:", "AALIB", "INVADERS", "FIRE", "GREETINGS",
        "PHOTOS", "XAOS", "ZEBRA", "TIMING", "OUTRO",
        "...",
        "SPECIAL THANKS",
        "EVA HUBICKOVA", "FOR PHOTOS",
        "TEXAS LINUX USERS GROUP", "INSPIRATION",
        "THOMAS MARSH", "FRACTAL ZOOMING",
        "IBM", "FOR MDA", "THE PRIMARY", "GFX TARGET",
        "MIKMAK", "MIKMOD",
        "RICHARD STALLMAN", "GNU",
        "LINUS", "LINUX",
        "...",
        "PORTED TO TSVM", "CURIOUSTORVALD", "2026",
        "(C) 1997 AA",
    ]
    const CTIME_MS = 800
    const TOTAL_MS = CTIME_MS * (CREDITS.length + 4)

    const okCred = runScene(TOTAL_MS * 1000, 18, function(el, dur) {
        // move + project stars
        for (let i = 0; i < NSTARS; i++) {
            let s = stars[i]
            s.z -= 30  // approach the viewer
            if (s.z <= 1) { spawnStar(i); s = stars[i] }
            const sx = (((s.x - 256) / s.z) * TCOLS) | 0
            const sy = (((s.y - 256) / s.z) * TCOLS * 0.5) | 0
            s._sx = sx + HALF_W
            s._sy = sy + HALF_H
        }
        con.clear()
        for (let i = 0; i < NSTARS; i++) {
            const s = stars[i]
            if (s._sx == null) continue
            if (s._sx < 0 || s._sx >= TCOLS) continue
            if (s._sy < 0 || s._sy >= TROWS) continue
            const intensity = MAXFAR / Math.max(1, s.z)
            const ch = intensity > 1.5 ? 0xFE : intensity > 0.7 ? 0x2A : 0x2E
            putCh(s._sy + 1, s._sx + 1, ch)
        }
        // scroll captions
        const elMs = el / 1000
        for (let i = 0; i < CREDITS.length; i++) {
            const localMs = elMs - i * CTIME_MS
            if (localMs < 0 || localMs > CTIME_MS * 3) continue
            const yf = TROWS - (localMs / (CTIME_MS * 3)) * (TROWS + 6)
            const y = yf | 0
            if (y < 1 || y > TROWS) continue
            setFG(WHITE)
            bigText(y, CREDITS[i], 1)
        }
    })
    if (!okCred) return
    con.clear()
}

// ============================================================================
// Closing logo (clipped credits2 — no interactive text reader)
// ============================================================================
function closingLogo() {
    clearScreen()
    loadSong(BB_DIR + "bb3.taud"); startMusic()

    // Build a vertical "8 8" growing from below.
    const LOGOH = 7
    const yStart = TROWS - 2
    const xMid = HALF_W - 1
    for (let i = 0; i <= LOGOH; i++) {
        if (g_quit) return
        con.clear()
        for (let r = 0; r < i; r++) {
            const yy = yStart - r
            if (yy >= 1) drawText(yy, xMid, "8  8")
        }
        if (!waitMs(120)) return
    }
    drawText((TROWS / 2) | 0, ((TCOLS - 18) / 2 | 0) + 1, "<PROJECT><PROJECT>")
    if (!waitMs(700)) return

    const banner = [
        "                               dT8  8Tb                       ",
        "                              dT 8  8 Tb                      ",
        "                             dT  8  8  Tb                     ",
        "                          <PROJECT><PROJECT>                  ",
        "                           dT    8  8    Tb                   ",
        "                          dT     8  8     Tb                  ",
    ]
    const okBan = runScene(3500000, 20, function(el) {
        con.clear()
        const yTop = ((TROWS - banner.length) / 2 | 0) + 1
        for (let i = 0; i < banner.length; i++) drawText(yTop + i, 1, banner[i])
        if (((el / 200000) | 0) % 2) drawText(yTop + 3, 1, banner[3])
    })
    if (!okBan) return

    runScene(3000000, 12, function(el) {
        con.clear()
        bigText(HALF_H - 2, "END", 3)
        if (((el / 200000) | 0) % 2) bigText(HALF_H + 4, "(C) 1997 AA", 1)
    })
}

// ============================================================================
// Main
// ============================================================================
function teardown() {
    stopMusic()
    reset()
    con.reset_graphics()
    con.clear()
    con.curs_set(1)
    con.move(1, 1)
}

function main() {
    con.curs_set(0)
    clearScreen()
    g_t0_ns = sysNow()

    // Pre-load the song; playback is kicked off mid-scene1, exactly where the
    // C scene1.c calls play() (between the scramble phases and "AA PRESENTS").
    loadSong(BB_DIR + "bb.taud")

    // Scene order + devezen variant per bio match bb.c's bb() loop.
    scene1();           if (g_quit) return
    scene3();           if (g_quit) return
    vezen("fk");        if (g_quit) return
    messager(BIO_FK);   if (g_quit) return
    devezen2()          // fade to black
    scene4();           if (g_quit) return
    scene2();           if (g_quit) return
    vezen("ms");        if (g_quit) return
    messager(BIO_MS);   if (g_quit) return
    devezen3()          // noise-up then fade to black
    scene8();           if (g_quit) return
    vezen("kt");        if (g_quit) return
    messager(BIO_KT);   if (g_quit) return
    devezen1()          // two-buffer scroll wipe
    scene7();           if (g_quit) return
    scene5();           if (g_quit) return
    scene910();         if (g_quit) return
    vezen("hh");        if (g_quit) return
    messager(BIO_HH);   if (g_quit) return
    devezen4()          // drop contrast then white-out
    credits();          if (g_quit) return
    closingLogo()
}

try {
    main()
} finally {
    teardown()
}

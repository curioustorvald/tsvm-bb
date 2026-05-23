/* Decode all LZO-compressed BB images (zeb + 16 portraits) into raw 8bpp
 * greyscale files with a tiny header so the JS loader knows the dimensions.
 *
 * Put the BB source codes under `original_codes` then compile.
 *
 * File format:
 *   bytes 0..1  uint16 LE   width
 *   bytes 2..3  uint16 LE   height
 *   bytes 4..   width*height bytes of luminance (0..255)
 *
 * Build & run:
 *   gcc -O2 -Wno-implicit-function-declaration -I original_codes \
 *       decode_images.c original_codes/minilzo.c \
 *       original_codes/zeb.c \
 *       original_codes/fk1.c original_codes/fk2.c \
 *       original_codes/fk3.c original_codes/fk4.c \
 *       original_codes/hh1.c original_codes/hh2.c \
 *       original_codes/hh3.c original_codes/hh4.c \
 *       original_codes/kt1.c original_codes/kt2.c \
 *       original_codes/kt3.c original_codes/kt4.c \
 *       original_codes/ms1.c original_codes/ms2.c \
 *       original_codes/ms3.c original_codes/ms4.c -o decode_images
 *   ./decode_images <outdir>
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "image.h"
#include "minilzo.h"

extern struct image zeb;
extern struct image fk1, fk2, fk3, fk4;
extern struct image hh1, hh2, hh3, hh4;
extern struct image kt1, kt2, kt3, kt4;
extern struct image ms1, ms2, ms3, ms4;

struct entry { const char *name; struct image *img; };
static const struct entry table[] = {
    {"zeb", &zeb},
    {"fk1", &fk1}, {"fk2", &fk2}, {"fk3", &fk3}, {"fk4", &fk4},
    {"hh1", &hh1}, {"hh2", &hh2}, {"hh3", &hh3}, {"hh4", &hh4},
    {"kt1", &kt1}, {"kt2", &kt2}, {"kt3", &kt3}, {"kt4", &kt4},
    {"ms1", &ms1}, {"ms2", &ms2}, {"ms3", &ms3}, {"ms4", &ms4},
};

static int decode_one(const char *name, struct image *img, const char *outdir)
{
    int outsize = img->width * img->height;
    unsigned char *buf = malloc(outsize + 16);
    if (!buf) { perror("malloc"); return 1; }
    int sz = outsize;
    int r = lzo1x_decompress(img->data, img->size, buf, &sz, NULL);
    if (r != LZO_E_OK || sz != outsize) {
        fprintf(stderr, "%s: decompress failed (r=%d sz=%d expected=%d)\n",
                name, r, sz, outsize);
        free(buf);
        return 1;
    }
    char path[512];
    snprintf(path, sizeof(path), "%s/%s.raw", outdir, name);
    FILE *f = fopen(path, "wb");
    if (!f) { perror(path); free(buf); return 1; }
    unsigned char hdr[4] = {
        (unsigned char)(img->width  & 0xFF),
        (unsigned char)((img->width  >> 8) & 0xFF),
        (unsigned char)(img->height & 0xFF),
        (unsigned char)((img->height >> 8) & 0xFF),
    };
    fwrite(hdr, 1, 4, f);
    fwrite(buf, 1, sz, f);
    fclose(f);
    fprintf(stderr, "%s: %dx%d -> %s\n", name, img->width, img->height, path);
    free(buf);
    return 0;
}

int main(int argc, char **argv)
{
    if (argc < 2) {
        fprintf(stderr, "usage: %s <outdir>\n", argv[0]);
        return 1;
    }
    if (lzo_init() != LZO_E_OK) {
        fprintf(stderr, "lzo_init failed\n");
        return 1;
    }
    int rc = 0;
    for (size_t i = 0; i < sizeof(table) / sizeof(*table); i++)
        rc |= decode_one(table[i].name, table[i].img, argv[1]);
    return rc;
}

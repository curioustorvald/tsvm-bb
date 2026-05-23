import re, struct, sys

# Format: 3 vertices per triangle, each vertex: x, y, z, nx, ny, nz
# Where x,y,z are int8 (signed -128..127), nx/ny/nz are int16 (signed -32768..32767)
# Pack as little-endian: x,y,z (1 byte each signed) + nx,ny,nz (2 bytes each signed) = 9 bytes per vertex.

def convert(infile, outfile, define_name):
    txt = open(infile).read()
    # Strip C comments
    txt = re.sub(r'/\*.*?\*/', '', txt, flags=re.S)
    # Find face count
    m = re.search(r'#define\s+' + define_name + r'\s+(\d+)', txt)
    nfaces = int(m.group(1))
    # Strip everything before the polygon array
    arr_start = txt.find('obj[]=')
    body = txt[arr_start:]
    # Find all numbers (signed)
    nums = re.findall(r'-?\d+', body)
    nums = [int(x) for x in nums]
    needed = nfaces * 3 * 6
    if len(nums) < needed:
        print(f"Error: only {len(nums)} numbers, need {needed}", file=sys.stderr)
        sys.exit(1)
    out = bytearray()
    # 4-byte header: little-endian face count (uint16) + 2 reserved bytes (zeros)
    out += struct.pack('<HH', nfaces, 0)
    for i in range(nfaces):
        for v in range(3):
            base = (i*3 + v) * 6
            x, y, z, nx, ny, nz = nums[base:base+6]
            # Range check
            assert -128 <= x <= 127, f"x out of range: {x}"
            assert -128 <= y <= 127, f"y out of range: {y}"
            assert -128 <= z <= 127, f"z out of range: {z}"
            assert -32768 <= nx <= 32767, f"nx out of range: {nx}"
            assert -32768 <= ny <= 32767, f"ny out of range: {ny}"
            assert -32768 <= nz <= 32767, f"nz out of range: {nz}"
            out += struct.pack('<bbbhhh', x, y, z, nx, ny, nz)
    open(outfile, 'wb').write(out)
    print(f"{outfile}: {nfaces} faces, {len(out)} bytes")

convert('/home/torvald/Documents/tsvm-bb/original_codes/torus.h',
        '/home/torvald/Documents/tsvm-bb/torus.poly',
        'torusnFaces')
convert('/home/torvald/Documents/tsvm-bb/original_codes/patnik.h',
        '/home/torvald/Documents/tsvm-bb/patnik.poly',
        'patniknFaces')

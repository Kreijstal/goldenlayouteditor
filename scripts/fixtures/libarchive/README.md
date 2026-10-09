RAR, CAB and LHA fixtures are decoded from the libarchive v3.7.9 regression tests:

- `test_read_format_rar.rar.uu`
- `test_read_format_cab_1.cab.uu`
- `test_read_format_lha_header0.lzh.uu`

Source: https://github.com/libarchive/libarchive/tree/v3.7.9/libarchive/test
License: the libarchive BSD notices retained in `public/licenses/imported-viewers/libarchive-BSD.txt`.

The separate `tiny.7z` fixture is authored here with py7zr and contains a small hello text file. Other archive fixtures are generated locally by `scripts/archive-fixtures.py`, including tar, compression streams, ar, cpio, a Debian ar package, RPM with a nonempty cpio payload, ZIP and XAR.

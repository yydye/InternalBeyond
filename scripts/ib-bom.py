#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""确保给定文件带 UTF-8 BOM（Windows 编辑器兼容）。

为什么需要它：DSH 的 write/edit 工具会去掉文件原有的 UTF-8 BOM，而本仓库的
前端静态回归（tests/test_frontend_structure.js 的 encoding.bom.*）要求
InternalBeyond.html 与 assets/ 下的每个 .css / .js 都带 BOM。含中文的
PowerShell .ps1 与 Inno Setup 的 .iss 同样必须带 BOM（否则 PowerShell 5.1
按 ANSI 解析报语法错误、ISCC 中文乱码）。

用法：
    python scripts/ib-bom.py <file> [<file> ...]
    python scripts/ib-bom.py --check <file> [...]    # 只报告，不写

它对已经带 BOM 的文件是幂等的，对不存在的文件只报错不改动。
"""
import io
import sys

BOM = b"\xef\xbb\xbf"


def ensure(path, write=True):
    try:
        with io.open(path, "rb") as fh:
            data = fh.read()
    except OSError as exc:
        return ("missing", path, str(exc))
    if data.startswith(BOM):
        return ("ok", path, "")
    if not write:
        return ("missing-bom", path, "")
    with io.open(path, "wb") as fh:
        fh.write(BOM + data)
    return ("added", path, "")


def main(argv):
    check_only = False
    paths = []
    for arg in argv[1:]:
        if arg == "--check":
            check_only = True
        else:
            paths.append(arg)
    if not paths:
        print(__doc__)
        return 2
    bad = 0
    for path in paths:
        status, name, detail = ensure(path, write=not check_only)
        print("%-12s %s%s" % (status, name, (" — " + detail) if detail else ""))
        if status in ("missing", "missing-bom"):
            bad += 1
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

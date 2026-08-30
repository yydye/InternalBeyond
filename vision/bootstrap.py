"""Install missing LocateAnything service dependencies into the active Python environment."""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys


MODULE_REQUIREMENTS = {
    "PIL": "Pillow>=11.1,<13",
    "fastapi": "fastapi>=0.115,<1",
    "uvicorn": "uvicorn[standard]>=0.34,<1",
    "python_multipart": "python-multipart>=0.0.20,<1",
    "httpx": "httpx>=0.28,<1",
}


def run(*args: str) -> None:
    subprocess.check_call([sys.executable, "-m", "pip", *args])


def has_module(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def nvidia_gpu_present() -> bool:
    try:
        subprocess.run(
            ["nvidia-smi"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
            timeout=8,
        )
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def ensure_torch() -> None:
    needs_install = not has_module("torch")
    if not needs_install:
        import torch

        if nvidia_gpu_present() and not torch.cuda.is_available():
            needs_install = True
    if not needs_install:
        return
    if nvidia_gpu_present():
        index = os.getenv("VISION_TORCH_INDEX_URL", "https://download.pytorch.org/whl/cu130")
        run("install", "torch==2.13.0", "--index-url", index)
    else:
        run(
            "install",
            "torch==2.13.0",
            "--index-url",
            "https://download.pytorch.org/whl/cpu",
        )


def main() -> None:
    if sys.version_info >= (3, 13):
        raise SystemExit(
            "LocateAnything 的 Windows PyTorch 环境需要 Python 3.9-3.12。"
            "请运行 start-vision-service.cmd，它会自动选择 Python 3.12。"
        )
    ensure_torch()
    missing = [requirement for module, requirement in MODULE_REQUIREMENTS.items() if not has_module(module)]
    if missing:
        run("install", *missing)
    print("Vision dependencies are ready.")


if __name__ == "__main__":
    main()

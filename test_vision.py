"""Smoke-test the running local vision API with two prompts."""

from __future__ import annotations

import argparse
import mimetypes
from pathlib import Path

import httpx


DEFAULT_PROMPTS = ["描述这张图片", "找到图片中的主要对象"]


def main() -> None:
    parser = argparse.ArgumentParser(description="Test Internal Beyond local vision API")
    parser.add_argument("image", nargs="?", default="test.jpg", help="image path")
    parser.add_argument("--api", default="http://127.0.0.1:8765/vision", help="vision endpoint")
    parser.add_argument("--prompt", action="append", dest="prompts", help="repeatable prompt")
    args = parser.parse_args()
    image_path = Path(args.image).expanduser().resolve()
    if not image_path.is_file():
        raise SystemExit(f"Image not found: {image_path}")
    mime = mimetypes.guess_type(image_path.name)[0] or "image/jpeg"
    prompts = args.prompts or DEFAULT_PROMPTS
    with httpx.Client(timeout=600) as client:
        for prompt in prompts:
            with image_path.open("rb") as handle:
                response = client.post(
                    args.api,
                    files={"image": (image_path.name, handle, mime)},
                    data={"prompt": prompt},
                )
            response.raise_for_status()
            print(f"\nPrompt: {prompt}\nResult: {response.json()['result']}")


if __name__ == "__main__":
    main()

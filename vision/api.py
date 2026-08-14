"""FastAPI endpoint for the local Qwen2.5-VL vision worker."""

from __future__ import annotations

import io
import os

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel

from .model import VisionModelError, get_vision_model


MAX_IMAGE_BYTES = int(os.getenv("VISION_MAX_IMAGE_BYTES", str(20 * 1024 * 1024)))


class VisionResponse(BaseModel):
    result: str


app = FastAPI(
    title="Internal Beyond Qwen Vision",
    version="1.0.0",
    description="Local-only Qwen2.5-VL-3B-Instruct image understanding service.",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["null"],
    allow_origin_regex=os.getenv(
        "VISION_ALLOWED_ORIGIN_REGEX",
        r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    ),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict:
    return {
        "ok": True,
        "service": "internal-beyond-vision",
        **get_vision_model().status(),
    }


@app.post("/vision", response_model=VisionResponse)
async def vision(
    image: UploadFile = File(...),
    prompt: str = Form("Describe this image."),
) -> VisionResponse:
    if image.content_type and not image.content_type.startswith("image/"):
        raise HTTPException(status_code=415, detail="image 必须是图片文件")
    raw = await image.read(MAX_IMAGE_BYTES + 1)
    await image.close()
    if not raw:
        raise HTTPException(status_code=400, detail="图片为空")
    if len(raw) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="图片超过 20MB 限制")
    try:
        pil_image = Image.open(io.BytesIO(raw))
        pil_image.load()
        pil_image = pil_image.convert("RGB")
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="无法解析图片") from exc
    try:
        result = await run_in_threadpool(
            get_vision_model().predict,
            pil_image,
            prompt,
        )
    except VisionModelError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return VisionResponse(result=result)

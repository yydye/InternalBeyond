"""Singleton client for the local Ollama Qwen2.5-VL-3B runtime."""

from __future__ import annotations

import base64
import io
import os
import platform
import subprocess
import threading
from typing import Any

import httpx
import torch
from PIL import Image


MODEL_ID = os.getenv("VISION_MODEL_ID", "qwen2.5vl:3b")
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")


class VisionModelError(RuntimeError):
    """Safe, user-facing vision model failure."""


class QwenVisionService:
    """Thread-safe Qwen2.5-VL client; Ollama owns model/GPU lifetime."""

    def __init__(self, model_id: str = MODEL_ID) -> None:
        self.model_id = model_id
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.quantized_4bit = True
        self._loaded = False
        self._load_error = ""
        self._load_lock = threading.Lock()
        self._inference_lock = threading.Lock()
        self._client = httpx.Client(timeout=httpx.Timeout(600.0, connect=10.0))

    def _tags(self) -> dict[str, Any]:
        response = self._client.get(f"{OLLAMA_URL}/api/tags")
        response.raise_for_status()
        return response.json()

    def _model_installed(self) -> bool:
        names = {
            str(item.get("name") or item.get("model") or "")
            for item in self._tags().get("models", [])
        }
        return self.model_id in names or self.model_id.replace(":latest", "") in names

    def load(self) -> "QwenVisionService":
        if self._loaded:
            return self
        with self._load_lock:
            if self._loaded:
                return self
            try:
                if not self._model_installed():
                    subprocess.run(
                        ["ollama", "pull", self.model_id], check=True, timeout=1800
                    )
                self._loaded = True
                self._load_error = ""
            except FileNotFoundError as exc:
                self._load_error = "Ollama 未安装"
                raise VisionModelError("未找到 Ollama，请先安装并启动 Ollama") from exc
            except Exception as exc:
                self._load_error = str(exc)
                raise VisionModelError(
                    f"无法连接本地 Ollama 或加载 {self.model_id}：{exc}"
                ) from exc
        return self

    @staticmethod
    def _encode_image(image: Image.Image) -> str:
        prepared = image.convert("RGB")
        max_side = int(os.getenv("VISION_MAX_IMAGE_SIDE", "1280"))
        if max(prepared.size) > max_side:
            prepared = prepared.copy()
            prepared.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
        buffer = io.BytesIO()
        prepared.save(buffer, format="JPEG", quality=90, optimize=True)
        return base64.b64encode(buffer.getvalue()).decode("ascii")

    def predict(
        self,
        image: Image.Image,
        prompt: str,
        generation_mode: str = "hybrid",
        max_new_tokens: int = 512,
    ) -> str:
        del generation_mode
        self.load()
        payload = {
            "model": self.model_id,
            "stream": False,
            "keep_alive": os.getenv("VISION_KEEP_ALIVE", "10m"),
            "messages": [{
                "role": "user",
                "content": (prompt or "请详细描述这张图片。").strip(),
                "images": [self._encode_image(image)],
            }],
            "options": {
                "num_predict": max(32, min(int(max_new_tokens), 1024)),
                "temperature": 0,
            },
        }
        with self._inference_lock:
            try:
                response = self._client.post(f"{OLLAMA_URL}/api/chat", json=payload)
                response.raise_for_status()
                result = str(response.json().get("message", {}).get("content", "")).strip()
            except Exception as exc:
                raise VisionModelError(f"Qwen2.5-VL 推理失败：{exc}") from exc
        if not result:
            raise VisionModelError("Qwen2.5-VL 返回空内容")
        return result

    def status(self) -> dict[str, Any]:
        installed = False
        running: list[dict[str, Any]] = []
        try:
            installed = self._model_installed()
            process_response = self._client.get(f"{OLLAMA_URL}/api/ps")
            if process_response.is_success:
                running = process_response.json().get("models", [])
        except Exception as exc:
            self._load_error = str(exc)
        active = next(
            (item for item in running if item.get("name") == self.model_id), None
        )
        result: dict[str, Any] = {
            "model": self.model_id,
            "runtime": "ollama",
            "installed": installed,
            "loaded": active is not None,
            "device": self.device,
            "quantized_4bit": self.quantized_4bit,
            "platform": platform.system(),
            "cuda_available": torch.cuda.is_available(),
            "load_error": self._load_error,
        }
        if active:
            result.update({
                "model_size_mib": round(int(active.get("size", 0)) / 1024**2),
                "gpu_size_mib": round(int(active.get("size_vram", 0)) / 1024**2),
            })
        if torch.cuda.is_available():
            result.update({
                "gpu": torch.cuda.get_device_name(0),
                "gpu_total_mib": round(torch.cuda.get_device_properties(0).total_memory / 1024**2),
            })
        return result


_singleton: QwenVisionService | None = None
_singleton_lock = threading.Lock()


def get_vision_model() -> QwenVisionService:
    global _singleton
    if _singleton is None:
        with _singleton_lock:
            if _singleton is None:
                _singleton = QwenVisionService()
    return _singleton


LocateAnythingService = QwenVisionService

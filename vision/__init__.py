"""Internal Beyond local vision service.

The package root deliberately avoids importing torch so ``python -m vision.bootstrap``
can install dependencies into a brand-new virtual environment.
"""

__all__ = ["QwenVisionService", "LocateAnythingService", "get_vision_model"]


def __getattr__(name):
    if name in __all__:
        from .model import LocateAnythingService, QwenVisionService, get_vision_model

        return {
            "QwenVisionService": QwenVisionService,
            "LocateAnythingService": LocateAnythingService,
            "get_vision_model": get_vision_model,
        }[name]
    raise AttributeError(name)

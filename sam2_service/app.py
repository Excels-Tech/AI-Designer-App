import base64
import io
import os
import uuid
from typing import List, Optional

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from PIL import Image
from sklearn.cluster import KMeans
import torch


class Sam2State:
    def __init__(self) -> None:
        self.enabled = False
        self.error: Optional[str] = None
        self.generator = None
        self.device = "cpu"
        self.sam2_available = False
        self.warning: Optional[str] = None

    def load(self) -> None:
        try:
            from sam2.build_sam import build_sam2
            from sam2.automatic_mask_generator import SAM2AutomaticMaskGenerator
        except Exception as exc:
            self.sam2_available = False
            self.warning = "SAM2 import unavailable; using KMeans fallback"
            return
        self.sam2_available = True

        config_path = os.getenv("SAM2_CONFIG", "").strip()
        checkpoint_path = os.getenv("SAM2_CHECKPOINT", "").strip()
        if not config_path or not checkpoint_path:
            self.warning = "SAM2 not configured; using KMeans fallback"
            return
        if not os.path.exists(config_path) or not os.path.exists(checkpoint_path):
            self.warning = "SAM2 weights missing; using KMeans fallback"
            return

        device = "cuda" if torch.cuda.is_available() else "cpu"
        model = build_sam2(config_path, checkpoint_path, device=device)
        self.generator = SAM2AutomaticMaskGenerator(model)
        self.enabled = True
        self.device = device
        self.warning = None


sam2_state = Sam2State()
sam2_state.load()

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class AutoRequest(BaseModel):
    imageDataUrl: str


class ColorLayerRequest(BaseModel):
    imageDataUrl: str
    num_layers: int = Field(default=4, ge=2, le=8)
    min_area_ratio: float = Field(default=0.01, ge=0.0, le=0.5)
    blur: int = Field(default=1, ge=0, le=9)
    seed: int = Field(default=42)


def decode_data_url(data_url: str) -> Image.Image:
    if not data_url.startswith("data:image"):
        raise ValueError("Expected data URL")
    header, encoded = data_url.split(",", 1)
    binary = base64.b64decode(encoded)
    return Image.open(io.BytesIO(binary)).convert("RGB")


def encode_png(image: np.ndarray) -> str:
    if image.ndim == 3 and image.shape[2] == 3:
        image = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
    elif image.ndim == 3 and image.shape[2] == 4:
        image = cv2.cvtColor(image, cv2.COLOR_RGBA2BGRA)
    success, buf = cv2.imencode(".png", image)
    if not success:
        raise ValueError("Failed to encode PNG")
    return "data:image/png;base64," + base64.b64encode(buf.tobytes()).decode("utf-8")


def mask_to_png(mask: np.ndarray, blur: int = 0) -> str:
    mask_uint8 = (mask.astype(np.uint8) * 255)
    if blur > 0:
        k = blur * 2 + 1
        mask_uint8 = cv2.GaussianBlur(mask_uint8, (k, k), 0)
    return encode_png(mask_uint8)


def apply_mask_cutout(image: np.ndarray, mask: np.ndarray, blur: int = 0) -> str:
    mask_uint8 = (mask.astype(np.uint8) * 255)
    if blur > 0:
        k = blur * 2 + 1
        mask_uint8 = cv2.GaussianBlur(mask_uint8, (k, k), 0)
    rgba = cv2.cvtColor(image, cv2.COLOR_RGB2RGBA)
    rgba[:, :, 3] = mask_uint8
    return encode_png(rgba)


def lab_from_rgb(rgb: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(rgb.astype(np.uint8), cv2.COLOR_RGB2LAB)


def rgb_hex_from_lab(lab: np.ndarray) -> str:
    lab_img = np.array([[lab]], dtype=np.uint8)
    rgb = cv2.cvtColor(lab_img, cv2.COLOR_LAB2RGB)[0][0]
    return "#{:02X}{:02X}{:02X}".format(int(rgb[0]), int(rgb[1]), int(rgb[2]))


def generate_sam2_masks(image_rgb: np.ndarray) -> List[np.ndarray]:
    if not sam2_state.enabled:
        raise RuntimeError(sam2_state.error or "SAM2 not ready.")
    masks = sam2_state.generator.generate(image_rgb)
    return [m["segmentation"].astype(bool) for m in masks]


def downsample_image(image_rgb: np.ndarray, max_dim: int = 512) -> np.ndarray:
    height, width = image_rgb.shape[:2]
    scale = min(1.0, max_dim / max(height, width))
    if scale == 1.0:
        return image_rgb
    new_w = max(1, int(width * scale))
    new_h = max(1, int(height * scale))
    return cv2.resize(image_rgb, (new_w, new_h), interpolation=cv2.INTER_AREA)


def kmeans_color_layers(image_rgb: np.ndarray, num_layers: int, seed: int) -> List[dict]:
    downsampled = downsample_image(image_rgb, max_dim=512)
    small_h, small_w = downsampled.shape[:2]
    lab_small = lab_from_rgb(downsampled)
    pixels = lab_small.reshape(-1, 3).astype(np.float32)

    if pixels.shape[0] == 0:
        return []

    k = max(2, min(int(num_layers), 8, pixels.shape[0]))
    kmeans = KMeans(n_clusters=k, random_state=seed, n_init=10)
    labels = kmeans.fit_predict(pixels)
    label_map_small = labels.reshape(small_h, small_w)

    label_map = cv2.resize(label_map_small.astype(np.uint8), (image_rgb.shape[1], image_rgb.shape[0]), interpolation=cv2.INTER_NEAREST)

    layers = []
    for idx in range(k):
        mask = label_map == idx
        area = int(mask.sum())
        if area == 0:
            continue
        centroid_lab = kmeans.cluster_centers_[idx]
        layers.append(
            {
                "id": str(uuid.uuid4()),
                "label": f"Layer {idx + 1}",
                "suggestedColor": rgb_hex_from_lab(centroid_lab.astype(np.uint8)),
                "maskPng": mask_to_png(mask),
                "cutoutPng": apply_mask_cutout(image_rgb, mask),
                "area": area,
            }
        )

    layers.sort(key=lambda item: item["area"], reverse=True)
    return layers


@app.get("/health")
async def health():
    if not sam2_state.enabled:
        warning = sam2_state.warning or "SAM2 not configured; using KMeans fallback"
        return {
            "ok": True,
            "device": sam2_state.device,
            "sam2Available": sam2_state.sam2_available,
            "modelLoaded": False,
            "warning": warning,
        }
    return {
        "ok": True,
        "device": sam2_state.device,
        "sam2Available": sam2_state.sam2_available,
        "modelLoaded": True,
    }


@app.post("/segment/auto")
async def segment_auto(payload: Optional[AutoRequest] = None, file: Optional[UploadFile] = File(default=None)):
    if not sam2_state.enabled:
        raise HTTPException(status_code=503, detail=sam2_state.error or "SAM2 service not ready.")

    if file:
        data = await file.read()
        image = Image.open(io.BytesIO(data)).convert("RGB")
    elif payload:
        image = decode_data_url(payload.imageDataUrl)
    else:
        raise HTTPException(status_code=400, detail="No image provided.")

    image_rgb = np.array(image)
    masks = generate_sam2_masks(image_rgb)
    if not masks:
        return {"masks": []}

    mask_pngs = [mask_to_png(mask) for mask in masks]
    return {"masks": mask_pngs}


@app.post("/segment/color-layers")
async def segment_color_layers(payload: ColorLayerRequest):
    image = decode_data_url(payload.imageDataUrl)
    image_rgb = np.array(image)
    height, width = image_rgb.shape[:2]

    min_area = int(width * height * payload.min_area_ratio)
    filtered: List[np.ndarray] = []
    try:
        if sam2_state.enabled:
            masks = generate_sam2_masks(image_rgb)
            if masks:
                filtered = [mask for mask in masks if mask.sum() >= min_area]
    except Exception:
        filtered = []

    if len(filtered) < 2:
        fallback_layers = kmeans_color_layers(image_rgb, payload.num_layers, payload.seed)
        if not fallback_layers:
            raise HTTPException(status_code=400, detail="Layer detection failed. Try a simpler image or increase contrast.")
        return {"width": width, "height": height, "layers": fallback_layers}

    lab_image = lab_from_rgb(image_rgb)
    mask_colors = []
    mask_areas = []
    for mask in filtered:
        pixels = lab_image[mask]
        if pixels.size == 0:
            continue
        mean_lab = pixels.mean(axis=0)
        mask_colors.append(mean_lab)
        mask_areas.append(int(mask.sum()))

    if not mask_colors:
        raise HTTPException(status_code=400, detail="Layer detection failed. Try a simpler image or increase contrast.")

    k = min(max(2, payload.num_layers), len(mask_colors))
    kmeans = KMeans(n_clusters=k, random_state=payload.seed, n_init=10)
    labels = kmeans.fit_predict(np.array(mask_colors))

    cluster_masks = []
    cluster_labs = []
    cluster_areas = []
    for cluster_idx in range(k):
        combined = np.zeros((height, width), dtype=bool)
        total_area = 0
        lab_accum = np.zeros(3, dtype=np.float64)
        for mask, lab, area, label in zip(filtered, mask_colors, mask_areas, labels):
            if label != cluster_idx:
                continue
            combined |= mask
            total_area += area
            lab_accum += lab * area
        if total_area == 0:
            continue
        cluster_masks.append(combined)
        cluster_labs.append(lab_accum / total_area)
        cluster_areas.append(total_area)

    layers = []
    for idx, (mask, lab_mean, area) in enumerate(zip(cluster_masks, cluster_labs, cluster_areas)):
        layers.append(
            {
                "id": str(uuid.uuid4()),
                "label": f"Layer {idx + 1}",
                "suggestedColor": rgb_hex_from_lab(lab_mean.astype(np.uint8)),
                "maskPng": mask_to_png(mask, blur=payload.blur),
                "cutoutPng": apply_mask_cutout(image_rgb, mask, blur=payload.blur),
                "area": area,
            }
        )
    layers.sort(key=lambda item: item["area"], reverse=True)
    return {"width": width, "height": height, "layers": layers}

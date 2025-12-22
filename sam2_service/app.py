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
from sklearn.metrics import silhouette_score
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

class ObjectFromPointRequest(BaseModel):
    imageDataUrl: str
    x: float = Field(ge=0.0, le=1.0)
    y: float = Field(ge=0.0, le=1.0)


class SplitColorsInMaskRequest(BaseModel):
    imageDataUrl: str
    objectMaskDataUrl: str
    max_colors: int = Field(default=6, ge=2, le=10)
    min_area_ratio: float = Field(default=0.02, ge=0.0, le=0.5)
    seed: int = Field(default=42)


def decode_data_url(data_url: str) -> Image.Image:
    if not data_url.startswith("data:image"):
        raise ValueError("Expected data URL")
    header, encoded = data_url.split(",", 1)
    binary = base64.b64decode(encoded)
    return Image.open(io.BytesIO(binary)).convert("RGB")

def decode_mask_data_url(data_url: str, size: Optional[tuple] = None) -> np.ndarray:
    if not data_url.startswith("data:image"):
        raise ValueError("Expected data URL")
    header, encoded = data_url.split(",", 1)
    binary = base64.b64decode(encoded)
    img = Image.open(io.BytesIO(binary)).convert("L")
    if size:
        img = img.resize(size, resample=Image.NEAREST)
    mask = np.array(img)
    return (mask >= 128).astype(bool)


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

def delta_e76(lab_a: np.ndarray, lab_b: np.ndarray) -> float:
    diff = lab_a.astype(np.float64) - lab_b.astype(np.float64)
    return float(np.sqrt(np.sum(diff * diff)))


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

def grow_region_from_point(image_rgb: np.ndarray, x: float, y: float) -> np.ndarray:
    # Downsample for speed, then grow region in LAB space.
    down = downsample_image(image_rgb, max_dim=512)
    h, w = down.shape[:2]
    px = int(np.clip(x, 0.0, 1.0) * (w - 1))
    py = int(np.clip(y, 0.0, 1.0) * (h - 1))

    lab = lab_from_rgb(down).astype(np.int16)
    seed = lab[py, px]

    visited = np.zeros((h, w), dtype=bool)
    mask = np.zeros((h, w), dtype=bool)
    qx = [px]
    qy = [py]
    visited[py, px] = True
    max_pixels = int(h * w * 0.35)
    tol = 12.0

    while qx and len(qx) < max_pixels:
        cx = qx.pop()
        cy = qy.pop()
        mask[cy, cx] = True

        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx = cx + dx
            ny = cy + dy
            if nx < 0 or ny < 0 or nx >= w or ny >= h:
                continue
            if visited[ny, nx]:
                continue
            visited[ny, nx] = True

            pix = lab[ny, nx].astype(np.float64)
            dist = np.linalg.norm(pix - seed.astype(np.float64))
            if dist <= tol:
                qx.append(nx)
                qy.append(ny)

    mask_uint8 = (mask.astype(np.uint8) * 255)
    kernel = np.ones((5, 5), np.uint8)
    mask_uint8 = cv2.morphologyEx(mask_uint8, cv2.MORPH_CLOSE, kernel)
    mask_uint8 = cv2.morphologyEx(mask_uint8, cv2.MORPH_OPEN, kernel)
    mask_small = mask_uint8 >= 128
    mask_full = cv2.resize(mask_small.astype(np.uint8), (image_rgb.shape[1], image_rgb.shape[0]), interpolation=cv2.INTER_NEAREST).astype(bool)
    return mask_full

def select_sam2_mask_from_point(image_rgb: np.ndarray, x: float, y: float, min_area_ratio: float = 0.01) -> Optional[np.ndarray]:
    try:
        masks = generate_sam2_masks(image_rgb)
    except Exception:
        return None
    if not masks:
        return None

    height, width = image_rgb.shape[:2]
    px = int(np.clip(x, 0.0, 1.0) * (width - 1))
    py = int(np.clip(y, 0.0, 1.0) * (height - 1))
    min_area = int(width * height * min_area_ratio)

    candidates = []
    for mask in masks:
        if mask.shape[0] != height or mask.shape[1] != width:
            continue
        if not mask[py, px]:
            continue
        area = int(mask.sum())
        if area < min_area:
            continue
        candidates.append((area, mask))
    if not candidates:
        return None
    # Pick smallest mask that contains the point (tends to select the object, not the background).
    candidates.sort(key=lambda item: item[0])
    return candidates[0][1]

def merge_similar_centroids(centroids: np.ndarray, threshold: float = 10.0) -> np.ndarray:
    n = centroids.shape[0]
    parent = list(range(n))

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a: int, b: int) -> None:
        ra = find(a)
        rb = find(b)
        if ra != rb:
            parent[rb] = ra

    for i in range(n):
        for j in range(i + 1, n):
            if delta_e76(centroids[i], centroids[j]) <= threshold:
                union(i, j)

    # Map each cluster to its root.
    roots = {}
    next_id = 0
    mapping = np.zeros(n, dtype=np.int32)
    for i in range(n):
        r = find(i)
        if r not in roots:
            roots[r] = next_id
            next_id += 1
        mapping[i] = roots[r]
    return mapping

def split_colors_inside_mask(image_rgb: np.ndarray, object_mask: np.ndarray, max_colors: int, min_area_ratio: float, seed: int) -> List[dict]:
    if object_mask.shape[:2] != image_rgb.shape[:2]:
        raise ValueError("Mask dimensions do not match image.")
    mask_area = int(object_mask.sum())
    if mask_area <= 0:
        raise ValueError("Empty object mask.")

    lab_image = lab_from_rgb(image_rgb)
    pixels = lab_image[object_mask].reshape(-1, 3).astype(np.float32)

    if pixels.shape[0] < 10:
        raise ValueError("Not enough pixels in mask.")

    # Subsample for model selection.
    rng = np.random.default_rng(seed)
    sample_n = min(20000, pixels.shape[0])
    sample_idx = rng.choice(pixels.shape[0], size=sample_n, replace=False)
    sample = pixels[sample_idx]

    best_k = 1
    best_score = -1.0
    best_model = None

    # Try k=2..max_colors for silhouette, but allow k=1 if silhouette is weak.
    for k in range(2, max(2, int(max_colors)) + 1):
        if sample.shape[0] <= k:
            break
        model = KMeans(n_clusters=k, random_state=seed, n_init=10)
        labels = model.fit_predict(sample)
        # Silhouette score is undefined for a single cluster.
        score = float(silhouette_score(sample, labels, metric="euclidean"))
        if score > best_score:
            best_score = score
            best_k = k
            best_model = model

    # If color variation is low, treat as a single-color object.
    channel_std = float(np.mean(np.std(sample, axis=0)))
    if best_model is None or best_score < 0.15 or channel_std < 2.0:
        best_k = 1
        best_model = KMeans(n_clusters=1, random_state=seed, n_init=1).fit(sample)

    # Use the selected centroids, then optionally merge near-identical colors.
    centroids = best_model.cluster_centers_.astype(np.float64)
    if centroids.shape[0] > 1:
        mapping = merge_similar_centroids(centroids, threshold=10.0)
        if mapping.max() + 1 < centroids.shape[0]:
            merged = []
            for new_id in range(mapping.max() + 1):
                members = centroids[mapping == new_id]
                merged.append(members.mean(axis=0))
            centroids = np.array(merged, dtype=np.float64)

    # Assign every masked pixel to the nearest centroid (vectorized).
    masked_lab = lab_image.astype(np.float64)
    coords = np.where(object_mask)
    pix = masked_lab[coords]
    dists = np.sum((pix[:, None, :] - centroids[None, :, :]) ** 2, axis=2)
    labels_full = np.argmin(dists, axis=1).astype(np.int32)

    # Build masks and filter by min area.
    layers = []
    min_area = int(mask_area * float(min_area_ratio))
    for idx in range(centroids.shape[0]):
        layer_mask = np.zeros(object_mask.shape, dtype=bool)
        layer_coords = labels_full == idx
        layer_mask[coords[0][layer_coords], coords[1][layer_coords]] = True
        area = int(layer_mask.sum())
        if area < max(1, min_area):
            continue
        area_pct = area / mask_area
        layers.append(
            {
                "id": f"color-{idx+1}",
                "maskDataUrl": mask_to_png(layer_mask, blur=0),
                "avgColor": rgb_hex_from_lab(np.clip(centroids[idx], 0, 255).astype(np.uint8)),
                "areaPct": float(area_pct),
            }
        )

    if not layers:
        # Always return at least one layer: pick the dominant cluster.
        idx = 0
        layer_mask = object_mask
        layers = [
            {
                "id": "color-1",
                "maskDataUrl": mask_to_png(layer_mask, blur=0),
                "avgColor": rgb_hex_from_lab(np.clip(centroids[idx], 0, 255).astype(np.uint8)),
                "areaPct": 1.0,
            }
        ]

    layers.sort(key=lambda item: item["areaPct"], reverse=True)
    return layers


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
            "mode": "kmeans",
            "warning": warning,
        }
    return {
        "ok": True,
        "device": sam2_state.device,
        "sam2Available": sam2_state.sam2_available,
        "modelLoaded": True,
        "mode": "sam2",
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
    used_sam2 = False
    try:
        if sam2_state.enabled:
            masks = generate_sam2_masks(image_rgb)
            if masks:
                filtered = [mask for mask in masks if mask.sum() >= min_area]
                used_sam2 = len(filtered) >= 2
    except Exception:
        filtered = []
        used_sam2 = False

    if len(filtered) < 2:
        fallback_layers = kmeans_color_layers(image_rgb, payload.num_layers, payload.seed)
        if not fallback_layers:
            raise HTTPException(status_code=400, detail="Layer detection failed. Try a simpler image or increase contrast.")
        return {
            "width": width,
            "height": height,
            "layers": fallback_layers,
            "sam2": {
                "available": sam2_state.sam2_available,
                "modelLoaded": bool(sam2_state.enabled),
                "used": False,
                "mode": "kmeans",
                "device": sam2_state.device,
                "warning": sam2_state.warning,
            },
        }

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
    return {
        "width": width,
        "height": height,
        "layers": layers,
        "sam2": {
            "available": sam2_state.sam2_available,
            "modelLoaded": bool(sam2_state.enabled),
            "used": used_sam2,
            "mode": "sam2" if used_sam2 else "kmeans",
            "device": sam2_state.device,
            "warning": sam2_state.warning,
        },
    }


@app.post("/segment/object-from-point")
async def segment_object_from_point(payload: ObjectFromPointRequest):
    image = decode_data_url(payload.imageDataUrl)
    image_rgb = np.array(image)
    mask = None
    if sam2_state.enabled:
        mask = select_sam2_mask_from_point(image_rgb, payload.x, payload.y, min_area_ratio=0.01)
    if mask is None:
        mask = grow_region_from_point(image_rgb, payload.x, payload.y)
    if mask is None or int(mask.sum()) == 0:
        raise HTTPException(status_code=400, detail="Object selection failed. Try clicking closer to the garment.")
    return {"ok": True, "objectMaskDataUrl": mask_to_png(mask, blur=1)}


@app.post("/segment/split-colors-in-mask")
async def segment_split_colors_in_mask(payload: SplitColorsInMaskRequest):
    image = decode_data_url(payload.imageDataUrl)
    image_rgb = np.array(image)
    height, width = image_rgb.shape[:2]
    object_mask = decode_mask_data_url(payload.objectMaskDataUrl, size=(width, height))
    try:
        layers = split_colors_inside_mask(
            image_rgb=image_rgb,
            object_mask=object_mask,
            max_colors=payload.max_colors,
            min_area_ratio=payload.min_area_ratio,
            seed=payload.seed,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"ok": True, "layers": layers}

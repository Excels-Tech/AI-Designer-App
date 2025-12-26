import base64
import io
import os
import uuid
import logging
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


logger = logging.getLogger("sam2_service")

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

class ColorLayersDynamicRequest(BaseModel):
    imageDataUrl: str
    max_colors: int = Field(default=8, ge=2, le=10)
    min_area_ratio: float = Field(default=0.02, ge=0.0, le=0.5)
    merge_threshold: float = Field(default=12, ge=0.0, le=100.0)
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
    img = Image.open(io.BytesIO(binary))
    mode = img.mode

    # Prefer alpha channel when present (transparent PNG masks).
    if mode in ("RGBA", "LA") or (isinstance(img.info, dict) and "transparency" in img.info):
        rgba = img.convert("RGBA")
        if size:
            rgba = rgba.resize(size, resample=Image.NEAREST)
        alpha = np.array(rgba)[:, :, 3]
        return (alpha >= 128).astype(bool)

    lum = img.convert("L")
    if size:
        lum = lum.resize(size, resample=Image.NEAREST)
    mask = np.array(lum)
    return (mask >= 128).astype(bool)


def mask_coverage_pct(mask_u8: np.ndarray, threshold: int = 20) -> float:
    if mask_u8.size == 0:
        return 0.0
    mask_u8 = mask_u8.astype(np.uint8)
    return float(np.count_nonzero(mask_u8 > threshold)) / float(mask_u8.size)


def fill_holes_binary(mask_u8: np.ndarray) -> np.ndarray:
    mask = (mask_u8 > 0).astype(np.uint8)
    if mask.size == 0:
        return mask_u8

    inv = (mask == 0).astype(np.uint8)
    padded = cv2.copyMakeBorder(inv, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=1)
    h, w = padded.shape[:2]
    ffmask = np.zeros((h + 2, w + 2), dtype=np.uint8)
    cv2.floodFill(padded, ffmask, (0, 0), 2)
    holes = padded == 1

    filled = cv2.copyMakeBorder(mask, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=0)
    filled[holes] = 1
    filled = filled[1:-1, 1:-1]
    return (filled.astype(np.uint8) * 255)


def remove_small_components(mask_u8: np.ndarray, min_area: int) -> np.ndarray:
    if min_area <= 1:
        return mask_u8
    binary = (mask_u8 > 0).astype(np.uint8)
    num, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    if num <= 1:
        return mask_u8
    out = np.zeros_like(binary)
    for comp_id in range(1, num):
        area = int(stats[comp_id, cv2.CC_STAT_AREA])
        if area >= min_area:
            out[labels == comp_id] = 1
    return (out.astype(np.uint8) * 255)


def clean_binary_mask(
    mask_bool: np.ndarray,
    *,
    kernel_size: int = 5,
    min_component_area: int = 0,
    fill_holes: bool = True,
) -> np.ndarray:
    mask_u8 = (mask_bool.astype(np.uint8) * 255)
    if mask_u8.size == 0:
        return mask_u8

    if kernel_size and kernel_size > 1:
        k = int(kernel_size)
        if k % 2 == 0:
            k += 1
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
        mask_u8 = cv2.morphologyEx(mask_u8, cv2.MORPH_CLOSE, kernel)

    if fill_holes:
        mask_u8 = fill_holes_binary(mask_u8)

    if min_component_area and min_component_area > 1:
        mask_u8 = remove_small_components(mask_u8, int(min_component_area))

    return mask_u8


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
    # Return a transparent RGBA PNG with alpha=0 outside the region.
    h, w = mask_uint8.shape[:2]
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[:, :, 0] = 255
    rgba[:, :, 1] = 255
    rgba[:, :, 2] = 255
    rgba[:, :, 3] = mask_uint8
    return encode_png(rgba)


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

    height, width = image_rgb.shape[:2]
    if logger.isEnabledFor(logging.INFO):
        logger.info("split_colors_inside_mask: image=%sx%s max_colors=%s min_area_ratio=%s", width, height, max_colors, min_area_ratio)

    # Clean the object mask to avoid edge-only/noisy artifacts feeding the clustering.
    object_mask_u8 = clean_binary_mask(
        object_mask.astype(bool),
        kernel_size=5,
        min_component_area=max(1, int(float(object_mask.sum()) * 0.01)),
        fill_holes=True,
    )
    object_mask = (object_mask_u8 > 127)
    mask_area = int(object_mask.sum())
    if mask_area <= 0:
        raise ValueError("Empty object mask.")

    if logger.isEnabledFor(logging.INFO):
        logger.info("split_colors_inside_mask: object_mask coverage=%.2f%%", mask_coverage_pct(object_mask_u8) * 100.0)

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

    if logger.isEnabledFor(logging.INFO):
        label_counts = np.bincount(labels_full, minlength=int(centroids.shape[0]))
        logger.info("split_colors_inside_mask: label counts=%s", ",".join(str(int(c)) for c in label_counts.tolist()))

    # Build masks and filter by min area.
    layers = []
    min_area = int(mask_area * float(min_area_ratio))
    label_map = np.full((height, width), -1, dtype=np.int16)
    label_map[coords] = labels_full.astype(np.int16)
    for idx in range(centroids.shape[0]):
        layer_mask = (label_map == int(idx)) & object_mask

        # Morphological cleanup to remove holes/noise and return a solid filled region mask.
        cleaned_u8 = clean_binary_mask(
            layer_mask,
            kernel_size=5,
            min_component_area=max(1, min_area),
            fill_holes=True,
        )
        layer_mask = cleaned_u8 > 127
        area = int(layer_mask.sum())
        if area < max(1, min_area):
            continue
        area_pct = area / mask_area
        if logger.isEnabledFor(logging.INFO):
            logger.info("split_colors_inside_mask: layer %s coverage=%.2f%%", idx, mask_coverage_pct(cleaned_u8) * 100.0)
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


def rgb_to_hex(rgb: np.ndarray) -> str:
    rgb = np.clip(rgb.astype(np.float64), 0.0, 255.0)
    return "#{:02X}{:02X}{:02X}".format(int(rgb[0]), int(rgb[1]), int(rgb[2]))


def dynamic_kmeans_color_layers(
    image_rgb: np.ndarray,
    max_colors: int = 8,
    min_area_ratio: float = 0.02,
    merge_threshold: float = 12.0,
    seed: int = 42,
) -> List[dict]:
    downsampled = downsample_image(image_rgb, max_dim=512)
    small_h, small_w = downsampled.shape[:2]
    lab_small = lab_from_rgb(downsampled).astype(np.float32)
    pixels = lab_small.reshape(-1, 3)

    if pixels.shape[0] < 10:
        return []

    sample_size = min(50000, pixels.shape[0])
    rng = np.random.default_rng(seed)
    sample_idx = rng.choice(pixels.shape[0], size=sample_size, replace=False)
    samples = pixels[sample_idx]

    max_k = max(2, min(int(max_colors), 10, samples.shape[0]))
    prev_inertia: Optional[float] = None
    best_model: Optional[KMeans] = None
    best_k = 2

    for k in range(2, max_k + 1):
        model = KMeans(n_clusters=k, random_state=seed, n_init=6)
        model.fit(samples)
        inertia = float(model.inertia_)

        if prev_inertia is not None:
            improvement = (prev_inertia - inertia) / max(prev_inertia, 1e-9)
            if improvement < 0.08 and k >= 3:
                break
        prev_inertia = inertia
        best_model = model
        best_k = k

    if best_model is None:
        return []

    label_map_small = best_model.predict(pixels).reshape(small_h, small_w).astype(np.uint8)
    label_map = cv2.resize(
        label_map_small, (image_rgb.shape[1], image_rgb.shape[0]), interpolation=cv2.INTER_NEAREST
    )

    height, width = label_map.shape[:2]
    total_area = float(width * height)
    min_area = int(total_area * float(min_area_ratio))

    border = np.concatenate([label_map[0, :], label_map[-1, :], label_map[:, 0], label_map[:, -1]])
    border_counts = np.bincount(border.astype(np.int32), minlength=best_k)
    border_total = int(border.shape[0]) if border.shape[0] else 1
    border_dom = int(border_counts.argmax())
    border_ratio = float(border_counts[border_dom]) / float(border_total)

    lab_full = lab_from_rgb(image_rgb).astype(np.float32)

    kept_masks: List[np.ndarray] = []
    kept_labs: List[np.ndarray] = []
    kept_areas: List[int] = []

    for idx in range(best_k):
        mask = label_map == idx
        area = int(mask.sum())
        if area <= 0:
            continue
        if area < min_area:
            continue
        if idx == border_dom and border_ratio >= 0.6 and (area / total_area) >= 0.15 and best_k > 2:
            continue
        pixels_lab = lab_full[mask]
        if pixels_lab.size == 0:
            continue
        kept_masks.append(mask)
        kept_labs.append(pixels_lab.mean(axis=0))
        kept_areas.append(area)

    if not kept_masks:
        return []

    parents = list(range(len(kept_masks)))

    def find(a: int) -> int:
        while parents[a] != a:
            parents[a] = parents[parents[a]]
            a = parents[a]
        return a

    def union(a: int, b: int) -> None:
        ra = find(a)
        rb = find(b)
        if ra != rb:
            parents[rb] = ra

    for i in range(len(kept_labs)):
        for j in range(i + 1, len(kept_labs)):
            if delta_e76(kept_labs[i], kept_labs[j]) < float(merge_threshold):
                union(i, j)

    groups: dict[int, dict] = {}
    for i, (mask, area) in enumerate(zip(kept_masks, kept_areas)):
        root = find(i)
        entry = groups.get(root)
        if entry is None:
            groups[root] = {"mask": mask.copy(), "area": int(area)}
        else:
            entry["mask"] |= mask
            entry["area"] += int(area)

    layers: List[dict] = []
    for entry in groups.values():
        mask = entry["mask"]
        area = int(entry["area"])
        pixels_rgb = image_rgb[mask]
        if pixels_rgb.size == 0:
            continue
        mean_rgb = pixels_rgb.mean(axis=0)
        layers.append(
            {
                "maskDataUrl": mask_to_png(mask, blur=0),
                "avgColor": rgb_to_hex(mean_rgb),
                "areaPct": float(area) / total_area,
                "_area": area,
            }
        )

    layers.sort(key=lambda item: item["_area"], reverse=True)
    out: List[dict] = []
    for idx, layer in enumerate(layers):
        out.append(
            {
                "id": f"color-{idx + 1}",
                "maskDataUrl": layer["maskDataUrl"],
                "avgColor": layer["avgColor"],
                "areaPct": layer["areaPct"],
            }
        )

    return out


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


@app.post("/segment/color-layers-dynamic")
async def segment_color_layers_dynamic(payload: ColorLayersDynamicRequest):
    image = decode_data_url(payload.imageDataUrl)
    image_rgb = np.array(image)
    height, width = image_rgb.shape[:2]

    layers = dynamic_kmeans_color_layers(
        image_rgb=image_rgb,
        max_colors=payload.max_colors,
        min_area_ratio=payload.min_area_ratio,
        merge_threshold=float(payload.merge_threshold),
        seed=payload.seed,
    )
    if not layers:
        raise HTTPException(status_code=400, detail="Layer detection failed. Try a simpler image or increase contrast.")

    return {
        "ok": True,
        "width": width,
        "height": height,
        "layers": layers,
        "sam2": {
            "available": sam2_state.sam2_available,
            "modelLoaded": bool(sam2_state.enabled),
            "used": False,
            "mode": "kmeans-dynamic",
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

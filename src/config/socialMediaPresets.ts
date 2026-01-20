export type SocialPlatform = 'LinkedIn' | 'Instagram' | 'YouTube' | 'Facebook' | 'Website' | 'Custom';
export type SocialDesignType = 'post' | 'banner' | 'thumbnail';

export type SocialPreset = {
  id: string;
  label: string;
  width: number;
  height: number;
  ratioLabel: string;
  designType?: SocialDesignType; // Optional: added to track design type when combined
  notes?: string;
};

export type SocialPresetConfig = Record<SocialPlatform, Partial<Record<SocialDesignType, SocialPreset[]>>>;

export function formatRatioLabel(width: number, height: number): string {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const d = gcd(w, h);
  const rw = Math.round(w / d);
  const rh = Math.round(h / d);
  const ratio = w / h;
  if (rw <= 20 && rh <= 20) return `${rw}:${rh}`;
  if (ratio >= 1) return `${ratio.toFixed(2)}:1`;
  return `1:${(1 / ratio).toFixed(2)}`;
}

export const socialPresets: SocialPresetConfig = {
  LinkedIn: {
    post: [
      { id: 'li-post-landscape', label: 'Landscape', width: 1200, height: 627, ratioLabel: '1.91:1' },
      { id: 'li-post-square', label: 'Square', width: 1080, height: 1080, ratioLabel: '1:1' },
      { id: 'li-post-portrait', label: 'Portrait', width: 1080, height: 1350, ratioLabel: '4:5' },
      { id: 'li-article-feature', label: 'Article Feature Image', width: 1200, height: 644, ratioLabel: formatRatioLabel(1200, 644) },
      { id: 'li-carousel-square', label: 'Carousel (Square)', width: 1080, height: 1080, ratioLabel: '1:1' },
      { id: 'li-carousel-wide', label: 'Carousel (Wide)', width: 1920, height: 1080, ratioLabel: '16:9' },
      { id: 'li-stories', label: 'Stories', width: 1080, height: 1920, ratioLabel: '9:16' },
    ],
  },
  Instagram: {
    post: [
      { id: 'ig-post-square', label: 'Post (Square)', width: 1080, height: 1080, ratioLabel: '1:1' },
      { id: 'ig-post-portrait', label: 'Post (Portrait)', width: 1080, height: 1350, ratioLabel: '4:5' },
      { id: 'ig-post-landscape', label: 'Post (Landscape)', width: 1080, height: 566, ratioLabel: '1.91:1' },
      { id: 'ig-post-portrait-expand', label: 'Post (Portrait Expand)', width: 1080, height: 1440, ratioLabel: '3:4' },
    ],
    banner: [{ id: 'ig-story', label: 'Story', width: 1080, height: 1920, ratioLabel: '9:16' }],
  },
  YouTube: {
    thumbnail: [{ id: 'yt-thumbnail', label: 'Thumbnail', width: 1280, height: 720, ratioLabel: '16:9' }],
    banner: [{ id: 'yt-banner-large', label: 'Banner', width: 2560, height: 1440, ratioLabel: '16:9' }],
    post: [
      { id: 'yt-short', label: 'Shorts', width: 1080, height: 1920, ratioLabel: '9:16' },
      { id: 'yt-profile', label: 'Profile Picture', width: 800, height: 800, ratioLabel: '1:1' },
      { id: 'yt-community-post', label: 'Community Post', width: 1080, height: 1080, ratioLabel: '1:1' },
    ],
  },
  Facebook: {
    post: [
      { id: 'fb-post-landscape', label: 'Landscape', width: 1200, height: 630, ratioLabel: '1.91:1' },
      { id: 'fb-post-square', label: 'Square', width: 1080, height: 1080, ratioLabel: '1:1' },
      { id: 'fb-post-portrait', label: 'Portrait', width: 1080, height: 1350, ratioLabel: '4:5' },
    ],
    banner: [
      { id: 'fb-cover', label: 'Cover', width: 820, height: 312, ratioLabel: formatRatioLabel(820, 312) },
      { id: 'fb-story', label: 'Story', width: 1080, height: 1920, ratioLabel: '9:16' },
    ],
  },
  Website: {
    banner: [
      { id: 'web-banner-slim', label: 'Banner (Slim)', width: 1920, height: 600, ratioLabel: formatRatioLabel(1920, 600) },
      { id: 'web-hero', label: 'Hero (Full)', width: 1920, height: 1080, ratioLabel: '16:9' },
    ],
  },
  Custom: {
    post: [],
    banner: [],
    thumbnail: [],
  },
};

export function getPresets(platform: SocialPlatform, designType: SocialDesignType): SocialPreset[] {
  const presets = socialPresets[platform]?.[designType];
  return Array.isArray(presets) ? presets : [];
}

export function getAllPlatformPresets(platform: SocialPlatform): SocialPreset[] {
  const config = socialPresets[platform];
  if (!config) return [];

  const all: SocialPreset[] = [];

  if (config.post) {
    all.push(...config.post.map(p => ({ ...p, designType: 'post' as SocialDesignType })));
  }
  if (config.banner) {
    all.push(...config.banner.map(p => ({ ...p, designType: 'banner' as SocialDesignType })));
  }
  if (config.thumbnail) {
    all.push(...config.thumbnail.map(p => ({ ...p, designType: 'thumbnail' as SocialDesignType })));
  }

  return all;
}


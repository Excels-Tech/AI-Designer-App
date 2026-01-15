export function buildSaveDesignPayload(args: {
  title?: string;
  userId: string;
  prompt: string;
  style: string;
  resolution: number;
  views: string[];
  composite: string;
  images: Array<{ view: string; src: string }>;
}) {
  // IMPORTANT: Only store the original user prompt (privacy guarantee).
  return {
    title: args.title,
    userId: args.userId,
    prompt: args.prompt,
    style: args.style,
    resolution: args.resolution,
    views: args.views,
    composite: args.composite,
    images: args.images,
  };
}


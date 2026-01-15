export const templates = {
  phraseGroups: {
    style: {
      phrases: [
        { phrase: 'high-quality', weight: 1.2 },
        { phrase: 'visually compelling', weight: 1.0 },
        { phrase: 'cohesive and well-composed', weight: 1.0 },
        { phrase: 'photorealistic', weight: 0.9 },
        { phrase: 'cinematic', weight: 0.9 },
        { phrase: 'editorial style', weight: 0.9 },
        { phrase: 'concept art', weight: 0.8 },
        { phrase: 'illustration', weight: 0.8 },
        { phrase: '3D render', weight: 0.7 },
        { phrase: 'painterly', weight: 0.7 },
        { phrase: 'surreal', weight: 0.6 },
      ],
    },
    lighting: {
      phrases: [
        { phrase: 'soft natural light', weight: 1.0 },
        { phrase: 'dramatic lighting', weight: 0.9 },
        { phrase: 'golden hour', weight: 0.8 },
        { phrase: 'studio lighting', weight: 0.9 },
        { phrase: 'rim lighting', weight: 0.7 },
        { phrase: 'volumetric light', weight: 0.7 },
        { phrase: 'soft diffused lighting', weight: 0.9 },
        { phrase: 'neon accent lighting', weight: 0.6 },
        { phrase: 'dreamy glow', weight: 0.7 },
      ],
    },
    camera: {
      phrases: [
        { phrase: 'sharp subject focus', weight: 1.0 },
        { phrase: 'shallow depth of field', weight: 0.9 },
        { phrase: 'high dynamic range', weight: 0.8 },
        { phrase: 'bokeh', weight: 0.7 },
        { phrase: 'dynamic perspective', weight: 0.7 },
        { phrase: 'wide angle perspective', weight: 0.6 },
      ],
    },
    composition: {
      phrases: [
        { phrase: 'thoughtful composition', weight: 1.0 },
        { phrase: 'rule of thirds', weight: 0.8 },
        { phrase: 'leading lines', weight: 0.7 },
        { phrase: 'symmetrical framing', weight: 0.6 },
        { phrase: 'dynamic angle', weight: 0.7 },
        { phrase: 'candid moment framing', weight: 0.6 },
        { phrase: 'negative space', weight: 0.6 },
      ],
    },
    detail: {
      phrases: [
        { phrase: 'high detail', weight: 1.1 },
        { phrase: 'texture-rich', weight: 0.9 },
        { phrase: 'fine details', weight: 0.9 },
        { phrase: 'crisp edges', weight: 0.8 },
      ],
    },
    colorMood: {
      phrases: [
        { phrase: 'vibrant colors', weight: 0.8 },
        { phrase: 'muted tones', weight: 0.7 },
        { phrase: 'warm color palette', weight: 0.7 },
        { phrase: 'cool color palette', weight: 0.7 },
        { phrase: 'high contrast', weight: 0.7 },
        { phrase: 'soft pastel palette', weight: 0.6 },
        { phrase: 'moody color grading', weight: 0.6 },
      ],
    },
    environment: {
      phrases: [
        { phrase: 'background that complements the subject', weight: 1.0 },
        { phrase: 'contextual setting', weight: 0.8 },
        { phrase: 'subtle atmosphere', weight: 0.8 },
        { phrase: 'simple studio backdrop', weight: 0.8 },
        { phrase: 'cinematic environment', weight: 0.7 },
      ],
    },
  },
} as const;

import { ViewId } from './types';

type ViewSpec = {
  angle: string;
  anchors?: string[];
};

export const commonNegatives = [
  'no flat-lay',
  'no folded',
  'no hanger',
  'no mannequin',
  'no model',
  'no table',
  'no collage',
  'no split panels',
  'no text',
  'no watermark',
];

export const viewSpecs: Record<ViewId, ViewSpec> = {
  front: {
    angle: 'front-facing, symmetrical, both sleeves visible, straight-on camera',
  },
  back: {
    angle: 'back-facing, collar seam visible, no chest details, straight-on camera',
  },
  left: {
    angle:
      'Left side profile; the FRONT of the shirt faces RIGHT in the frame; rotate 90 degrees left from front. True side profile (90 degrees), not 3/4.',
    anchors: [
      'camera at mid-torso height',
      'show side seam line and sleeve opening edge',
      'only a sliver of front is acceptable',
      'no flat-lay, no folded, no mannequin, no collage',
    ],
  },
  right: {
    angle:
      'Right side profile; the FRONT of the shirt faces LEFT in the frame; rotate 90 degrees right from front. True side profile (90 degrees), not 3/4.',
    anchors: [
      'camera at mid-torso height',
      'shoulder on right side of frame closer to camera',
      'show side seam line and sleeve opening edge',
      'only a sliver of front is acceptable',
      'no flat-lay, no folded, no mannequin, no collage',
    ],
  },
  top: {
    angle: 'top-down view looking at collar opening, product not folded',
  },
  threeQuarter: {
    angle: '3/4 view rotated about 45 degrees from front, showing depth and perspective',
  },
};

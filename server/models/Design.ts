import mongoose, { Schema, Document } from 'mongoose';

export interface DesignImage {
  view: string;
  mime: 'image/png';
  fileId?: string;
  dataUrl?: string; // legacy fallback
}

export interface DesignDoc extends Document {
  name: string;
  title: string;
  prompt: string;
  userId: string;
  style: 'realistic' | '3d' | 'lineart' | 'watercolor';
  resolution: number;
  views: string[];
  composite: {
    mime: 'image/png';
    fileId?: string;
    dataUrl?: string; // legacy fallback
  };
  images: DesignImage[];
  createdAt: Date;
  updatedAt: Date;
}

const DesignSchema = new Schema<DesignDoc>(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    title: { type: String, default: 'Untitled Design', trim: true },
    prompt: { type: String, required: true, trim: true },
    userId: { type: String, required: true, index: true },
    style: { type: String, enum: ['realistic', '3d', 'lineart', 'watercolor'], required: true },
    resolution: { type: Number, required: true },
    views: { type: [String], required: true },
    composite: {
      mime: { type: String, enum: ['image/png'], required: true },
      fileId: { type: String },
      dataUrl: { type: String },
    },
    images: [
      {
        view: { type: String, required: true },
        mime: { type: String, enum: ['image/png'], required: true },
        fileId: { type: String },
        dataUrl: { type: String },
      },
    ],
  },
  { timestamps: true }
);

DesignSchema.index({ createdAt: -1 });

export const Design = mongoose.models.Design || mongoose.model<DesignDoc>('Design', DesignSchema);

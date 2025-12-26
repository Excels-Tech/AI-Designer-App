import mongoose, { Schema, Document } from 'mongoose';

export interface VideoDesignDoc extends Document {
  title: string;
  userId: string;
  video: {
    mime: 'video/mp4';
    fileId: string;
  };
  project?: unknown;
  createdAt: Date;
  updatedAt: Date;
}

const VideoDesignSchema = new Schema<VideoDesignDoc>(
  {
    title: { type: String, required: true, trim: true, maxlength: 80 },
    userId: { type: String, required: true, index: true },
    video: {
      mime: { type: String, enum: ['video/mp4'], required: true },
      fileId: { type: String, required: true },
    },
    project: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

VideoDesignSchema.index({ createdAt: -1 });

export const VideoDesign =
  mongoose.models.VideoDesign || mongoose.model<VideoDesignDoc>('VideoDesign', VideoDesignSchema);


import { useRef, useState } from 'react';
import { ImagePlus, UploadCloud, AlertTriangle } from 'lucide-react';

type UploadDropzoneProps = {
  maxFiles: number;
  maxBytes: number;
  onFilesAdded: (files: File[]) => void;
};

const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export function UploadDropzone({ maxFiles, maxBytes, onFilesAdded }: UploadDropzoneProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFiles = (fileList: FileList | null) => {
    if (!fileList) return;
    setError(null);
    const files = Array.from(fileList);
    const limit = Math.max(0, maxFiles);

    if (!files.length) {
      return;
    }
    if (limit === 0) {
      setError('No more files can be added.');
      return;
    }
    if (files.length > limit) {
      setError(`Limit is ${limit} images per upload.`);
      return;
    }

    const invalidType = files.find((file) => !ACCEPTED_TYPES.includes(file.type));
    if (invalidType) {
      setError('Only PNG, JPG, and WEBP images are supported.');
      return;
    }
    const oversized = files.find((file) => file.size > maxBytes);
    if (oversized) {
      setError(`Max file size is ${(maxBytes / (1024 * 1024)).toFixed(0)}MB.`);
      return;
    }

    onFilesAdded(files);
  };

  return (
    <div className="space-y-3">
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          handleFiles(event.dataTransfer.files);
        }}
        className={`rounded-2xl border-2 border-dashed p-5 transition-colors ${
          dragging ? 'border-purple-500 bg-purple-50' : 'border-slate-200 bg-white'
        }`}
      >
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-slate-100 flex items-center justify-center">
            <UploadCloud className="h-5 w-5 text-slate-600" />
          </div>
          <div className="flex-1">
            <p className="text-sm text-slate-900">Drop images here</p>
            <p className="text-xs text-slate-500">PNG, JPG, WEBP up to {(maxBytes / (1024 * 1024)).toFixed(0)}MB</p>
          </div>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="px-3 py-2 rounded-xl bg-purple-500 text-white text-xs hover:bg-purple-600"
          >
            Browse
          </button>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(event) => handleFiles(event.target.files)}
        />
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          <AlertTriangle className="h-4 w-4" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex items-center gap-2 text-xs text-slate-500">
        <ImagePlus className="h-4 w-4" />
        <span>Uploads add each image as a slide.</span>
      </div>
    </div>
  );
}

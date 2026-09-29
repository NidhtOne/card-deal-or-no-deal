import { ChangeEvent, useCallback, useEffect, useState } from 'react';
import Cropper, { Area, Point } from 'react-easy-crop';
import { getErrorMessage } from '../api/client';
import { getCroppedBlob, validateImageFile } from '../utils/image';

export interface ImageCropUploadProps {
  open: boolean;
  /** 弹窗标题 */
  title: string;
  /** 裁剪宽高比：头像 1（1:1）；角色立绘 3/4（3:4） */
  aspect: number;
  /** 比例提示文案，如「建议 1:1」 */
  hint?: string;
  onClose: () => void;
  /** 执行实际上传（抛错则展示错误）；onProgress 0-100 */
  onUpload: (blob: Blob, onProgress: (percent: number) => void) => Promise<void>;
}

/**
 * 图片上传弹窗：选择文件 → 前端预校验（类型/大小）→ react-easy-crop 裁剪 → 上传（含进度条）。
 * 用于头像（1:1）与角色/银行家立绘（3:4）。
 */
export default function ImageCropUpload({
  open,
  title,
  aspect,
  hint,
  onClose,
  onUpload,
}: ImageCropUploadProps) {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [mime, setMime] = useState('image/png');
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedArea, setCroppedArea] = useState<Area | null>(null);
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  // 关闭/打开时重置内部状态
  useEffect(() => {
    if (open) {
      setImageSrc(null);
      setCrop({ x: 0, y: 0 });
      setZoom(1);
      setCroppedArea(null);
      setProgress(0);
      setUploading(false);
      setError('');
    }
  }, [open]);

  const onCropComplete = useCallback((_: Area, croppedAreaPixels: Area) => {
    setCroppedArea(croppedAreaPixels);
  }, []);

  if (!open) return null;

  function onSelectFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const invalid = validateImageFile(file);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError('');
    setMime(file.type);
    const reader = new FileReader();
    reader.onload = () => setImageSrc(reader.result as string);
    reader.onerror = () => setError('图片读取失败');
    reader.readAsDataURL(file);
  }

  async function onConfirm() {
    if (!imageSrc || !croppedArea) return;
    setUploading(true);
    setError('');
    setProgress(0);
    try {
      const blob = await getCroppedBlob(imageSrc, croppedArea, mime);
      await onUpload(blob, setProgress);
      onClose();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button
            onClick={onClose}
            disabled={uploading}
            className="text-slate-400 hover:text-slate-200 disabled:opacity-40"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        {hint && <p className="mb-3 text-xs text-slate-500">{hint}，支持 JPG/PNG/WebP，≤5MB</p>}

        {!imageSrc ? (
          <label className="flex h-56 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-slate-700 text-slate-400 hover:border-amber-400 hover:text-amber-300">
            <span className="text-3xl">＋</span>
            <span className="text-sm">点击选择图片</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={onSelectFile}
            />
          </label>
        ) : (
          <>
            <div className="relative h-72 w-full overflow-hidden rounded-lg bg-slate-800">
              <Cropper
                image={imageSrc}
                crop={crop}
                zoom={zoom}
                aspect={aspect}
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={onCropComplete}
              />
            </div>
            <div className="mt-3 flex items-center gap-3">
              <span className="text-xs text-slate-400">缩放</span>
              <input
                type="range"
                min={1}
                max={3}
                step={0.05}
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                className="flex-1 accent-amber-400"
                disabled={uploading}
              />
            </div>
          </>
        )}

        {error && <p className="mt-3 text-sm text-rose-400">{error}</p>}

        {uploading && (
          <div className="mt-3 h-2 w-full overflow-hidden rounded bg-slate-800">
            <div
              className="h-full bg-amber-400 transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}

        <div className="mt-5 flex justify-end gap-3">
          {!imageSrc ? (
            <button
              onClick={onClose}
              className="rounded border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:border-slate-500"
            >
              取消
            </button>
          ) : (
            <>
              <label className="cursor-pointer rounded border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:border-slate-500">
                重选
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={onSelectFile}
                  disabled={uploading}
                />
              </label>
              <button
                onClick={onConfirm}
                disabled={uploading || !croppedArea}
                className="rounded bg-amber-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-40"
              >
                {uploading ? `上传中 ${progress}%` : '确认上传'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

import { Area } from 'react-easy-crop';

/** 上传图片前端预校验规则（与后端一致：JPG/PNG/WebP ≤5MB，文档 3.2/3.3） */
export const IMAGE_MIME_WHITELIST = ['image/jpeg', 'image/png', 'image/webp'];
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** 前端预校验：返回错误文案，合法返回 null */
export function validateImageFile(file: File): string | null {
  if (!IMAGE_MIME_WHITELIST.includes(file.type)) return '仅支持 JPG/PNG/WebP 图片';
  if (file.size > IMAGE_MAX_BYTES) return '图片大小不能超过 5MB';
  return null;
}

function createImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}

/** 按裁剪像素区域导出 Blob（保持原始格式，canvas 不支持时回退 PNG） */
export async function getCroppedBlob(
  imageSrc: string,
  pixelCrop: Area,
  mime: string,
): Promise<Blob> {
  const image = await createImage(imageSrc);
  const canvas = document.createElement('canvas');
  canvas.width = pixelCrop.width;
  canvas.height = pixelCrop.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('画布初始化失败');
  ctx.drawImage(
    image,
    pixelCrop.x,
    pixelCrop.y,
    pixelCrop.width,
    pixelCrop.height,
    0,
    0,
    pixelCrop.width,
    pixelCrop.height,
  );
  const type = IMAGE_MIME_WHITELIST.includes(mime) ? mime : 'image/png';
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('裁剪导出失败'))),
      type,
      0.92,
    );
  });
}

/** blob.type → 文件扩展名（上传 multipart 文件名用） */
export function blobExt(blob: Blob): string {
  if (blob.type === 'image/jpeg') return 'jpg';
  if (blob.type === 'image/webp') return 'webp';
  return 'png';
}

/** 分 → 元 展示（铁律 4：金额一律以分存储） */
export function formatFen(fen: number): string {
  return (fen / 100).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

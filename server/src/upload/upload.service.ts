import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { mkdir, unlink } from 'fs/promises';
import { join, resolve, sep } from 'path';
import sharp, { Sharp } from 'sharp';
import { resolveFromRoot } from '../config/paths';

/** 上传白名单与限制（docs/开发文档.md 3.2/3.3：JPG/PNG/WebP，≤5MB） */
export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const UPLOAD_MIME_WHITELIST = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** STORAGE_DIR 下的上传子目录（对外 URL 前缀 /uploads/<subdir>/） */
export const UPLOAD_SUBDIRS = ['avatars', 'characters', 'bankers-custom'] as const;
export type UploadSubdir = (typeof UPLOAD_SUBDIRS)[number];

/**
 * 头像缩略图规格：3.2 只要求「服务端压缩生成多尺寸缩略图」，未定义具体规格 —— 实现决策：
 * 主图 512×512（cover 裁剪为正方形），另生成 256 / 64 两档缩略图，
 * 文件名为 `<主名>_256.<ext>` / `<主名>_64.<ext>`，avatar_url 记录主图 URL，缩略图按后缀约定派生。
 */
export const AVATAR_MAIN_SIZE = 512;
export const AVATAR_THUMB_SIZES = [256, 64] as const;

/** 立绘（用户角色/自定义银行家）压缩上限：等比缩至 1080×1440 以内（不放大）—— 文档未定义，实现决策 */
export const PORTRAIT_MAX_WIDTH = 1080;
export const PORTRAIT_MAX_HEIGHT = 1440;

export interface UploadedImage {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

export interface SavedImage {
  /** 对外 URL（/uploads/<subdir>/<name>.<ext>） */
  url: string;
  /** 主图磁盘绝对路径 */
  filePath: string;
  /** 头像缩略图磁盘绝对路径（仅头像有） */
  thumbPaths: string[];
}

/**
 * 上传文件处理：multer（内存存储 + limits 拦截超限）收文件后，本服务做服务端二次校验
 * （声明类型白名单、大小复检、sharp magic bytes 识别真实格式），再以真实格式重编码
 * （不调用 withMetadata，输出默认剥离全部元数据即去 EXIF），随机文件名落盘，URL 入库。
 */
@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);

  storageRoot(): string {
    return resolveFromRoot(process.env.STORAGE_DIR ?? './storage');
  }

  /** 校验 + 重编码 + 落盘，返回对外 URL 与磁盘路径 */
  async saveImage(
    file: UploadedImage,
    subdir: UploadSubdir,
    kind: 'avatar' | 'portrait',
  ): Promise<SavedImage> {
    // 服务端二次校验（第一道是 multer limits/mimetype）
    if (!UPLOAD_MIME_WHITELIST.has(file.mimetype)) {
      throw new BadRequestException('仅支持 JPG/PNG/WebP 图片');
    }
    if (file.size > UPLOAD_MAX_BYTES) {
      throw new BadRequestException('图片大小不能超过 5MB');
    }

    // magic bytes 识别真实格式：伪造扩展名/伪装内容在此被识破
    let format: string | undefined;
    try {
      format = (await sharp(file.buffer).metadata()).format;
    } catch {
      throw new BadRequestException('文件内容不是有效图片');
    }
    if (!format || !['jpeg', 'png', 'webp'].includes(format)) {
      throw new BadRequestException('仅支持 JPG/PNG/WebP 图片');
    }

    const ext = format === 'jpeg' ? 'jpg' : format;
    // 文件以随机名落盘，原始文件名不入库不落盘
    const name = `${randomBytes(16).toString('hex')}.${ext}`;
    const dir = join(this.storageRoot(), subdir);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, name);

    // .rotate()：按 EXIF 方向自动转正后再剥离元数据，避免转正信息丢失导致显示旋转错误
    const base = () => sharp(file.buffer).rotate();
    const encode = (p: Sharp): Sharp =>
      format === 'jpeg'
        ? p.jpeg({ quality: 88, mozjpeg: true })
        : format === 'png'
          ? p.png({ compressionLevel: 9 })
          : p.webp({ quality: 88 });

    const main =
      kind === 'avatar'
        ? base().resize(AVATAR_MAIN_SIZE, AVATAR_MAIN_SIZE, { fit: 'cover' })
        : base().resize(PORTRAIT_MAX_WIDTH, PORTRAIT_MAX_HEIGHT, {
            fit: 'inside',
            withoutEnlargement: true,
          });
    await encode(main).toFile(filePath);

    const thumbPaths: string[] = [];
    if (kind === 'avatar') {
      const stem = name.slice(0, -(ext.length + 1));
      for (const size of AVATAR_THUMB_SIZES) {
        const thumbPath = join(dir, `${stem}_${size}.${ext}`);
        await encode(base().resize(size, size, { fit: 'cover' })).toFile(thumbPath);
        thumbPaths.push(thumbPath);
      }
    }

    return { url: `/uploads/${subdir}/${name}`, filePath, thumbPaths };
  }

  /**
   * 按对外 URL 删除磁盘文件。仅允许 /uploads/ 前缀且解析后仍位于 STORAGE_DIR 内（防路径穿越）。
   * 「先更库后删旧文件，删文件失败不回滚」：删除失败仅记录日志，不向上抛错。
   */
  async deleteByUrl(url: string | null | undefined): Promise<void> {
    if (!url || !url.startsWith('/uploads/')) return;
    const root = this.storageRoot();
    const abs = resolve(root, url.slice('/uploads/'.length));
    if (!abs.startsWith(resolve(root) + sep)) {
      this.logger.warn(`拒绝删除越界路径: ${url}`);
      return;
    }
    try {
      await unlink(abs);
    } catch (e) {
      this.logger.warn(`删除文件失败（不回滚）: ${abs} — ${(e as Error).message}`);
    }
  }

  /** 删除头像主图及其全部缩略图（按 `_256` / `_64` 后缀约定派生） */
  async deleteAvatarSet(avatarUrl: string | null | undefined): Promise<void> {
    if (!avatarUrl) return;
    await this.deleteByUrl(avatarUrl);
    const m = /^(.*)(\.[a-z0-9]+)$/i.exec(avatarUrl);
    if (!m) return;
    for (const size of AVATAR_THUMB_SIZES) {
      await this.deleteByUrl(`${m[1]}_${size}${m[2]}`);
    }
  }
}

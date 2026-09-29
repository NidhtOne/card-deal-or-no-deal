import { Injectable } from '@nestjs/common';
import { readdir } from 'fs/promises';
import { extname } from 'path';
import { resolveFromRoot } from '../config/paths';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/**
 * 内置资产目录扫描：
 * - assets/bankers/：内置银行家立绘白名单（3.3，「选择内置」模式仅允许该目录现有文件）
 * - assets/music/：BGM 曲目白名单（3.9，开源用户可直接替换目录内文件增删曲目）
 * 目录不存在/读取失败时返回空列表（本地一键可跑兜底）。
 */
@Injectable()
export class AssetCatalogService {
  /** 内置银行家立绘文件名列表（仅图片扩展名，按字典序） */
  async listBankerFiles(): Promise<string[]> {
    return this.listFiles('assets/bankers', IMAGE_EXTS);
  }

  /** 内置 BGM 曲目文件名列表（不限扩展名，按字典序） */
  async listMusicTracks(): Promise<string[]> {
    return this.listFiles('assets/music', null);
  }

  private async listFiles(dir: string, exts: Set<string> | null): Promise<string[]> {
    try {
      const entries = await readdir(resolveFromRoot(dir), { withFileTypes: true });
      return entries
        .filter(
          (e) =>
            e.isFile() &&
            !e.name.startsWith('.') && // 过滤 .gitkeep 等隐藏文件
            (!exts || exts.has(extname(e.name).toLowerCase())),
        )
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  }
}

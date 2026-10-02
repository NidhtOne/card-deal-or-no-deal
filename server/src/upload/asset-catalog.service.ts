import { Injectable } from '@nestjs/common';
import { readdir } from 'fs/promises';
import { extname } from 'path';
import { resolveFromRoot } from '../config/paths';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
/**
 * 说明文档扩展名【文档外补充】：assets/music/README.md 等文档不参与 BGM 曲目白名单
 * （3.9 允许增删曲目，但设置页选曲下拉不应出现说明文档）。
 */
const DOC_EXTS = new Set(['.md', '.txt']);

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

  /**
   * 内置 BGM 曲目文件名列表（按字典序）。
   * 【文档外补充】排除说明文档（.md/.txt，如 assets/music/README.md）；
   * 子目录（如 sfx/）已被 isFile 过滤，不参与白名单。
   */
  async listMusicTracks(): Promise<string[]> {
    const files = await this.listFiles('assets/music', null);
    return files.filter((name) => !DOC_EXTS.has(extname(name).toLowerCase()));
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

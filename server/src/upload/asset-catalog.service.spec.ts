import { AssetCatalogService } from './asset-catalog.service';

/**
 * 曲目白名单扫描单测（3.9 / 阶段 6）：
 * assets/music/ 允许放说明文档（README.md 等）与子目录（sfx/ 音效，文档外补充），
 * 但它们不得混入 BGM 曲目白名单（设置页选曲下拉只应出现可播放曲目）。
 */
describe('AssetCatalogService.listMusicTracks（文档外补充过滤）', () => {
  const service = new AssetCatalogService();

  it('排除说明文档（.md/.txt）与子目录（sfx/），保留音频文件', async () => {
    const tracks = await service.listMusicTracks();
    expect(tracks.length).toBeGreaterThan(0);
    for (const name of tracks) {
      expect(name.endsWith('.md')).toBe(false);
      expect(name.endsWith('.txt')).toBe(false);
      expect(name.includes('/')).toBe(false); // 子目录文件（如 sfx/flip.wav）不进入白名单
    }
  });

  it('内置占位曲目在白名单内（lobby/match/finale/loading，可同名替换）', async () => {
    const tracks = await service.listMusicTracks();
    for (const name of ['lobby.wav', 'match.wav', 'finale.wav', 'loading.wav']) {
      expect(tracks).toContain(name);
    }
  });
});

import { join } from 'path';
import { REPO_ROOT, SERVER_ROOT, resolveFromRoot } from './paths';

describe('config/paths', () => {
  it('相对路径基于仓库根目录解析', () => {
    expect(resolveFromRoot('./data/game.db')).toBe(join(REPO_ROOT, 'data', 'game.db'));
  });

  it('绝对路径原样返回', () => {
    const abs = join(REPO_ROOT, 'storage');
    expect(resolveFromRoot(abs)).toBe(abs);
  });

  it('SERVER_ROOT 位于仓库根之下的 server 目录', () => {
    expect(SERVER_ROOT).toBe(join(REPO_ROOT, 'server'));
  });
});

import { Module } from '@nestjs/common';
import { AssetCatalogService } from './asset-catalog.service';
import { UploadService } from './upload.service';

/** 上传文件处理（sharp 重编码去 EXIF、缩略图、随机名落盘）与内置资产目录扫描 */
@Module({
  providers: [UploadService, AssetCatalogService],
  exports: [UploadService, AssetCatalogService],
})
export class UploadModule {}

/* eslint-disable max-classes-per-file */
import { Type } from 'class-transformer';
import { ScanResult } from '@infra/antivirus';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
	FileRecordIdentifier,
	MultipleFileRecordIdentifier,
	ParentIdentifier,
} from '@shared/domain/interface/file-record.interface';
import { EntityId } from '@shared/domain/types';
import { SanitizeHtml, StringToBoolean, StringToObject } from '@shared/transformer';
import { Allow, IsBoolean, IsEnum, IsMongoId, IsNotEmpty, IsOptional, IsString, ValidateNested } from 'class-validator';
import {
	DocumentType,
	FileRecordParentType,
	ParentInfo,
	PreviewInfo,
	PreviewOutputMimeTypes,
	PreviewWidth,
	StorageLocation,
	StorageLocationParams,
} from '../../domain';

// "paramsDto" is the same information twice
export class StorageLocationParamsDto implements StorageLocationParams {
	@ApiProperty()
	@IsMongoId()
	storageLocationId!: EntityId;

	@ApiProperty({ enum: StorageLocation, enumName: 'StorageLocation' })
	@IsEnum(StorageLocation)
	storageLocation!: StorageLocation;
}

export class FileRecordParams implements ParentInfo, ParentIdentifier {
	@ApiProperty()
	@IsMongoId()
	storageLocationId!: EntityId;

	@ApiProperty({ enum: StorageLocation, enumName: 'StorageLocation' })
	@IsEnum(StorageLocation)
	storageLocation!: StorageLocation;

	@ApiProperty()
	@IsMongoId()
	parentId!: EntityId;

	@ApiProperty({ enum: FileRecordParentType, enumName: 'FileRecordParentType' })
	@IsEnum(FileRecordParentType)
	parentType!: FileRecordParentType;
}

export class FileUrlParams {
	@ApiProperty()
	@IsString()
	@IsNotEmpty()
	url!: string;

	@ApiProperty()
	@IsString()
	@IsNotEmpty()
	@SanitizeHtml()
	fileName!: string;

	@ApiPropertyOptional()
	@Allow()
	headers?: Record<string, string>;
}

export class AddDocumentToParentParams {
	@ApiProperty()
	@IsString()
	@IsNotEmpty()
	@SanitizeHtml()
	fileName!: string;

	@ApiProperty({ enum: DocumentType, enumName: 'DocumentType' })
	@IsEnum(DocumentType)
	documentType!: DocumentType;
}

export class FileParams {
	@ApiProperty({ type: 'string', format: 'binary' })
	@Allow()
	file!: string;
}

export class DownloadFileParams implements FileRecordIdentifier {
	@ApiProperty()
	@IsMongoId()
	fileRecordId!: EntityId;

	@ApiProperty()
	@IsString()
	fileName!: string;
}

export class ScanResultParams implements ScanResult {
	@ApiProperty()
	@Allow()
	virus_detected?: boolean;

	@ApiProperty()
	@Allow()
	virus_signature?: string;

	@ApiProperty()
	@Allow()
	error?: string;
}

export class SingleFileParams implements FileRecordIdentifier {
	@ApiProperty()
	@IsMongoId()
	fileRecordId!: EntityId;
}

export class MultiFileParams implements MultipleFileRecordIdentifier {
	@ApiProperty()
	@IsMongoId({ each: true })
	fileRecordIds!: EntityId[];
}

export class ArchiveFileParams implements MultipleFileRecordIdentifier {
	@ApiProperty()
	@IsMongoId({ each: true })
	@StringToObject(ArchiveFileParams)
	fileRecordIds!: EntityId[];

	@ApiProperty()
	@IsString()
	archiveName!: string;

	@ApiPropertyOptional({
		description:
			'Optional map of fileRecordId to the path it should get inside the zip (including any ' +
			'folder segments), so a caller that already knows the folder structure of the selected ' +
			'files can preserve it in the archive. Ids without an entry fall back to their flat name.',
	})
	@IsOptional()
	@StringToObject(ArchiveFileParams)
	paths?: Record<EntityId, string>;
}

export class RenameFileParams {
	@ApiProperty()
	@IsString()
	@IsNotEmpty()
	@SanitizeHtml()
	fileName!: string;
}

export class CopyFileParams {
	@ApiProperty()
	@ValidateNested()
	target!: FileRecordParams;
}

export class MoveFileParams {
	@ApiProperty({ description: 'The new parent. The storage location must stay the same.' })
	@ValidateNested()
	@Type(() => FileRecordParams)
	target!: FileRecordParams;
}

export class CopyFilesOfParentPayload {
	@IsMongoId()
	userId!: EntityId;

	@ValidateNested()
	source!: FileRecordParams;

	@ValidateNested()
	target!: FileRecordParams;
}

export class PreviewParams implements PreviewInfo {
	@ApiPropertyOptional({ enum: PreviewOutputMimeTypes, enumName: 'PreviewOutputMimeTypes' })
	@IsOptional()
	@IsEnum(PreviewOutputMimeTypes)
	outputFormat?: PreviewOutputMimeTypes;

	@ApiPropertyOptional({ enum: PreviewWidth, enumName: 'PreviewWidth' })
	@IsOptional()
	@IsEnum(PreviewWidth)
	width?: PreviewWidth;

	@IsOptional()
	@IsBoolean()
	@StringToBoolean()
	@ApiPropertyOptional({
		description: 'If true, the preview will be generated again.',
	})
	forceUpdate?: boolean;
}

export class ParentParams implements ParentIdentifier {
	@ApiProperty()
	@IsMongoId()
	parentId!: EntityId;

	@ApiProperty({ enum: FileRecordParentType, enumName: 'FileRecordParentType' })
	@IsEnum(FileRecordParentType)
	parentType!: FileRecordParentType;
}

/* eslint-disable max-classes-per-file */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EntityId } from '@shared/domain/types';
import { DecodeHtmlEntities } from '@shared/transformer';
import {
	CopyFileResult,
	FileRecord,
	FileRecordParentType,
	FileRecordStatus,
	PreviewStatus,
	ScanStatus,
	StorageLocation,
} from '../../domain';
import { PaginationResponse } from './pagination.response';

export class FileRecordResponse {
	constructor(fileRecord: FileRecord, status: FileRecordStatus) {
		const props = fileRecord.getProps();
		const expiresAt = fileRecord.getExpiresAt();

		this.id = props.id;
		this.name = props.name;
		this.url = `/api/v3/file/download/${props.id}/${encodeURIComponent(props.name)}`;
		this.size = props.size;
		this.parentId = props.parentId;
		this.creatorId = props.creatorId;
		this.mimeType = props.mimeType;
		this.parentType = props.parentType;
		this.isUploading = props.isUploading;
		this.deletedSince = props.deletedSince;
		this.createdAt = props.createdAt;
		this.updatedAt = props.updatedAt;
		this.previewStatus = status.previewStatus;
		this.securityCheckStatus = status.scanStatus;
		this.isCollaboraEditable = status.isCollaboraEditable;
		this.exceedsCollaboraEditableFileSize = status.exceedsCollaboraEditableFileSize;
		this.contentLastModifiedAt = props.contentLastModifiedAt;
		this.expiresAt = expiresAt;
		this.isFolder = props.isFolder;
		this.folderId = props.folderId;
	}

	@ApiProperty()
	id: string;

	@ApiProperty()
	@DecodeHtmlEntities()
	name: string;

	@ApiProperty()
	parentId: string;

	@ApiProperty()
	url: string;

	@ApiProperty({ enum: ScanStatus, enumName: 'FileRecordScanStatus' })
	securityCheckStatus: ScanStatus;

	@ApiProperty()
	size: number;

	@ApiProperty()
	creatorId?: string;

	@ApiProperty()
	mimeType: string;

	@ApiProperty({ enum: FileRecordParentType, enumName: 'FileRecordParentType' })
	parentType: FileRecordParentType;

	@ApiPropertyOptional()
	isUploading?: boolean;

	@ApiProperty({ enum: PreviewStatus, enumName: 'PreviewStatus' })
	previewStatus: PreviewStatus;

	@ApiProperty()
	isCollaboraEditable: boolean;

	@ApiProperty()
	exceedsCollaboraEditableFileSize: boolean;

	@ApiPropertyOptional()
	deletedSince?: Date;

	@ApiPropertyOptional()
	createdAt?: Date;

	@ApiPropertyOptional()
	updatedAt?: Date;

	@ApiPropertyOptional()
	contentLastModifiedAt?: Date;

	@ApiPropertyOptional()
	expiresAt?: Date;

	@ApiPropertyOptional({ description: 'True if this entry represents a folder rather than an uploaded file.' })
	isFolder?: boolean;

	@ApiPropertyOptional({ description: 'Id of the containing folder. Omitted/null for the root level.' })
	folderId?: string | null;
}

export class FileRecordListResponse extends PaginationResponse<FileRecordResponse[]> {
	constructor(data: FileRecordResponse[], total: number, skip?: number, limit?: number) {
		super(total, skip, limit);
		this.data = data;
	}

	@ApiProperty({ type: [FileRecordResponse] })
	data: FileRecordResponse[];
}

export class CopyFileResponse implements CopyFileResult {
	constructor(data: CopyFileResponse) {
		this.id = data.id;
		this.sourceId = data.sourceId;
		this.name = data.name;
	}

	@ApiPropertyOptional()
	id?: string;

	@ApiProperty()
	sourceId: string;

	@ApiProperty()
	@DecodeHtmlEntities()
	name: string;
}

export class CopyFileListResponse extends PaginationResponse<CopyFileResponse[]> {
	constructor(data: CopyFileResponse[], total: number, skip?: number, limit?: number) {
		super(total, skip, limit);
		this.data = data;
	}

	@ApiProperty({ type: [CopyFileResponse] })
	data: CopyFileResponse[];
}

export class DeleteByStorageLocationResponse {
	constructor(data: DeleteByStorageLocationResponse) {
		this.storageLocationId = data.storageLocationId;
		this.storageLocation = data.storageLocation;
		this.deletedFiles = data.deletedFiles;
	}

	@ApiProperty()
	storageLocationId: EntityId;

	@ApiProperty({ enum: StorageLocation, enumName: 'StorageLocation' })
	storageLocation: StorageLocation;

	@ApiProperty()
	deletedFiles: number;
}

export class ParentStatisticResponse {
	@ApiProperty({ description: 'The number of files for the parent entity.' })
	fileCount!: number;

	@ApiProperty({ description: 'The total size in bytes of all files for the parent entity.' })
	totalSizeInBytes!: number;
}

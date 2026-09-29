import { PreviewInputMimeTypes } from '@infra/preview-generator';
import { BadRequestException } from '@nestjs/common';
import { DomainObject, type AuthorizableObject } from '@shared/domain/domain-object';
import { type EntityId } from '@shared/domain/types';
import path from 'node:path';
import { ErrorType } from './error';
import { type FileRecordParentType, type ParentReference, type StorageLocation } from './interface';
import { FolderExpirationDays, StorageType } from './storage-paths.const';
import { FileRecordSecurityCheck, ScanStatus, type FileRecordSecurityCheckProps } from './vo';

export enum PreviewOutputMimeTypes {
	IMAGE_WEBP = 'image/webp',
}

interface StorageReference {
	storageLocationId: EntityId;
	storageLocation: StorageLocation;
	storageType: StorageType;
}

export enum PreviewStatus {
	PREVIEW_POSSIBLE = 'preview_possible',
	AWAITING_SCAN_STATUS = 'awaiting_scan_status',
	PREVIEW_NOT_POSSIBLE_SCAN_STATUS_ERROR = 'preview_not_possible_scan_status_error',
	PREVIEW_NOT_POSSIBLE_SCAN_STATUS_WONT_CHECK = 'preview_not_possible_scan_status_wont_check',
	PREVIEW_NOT_POSSIBLE_SCAN_STATUS_BLOCKED = 'preview_not_possible_scan_status_blocked',
	PREVIEW_NOT_POSSIBLE_WRONG_MIME_TYPE = 'preview_not_possible_wrong_mime_type',
}

const SECONDS_PER_DAY = 24 * 60 * 60;
export const TEMP_FILE_EXPIRY_SECONDS = FolderExpirationDays[StorageType.TEMP] * SECONDS_PER_DAY;

export enum CollaboraMimeTypes {
	DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	DOTX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
	DOC = 'application/msword',
	ODT = 'application/vnd.oasis.opendocument.text',
	RTF = 'application/rtf',
	TXT = 'text/plain',
	XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	XLTX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
	XLS = 'application/vnd.ms-excel',
	ODS = 'application/vnd.oasis.opendocument.spreadsheet',
	CSV = 'text/csv',
	PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	POTX = 'application/vnd.openxmlformats-officedocument.presentationml.template',
	PPSX = 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
	PPT = 'application/vnd.ms-powerpoint',
	ODP = 'application/vnd.oasis.opendocument.presentation',
}
export interface FileRecordProps extends AuthorizableObject {
	id: EntityId;
	size: number;
	name: string;
	mimeType: string;
	parentType: FileRecordParentType;
	parentId: EntityId;
	creatorId?: EntityId;
	storageLocation: StorageLocation;
	storageLocationId: EntityId;
	deletedSince?: Date;
	isCopyFrom?: EntityId;
	isUploading?: boolean;
	previewGenerationFailed?: boolean;
	createdAt: Date;
	updatedAt: Date;
	contentLastModifiedAt?: Date;
	storageType: StorageType;
	isFolder?: boolean;
	/**
	 * null = explicitly at the root level, undefined = not yet decided/unused by the caller.
	 * MikroORM's em.assign() skips properties whose value is undefined (treated as "not
	 * provided"), so clearing this back to root via an update MUST persist null, not undefined,
	 * or the change silently never reaches the database. See setFolderId().
	 */
	folderId?: EntityId | null;
}

export class FileRecord extends DomainObject<FileRecordProps> {
	constructor(
		props: FileRecordProps,
		private securityCheck: FileRecordSecurityCheck
	) {
		super(props);
	}

	// --- should be part of a aggregate that contain a file-record array ---
	public static hasDuplicateName(fileRecords: FileRecord[], fileName: string): FileRecord | undefined {
		const foundFileRecord = fileRecords.find((item: FileRecord) => item.hasName(fileName));

		return foundFileRecord;
	}

	public static removeCreatorId(fileRecords: FileRecord[]): void {
		fileRecords.forEach((entity: FileRecord) => entity.removeCreatorId());
	}

	public static resolveFileNameDuplicates(fileRecords: FileRecord[], fileName: string): string {
		let counter = 0;
		const filenameObj = path.parse(fileName);
		let newFilename = fileName;

		while (FileRecord.hasDuplicateName(fileRecords, newFilename)) {
			counter += 1;
			newFilename = `${filenameObj.name} (${counter})${filenameObj.ext}`;
		}

		return newFilename;
	}

	public static markForDelete(fileRecords: FileRecord[]): void {
		fileRecords.forEach((fileRecord) => {
			fileRecord.markForDelete();
		});
	}

	public static unmarkForDelete(fileRecords: FileRecord[]): void {
		fileRecords.forEach((fileRecord) => {
			fileRecord.unmarkForDelete();
		});
	}

	public static getUniqueParentReferences(fileRecords: FileRecord[]): ParentReference[] {
		const parentMap = new Map<EntityId, ParentReference>();

		for (const fileRecord of fileRecords) {
			const parentReference = fileRecord.getParentReference();

			if (!parentMap.has(parentReference.parentId)) {
				parentMap.set(parentReference.parentId, parentReference);
			}
		}

		const parentReferences = Array.from(parentMap.values());

		return parentReferences;
	}

	// ---------------------------------------------------------

	public static getFormat(mimeType: string): string {
		const format = mimeType.split('/')[1];

		if (!format) {
			throw new Error(`could not get format from mime type: ${mimeType}`);
		}

		return format;
	}

	// ---------------------------------------------------------

	public getSecurityCheckProps(): FileRecordSecurityCheckProps {
		const securityCheckProps = this.securityCheck.getProps();

		return securityCheckProps;
	}

	public createSecurityScanBasedOnStatus(): FileRecordSecurityCheck {
		const securityCheck = this.securityCheck.isVerified()
			? this.securityCheck.copy()
			: FileRecordSecurityCheck.createWithDefaultProps();

		return securityCheck;
	}

	get sizeInByte(): number {
		return this.props.size;
	}

	get mimeType(): string {
		return this.props.mimeType;
	}

	public updateSecurityCheckStatus(status: ScanStatus, reason: string): void {
		this.securityCheck = FileRecordSecurityCheck.scanned(status, reason);
	}

	public getSecurityToken(): string | undefined {
		return this.securityCheck.requestToken;
	}

	public isDownloadable(): boolean {
		return !this.securityCheck.isBlocked() && !this.props.isUploading && !this.isFolderRecord();
	}

	public isBlocked(): boolean {
		return this.securityCheck.isBlocked();
	}

	public isPending(): boolean {
		return this.securityCheck.isPending();
	}

	public isWontCheck(): boolean {
		return this.securityCheck.hasScanStatusWontCheck();
	}

	public hasSecurityErrorStatus(): boolean {
		return this.securityCheck.hasErrorStatus();
	}

	public isMarkedForDelete(): boolean {
		return this.props.deletedSince != null;
	}

	public markForDelete(): void {
		this.props.deletedSince = new Date();
	}

	public unmarkForDelete(): void {
		this.props.deletedSince = undefined;
	}

	public setName(name: string): void {
		if (name.length === 0) {
			throw new BadRequestException(ErrorType.FILE_NAME_EMPTY);
		}

		this.props.name = name;
	}

	public hasName(name: string): boolean {
		const hasName = this.props.name === name;

		return hasName;
	}

	public getName(): string {
		return this.props.name;
	}

	public getMimeType(): string {
		return this.props.mimeType;
	}

	public previewGenerationFailed(): boolean {
		return this.props.previewGenerationFailed ?? false;
	}

	public isPreviewPossible(): boolean {
		const isPreviewPossible = Object.values<string>(PreviewInputMimeTypes).includes(this.props.mimeType);

		return isPreviewPossible;
	}

	public markPreviewGenerationFailed(): void {
		this.props.previewGenerationFailed = true;
	}

	public hasMediaMimeType(): boolean {
		const hasMediaMimeType =
			this.props.mimeType.startsWith('image/') ||
			this.props.mimeType.startsWith('video/') ||
			this.props.mimeType.startsWith('audio/');

		return hasMediaMimeType;
	}

	public exceedsCollaboraEditableFileSize(collaboraMaxFileSizeInBytes: number): boolean {
		const exceedsFileSize = this.props.size > collaboraMaxFileSizeInBytes;

		const result = this.hasCollaboraCompatibleMimeType() && exceedsFileSize;

		return result;
	}

	public hasCollaboraCompatibleMimeType(): boolean {
		const hasCollaboraCompatibleMimeType = Object.values<string>(CollaboraMimeTypes).includes(this.props.mimeType);

		return hasCollaboraCompatibleMimeType;
	}

	public isCollaboraEditable(collaboraMaxFileSizeInBytes: number): boolean {
		const isBlocked = this.securityCheck.isBlocked();
		const hasCollaboraCompatibleMimeType = this.hasCollaboraCompatibleMimeType();
		const exceedsFileSize = this.exceedsCollaboraEditableFileSize(collaboraMaxFileSizeInBytes);

		const isEditable = hasCollaboraCompatibleMimeType && !isBlocked && !exceedsFileSize;

		return isEditable;
	}

	public getParentReference(): ParentReference {
		const { parentId, parentType } = this.props;

		return { parentId, parentType };
	}

	public isFolderRecord(): boolean {
		return this.props.isFolder === true;
	}

	public getFolderId(): EntityId | undefined {
		return this.props.folderId ?? undefined;
	}

	public setFolderId(folderId: EntityId | undefined): void {
		this.props.folderId = folderId ?? null;
	}

	public getStorageReference(): StorageReference {
		const { storageLocationId, storageLocation, storageType } = this.props;

		return { storageLocationId, storageLocation, storageType };
	}

	public getPreviewStatus(): PreviewStatus {
		if (this.securityCheck.isBlocked()) {
			return PreviewStatus.PREVIEW_NOT_POSSIBLE_SCAN_STATUS_BLOCKED;
		}

		if (!this.isPreviewPossible()) {
			return PreviewStatus.PREVIEW_NOT_POSSIBLE_WRONG_MIME_TYPE;
		}

		if (this.securityCheck.isVerified()) {
			return PreviewStatus.PREVIEW_POSSIBLE;
		}

		if (this.securityCheck.isPending()) {
			return PreviewStatus.AWAITING_SCAN_STATUS;
		}

		if (this.securityCheck.hasScanStatusWontCheck()) {
			return PreviewStatus.PREVIEW_NOT_POSSIBLE_SCAN_STATUS_WONT_CHECK;
		}

		return PreviewStatus.PREVIEW_NOT_POSSIBLE_SCAN_STATUS_ERROR;
	}

	get scanStatus(): ScanStatus {
		return this.securityCheck.status;
	}

	get fileNameWithoutExtension(): string {
		const filenameObj = path.parse(this.getName());

		return filenameObj.name;
	}

	public getPreviewName(outputFormat?: PreviewOutputMimeTypes): string {
		if (!outputFormat) {
			return this.props.name;
		}

		const format = FileRecord.getFormat(outputFormat);
		const previewFileName = `${this.fileNameWithoutExtension}.${format}`;

		return previewFileName;
	}

	public removeCreatorId(): void {
		this.props.creatorId = undefined;
	}

	private setSizeInByte(sizeInByte: number, maxSizeInByte: number): void {
		if (sizeInByte < 0) {
			throw new BadRequestException(ErrorType.FILE_IS_EMPTY);
		}
		if (sizeInByte > maxSizeInByte) {
			throw new BadRequestException(ErrorType.FILE_TOO_BIG);
		}
		this.props.size = sizeInByte;
	}

	public markAsUploading(): void {
		this.props.isUploading = true;
	}

	public markAsUploaded(sizeInByte: number, maxSizeInByte: number, maxSecurityCheckFileSizeInByte: number): void {
		this.setSizeInByte(sizeInByte, maxSizeInByte);
		this.props.isUploading = undefined;
		this.touchContentLastModifiedAt();
		if (sizeInByte > maxSecurityCheckFileSizeInByte) {
			this.updateSecurityCheckStatus(ScanStatus.WONT_CHECK, 'File is too big');
		}
	}

	public getExpiresAt(): Date | undefined {
		if (this.props.storageType !== StorageType.TEMP) {
			return undefined;
		}

		return new Date(this.props.createdAt.getTime() + TEMP_FILE_EXPIRY_SECONDS * 1000);
	}

	public getContentLastModifiedAt(): Date | undefined {
		return this.props.contentLastModifiedAt;
	}

	private touchContentLastModifiedAt(): void {
		this.props.contentLastModifiedAt = new Date();
	}
}

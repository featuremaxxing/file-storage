import { AntivirusService, ScanResult } from '@infra/antivirus';
import { DomainErrorHandler } from '@infra/error';
import { Logger } from '@infra/logger';
import { CopyFiles, S3ClientAdapter } from '@infra/s3-client';
import {
	ConflictException,
	ForbiddenException,
	HttpException,
	Inject,
	Injectable,
	InternalServerErrorException,
	NotFoundException,
} from '@nestjs/common';
import { FindOptions } from '@shared/domain/interface';
import { Counted, EntityId } from '@shared/domain/types';
import type { Archiver } from 'archiver';
import { PassThrough } from 'node:stream';
import { FILE_STORAGE_CONFIG_TOKEN, FILES_STORAGE_S3_CONNECTION, FileStorageConfig } from '../../files-storage.config';
import { FILE_RECORD_REPO, type FileRecordRepo, type FileRecordStatus, type FileRecordWithStatus } from '../contract';
import { FileDto, PassThroughFileDto } from '../dto';
import { ErrorType } from '../error';
import {
	ArchiveFactory,
	FilePathFactory,
	FileRecordFactory,
	PassThroughFileDtoFactory,
	StreamFileSizeObserver,
} from '../factory';
import { FileRecord } from '../file-record.do';
import {
	CollaboraEditabilityStatus,
	CopyFileResult,
	DocumentType,
	GetFileResponse,
	ParentInfo,
	StorageLocationParams,
} from '../interface';
import { FileStorageActionsLoggable, StorageLocationDeleteLoggableException } from '../loggable';
import { FileResponseFactory, ScanResultDtoMapper } from '../mapper';
import { StorageType } from '../storage-paths.const';
import { detectMimeTypeByStream, duplicateStream, readDocumentSource } from '../utils';
import { ParentStatistic } from '../vo';

@Injectable()
export class FilesStorageService {
	constructor(
		@Inject(FILE_RECORD_REPO) private readonly fileRecordRepo: FileRecordRepo,
		@Inject(FILES_STORAGE_S3_CONNECTION) private readonly storageClient: S3ClientAdapter,
		private readonly antivirusService: AntivirusService,
		@Inject(FILE_STORAGE_CONFIG_TOKEN) private readonly config: FileStorageConfig,
		private readonly logger: Logger,
		private readonly domainErrorHandler: DomainErrorHandler
	) {
		this.logger.setContext(FilesStorageService.name);
	}

	// find
	public async getFileRecord(fileRecordId: EntityId): Promise<FileRecord> {
		const fileRecord = await this.fileRecordRepo.findOneById(fileRecordId);

		return fileRecord;
	}

	public getFileRecords(fileRecordIds: EntityId[]): Promise<Counted<FileRecord[]>> {
		const fileRecords = this.fileRecordRepo.findMultipleById(fileRecordIds);

		return fileRecords;
	}

	public async getFileRecordBySecurityCheckRequestToken(token: string): Promise<FileRecord> {
		const fileRecord = await this.fileRecordRepo.findBySecurityCheckRequestToken(token);

		return fileRecord;
	}

	public async getFileRecordMarkedForDelete(fileRecordId: EntityId): Promise<FileRecord> {
		const fileRecord = await this.fileRecordRepo.findOneByIdMarkedForDelete(fileRecordId);

		return fileRecord;
	}

	public async getFileRecordsMarkedForDelete(fileRecordIds: EntityId[]): Promise<Counted<FileRecord[]>> {
		const countedFileRecords = await this.fileRecordRepo.findMultipleByIdMarkedForDelete(fileRecordIds);

		return countedFileRecords;
	}

	public async getFileRecordsByParentAndStorageType(
		parentId: EntityId,
		storageType?: StorageType,
		options?: FindOptions<FileRecord>
	): Promise<Counted<FileRecord[]>> {
		const countedFileRecords = await this.fileRecordRepo.findByParentId(parentId, options, storageType);

		return countedFileRecords;
	}

	/**
	 * Lists only the direct children of one nesting level (folderId undefined = root level of
	 * the FileFolderElement). Used for UI folder browsing and for scoping duplicate-name checks
	 * to siblings within the same folder, so files with identical names may exist in different
	 * subfolders.
	 */
	public async getFileRecordsByFolderScope(
		parentId: EntityId,
		folderId?: EntityId | null,
		options?: FindOptions<FileRecord>
	): Promise<Counted<FileRecord[]>> {
		const countedFileRecords = await this.fileRecordRepo.findByParentAndFolderId(parentId, folderId, options);

		return countedFileRecords;
	}

	public async getFileRecordsMarkedForDeleteByParent(
		parentId: EntityId,
		options?: FindOptions<FileRecord>
	): Promise<Counted<FileRecord[]>> {
		const countedFileRecords = await this.fileRecordRepo.findMarkedForDeleteByParentId(parentId, options);

		return countedFileRecords;
	}

	public async getFileRecordsByCreatorId(creatorId: EntityId): Promise<Counted<FileRecord[]>> {
		const countedFileRecords = await this.fileRecordRepo.findByCreatorId(creatorId);

		return countedFileRecords;
	}

	// generate status
	public getFileRecordStatus(fileRecord: FileRecord): FileRecordStatus {
		const scanStatus = fileRecord.scanStatus;
		const previewStatus = fileRecord.getPreviewStatus();
		const collaboraEditabilityStatus = this.getCollaboraEditabilityStatus(fileRecord);

		const status = {
			scanStatus,
			previewStatus,
			...collaboraEditabilityStatus,
		};

		return status;
	}

	public getCollaboraEditabilityStatus(fileRecord: FileRecord): CollaboraEditabilityStatus {
		const status = {
			isCollaboraEditable: fileRecord.isCollaboraEditable(this.config.collaboraMaxFileSizeInBytes),
			exceedsCollaboraEditableFileSize: fileRecord.exceedsCollaboraEditableFileSize(
				this.config.collaboraMaxFileSizeInBytes
			),
		};

		return status;
	}

	public getFileRecordsWithStatus(fileRecords: FileRecord[]): FileRecordWithStatus[] {
		return fileRecords.map((fileRecord) => ({
			fileRecord,
			status: this.getFileRecordStatus(fileRecord),
		}));
	}

	// upload
	public async uploadFile(userId: EntityId, parentInfo: ParentInfo, sourceFile: FileDto): Promise<FileRecord> {
		if (parentInfo.folderId) {
			await this.assertIsFolderWithinSameParent(parentInfo.folderId, parentInfo.parentId);
		}

		const [, totalCountOfParent] = await this.getFileRecordsByParentAndStorageType(
			parentInfo.parentId,
			sourceFile.storageType
		);
		this.checkFileLimitPerParent(totalCountOfParent);

		const [siblingsInFolder] = await this.getFileRecordsByFolderScope(parentInfo.parentId, parentInfo.folderId);
		const fileName = this.resolveFileName(sourceFile.name, siblingsInFolder.length, siblingsInFolder);
		const file = await this.createPassThroughFileDto(sourceFile, fileName);
		const fileRecord = await this.prepareFileRecordWithUploadingFlag(file, parentInfo, userId);

		try {
			await this.storeAndScanFile(fileRecord, file);
		} catch (error) {
			await this.rollbackByFileRecord(fileRecord);
			throw error;
		}

		return fileRecord;
	}

	public async updateFileContents(fileRecord: FileRecord, sourceFile: FileDto): Promise<FileRecord> {
		const file = await this.createPassThroughFileDto(sourceFile);
		this.checkMimeType(fileRecord, file);

		await this.storeAndScanFile(fileRecord, file);

		return fileRecord;
	}

	public async uploadDocumentToParent(
		userId: EntityId,
		parentInfo: ParentInfo,
		targetFileName: string,
		documentType: DocumentType
	): Promise<FileRecord> {
		const sourceFile = await readDocumentSource(targetFileName, documentType);

		return this.uploadFile(userId, parentInfo, sourceFile);
	}

	private async createPassThroughFileDto(sourceFile: FileDto, newFileName?: string): Promise<PassThroughFileDto> {
		const [mimeTypeStream, filesStorageStream] = duplicateStream(sourceFile.data, 2);
		const mimeType = await detectMimeTypeByStream(mimeTypeStream, sourceFile.mimeType, this.logger);
		const file = PassThroughFileDtoFactory.create(sourceFile, filesStorageStream, mimeType, newFileName);

		return file;
	}

	private checkFileLimitPerParent(count: number, additionalFiles = 1): void {
		const totalFiles = count + additionalFiles;

		if (totalFiles > this.config.filesStorageMaxFilesPerParent) {
			throw new ForbiddenException(ErrorType.FILE_LIMIT_PER_PARENT_EXCEEDED);
		}
	}

	private resolveFileName(name: string, count: number, fileRecordsOfParent: FileRecord[]): string {
		let fileName = name;

		if (count > 0) {
			fileName = FileRecord.resolveFileNameDuplicates(fileRecordsOfParent, name);
		}

		return fileName;
	}

	private checkMimeType(fileRecord: FileRecord, file: FileDto): void {
		if (fileRecord.mimeType !== file.mimeType) {
			throw new ConflictException(ErrorType.MIME_TYPE_MISMATCH);
		}
	}

	private async prepareFileRecordWithUploadingFlag(
		file: FileDto,
		parentInfo: ParentInfo,
		userId: EntityId
	): Promise<FileRecord> {
		const fileRecord = FileRecordFactory.buildFromExternalInput(
			file.name,
			file.mimeType,
			parentInfo,
			userId,
			file.storageType
		);
		fileRecord.markAsUploading();
		await this.fileRecordRepo.save(fileRecord);

		return fileRecord;
	}

	private async storeAndScanFile(fileRecord: FileRecord, file: PassThroughFileDto): Promise<void> {
		StreamFileSizeObserver.observe(file, this.config.filesStorageMaxFileSize);

		const [uploadResult, streamResult] = await Promise.allSettled([
			this.uploadAndScan(fileRecord, file),
			file.streamCompletion,
		]);

		this.handleUploadAndStreamPromiseResults(uploadResult, streamResult);

		fileRecord.markAsUploaded(
			file.fileSize,
			this.config.filesStorageMaxFileSize,
			this.config.filesStorageMaxSecurityCheckFileSize
		);
		await this.fileRecordRepo.save(fileRecord);

		if (this.needsAsyncAntivirusScan(fileRecord)) {
			await this.antivirusService.send(fileRecord.getSecurityToken());
		}
	}

	private handleUploadAndStreamPromiseResults(
		uploadResult: PromiseSettledResult<void>,
		streamResult: PromiseSettledResult<void>
	): void {
		// Stream error takes priority over upload error.
		// When the stream size limit is exceeded, StreamFileSizeObserver emits an error and destroys
		// the stream, which causes the S3 upload to abort and reject with its own error.
		// Throwing the stream error first ensures the meaningful PayloadTooLargeException reaches
		// the caller instead of the opaque S3 abort error.
		if (streamResult.status === 'rejected') {
			this.throwStreamError(streamResult.reason);
		}

		if (uploadResult.status === 'rejected') {
			throw uploadResult.reason;
		}
	}

	private throwStreamError(reason: unknown): never {
		if (reason instanceof HttpException) throw reason;
		throw new InternalServerErrorException('File stream error', { cause: reason });
	}

	private async uploadAndScan(fileRecord: FileRecord, file: PassThroughFileDto): Promise<void> {
		const filePath = FilePathFactory.create(fileRecord);

		if (this.shouldStreamToAntivirus(fileRecord)) {
			const pipedStream = file.data.pipe(new PassThrough());

			const [, antivirusClientResponse] = await Promise.all([
				this.storageClient.create(filePath, file),
				this.antivirusService.scanStream(pipedStream),
			]);
			const { status, reason } = ScanResultDtoMapper.fromScanResult(antivirusClientResponse);
			fileRecord.updateSecurityCheckStatus(status, reason);
		} else {
			await this.storageClient.create(filePath, file);
		}
	}

	private needsAsyncAntivirusScan(fileRecord: FileRecord): boolean {
		return !this.shouldStreamToAntivirus(fileRecord) && !fileRecord.isWontCheck();
	}

	private shouldStreamToAntivirus(fileRecord: FileRecord): boolean {
		const isCollaboraEditable = fileRecord.isCollaboraEditable(this.config.collaboraMaxFileSizeInBytes);
		const shouldStreamToAntiVirus =
			this.config.filesStorageUseStreamToAntivirus && (fileRecord.isPreviewPossible() || isCollaboraEditable);

		return shouldStreamToAntiVirus;
	}

	private async rollbackByFileRecord(fileRecord: FileRecord): Promise<void> {
		const filePath = FilePathFactory.create(fileRecord);
		await Promise.allSettled([this.storageClient.delete([filePath]), this.fileRecordRepo.delete(fileRecord)]);
	}

	// update
	private checkDuplicatedNames(fileRecords: FileRecord[], newFileName: string, currentFileRecordId: EntityId): void {
		const duplicateFound = fileRecords.find((item) => item.id !== currentFileRecordId && item.hasName(newFileName));

		if (duplicateFound) {
			throw new ConflictException(ErrorType.FILE_NAME_EXISTS);
		}
	}

	public async patchFilename(fileRecord: FileRecord, fileName: string): Promise<FileRecord> {
		const { parentId } = fileRecord.getParentReference();
		const [siblingsInFolder] = await this.getFileRecordsByFolderScope(parentId, fileRecord.getFolderId());

		this.checkDuplicatedNames(siblingsInFolder, fileName, fileRecord.id);
		fileRecord.setName(fileName);
		await this.fileRecordRepo.save(fileRecord);

		return fileRecord;
	}

	public async updateSecurityStatus(token: string, scanResult: ScanResult): Promise<void> {
		const fileRecord = await this.fileRecordRepo.findBySecurityCheckRequestToken(token);

		const { status, reason } = ScanResultDtoMapper.fromScanResult(scanResult);
		fileRecord.updateSecurityCheckStatus(status, reason);

		await this.fileRecordRepo.save(fileRecord);
	}

	// download
	public checkFileName(fileRecord: FileRecord, fileName: string): void | NotFoundException {
		if (!fileRecord.hasName(fileName)) {
			this.logger.debug(
				new FileStorageActionsLoggable(`could not find file by filename`, {
					action: 'checkFileName',
					sourcePayload: fileRecord,
				})
			);
			throw new NotFoundException(ErrorType.FILE_NOT_FOUND);
		}
	}

	private checkDownloadable(fileRecord: FileRecord): void | NotFoundException {
		if (!fileRecord.isDownloadable()) {
			this.logger.debug(
				new FileStorageActionsLoggable(`file is not downloadable`, {
					action: 'checkDownloadable',
					sourcePayload: fileRecord,
				})
			);
			throw new NotFoundException(ErrorType.FILE_NOT_FOUND);
		}
	}

	public async downloadFile(fileRecord: FileRecord, bytesRange?: string): Promise<GetFileResponse> {
		const pathToFile = FilePathFactory.create(fileRecord);
		const file = await this.storageClient.get(pathToFile, bytesRange);
		const fileResponse = FileResponseFactory.create(file, fileRecord.getName());

		return fileResponse;
	}

	public async download(fileRecord: FileRecord, fileName: string, bytesRange?: string): Promise<GetFileResponse> {
		this.checkFileName(fileRecord, fileName);
		this.checkDownloadable(fileRecord);

		const fileResponse = await this.downloadFile(fileRecord, bytesRange);

		return fileResponse;
	}

	public downloadFilesAsArchive(fileRecords: FileRecord[], archiveName: string): GetFileResponse {
		if (fileRecords.length === 0) {
			throw new NotFoundException(ErrorType.NO_FILES_IN_ARCHIVE);
		}

		const archive = ArchiveFactory.createEmpty(fileRecords, this.logger);
		this.populateArchiveAndFinalize(archive, fileRecords).catch((err) => archive.destroy(err));

		const fileResponse = FileResponseFactory.createFromArchive(archiveName, archive);

		return fileResponse;
	}

	private async populateArchiveAndFinalize(archive: Archiver, files: FileRecord[]): Promise<void> {
		for (const file of files) {
			if (archive.destroyed) {
				return;
			}

			const fileResponse = await this.downloadFile(file);

			await this.appendAndWaitForEntry(archive, fileResponse);
		}

		await archive.finalize();
	}

	private appendAndWaitForEntry(archive: Archiver, fileResponse: GetFileResponse): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			/* istanbul ignore next */
			if (archive.destroyed) {
				resolve();

				return;
			}

			const cleanup = (): void => {
				archive.off('entry', onEntry);
				archive.off('error', onError);
				archive.off('close', onClose);
			};

			const onEntry = (): void => {
				cleanup();
				resolve();
			};
			const onError = (err: Error): void => {
				cleanup();
				reject(err);
			};
			/* istanbul ignore next */
			const onClose = (): void => {
				cleanup();
				resolve();
			};

			archive.once('entry', onEntry);
			archive.once('error', onError);
			archive.once('close', onClose);

			if (archive.destroyed) {
				cleanup();
				resolve();

				return;
			}
			ArchiveFactory.appendFile(archive, fileResponse);
		});
	}

	// delete and restore
	private async deleteBinaryFiles(fileRecords: FileRecord[]): Promise<void> {
		const paths = FilePathFactory.createMany(fileRecords);
		await this.storageClient.moveToTrash(paths);
	}

	private async restoreBinaryFiles(fileRecords: FileRecord[]): Promise<void> {
		const paths = FilePathFactory.createMany(fileRecords);
		await this.storageClient.restore(paths);
	}

	private async markFileRecordsForDelete(fileRecords: FileRecord[]): Promise<void> {
		FileRecord.markForDelete(fileRecords);
		await this.fileRecordRepo.save(fileRecords);
	}

	private async restoreFileRecords(fileRecords: FileRecord[]): Promise<void> {
		FileRecord.unmarkForDelete(fileRecords);
		await this.fileRecordRepo.save(fileRecords);
	}

	public async deleteFiles(fileRecords: FileRecord[]): Promise<void> {
		this.logDelete(fileRecords);
		if (fileRecords.length === 0) return;

		await this.markFileRecordsForDelete(fileRecords);

		try {
			await this.deleteBinaryFiles(fileRecords);
		} catch (error) {
			await this.restoreFileRecords(fileRecords);

			throw error;
		}
	}

	/**
	 * Collects a folder together with every file/subfolder nested underneath it, so the caller
	 * can delete them all in one batch (including preview cleanup, which lives outside this
	 * service). Walks the folderId chain one level at a time (no materialized paths) - O(depth)
	 * queries, acceptable for the expected shallow/moderate folder trees in a file element.
	 */
	public async getFolderAndDescendants(folder: FileRecord): Promise<FileRecord[]> {
		const descendants = await this.collectDescendants(folder);

		return [folder, ...descendants];
	}

	private async collectDescendants(folder: FileRecord): Promise<FileRecord[]> {
		const { parentId } = folder.getParentReference();
		const [children] = await this.getFileRecordsByFolderScope(parentId, folder.id);

		const nestedDescendants = await Promise.all(
			children.filter((child) => child.isFolderRecord()).map((childFolder) => this.collectDescendants(childFolder))
		);

		return [...children, ...nestedDescendants.flat()];
	}

	// folders
	public async createFolder(userId: EntityId, parentInfo: ParentInfo, name: string): Promise<FileRecord> {
		if (parentInfo.folderId) {
			await this.assertIsFolderWithinSameParent(parentInfo.folderId, parentInfo.parentId);
		}

		const [, totalCountOfParent] = await this.getFileRecordsByParentAndStorageType(parentInfo.parentId);
		this.checkFileLimitPerParent(totalCountOfParent);

		const [siblingsInFolder] = await this.getFileRecordsByFolderScope(parentInfo.parentId, parentInfo.folderId);

		if (FileRecord.hasDuplicateName(siblingsInFolder, name)) {
			throw new ConflictException(ErrorType.FILE_NAME_EXISTS);
		}

		const folder = FileRecordFactory.buildFolder(name, parentInfo, userId);
		await this.fileRecordRepo.save(folder);

		return folder;
	}

	/**
	 * Moves a file or folder to a different folder (or to the root) within the same
	 * FileFolderElement. Moving across different parentId scopes is not supported, since
	 * parentId is what the authorization check is keyed on.
	 */
	public async moveRecord(record: FileRecord, targetFolderId?: EntityId): Promise<FileRecord> {
		const { parentId } = record.getParentReference();

		if (targetFolderId) {
			await this.assertIsFolderWithinSameParent(targetFolderId, parentId);
		}

		if (record.isFolderRecord() && targetFolderId) {
			await this.assertNoCycle(record.id, targetFolderId);
		}

		const [siblingsInTargetFolder] = await this.getFileRecordsByFolderScope(parentId, targetFolderId);
		const otherSiblings = siblingsInTargetFolder.filter((sibling) => sibling.id !== record.id);

		if (FileRecord.hasDuplicateName(otherSiblings, record.getName())) {
			throw new ConflictException(ErrorType.FILE_NAME_EXISTS);
		}

		record.setFolderId(targetFolderId);
		await this.fileRecordRepo.save(record);

		return record;
	}

	private async assertIsFolderWithinSameParent(targetFolderId: EntityId, expectedParentId: EntityId): Promise<void> {
		const targetFolder = await this.fileRecordRepo.findOneById(targetFolderId);
		const { parentId } = targetFolder.getParentReference();

		if (!targetFolder.isFolderRecord() || parentId !== expectedParentId) {
			throw new NotFoundException(ErrorType.FILE_NOT_FOUND);
		}
	}

	private async assertNoCycle(movedFolderId: EntityId, targetFolderId: EntityId): Promise<void> {
		let currentId: EntityId | undefined = targetFolderId;

		while (currentId) {
			if (currentId === movedFolderId) {
				throw new ConflictException(ErrorType.FOLDER_CANNOT_BE_MOVED_INTO_ITSELF);
			}

			const currentFolder: FileRecord = await this.fileRecordRepo.findOneById(currentId);
			currentId = currentFolder.getFolderId();
		}
	}

	public async permanentlyDeleteFiles(fileRecords: FileRecord[]): Promise<void> {
		if (fileRecords.length === 0) return;

		const trashPaths = FilePathFactory.createManyTrashPaths(fileRecords);
		await this.storageClient.delete(trashPaths);
		await this.fileRecordRepo.delete(fileRecords);
	}

	public async restoreFiles(fileRecords: FileRecord[]): Promise<void> {
		this.logRestore(fileRecords);
		if (fileRecords.length === 0) return;

		await this.restoreFileRecords(fileRecords);

		try {
			await this.restoreBinaryFiles(fileRecords);
		} catch (error) {
			await this.markFileRecordsForDelete(fileRecords);

			throw error;
		}
	}

	public async removeCreatorIdFromFileRecords(fileRecords: FileRecord[]): Promise<void> {
		FileRecord.removeCreatorId(fileRecords);
		await this.fileRecordRepo.save(fileRecords);
	}

	public async deleteStorageLocationWithAllFiles(params: StorageLocationParams): Promise<number> {
		const { storageLocation, storageLocationId } = params;
		const result = await this.fileRecordRepo.markForDeleteByStorageLocation(storageLocation, storageLocationId);

		this.storageClient.moveDirectoryToTrash(storageLocationId).catch((error) => {
			this.domainErrorHandler.exec(new StorageLocationDeleteLoggableException(params, error));
			/*****************************************************************************
			 * We do not want a rollback of the file records. Need to be fixed manually. *
			 *****************************************************************************/
		});

		return result;
	}

	public async copyFilesToParent(
		userId: EntityId,
		sourceFileRecords: FileRecord[],
		targetParentInfo: ParentInfo
	): Promise<CopyFileResult[]> {
		this.logCopy(sourceFileRecords, targetParentInfo);
		if (sourceFileRecords.length === 0) return [];

		if (targetParentInfo.folderId) {
			await this.assertIsFolderWithinSameParent(targetParentInfo.folderId, targetParentInfo.parentId);
		}

		const [, count] = await this.getFileRecordsByParentAndStorageType(targetParentInfo.parentId);

		this.checkFileLimitPerParent(count, sourceFileRecords.length);

		const promises: Promise<CopyFileResult>[] = sourceFileRecords.map(async (sourceFile) => {
			try {
				this.checkDownloadable(sourceFile);

				const targetFile = await this.copyFileRecord(sourceFile, targetParentInfo, userId);
				const copyFileResult = await this.copyFilesWithRollbackOnError(sourceFile, targetFile);

				return copyFileResult;
			} catch (error) {
				this.domainErrorHandler.exec(
					new InternalServerErrorException(`copy file failed for source fileRecordId ${sourceFile.id}`, {
						cause: error,
					})
				);

				const copyFileResult: CopyFileResult = { id: undefined, sourceId: sourceFile.id, name: sourceFile.getName() };

				return copyFileResult;
			}
		});

		const settledPromises = await Promise.all(promises);

		return settledPromises;
	}

	private async copyFileRecord(
		sourceFile: FileRecord,
		targetParentInfo: ParentInfo,
		userId: EntityId
	): Promise<FileRecord> {
		const fileRecord = FileRecordFactory.copy(sourceFile, userId, targetParentInfo);
		await this.fileRecordRepo.save(fileRecord);

		return fileRecord;
	}

	private async copyFilesWithRollbackOnError(sourceFile: FileRecord, targetFile: FileRecord): Promise<CopyFileResult> {
		try {
			const copyFiles: CopyFiles = {
				sourcePath: FilePathFactory.create(sourceFile),
				targetPath: FilePathFactory.create(targetFile),
			};

			await this.storageClient.copy([copyFiles]);
			if (targetFile.isPending() || targetFile.hasSecurityErrorStatus()) {
				await this.antivirusService.send(targetFile.getSecurityToken());
			}

			const copyFileResult: CopyFileResult = { id: targetFile.id, sourceId: sourceFile.id, name: targetFile.getName() };

			return copyFileResult;
		} catch (error) {
			await this.fileRecordRepo.delete([targetFile]);
			throw error;
		}
	}

	// statistics
	public async getParentStatistic(parentId: EntityId): Promise<ParentStatistic> {
		const statistics = await this.fileRecordRepo.getStatisticByParentId(parentId);

		return statistics;
	}

	private logCopy(sourceFileRecords: FileRecord[], targetParentInfo: ParentInfo): void {
		this.logger.debug(
			new FileStorageActionsLoggable('Start copy of FileRecords', {
				action: 'copy',
				sourcePayload: sourceFileRecords,
				targetPayload: targetParentInfo,
			})
		);
	}

	private logDelete(fileRecords: FileRecord[]): void {
		this.logger.debug(
			new FileStorageActionsLoggable('Start of FileRecords deletion', { action: 'delete', sourcePayload: fileRecords })
		);
	}

	private logRestore(fileRecords: FileRecord[]): void {
		this.logger.debug(
			new FileStorageActionsLoggable('Start restore of FileRecords', { action: 'restore', sourcePayload: fileRecords })
		);
	}

	public async markPreviewGenerationFailed(fileRecord: FileRecord): Promise<void> {
		fileRecord.markPreviewGenerationFailed();
		await this.fileRecordRepo.save([fileRecord]);

		this.logger.warning(
			new FileStorageActionsLoggable('Preview generation marked as failed', {
				action: 'previewNotPossible',
				sourcePayload: fileRecord,
			})
		);
	}
}

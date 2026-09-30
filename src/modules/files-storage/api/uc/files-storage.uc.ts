import {
	AuthorizationClientAdapter,
	AuthorizationContextBuilder,
	AuthorizationContextParams,
	AuthorizationContextParamsRequiredPermissions,
} from '@infra/authorization-client';
import { AbortableRequest } from '@infra/core/interceptor';
import { DomainErrorHandler } from '@infra/error';
import { Logger } from '@infra/logger';
import { RpcTimeoutException } from '@infra/rabbitmq';
import { EntityManager, RequestContext } from '@mikro-orm/mongodb';
import { DEFAULT_CHUNK_SIZE } from '@modules/files-storage/domain/utils';
import { HttpService } from '@nestjs/axios';
import {
	Inject,
	Injectable,
	InternalServerErrorException,
	NotFoundException,
	PayloadTooLargeException,
	UnprocessableEntityException,
} from '@nestjs/common';
import { Counted, EntityId } from '@shared/domain/types';
import { AxiosRequestConfig, AxiosResponse } from 'axios';
import busboy from 'busboy';
import { Request } from 'express';
import internal from 'node:stream';
import { firstValueFrom } from 'rxjs';
import {
	ErrorType,
	FileRecord,
	FilesStorageMapper,
	FilesStorageService,
	GetFileResponse,
	ParentReference,
	PreviewService,
	StorageLocation,
	StorageType,
} from '../../domain';
import { FILE_STORAGE_PUBLIC_API_CONFIG_TOKEN, FileStoragePublicApiConfig } from '../../files-storage.config';
import { UploadAbortLoggable } from '../../loggable';
import {
	AddDocumentToParentParams,
	ArchiveFileParams,
	CopyFileResponse,
	DownloadFileParams,
	FileRecordListResponse,
	FileRecordParams,
	FileRecordResponse,
	FileUrlParams,
	MultiFileParams,
	PaginationParams,
	ParentParams,
	ParentStatisticResponse,
	PreviewParams,
	RenameFileParams,
	ScanResultParams,
	SingleFileParams,
} from '../dto';
import { FileDtoMapper, FileRecordMapper, ParentStatisticMapper, PreviewBuilder } from '../mapper';

const FileStorageAuthorizationContext = {
	create: AuthorizationContextBuilder.write([AuthorizationContextParamsRequiredPermissions.FILESTORAGE_CREATE]),
	read: AuthorizationContextBuilder.read([AuthorizationContextParamsRequiredPermissions.FILESTORAGE_VIEW]),
	update: AuthorizationContextBuilder.write([AuthorizationContextParamsRequiredPermissions.FILESTORAGE_EDIT]),
	delete: AuthorizationContextBuilder.write([AuthorizationContextParamsRequiredPermissions.FILESTORAGE_REMOVE]),
};

@Injectable()
export class FilesStorageUC {
	constructor(
		private readonly logger: Logger,
		private readonly authorizationClientAdapter: AuthorizationClientAdapter,
		private readonly httpService: HttpService,
		private readonly filesStorageService: FilesStorageService,
		private readonly previewService: PreviewService,
		// maybe better to pass the request context from controller and avoid em at this place
		private readonly em: EntityManager,
		private readonly domainErrorHandler: DomainErrorHandler,
		@Inject(FILE_STORAGE_PUBLIC_API_CONFIG_TOKEN) private readonly config: FileStoragePublicApiConfig
	) {
		this.logger.setContext(FilesStorageUC.name);
	}

	// upload
	public async upload(userId: EntityId, params: FileRecordParams, req: Request): Promise<FileRecordResponse> {
		await Promise.all([
			this.checkPermission(params, FileStorageAuthorizationContext.create),
			this.checkStorageLocationCanRead(params.storageLocation, params.storageLocationId),
		]);
		this.checkContentLength(req);

		const fileRecord = await this.uploadFileWithBusboy(userId, params, req, StorageType.STANDARD);
		const status = this.filesStorageService.getFileRecordStatus(fileRecord);
		const fileRecordResponse = FileRecordMapper.mapToFileRecordResponse(fileRecord, status);

		return fileRecordResponse;
	}

	public async uploadFromUrl(userId: EntityId, params: FileRecordParams & FileUrlParams): Promise<FileRecordResponse> {
		await Promise.all([
			this.checkPermission(params, FileStorageAuthorizationContext.create),
			this.checkStorageLocationCanRead(params.storageLocation, params.storageLocationId),
		]);

		const response = await this.getResponse(params);
		const abortSignal = undefined;
		const fileDto = FileDtoMapper.mapFromAxiosResponse(params.fileName, response, StorageType.STANDARD, abortSignal);
		const fileRecord = await this.filesStorageService.uploadFile(userId, params, fileDto);
		await this.checkMimeTypeAndRollbackIfNotAllowed(fileRecord);

		const status = this.filesStorageService.getFileRecordStatus(fileRecord);
		const fileRecordResponse = FileRecordMapper.mapToFileRecordResponse(fileRecord, status);

		return fileRecordResponse;
	}

	private async checkMimeTypeAndRollbackIfNotAllowed(fileRecord: FileRecord): Promise<void> {
		if (fileRecord.hasMediaMimeType()) return;

		await this.filesStorageService.permanentlyDeleteFiles([fileRecord]);
		throw new UnprocessableEntityException(ErrorType.MIME_TYPE_MISMATCH);
	}

	public async addDocumentToParent(
		userId: EntityId,
		params: FileRecordParams & AddDocumentToParentParams
	): Promise<FileRecordResponse> {
		await Promise.all([
			this.checkPermission(params, FileStorageAuthorizationContext.create),
			this.checkStorageLocationCanRead(params.storageLocation, params.storageLocationId),
		]);

		const fileRecord = await this.filesStorageService.uploadDocumentToParent(
			userId,
			params,
			params.fileName,
			params.documentType
		);

		const status = this.filesStorageService.getFileRecordStatus(fileRecord);
		const fileRecordResponse = FileRecordMapper.mapToFileRecordResponse(fileRecord, status);

		return fileRecordResponse;
	}

	public async tempUpload(userId: string, params: FileRecordParams, req: Request): Promise<FileRecordResponse> {
		await Promise.all([
			this.checkPermission(params, FileStorageAuthorizationContext.create),
			this.checkStorageLocationCanRead(params.storageLocation, params.storageLocationId),
		]);
		this.checkContentLength(req);

		const fileRecord = await this.uploadFileWithBusboy(userId, params, req, StorageType.TEMP);

		const status = this.filesStorageService.getFileRecordStatus(fileRecord);
		const fileRecordResponse = FileRecordMapper.mapToFileRecordResponse(fileRecord, status);

		return fileRecordResponse;
	}

	// download
	public async download(params: DownloadFileParams, bytesRange?: string): Promise<GetFileResponse> {
		const fileRecord = await this.filesStorageService.getFileRecord(params.fileRecordId);
		const parentReference = fileRecord.getParentReference();

		await this.checkPermission(parentReference, FileStorageAuthorizationContext.read);

		return this.filesStorageService.download(fileRecord, params.fileName, bytesRange);
	}

	public async downloadBySecurityToken(token: string): Promise<GetFileResponse> {
		const fileRecord = await this.filesStorageService.getFileRecordBySecurityCheckRequestToken(token);
		const res = await this.filesStorageService.downloadFile(fileRecord);

		return res;
	}

	public async downloadPreview(
		params: DownloadFileParams,
		previewParams: PreviewParams,
		bytesRange?: string
	): Promise<GetFileResponse> {
		const fileRecord = await this.filesStorageService.getFileRecord(params.fileRecordId);

		if (fileRecord.previewGenerationFailed()) {
			throw new NotFoundException(ErrorType.PREVIEW_NOT_POSSIBLE);
		}

		const parentReference = fileRecord.getParentReference();

		await this.checkPermission(parentReference, FileStorageAuthorizationContext.read);
		this.filesStorageService.checkFileName(fileRecord, params.fileName);

		const previewFileParams = PreviewBuilder.buildParams(fileRecord, previewParams, bytesRange);
		try {
			const fileResponse = await this.previewService.download(fileRecord, previewFileParams);

			return fileResponse;
		} catch (error) {
			if (error instanceof UnprocessableEntityException || error instanceof RpcTimeoutException) {
				await this.filesStorageService.markPreviewGenerationFailed(fileRecord);
			}

			throw new NotFoundException(ErrorType.PREVIEW_NOT_POSSIBLE, { cause: error });
		}
	}

	public async downloadFilesOfParentAsArchive(params: ArchiveFileParams): Promise<GetFileResponse> {
		const [fileRecords] = await this.filesStorageService.getFileRecords(params.fileRecordIds);
		const downloadableFileRecords = fileRecords.filter((fileRecord) => fileRecord.isDownloadable());
		const uniqueParentReferences = FileRecord.getUniqueParentReferences(downloadableFileRecords);

		await this.checkPermissions(uniqueParentReferences, FileStorageAuthorizationContext.read);

		const fileResponse = this.filesStorageService.downloadFilesAsArchive(downloadableFileRecords, params.archiveName);

		return fileResponse;
	}

	// delete
	public async deleteFilesOfParent(params: FileRecordParams): Promise<FileRecordListResponse> {
		const [fileRecords, count] = await this.filesStorageService.getFileRecordsByParentAndStorageType(params.parentId);
		const parentReference = params;

		await this.checkDeletePermission([parentReference]);

		await this.deletePreviewsAndFiles(fileRecords);
		const fileRecordsWithStatus = this.filesStorageService.getFileRecordsWithStatus(fileRecords);
		const fileRecordListResponse = FileRecordMapper.mapToFileRecordListResponse(fileRecordsWithStatus, count);

		return fileRecordListResponse;
	}

	public async deleteFile(params: SingleFileParams): Promise<FileRecordResponse> {
		const fileRecord = await this.filesStorageService.getFileRecord(params.fileRecordId);
		const parentReference = fileRecord.getParentReference();

		await this.checkDeletePermission([parentReference]);

		await this.deletePreviewsAndFiles([fileRecord]);
		const status = this.filesStorageService.getFileRecordStatus(fileRecord);
		const fileRecordResponse = FileRecordMapper.mapToFileRecordResponse(fileRecord, status);

		return fileRecordResponse;
	}

	public async deleteMultipleFiles(params: MultiFileParams): Promise<FileRecordListResponse> {
		const [fileRecords, count] = await this.filesStorageService.getFileRecords(params.fileRecordIds);
		const parentReferences = FileRecord.getUniqueParentReferences(fileRecords);

		await this.checkDeletePermission(parentReferences);

		await this.deletePreviewsAndFiles(fileRecords);
		const fileRecordWithStatus = this.filesStorageService.getFileRecordsWithStatus(fileRecords);
		const fileRecordListResponse = FileRecordMapper.mapToFileRecordListResponse(fileRecordWithStatus, count);

		return fileRecordListResponse;
	}

	private async deletePreviewsAndFiles(fileRecords: FileRecord[]): Promise<void> {
		await this.previewService.deletePreviews(fileRecords);
		await this.filesStorageService.deleteFiles(fileRecords);
	}

	public async permanentlyDeleteFiles(params: MultiFileParams): Promise<FileRecordListResponse> {
		const [fileRecordsMarkedForDelete, count] = await this.filesStorageService.getFileRecordsMarkedForDelete(
			params.fileRecordIds
		);
		const parentReferences = FileRecord.getUniqueParentReferences(fileRecordsMarkedForDelete);

		await this.checkDeletePermission(parentReferences);

		await this.previewService.deletePreviews(fileRecordsMarkedForDelete);
		await this.filesStorageService.permanentlyDeleteFiles(fileRecordsMarkedForDelete);
		const fileRecordWithStatus = this.filesStorageService.getFileRecordsWithStatus(fileRecordsMarkedForDelete);
		const fileRecordListResponse = FileRecordMapper.mapToFileRecordListResponse(fileRecordWithStatus, count);

		return fileRecordListResponse;
	}

	// restore
	public async restoreMultipleFiles(params: MultiFileParams): Promise<FileRecordListResponse> {
		const [fileRecords, count] = await this.filesStorageService.getFileRecordsMarkedForDelete(params.fileRecordIds);
		const parentReferences = FileRecord.getUniqueParentReferences(fileRecords);

		await this.checkPermissions(parentReferences, FileStorageAuthorizationContext.create);

		await this.filesStorageService.restoreFiles(fileRecords);
		const fileRecordWithStatus = this.filesStorageService.getFileRecordsWithStatus(fileRecords);
		const fileRecordListResponse = FileRecordMapper.mapToFileRecordListResponse(fileRecordWithStatus, count);

		return fileRecordListResponse;
	}

	public async restoreFilesOfParent(params: FileRecordParams): Promise<FileRecordListResponse> {
		await this.checkPermission(params, FileStorageAuthorizationContext.create);

		const [fileRecords, count] = await this.filesStorageService.getFileRecordsMarkedForDeleteByParent(params.parentId);
		await this.filesStorageService.restoreFiles(fileRecords);
		const fileRecordWithStatus = this.filesStorageService.getFileRecordsWithStatus(fileRecords);
		const fileRecordListResponse = FileRecordMapper.mapToFileRecordListResponse(fileRecordWithStatus, count);

		return fileRecordListResponse;
	}

	public async restoreFile(params: SingleFileParams): Promise<FileRecordResponse> {
		const fileRecord = await this.filesStorageService.getFileRecordMarkedForDelete(params.fileRecordId);
		const parentReference = fileRecord.getParentReference();

		await this.checkPermission(parentReference, FileStorageAuthorizationContext.create);

		await this.filesStorageService.restoreFiles([fileRecord]);
		const status = this.filesStorageService.getFileRecordStatus(fileRecord);
		const fileRecordResponse = FileRecordMapper.mapToFileRecordResponse(fileRecord, status);

		return fileRecordResponse;
	}

	// copy
	public async copyFilesOfParent(
		userId: string,
		params: FileRecordParams,
		targetParams: FileRecordParams
	): Promise<Counted<CopyFileResponse[]>> {
		await Promise.all([
			this.checkPermission(params, FileStorageAuthorizationContext.create),
			this.checkPermission(targetParams, FileStorageAuthorizationContext.create),
		]);

		const [fileRecords, count] = await this.filesStorageService.getFileRecordsByParentAndStorageType(params.parentId);
		const copyFileResults = await this.filesStorageService.copyFilesToParent(userId, fileRecords, targetParams);

		return [copyFileResults, count];
	}

	public async copyFile(
		userId: string,
		params: SingleFileParams,
		targetParams: FileRecordParams
	): Promise<CopyFileResponse> {
		const fileRecord = await this.filesStorageService.getFileRecord(params.fileRecordId);
		const parentReference = fileRecord.getParentReference();

		await Promise.all([
			this.checkPermission(parentReference, FileStorageAuthorizationContext.create),
			this.checkPermission(targetParams, FileStorageAuthorizationContext.create),
		]);

		const copyFileResults = await this.filesStorageService.copyFilesToParent(userId, [fileRecord], targetParams);
		const result = copyFileResults[0];

		if (!result) {
			// This case is not possible with the current implementation. When filerecord is not found, an 404 error is thrown before.
			/* istanbul ignore next */
			throw new InternalServerErrorException(ErrorType.NO_SOURCE_FILE_RECORDS_PROVIDED);
		}

		return result;
	}

	// update
	public async moveFile(params: SingleFileParams, target: FileRecordParams): Promise<FileRecordResponse> {
		const fileRecord = await this.filesStorageService.getFileRecord(params.fileRecordId);
		const parentReference = fileRecord.getParentReference();

		// like a copy followed by a delete: the file leaves its parent and is added to the target
		await Promise.all([
			this.checkPermission(parentReference, FileStorageAuthorizationContext.delete),
			this.checkPermission(target, FileStorageAuthorizationContext.create),
		]);

		const movedFileRecord = await this.filesStorageService.moveFileRecord(fileRecord, target);
		const status = this.filesStorageService.getFileRecordStatus(movedFileRecord);

		return FileRecordMapper.mapToFileRecordResponse(movedFileRecord, status);
	}

	public async patchFilename(params: SingleFileParams, data: RenameFileParams): Promise<FileRecordResponse> {
		const fileRecord = await this.filesStorageService.getFileRecord(params.fileRecordId);
		const parentReference = fileRecord.getParentReference();

		await this.checkPermission(parentReference, FileStorageAuthorizationContext.update);

		const modifiedFileRecord = await this.filesStorageService.patchFilename(fileRecord, data.fileName);
		const status = this.filesStorageService.getFileRecordStatus(modifiedFileRecord);
		const fileRecordResponse = FileRecordMapper.mapToFileRecordResponse(modifiedFileRecord, status);

		return fileRecordResponse;
	}

	public async updateSecurityStatus(token: string, scanResultParams: ScanResultParams): Promise<void> {
		/*************************************
		 * Atm no authorisation is possible. *
		 *************************************/
		await this.filesStorageService.updateSecurityStatus(token, scanResultParams);
	}

	// get
	public async getFileRecord(params: SingleFileParams): Promise<FileRecordResponse> {
		const fileRecord = await this.filesStorageService.getFileRecord(params.fileRecordId);
		const parentReference = fileRecord.getParentReference();

		await this.checkPermission(parentReference, FileStorageAuthorizationContext.read);

		const status = this.filesStorageService.getFileRecordStatus(fileRecord);
		const fileRecordResponse = FileRecordMapper.mapToFileRecordResponse(fileRecord, status);

		return fileRecordResponse;
	}

	public async getFileRecordsOfParent(
		params: FileRecordParams,
		pagination: PaginationParams
	): Promise<FileRecordListResponse> {
		await this.checkPermission(params, FileStorageAuthorizationContext.read);

		const [fileRecords, count] = await this.filesStorageService.getFileRecordsByParentAndStorageType(
			params.parentId,
			undefined,
			{ pagination }
		);
		const fileRecordWithStatus = this.filesStorageService.getFileRecordsWithStatus(fileRecords);
		const fileRecordListResponse = FileRecordMapper.mapToFileRecordListResponse(
			fileRecordWithStatus,
			count,
			pagination
		);

		return fileRecordListResponse;
	}

	public async getDeletedFileRecordsOfParent(
		params: FileRecordParams,
		pagination: PaginationParams
	): Promise<FileRecordListResponse> {
		await this.checkPermission(params, FileStorageAuthorizationContext.create);

		const [fileRecords, count] = await this.filesStorageService.getFileRecordsMarkedForDeleteByParent(params.parentId, {
			pagination,
		});
		const fileRecordWithStatus = this.filesStorageService.getFileRecordsWithStatus(fileRecords);
		const fileRecordListResponse = FileRecordMapper.mapToFileRecordListResponse(
			fileRecordWithStatus,
			count,
			pagination
		);

		return fileRecordListResponse;
	}

	// statistics
	public async getParentStatistic(params: ParentParams): Promise<ParentStatisticResponse> {
		await this.checkPermission(params, FileStorageAuthorizationContext.read);

		const parentStatistic = await this.filesStorageService.getParentStatistic(params.parentId);
		const parentStatisticResponse = ParentStatisticMapper.toParentStatisticResponse(parentStatistic);

		return parentStatisticResponse;
	}

	private checkContentLength(req: Request): void {
		const requestContentLength = req.headers['content-length'];
		if (!requestContentLength) return;

		const contentLength = Number.parseInt(requestContentLength, 10);
		if (contentLength !== undefined && contentLength > this.config.filesStorageMaxFileSize) {
			throw new PayloadTooLargeException(ErrorType.FILE_TOO_BIG);
		}
	}

	private uploadFileWithBusboy(
		userId: EntityId,
		params: FileRecordParams,
		req: AbortableRequest,
		storageType: StorageType
	): Promise<FileRecord> {
		return new Promise<FileRecord>((resolve, reject) => {
			const bb = busboy({ headers: req.headers, defParamCharset: 'utf8', highWaterMark: DEFAULT_CHUNK_SIZE });
			const abortController = new AbortController();
			let fileRecordPromise: Promise<FileRecord> | undefined;
			let isResolved = false;

			const cleanup = (): void => {
				req.unpipe(bb);
			};

			const safeReject = (error: Error): void => {
				if (!isResolved) {
					isResolved = true;
					cleanup();
					reject(error);
				}
			};

			const safeResolve = (result: FileRecord): void => {
				if (!isResolved) {
					isResolved = true;
					cleanup();
					resolve(result);
				}
			};

			// Listen for timeout signal from TimeoutInterceptor
			const timeoutAbortController = req.abortController;
			if (timeoutAbortController) {
				timeoutAbortController.signal.addEventListener('abort', () => {
					abortController.abort();
					this.logger.warning(new UploadAbortLoggable('Upload request was aborted due to timeout', 'request_timeout'));
					safeReject(new Error('Request timed out during upload processing'));
				});
			}

			req.on('close', () => {
				if (!req.complete) {
					abortController.abort();
					this.logger.warning(
						new UploadAbortLoggable('Upload request was closed prematurely by client', 'request_closed')
					);
					safeReject(new Error('Request closed prematurely'));
				}
			});

			req.on('aborted', () => {
				abortController.abort();
				this.logger.warning(new UploadAbortLoggable('Upload request was aborted by client', 'request_aborted'));
				safeReject(new Error('Request aborted by client'));
			});

			bb.on('file', (_name, file, info) => {
				if (isResolved) return; // Already resolved/rejected

				const fileDto = FileDtoMapper.mapFromBusboyFileInfo(info, file, storageType, abortController.signal);

				fileRecordPromise = RequestContext.create(this.em, () => {
					return this.filesStorageService.uploadFile(userId, params, fileDto);
				});

				// Handle upload errors immediately
				fileRecordPromise.catch((error) => {
					safeReject(error);
				});
			});

			bb.on('finish', async () => {
				if (isResolved) return;

				if (fileRecordPromise instanceof Promise) {
					try {
						const fileRecord = await fileRecordPromise;
						safeResolve(fileRecord);
					} catch (error) {
						safeReject(error);
					}
				} else {
					safeReject(new Error('No file provided'));
				}
			});

			req.pipe(bb);
		});
	}

	private async getResponse(
		params: FileRecordParams & FileUrlParams
	): Promise<AxiosResponse<internal.Readable, unknown>> {
		const config: AxiosRequestConfig = {
			headers: params.headers,
			responseType: 'stream',
		};

		const encodedUrl = this.ensureEncodedUrl(params.url);

		try {
			const responseStream = this.httpService.get<internal.Readable>(encodedUrl, config);

			const response = await firstValueFrom(responseStream);

			/* istanbul ignore next */
			response.data.on('error', (error) => {
				this.domainErrorHandler.exec(error);
			});

			return response;
		} catch (error) {
			throw new NotFoundException(ErrorType.FILE_NOT_FOUND, { cause: error });
		}
	}

	private ensureEncodedUrl(url: string): string {
		const containsEncodedCharacters = (url: string): boolean => {
			return /%[0-9A-Fa-f]{2}/.test(url);
		};

		const encodedUrl = containsEncodedCharacters(url) ? url : encodeURI(url);

		return encodedUrl;
	}

	// private: permission checks
	private async checkPermission(parentReference: ParentReference, context: AuthorizationContextParams): Promise<void> {
		const { parentType, parentId } = parentReference;
		const referenceType = FilesStorageMapper.mapToAllowedAuthorizationEntityType(parentType);

		await this.authorizationClientAdapter.checkPermissionsByReference(referenceType, parentId, context);
	}

	private async checkPermissions(
		parentReference: ParentReference[],
		context: AuthorizationContextParams
	): Promise<void> {
		const references = parentReference.map((info) => {
			const { parentType, parentId } = info;
			const referenceType = FilesStorageMapper.mapToAllowedAuthorizationEntityType(parentType);

			return { referenceType, referenceId: parentId, context };
		});

		await this.authorizationClientAdapter.checkPermissionsByManyReferences({ references });
	}

	private async checkDeletePermission(parentReference: ParentReference[]): Promise<void> {
		await this.checkPermissions(parentReference, FileStorageAuthorizationContext.delete);
	}

	private async checkStorageLocationCanRead(
		storageLocation: StorageLocation,
		storageLocationId: EntityId
	): Promise<void> {
		const referenceType = FilesStorageMapper.mapToAllowedStorageLocationType(storageLocation);
		await this.authorizationClientAdapter.checkPermissionsByReference(
			referenceType,
			storageLocationId,
			AuthorizationContextBuilder.read([])
		);
	}
}

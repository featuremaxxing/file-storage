import { CurrentUser, ICurrentUser, JwtAuthentication } from '@infra/auth-guard';
import { RequestLoggingInterceptor } from '@infra/core/interceptor';
import { ApiValidationError } from '@infra/error';
import { CurrentDownloadMetricsInterceptor, CurrentUploadMetricsInterceptor } from '@infra/metrics';
import {
	BadRequestException,
	Body,
	ConflictException,
	Controller,
	Delete,
	ForbiddenException,
	Get,
	Headers,
	HttpStatus,
	InternalServerErrorException,
	NotAcceptableException,
	NotFoundException,
	Param,
	Patch,
	Post,
	Query,
	Req,
	Res,
	StreamableFile,
	UnprocessableEntityException,
	UseInterceptors,
} from '@nestjs/common';
import { ApiConsumes, ApiHeader, ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequestTimeout } from '@shared/decorator';
import { Request, Response } from 'express';
import { GetFileResponse } from '../../domain';
import {
	INCOMING_REQUEST_TIMEOUT_COPY_API_KEY,
	INCOMING_REQUEST_TIMEOUT_DELETE_API_KEY,
} from '../../files-storage.config';
import {
	AddDocumentToParentParams,
	ArchiveFileParams,
	CopyFileListResponse,
	CopyFileParams,
	CopyFileResponse,
	DownloadFileParams,
	FileParams,
	FileRecordListResponse,
	FileRecordParams,
	FileRecordResponse,
	FileUrlParams,
	MultiFileParams,
	PaginationParams,
	ParentParams,
	ParentStatisticResponse,
	PreviewParams,
	MoveFileParams,
	RenameFileParams,
	SingleFileParams,
} from '../dto';
import { StreamableFileMapper } from '../mapper';
import { FilesStorageUC } from '../uc';

@ApiTags('file')
@JwtAuthentication()
@Controller('file')
export class FilesStorageController {
	constructor(private readonly filesStorageUC: FilesStorageUC) {}

	@ApiOperation({ summary: 'Upload file from url' })
	@ApiResponse({ status: 201, type: FileRecordResponse })
	@ApiResponse({ status: 400, type: ApiValidationError })
	@ApiResponse({ status: 400, type: BadRequestException })
	@ApiResponse({ status: 403, type: ForbiddenException })
	@ApiResponse({ status: 500, type: InternalServerErrorException })
	@Post('/upload-from-url/:storageLocation/:storageLocationId/:parentType/:parentId')
	public async uploadFromUrl(
		@Body() body: FileUrlParams,
		@Param() params: FileRecordParams,
		@CurrentUser() currentUser: ICurrentUser
	): Promise<FileRecordResponse> {
		const response = await this.filesStorageUC.uploadFromUrl(currentUser.userId, { ...body, ...params });

		return response;
	}

	@ApiOperation({ summary: 'Add document to parent' })
	@ApiResponse({ status: 201, type: FileRecordResponse })
	@ApiResponse({ status: 400, type: ApiValidationError })
	@ApiResponse({ status: 400, type: BadRequestException })
	@ApiResponse({ status: 403, type: ForbiddenException })
	@ApiResponse({ status: 500, type: InternalServerErrorException })
	@Post('/add-document-to-parent/:storageLocation/:storageLocationId/:parentType/:parentId')
	public async addDocumentToParent(
		@Body() body: AddDocumentToParentParams,
		@Param() params: FileRecordParams,
		@CurrentUser() currentUser: ICurrentUser
	): Promise<FileRecordResponse> {
		const response = await this.filesStorageUC.addDocumentToParent(currentUser.userId, { ...body, ...params });

		return response;
	}

	@ApiOperation({ summary: 'Streamable upload of a binary file.' })
	@ApiResponse({ status: 201, type: FileRecordResponse })
	@ApiResponse({ status: 400, type: ApiValidationError })
	@ApiResponse({ status: 400, type: BadRequestException })
	@ApiResponse({ status: 403, type: ForbiddenException })
	@ApiResponse({ status: 500, type: InternalServerErrorException })
	@ApiConsumes('multipart/form-data')
	@UseInterceptors(CurrentUploadMetricsInterceptor)
	@Post('/upload/:storageLocation/:storageLocationId/:parentType/:parentId')
	public async upload(
		@Body() _: FileParams,
		@Param() params: FileRecordParams,
		@CurrentUser() currentUser: ICurrentUser,
		@Req() req: Request
	): Promise<FileRecordResponse> {
		const response = await this.filesStorageUC.upload(currentUser.userId, params, req);

		return response;
	}

	@ApiOperation({ summary: 'Temporary upload of a file.' })
	@ApiResponse({ status: 201, type: FileRecordResponse })
	@ApiResponse({ status: 400, type: ApiValidationError })
	@ApiResponse({ status: 400, type: BadRequestException })
	@ApiResponse({ status: 403, type: ForbiddenException })
	@ApiResponse({ status: 500, type: InternalServerErrorException })
	@ApiConsumes('multipart/form-data')
	@UseInterceptors(CurrentUploadMetricsInterceptor)
	@Post('/temp/upload/:storageLocation/:storageLocationId/:parentType/:parentId')
	public async tempUpload(
		@Body() _: FileParams,
		@Param() params: FileRecordParams,
		@CurrentUser() currentUser: ICurrentUser,
		@Req() req: Request
	): Promise<FileRecordResponse> {
		const response = await this.filesStorageUC.tempUpload(currentUser.userId, params, req);

		return response;
	}

	@ApiOperation({ summary: 'Streamable download of a binary file.' })
	@ApiProduces('application/octet-stream')
	@ApiResponse({
		status: 200,
		schema: { type: 'string', format: 'binary' },
	})
	@ApiResponse({
		status: 206,
		schema: { type: 'string', format: 'binary' },
	})
	@ApiResponse({ status: 400, type: ApiValidationError })
	@ApiResponse({ status: 403, type: ForbiddenException })
	@ApiResponse({ status: 404, type: NotFoundException })
	@ApiResponse({ status: 406, type: NotAcceptableException })
	@ApiResponse({ status: 500, type: InternalServerErrorException })
	@ApiHeader({ name: 'Range', required: false })
	@UseInterceptors(CurrentDownloadMetricsInterceptor)
	@Get('/download/:fileRecordId/:fileName')
	public async download(
		@Param() params: DownloadFileParams,
		@Req() req: Request,
		@Res({ passthrough: true }) response: Response,
		@Headers('Range') bytesRange?: string
	): Promise<StreamableFile> {
		const fileResponse = await this.filesStorageUC.download(params, bytesRange);

		const streamableFile = this.streamFileToClient(req, fileResponse, response, bytesRange);

		return streamableFile;
	}

	@ApiOperation({ summary: 'Streamable download of a preview file.' })
	@ApiResponse({ status: 200, type: StreamableFile })
	@ApiResponse({ status: 206, type: StreamableFile })
	@ApiResponse({ status: 304, description: 'Not Modified' })
	@ApiResponse({ status: 400, type: ApiValidationError })
	@ApiResponse({ status: 403, type: ForbiddenException })
	@ApiResponse({ status: 404, type: NotFoundException })
	@ApiResponse({ status: 422, type: UnprocessableEntityException })
	@ApiResponse({ status: 500, type: InternalServerErrorException })
	@ApiHeader({ name: 'Range', required: false })
	@ApiHeader({ name: 'If-None-Match', required: false })
	@UseInterceptors(CurrentDownloadMetricsInterceptor)
	@Get('/preview/:fileRecordId/:fileName')
	public async downloadPreview(
		@Param() params: DownloadFileParams,
		@Query() previewParams: PreviewParams,
		@Req() req: Request,
		@Res({ passthrough: true }) response: Response,
		@Headers('Range') bytesRange?: string,
		@Headers('If-None-Match') etag?: string
	): Promise<StreamableFile | void> {
		const fileResponse = await this.filesStorageUC.downloadPreview(params, previewParams, bytesRange);

		response.set({ ETag: fileResponse.etag });

		if (etag === fileResponse.etag) {
			response.status(HttpStatus.NOT_MODIFIED);

			const encodedFileName = encodeURIComponent(fileResponse.name);
			response.set({
				'Content-Disposition': `attachment; filename="${encodedFileName}"; filename*=UTF-8''${encodedFileName}`,
			});

			return undefined;
		}

		const streamableFile = this.streamFileToClient(req, fileResponse, response, bytesRange);

		return streamableFile;
	}

	@ApiOperation({ summary: 'Download multiple files as a zip' })
	@ApiResponse({
		status: 200,
		schema: { type: 'string', format: 'binary' },
	})
	@ApiResponse({
		status: 206,
		schema: { type: 'string', format: 'binary' },
	})
	@ApiResponse({ status: 400, type: ApiValidationError })
	@ApiResponse({ status: 403, type: ForbiddenException })
	@ApiResponse({ status: 500, type: InternalServerErrorException })
	@ApiHeader({ name: 'Range', required: false })
	@Post('/download-files-as-archive')
	@UseInterceptors(CurrentDownloadMetricsInterceptor)
	@UseInterceptors(RequestLoggingInterceptor)
	public async downloadFilesAsArchive(
		@Body() params: ArchiveFileParams,
		@Req() req: Request,
		@Res({ passthrough: true }) response: Response
	): Promise<StreamableFile | void> {
		const data = await this.filesStorageUC.downloadFilesOfParentAsArchive(params);

		const streamableFile = this.streamFileToClient(req, data, response);

		return streamableFile;
	}

	private streamFileToClient(
		req: Request,
		fileResponse: GetFileResponse,
		httpResponse: Response,
		bytesRange?: string
	): StreamableFile {
		req.on('close', () => fileResponse.data.destroy());

		// If bytes range has been defined, set Accept-Ranges and Content-Range HTTP headers
		// in a response and also set 206 Partial Content HTTP status code to inform the caller
		// about the partial data stream. Otherwise, just set a 200 OK HTTP status code.
		if (bytesRange) {
			httpResponse.set({
				'Accept-Ranges': 'bytes',
				'Content-Range': fileResponse.contentRange,
			});

			httpResponse.status(HttpStatus.PARTIAL_CONTENT);
		} else {
			httpResponse.status(HttpStatus.OK);
		}

		const streamableFile = StreamableFileMapper.fromResponse(fileResponse);

		return streamableFile;
	}

	@ApiOperation({ summary: 'Get file record meta data by file record id.' })
	@ApiResponse({ status: 200, type: FileRecordResponse })
	@ApiResponse({ status: 400, type: ApiValidationError })
	@ApiResponse({ status: 403, type: ForbiddenException })
	@ApiResponse({ status: 404, type: NotFoundException })
	@Get('/:fileRecordId')
	public async getFileRecord(@Param() params: SingleFileParams): Promise<FileRecordResponse> {
		const response = await this.filesStorageUC.getFileRecord(params);

		return response;
	}

	@ApiOperation({ summary: 'Get a list of file meta data by parent entityId. Excludes temporary and deleted files.' })
	@ApiResponse({ status: 200, type: FileRecordListResponse })
	@ApiResponse({ status: 400, type: ApiValidationError })
	@ApiResponse({ status: 403, type: ForbiddenException })
	@Get('/list/:storageLocation/:storageLocationId/:parentType/:parentId')
	public async list(
		@Param() params: FileRecordParams,
		@Query() pagination: PaginationParams
	): Promise<FileRecordListResponse> {
		const response = await this.filesStorageUC.getFileRecordsOfParent(params, pagination);

		return response;
	}

	@ApiOperation({ summary: 'Get a list of deleted file meta data by parent entityId.' })
	@ApiResponse({ status: 200, type: FileRecordListResponse })
	@ApiResponse({ status: 400, type: ApiValidationError })
	@ApiResponse({ status: 403, type: ForbiddenException })
	@Get('/list-deleted/:storageLocation/:storageLocationId/:parentType/:parentId')
	public async listDeleted(
		@Param() params: FileRecordParams,
		@Query() pagination: PaginationParams
	): Promise<FileRecordListResponse> {
		const response = await this.filesStorageUC.getDeletedFileRecordsOfParent(params, pagination);

		return response;
	}

	@ApiOperation({
		summary: 'Move a single file to another parent in the same storage location. The file keeps its id.',
	})
	@ApiResponse({ status: 200, type: FileRecordResponse })
	@ApiResponse({ status: 400, type: ApiValidationError })
	@ApiResponse({ status: 403, type: ForbiddenException })
	@ApiResponse({ status: 404, type: NotFoundException })
	@Patch('/move/:fileRecordId/')
	@UseInterceptors(RequestLoggingInterceptor)
	public async moveFile(
		@Param() params: SingleFileParams,
		@Body() moveFileParams: MoveFileParams
	): Promise<FileRecordResponse> {
		const response = await this.filesStorageUC.moveFile(params, moveFileParams.target);

		return response;
	}

	@ApiOperation({ summary: 'Rename a single file.' })
	@ApiResponse({ status: 200, type: FileRecordResponse })
	@ApiResponse({ status: 400, type: ApiValidationError })
	@ApiResponse({ status: 403, type: ForbiddenException })
	@ApiResponse({ status: 404, type: NotFoundException })
	@ApiResponse({
		status: 409,
		type: ConflictException,
		description: 'File with same name already exist in parent scope.',
	})
	@Patch('/rename/:fileRecordId/')
	@UseInterceptors(RequestLoggingInterceptor)
	public async patchFilename(
		@Param() params: SingleFileParams,
		@Body() renameFileParam: RenameFileParams
	): Promise<FileRecordResponse> {
		const response = await this.filesStorageUC.patchFilename(params, renameFileParam);

		return response;
	}

	@ApiOperation({
		summary:
			'Mark all files of a parent entityId for deletion. The files are permanently deleted after a certain time.',
	})
	@ApiResponse({ status: 200, type: FileRecordListResponse })
	@ApiResponse({ status: 400, type: ApiValidationError })
	@ApiResponse({ status: 403, type: ForbiddenException })
	@ApiResponse({ status: 500, type: InternalServerErrorException })
	@RequestTimeout(INCOMING_REQUEST_TIMEOUT_DELETE_API_KEY)
	@Delete('/delete/:storageLocation/:storageLocationId/:parentType/:parentId')
	@UseInterceptors(RequestLoggingInterceptor)
	public async deleteByParent(@Param() params: FileRecordParams): Promise<FileRecordListResponse> {
		const response = await this.filesStorageUC.deleteFilesOfParent(params);

		return response;
	}

	@ApiOperation({ summary: 'Mark a single file for deletion. The file is permanently deleted after a certain time.' })
	@ApiResponse({ status: 200, type: FileRecordResponse })
	@ApiResponse({ status: 400, type: ApiValidationError })
	@ApiResponse({ status: 403, type: ForbiddenException })
	@ApiResponse({ status: 500, type: InternalServerErrorException })
	@RequestTimeout(INCOMING_REQUEST_TIMEOUT_DELETE_API_KEY)
	@Delete('/delete/:fileRecordId')
	@UseInterceptors(RequestLoggingInterceptor)
	public async deleteFile(@Param() params: SingleFileParams): Promise<FileRecordResponse> {
		const response = await this.filesStorageUC.deleteFile(params);

		return response;
	}

	@ApiOperation({ summary: 'Mark several files for deletion. The files are permanently deleted after a certain time.' })
	@ApiResponse({ status: 200, type: FileRecordListResponse })
	@ApiResponse({ status: 400, type: ApiValidationError })
	@ApiResponse({ status: 403, type: ForbiddenException })
	@ApiResponse({ status: 500, type: InternalServerErrorException })
	@RequestTimeout(INCOMING_REQUEST_TIMEOUT_DELETE_API_KEY)
	@Delete('/delete')
	@UseInterceptors(RequestLoggingInterceptor)
	public async deleteFiles(@Body() params: MultiFileParams): Promise<FileRecordListResponse> {
		const response = await this.filesStorageUC.deleteMultipleFiles(params);

		return response;
	}

	@ApiOperation({
		summary:
			'Permanently delete files that are already marked for deletion (in trash). Files must be soft-deleted before calling this endpoint.',
	})
	@ApiResponse({ status: 200, type: FileRecordListResponse })
	@ApiResponse({ status: 400, type: ApiValidationError })
	@ApiResponse({ status: 403, type: ForbiddenException })
	@ApiResponse({ status: 500, type: InternalServerErrorException })
	@Delete('/purge')
	@UseInterceptors(RequestLoggingInterceptor)
	public async purgeFiles(@Body() params: MultiFileParams): Promise<FileRecordListResponse> {
		const response = await this.filesStorageUC.permanentlyDeleteFiles(params);

		return response;
	}

	@ApiOperation({ summary: 'Restore all files of a parent entityId that are marked for deletion.' })
	@ApiResponse({ status: 201, type: FileRecordListResponse })
	@ApiResponse({ status: 400, type: ApiValidationError })
	@ApiResponse({ status: 403, type: ForbiddenException })
	@Post('/restore/:storageLocation/:storageLocationId/:parentType/:parentId')
	public async restore(@Param() params: FileRecordParams): Promise<FileRecordListResponse> {
		const response = await this.filesStorageUC.restoreFilesOfParent(params);

		return response;
	}

	@ApiOperation({ summary: 'Restore a single file that is marked for deletion.' })
	@ApiResponse({ status: 201, type: FileRecordResponse })
	@ApiResponse({ status: 400, type: ApiValidationError })
	@ApiResponse({ status: 403, type: ForbiddenException })
	@Post('/restore/:fileRecordId')
	public async restoreFile(@Param() params: SingleFileParams): Promise<FileRecordResponse> {
		const response = await this.filesStorageUC.restoreFile(params);

		return response;
	}

	@ApiOperation({ summary: 'Restore several files that are marked for deletion.' })
	@ApiResponse({ status: 201, type: FileRecordListResponse })
	@ApiResponse({ status: 400, type: ApiValidationError })
	@ApiResponse({ status: 403, type: ForbiddenException })
	@Post('/restore')
	public async restoreFiles(@Body() params: MultiFileParams): Promise<FileRecordListResponse> {
		const response = await this.filesStorageUC.restoreMultipleFiles(params);

		return response;
	}

	@ApiOperation({ summary: 'Copy all files of a parent entityId to a target entityId' })
	@ApiResponse({ status: 201, type: CopyFileListResponse })
	@ApiResponse({ status: 400, type: ApiValidationError })
	@ApiResponse({ status: 403, type: ForbiddenException })
	@ApiResponse({ status: 500, type: InternalServerErrorException })
	@RequestTimeout(INCOMING_REQUEST_TIMEOUT_COPY_API_KEY)
	@Post('/copy/:storageLocation/:storageLocationId/:parentType/:parentId')
	public async copy(
		@Param() params: FileRecordParams,
		@Body() copyFilesParam: CopyFileParams,
		@CurrentUser() currentUser: ICurrentUser
	): Promise<CopyFileListResponse> {
		const [response, count] = await this.filesStorageUC.copyFilesOfParent(
			currentUser.userId,
			params,
			copyFilesParam.target
		);

		return new CopyFileListResponse(response, count);
	}

	@ApiOperation({ summary: 'Copy a single file in the same target entityId scope.' })
	@ApiResponse({ status: 201, type: FileRecordResponse })
	@ApiResponse({ status: 400, type: ApiValidationError })
	@ApiResponse({ status: 403, type: ForbiddenException })
	@ApiResponse({ status: 404, type: NotFoundException })
	@ApiResponse({ status: 500, type: InternalServerErrorException })
	@Post('/copy/:fileRecordId')
	public async copyFile(
		@Param() params: SingleFileParams,
		@Body() copyFileParam: CopyFileParams,
		@CurrentUser() currentUser: ICurrentUser
	): Promise<CopyFileResponse> {
		const response = await this.filesStorageUC.copyFile(currentUser.userId, params, copyFileParam.target);

		return response;
	}

	@ApiOperation({
		summary: 'Get stats (count and total size) of files for a parent entityId. Excludes temporary and deleted files.',
	})
	@ApiResponse({ status: 200, type: ParentStatisticResponse })
	@ApiResponse({ status: 400, type: ApiValidationError })
	@ApiResponse({ status: 403, type: ForbiddenException })
	@Get('/stats/:parentType/:parentId')
	public async getParentStatistic(@Param() params: ParentParams): Promise<ParentStatisticResponse> {
		const fileStatsResponse = await this.filesStorageUC.getParentStatistic(params);

		return fileStatsResponse;
	}
}

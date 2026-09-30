import { type Logger } from '@infra/logger';
import archiver from 'archiver';
import { type FileRecord } from '../file-record.do';
import { type GetFileResponse } from '../interface';
import { CreateArchiveLoggable } from '../loggable';

export class ArchiveFactory {
	public static create(
		fileResponses: GetFileResponse[],
		fileRecords: FileRecord[],
		logger: Logger,
		archiveType: archiver.Format = 'zip'
	): archiver.Archiver {
		const archive = this.createEmpty(fileRecords, logger, archiveType);

		for (const fileResponse of fileResponses) {
			this.appendFile(archive, fileResponse);
		}

		archive.finalize();

		return archive;
	}

	public static createEmpty(
		fileRecords: FileRecord[],
		logger: Logger,
		archiveType: archiver.Format = 'zip'
	): archiver.Archiver {
		const archive = archiver(archiveType);

		archive.on('warning', (err) => {
			if (err.code === 'ENOENT') {
				this.logWarning(fileRecords, logger);
			} else {
				logger.warning(new CreateArchiveLoggable('Warning while creating archive', 'createArchive', fileRecords, err));
			}
		});

		archive.on('error', (err) => {
			logger.warning(new CreateArchiveLoggable('Error while creating archive', 'createArchive', fileRecords, err));
			if (!archive.destroyed) {
				archive.destroy(err);
			}
		});

		archive.on('close', () => {
			this.logClose(fileRecords, logger);
		});

		return archive;
	}

	public static appendFile(archive: archiver.Archiver, fileResponse: GetFileResponse, archivePath?: string): void {
		fileResponse.data.once('error', (err: unknown) => {
			const normalizedError = this.toError(err);

			if (typeof fileResponse.data.destroy === 'function') {
				fileResponse.data.destroy(normalizedError);
			}

			archive.abort();
			archive.emit('error', normalizedError);
		});
		archive.append(fileResponse.data, { name: archivePath ?? fileResponse.name });
	}

	private static toError(err: unknown): Error {
		if (err instanceof Error) {
			return err;
		}

		if (typeof err === 'string') {
			return new Error(err);
		}

		return new Error(`Non-Error thrown:`, { cause: err });
	}

	private static logWarning(fileRecords: FileRecord[], logger: Logger): void {
		logger.warning(new CreateArchiveLoggable('Warning while creating archive', 'createArchive', fileRecords));
	}

	private static logClose(fileRecords: FileRecord[], logger: Logger): void {
		logger.debug(new CreateArchiveLoggable('Archive created', 'createArchive', fileRecords));
	}
}

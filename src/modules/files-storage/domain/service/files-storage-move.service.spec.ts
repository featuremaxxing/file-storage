import { createMock, type DeepMocked } from '@golevelup/ts-jest';
import { AntivirusService } from '@infra/antivirus';
import { DomainErrorHandler } from '@infra/error';
import { Logger } from '@infra/logger';
import { type S3ClientAdapter } from '@infra/s3-client';
import { ObjectId } from '@mikro-orm/mongodb';
import { BadRequestException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import {
	FILE_STORAGE_CONFIG_TOKEN,
	FILES_STORAGE_S3_CONNECTION,
	type FileStorageConfig,
} from '../../files-storage.config';
import { fileRecordTestFactory } from '../../testing';
import { FILE_RECORD_REPO, type FileRecordRepo } from '../contract';
import { ErrorType } from '../error';
import { FileRecordParentType } from '../interface/file-record-parent-type.enum';
import { StorageLocation } from '../interface/storage-location.enum';
import { FilesStorageService } from './files-storage.service';

describe('FilesStorageService moveFileRecord', () => {
	let module: TestingModule;
	let service: FilesStorageService;
	let fileRecordRepo: DeepMocked<FileRecordRepo>;

	beforeAll(async () => {
		module = await Test.createTestingModule({
			providers: [
				FilesStorageService,
				{ provide: FILES_STORAGE_S3_CONNECTION, useValue: createMock<S3ClientAdapter>() },
				{ provide: FILE_RECORD_REPO, useValue: createMock<FileRecordRepo>() },
				{ provide: Logger, useValue: createMock<Logger>() },
				{ provide: AntivirusService, useValue: createMock<AntivirusService>() },
				{
					provide: FILE_STORAGE_CONFIG_TOKEN,
					useValue: createMock<FileStorageConfig>({ filesStorageMaxFilesPerParent: 1000 }),
				},
				{ provide: DomainErrorHandler, useValue: createMock<DomainErrorHandler>() },
			],
		}).compile();

		service = module.get(FilesStorageService);
		fileRecordRepo = module.get(FILE_RECORD_REPO);
	});

	beforeEach(() => {
		jest.resetAllMocks();
	});

	afterAll(async () => {
		await module.close();
	});

	const setup = (namesInTarget: string[] = []) => {
		const storageLocationId = new ObjectId().toHexString();
		const fileRecord = fileRecordTestFactory().build({
			storageLocationId,
			storageLocation: StorageLocation.SCHOOL,
			parentId: new ObjectId().toHexString(),
			parentType: FileRecordParentType.BoardNode,
			name: 'aufgabe.pdf',
		});
		const target = {
			storageLocationId,
			storageLocation: StorageLocation.SCHOOL,
			parentId: new ObjectId().toHexString(),
			parentType: FileRecordParentType.BoardNode,
		};
		const filesInTarget = namesInTarget.map((name) =>
			fileRecordTestFactory().build({ storageLocationId, parentId: target.parentId, name })
		);
		jest
			.spyOn(service, 'getFileRecordsByParentAndStorageType')
			.mockResolvedValue([filesInTarget, filesInTarget.length]);

		return { fileRecord, target, originalId: fileRecord.id };
	};

	it('should give the file its new parent and keep its id', async () => {
		const { fileRecord, target, originalId } = setup();

		const result = await service.moveFileRecord(fileRecord, target);

		expect(result.id).toEqual(originalId);
		expect(result.getParentReference()).toEqual({ parentId: target.parentId, parentType: target.parentType });
		expect(fileRecordRepo.save).toHaveBeenCalledWith(fileRecord);
	});

	it('should rename the file when the target already has one with that name', async () => {
		const { fileRecord, target } = setup(['aufgabe.pdf']);

		const result = await service.moveFileRecord(fileRecord, target);

		expect(result.getName()).toEqual('aufgabe (1).pdf');
	});

	it('should refuse another storage location', async () => {
		const { fileRecord, target } = setup();

		await expect(
			service.moveFileRecord(fileRecord, { ...target, storageLocationId: new ObjectId().toHexString() })
		).rejects.toThrow(new BadRequestException(ErrorType.MOVE_TO_OTHER_STORAGE_LOCATION));
		expect(fileRecordRepo.save).not.toHaveBeenCalled();
	});

	it('should do nothing when the parent stays the same', async () => {
		const { fileRecord, target } = setup();
		const sameParent = { ...target, parentId: fileRecord.getParentReference().parentId };

		await service.moveFileRecord(fileRecord, sameParent);

		expect(fileRecordRepo.save).not.toHaveBeenCalled();
	});
});

import { EntityManager, EntityName, ObjectId, Utils } from '@mikro-orm/mongodb';
import { Injectable } from '@nestjs/common';
import { FindOptions, SortOrder } from '@shared/domain/interface';
import { Counted, EntityId } from '@shared/domain/types';
import {
	FileRecord,
	FileRecordRepo,
	ParentStatistic,
	ParentStatisticFactory,
	StorageLocation,
	StorageType,
} from '../domain';
import { FileRecordScope } from './file-record-scope';
import { FileRecordEntity } from './file-record.entity';
import { FileRecordEntityMapper } from './mapper';

@Injectable()
export class FileRecordMikroOrmRepo implements FileRecordRepo {
	constructor(private readonly em: EntityManager) {}

	get entityName(): EntityName<FileRecordEntity> {
		return FileRecordEntity;
	}

	public async findOneById(id: EntityId): Promise<FileRecord> {
		const scope = new FileRecordScope().byFileRecordId(id).byMarkedForDelete(false);
		const fileRecord = await this.findOneOrFail(scope);

		return fileRecord;
	}

	public async findMultipleById(
		ids: EntityId[],
		options?: FindOptions<FileRecordEntity>
	): Promise<Counted<FileRecord[]>> {
		const scope = new FileRecordScope().byFileRecordIds(ids).byMarkedForDelete(false);
		const result = await this.findAndCount(scope, options);

		return result;
	}

	public async findOneByIdMarkedForDelete(id: EntityId): Promise<FileRecord> {
		const scope = new FileRecordScope().byFileRecordId(id).byMarkedForDelete(true);
		const fileRecord = await this.findOneOrFail(scope);

		return fileRecord;
	}

	public async findMultipleByIdMarkedForDelete(
		ids: EntityId[],
		options?: FindOptions<FileRecordEntity>
	): Promise<Counted<FileRecord[]>> {
		const scope = new FileRecordScope().byFileRecordIds(ids).byMarkedForDelete(true);
		const result = await this.findAndCount(scope, options);

		return result;
	}

	public async findByParentId(
		parentId: EntityId,
		options?: FindOptions<FileRecordEntity>,
		storageType?: StorageType
	): Promise<Counted<FileRecord[]>> {
		const scope = new FileRecordScope().byParentId(parentId).byMarkedForDelete(false).byStorageType(storageType);
		const result = await this.findAndCount(scope, options);

		return result;
	}

	public async findByParentAndFolderId(
		parentId: EntityId,
		folderId?: EntityId | null,
		options?: FindOptions<FileRecordEntity>
	): Promise<Counted<FileRecord[]>> {
		const scope = new FileRecordScope()
			.byParentId(parentId)
			.byFolderId(folderId)
			.byMarkedForDelete(false)
			.byStorageType();
		const result = await this.findAndCount(scope, options);

		return result;
	}

	public async findMarkedForDeleteByParentId(
		parentId: EntityId,
		options?: FindOptions<FileRecordEntity>
	): Promise<Counted<FileRecord[]>> {
		const scope = new FileRecordScope().byParentId(parentId).byMarkedForDelete(true);
		const result = await this.findAndCount(scope, options);

		return result;
	}

	public async markForDeleteByStorageLocation(
		storageLocation: StorageLocation,
		storageLocationId: EntityId
	): Promise<number> {
		const scope = new FileRecordScope()
			.byStorageLocation(storageLocation)
			//@ts-ignore check issue https://github.com/mikro-orm/mikro-orm/issues/6690
			.byStorageLocationId(new ObjectId(storageLocationId))
			.byMarkedForDelete(false);
		const result = await this.em.nativeUpdate(this.entityName, scope.query, { deletedSince: new Date() });

		return result;
	}

	public async findBySecurityCheckRequestToken(token: string): Promise<FileRecord> {
		// Must also find expires in future. Please do not add .byExpires().
		const scope = new FileRecordScope().bySecurityCheckRequestToken(token);

		const fileRecord = await this.findOneOrFail(scope);

		return fileRecord;
	}

	public async findByCreatorId(creatorId: EntityId): Promise<Counted<FileRecord[]>> {
		const scope = new FileRecordScope().byCreatorId(creatorId);
		const result = await this.findAndCount(scope);

		return result;
	}

	public async save(fileRecord: FileRecord | FileRecord[]): Promise<void> {
		const fileRecords = Utils.asArray(fileRecord);

		fileRecords.forEach((f) => {
			const entity = FileRecordEntityMapper.mapDoToEntity(this.em, f);
			this.em.persist(entity);
		});

		await this.flush();
	}

	public async delete(fileRecord: FileRecord | FileRecord[]): Promise<void> {
		const fileRecords = Utils.asArray(fileRecord);

		fileRecords.forEach((f) => {
			const entity = FileRecordEntityMapper.mapDoToEntity(this.em, f);
			this.em.remove(entity);
		});

		await this.em.flush();
	}

	public async getStatisticByParentId(parentId: EntityId): Promise<ParentStatistic> {
		const aggregationPipeline = [
			{
				$match: {
					parent: new ObjectId(parentId),
					deletedSince: { $eq: null },
					storageType: { $ne: StorageType.TEMP },
				},
			},
			{
				$group: {
					_id: null,
					totalSizeInBytes: { $sum: '$size' },
					fileCount: { $sum: 1 },
				},
			},
		];

		const result = await this.em.aggregate(FileRecordEntity, aggregationPipeline);

		if (result.length > 0) {
			const { totalSizeInBytes, fileCount } = result[0];

			return ParentStatisticFactory.build({ fileCount, totalSizeInBytes });
		}

		return ParentStatisticFactory.build({ fileCount: 0, totalSizeInBytes: 0 });
	}

	private async findAndCount(
		scope: FileRecordScope,
		options?: FindOptions<FileRecordEntity>
	): Promise<Counted<FileRecord[]>> {
		const { pagination } = options ?? {};
		const order = { createdAt: SortOrder.desc, id: SortOrder.asc };

		const [entities, count] = await this.em.findAndCount(FileRecordEntity, scope.query, {
			offset: pagination?.skip,
			limit: pagination?.limit,
			orderBy: order,
		});

		const fileRecords = entities.map((entity) => FileRecordEntityMapper.mapEntityToDo(entity));

		return [fileRecords, count];
	}

	private async findOneOrFail(scope: FileRecordScope): Promise<FileRecord> {
		const entity = await this.em.findOneOrFail(FileRecordEntity, scope.query);

		const fileRecord = FileRecordEntityMapper.mapEntityToDo(entity);

		return fileRecord;
	}

	private flush(): Promise<void> {
		return this.em.flush();
	}
}
